"""
SmartOptimizer — Quota conservation and incremental change optimization.

Strategy:
  1. Hash target files before calling AI
  2. Query past hashes from Supabase / local cache
  3. Skip processing if content is unchanged
  4. Save API tokens and runner duration
"""

import hashlib
import json
import logging
import os
import subprocess
from typing import List, Dict, Optional

log = logging.getLogger(__name__)


class SmartOptimizer:
    def __init__(self, supabase_logger=None):
        self.db = supabase_logger
        self._local_cache_path = "logs/hash_cache.json"
        self._local_cache: dict = self._load_local_cache()

    def filter_changed_files(
        self,
        repo_name: str,
        files: List[Dict],
        force: bool = False,
    ) -> List[Dict]:
        """Return only files whose content hash has changed since the last run."""
        if force:
            log.info(f"  🔄 Force mode: bypassing hash check — processing all {len(files)} file(s)")
            for f in files:
                f["_hash"] = _sha256(f["content"])
            return files

        cached_hashes = self._load_hashes(repo_name)
        changed = []

        for f in files:
            current_hash = _sha256(f["content"])
            cached_hash = cached_hashes.get(f["path"])

            if current_hash != cached_hash:
                f["_hash"] = current_hash
                changed.append(f)
            else:
                log.info(f"    ⏭️  Skipping unchanged: {f['path']}")

        skipped = len(files) - len(changed)
        if skipped:
            log.info(f"  💡 Skipped {skipped} unchanged file(s) — saved API tokens")

        return changed

    def save_hashes(self, repo_name: str, improved_files: List[Dict]):
        """Persist new hashes after successful execution."""
        if not improved_files:
            return

        new_hashes = {}
        for f in improved_files:
            if f.get("_hash"):
                new_hashes[f["path"]] = f["_hash"]
            elif f.get("improved_content"):
                new_hashes[f["path"]] = _sha256(f["improved_content"])
            elif f.get("content"):
                new_hashes[f["path"]] = _sha256(f["content"])

        existing = self._load_hashes(repo_name)
        existing.update(new_hashes)

        self._save_hashes(repo_name, existing)

    def estimate_tokens(self, files: List[Dict], tokens_per_file: int = 8000) -> int:
        """Estimate token consumption for files."""
        return sum(
            min(len(f["content"]) // 4, tokens_per_file)
            for f in files
        )

    def _load_hashes(self, repo_name: str) -> dict:
        if self.db:
            try:
                rows = self.db.get_file_hashes(repo_name)
                if rows:
                    return {r["file_path"]: r["content_hash"] for r in rows}
            except Exception as e:
                log.warning(f"  Supabase hash fetch failed, using local cache: {e}")

        return self._local_cache.get(repo_name, {})

    def _save_hashes(self, repo_name: str, hashes: dict):
        self._local_cache[repo_name] = hashes
        self._persist_local_cache()

        if self.db:
            try:
                self.db.save_file_hashes(repo_name, hashes)
            except Exception as e:
                log.warning(f"  Supabase hash save failed (local cache used): {e}")

    def _load_local_cache(self) -> dict:
        try:
            if os.path.exists(self._local_cache_path):
                with open(self._local_cache_path) as f:
                    return json.load(f)
        except Exception:
            pass
        return {}

    def _persist_local_cache(self):
        os.makedirs("logs", exist_ok=True)
        try:
            with open(self._local_cache_path, "w") as f:
                json.dump(self._local_cache, f, indent=2)
        except Exception as e:
            log.warning(f"  Local cache write failed: {e}")


def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()
