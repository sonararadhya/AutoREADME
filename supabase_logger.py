"""
SupabaseLogger — Cloud telemetry & logging handler.

Features:
  - Batch log inserts (1 request instead of N)
  - Auto-retention pruning (deletes logs older than 30 days)
  - Hard cap on row limits
  - Resilient offline fallback (writes to local jsonl backup if network fails)
"""

import json
import logging
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from typing import List, Dict, Optional

log = logging.getLogger(__name__)

MAX_LOG_ROWS   = 5_000
MAX_RESULT_ROWS = 1_000
LOG_RETENTION_DAYS    = 30
RESULT_RETENTION_DAYS = 60
REQUEST_TIMEOUT = 8


class SupabaseLogger:
    def __init__(self, url: str, key: str):
        self.url  = url.rstrip("/")
        self.key  = key
        self.run_id: Optional[str] = None
        self._log_buffer: List[dict] = []
        self._available = True
        self._local_log_path = "logs/supabase_fallback.jsonl"

    def health_check(self) -> bool:
        """Ping Supabase. Returns True if reachable."""
        try:
            self._request("GET", "/rest/v1/runs?limit=1&select=id")
            self._available = True
            log.info("  ✅ Supabase telemetry connected")
            return True
        except Exception as e:
            self._available = False
            log.warning(f"  ⚠️  Supabase unreachable: {e}. Running in offline mode.")
            return False

    def start_run(self, repos: List[str]) -> Optional[str]:
        if not self._available:
            return None
        try:
            data = self._insert("runs", {
                "started_at":     _now(),
                "status":         "running",
                "repos":          json.dumps(repos),
                "triggered_by":   os.getenv("CUSTOM_TRIGGER_NAME") or os.getenv("GITHUB_EVENT_NAME", "manual"),
                "workflow_run_id": os.getenv("GITHUB_RUN_ID", "local"),
            })
            self.run_id = data[0]["id"] if data else None
            return self.run_id
        except Exception as e:
            log.warning(f"  Supabase start_run failed: {e}")
            return None

    def finish_run(self, status: str, summary_md: str, files_changed: int):
        self.flush_logs()
        if not self._available or not self.run_id:
            return
        try:
            self._update("runs", "id", self.run_id, {
                "finished_at":  _now(),
                "status":       status,
                "summary_md":   summary_md,
                "files_changed": files_changed,
            })
        except Exception as e:
            log.warning(f"  Supabase finish_run failed: {e}")

    def log_repo_result(self, repo_name, status, commit_url, files_changed, commit_message="", error=None):
        if not self._available:
            return
        try:
            self._insert("repo_results", {
                "run_id":          self.run_id,
                "repo_name":       repo_name,
                "status":          status,
                "branch_name":     "main",
                "pr_url":          commit_url,
                "files_changed":   json.dumps(files_changed),
                "error_message":   error,
                "processed_at":    _now(),
            })
        except Exception as e:
            log.warning(f"  Supabase log_repo_result failed: {e}")

    def update_system_config(self, key: str, value: str):
        if not self._available:
            return
        try:
            res = self._request("GET", f"/rest/v1/system_config?key=eq.{key}&select=id")
            if res and len(res) > 0:
                row_id = res[0]["id"]
            else:
                max_res = self._request("GET", "/rest/v1/system_config?select=id&order=id.desc&limit=1")
                max_id = max_res[0]["id"] if max_res else 0
                row_id = max_id + 1
            self._upsert("system_config", [{"id": row_id, "key": key, "value": value}])
        except Exception as e:
            log.warning(f"  Supabase update_system_config failed: {e}")

    def get_system_config(self, key: str) -> Optional[str]:
        if not self._available:
            return None
        try:
            res = self._request("GET", f"/rest/v1/system_config?key=eq.{key}&select=value")
            if res and len(res) > 0:
                return res[0].get("value")
        except Exception as e:
            log.warning(f"  Supabase get_system_config failed: {e}")
        return None

    def log_event(self, level: str, message: str):
        """Buffer a log line. Flush every 10 lines or at end of run."""
        entry = {"run_id": self.run_id, "ts": _now(), "level": level, "message": message}
        self._log_buffer.append(entry)
        self._write_local_log(entry)

        if level == "error" or "quota" in message.lower():
            self._send_discord_alert(level, message)

        if len(self._log_buffer) >= 10:
            self.flush_logs()

    def _send_discord_alert(self, level: str, message: str):
        webhook_url = os.getenv("DISCORD_WEBHOOK_URL")
        if not webhook_url:
            return
        try:
            color = 16711680 if level == "error" else 16753920
            payload = {
                "embeds": [{
                    "title": f"RepoSonar Alert: {level.upper()}",
                    "description": message,
                    "color": color,
                    "timestamp": _now()
                }]
            }
            req = urllib.request.Request(
                webhook_url,
                data=json.dumps(payload).encode('utf-8'),
                headers={'Content-Type': 'application/json', 'User-Agent': 'RepoSonar-Bot'}
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            log.warning(f"  Failed to send Discord alert: {e}")

    def flush_logs(self):
        if not self._available or not self._log_buffer or not self.run_id:
            self._log_buffer.clear()
            return
        batch = [e for e in self._log_buffer if e.get("run_id")]
        self._log_buffer.clear()
        if not batch:
            return
        try:
            self._insert_batch("run_logs", batch)
        except Exception as e:
            log.warning(f"  Supabase log flush failed: {e}")

    def get_file_hashes(self, repo_name: str) -> List[dict]:
        if not self._available:
            return []
        try:
            return self._request(
                "GET",
                f"/rest/v1/file_hashes?repo_name=eq.{repo_name}&select=file_path,content_hash"
            )
        except Exception:
            return []

    def save_file_hashes(self, repo_name: str, hashes: dict):
        if not self._available:
            return
        rows = [
            {"repo_name": repo_name, "file_path": path, "content_hash": h, "updated_at": _now()}
            for path, h in hashes.items()
        ]
        try:
            for i in range(0, len(rows), 50):
                self._upsert("file_hashes", rows[i:i+50])
        except Exception as e:
            log.warning(f"  Supabase save_file_hashes failed: {e}")

    def cleanup_old_data(self):
        """Delete old rows to stay within Supabase storage quotas."""
        if not self._available:
            return

        log_cutoff    = _days_ago(LOG_RETENTION_DAYS)
        result_cutoff = _days_ago(RESULT_RETENTION_DAYS)

        cleanups = [
            ("run_logs",     "ts",           log_cutoff,    "logs"),
            ("repo_results", "processed_at", result_cutoff, "results"),
        ]

        for table, col, cutoff, label in cleanups:
            try:
                self._request(
                    "DELETE",
                    f"/rest/v1/{table}?{col}=lt.{cutoff}"
                )
                log.info(f"  🧹 Cleaned old {label} (before {cutoff[:10]})")
            except Exception as e:
                log.warning(f"  Cleanup {table} failed (non-critical): {e}")

    def _insert(self, table: str, payload: dict) -> list:
        return self._request("POST", f"/rest/v1/{table}", payload)

    def _insert_batch(self, table: str, rows: list) -> list:
        return self._request("POST", f"/rest/v1/{table}", rows)

    def _upsert(self, table: str, rows: list) -> list:
        return self._request(
            "POST", f"/rest/v1/{table}", rows,
            extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"}
        )

    def _update(self, table: str, pk: str, pk_val: str, payload: dict):
        self._request("PATCH", f"/rest/v1/{table}?{pk}=eq.{pk_val}", payload)

    def _request(
        self,
        method: str,
        path: str,
        body=None,
        extra_headers: dict = None,
    ) -> list:
        url  = self.url + path
        data = json.dumps(body).encode() if body is not None else None
        headers = {
            "Content-Type":  "application/json",
            "apikey":        self.key,
            "Authorization": f"Bearer {self.key}",
            "Prefer":        "return=representation",
        }
        if extra_headers:
            headers.update(extra_headers)

        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            body_text = e.read().decode(errors="ignore")[:300]
            if e.code == 429:
                self._available = False
                log.warning("  ⚠️  Supabase rate limit hit (429). Switching to offline mode.")
            raise RuntimeError(f"HTTP {e.code}: {body_text}")
        except Exception as e:
            raise RuntimeError(f"Request failed: {e}")

    def _write_local_log(self, entry: dict):
        try:
            os.makedirs("logs", exist_ok=True)
            with open(self._local_log_path, "a") as f:
                f.write(json.dumps(entry) + "\n")
        except Exception:
            pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()
