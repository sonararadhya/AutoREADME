"""
GitHandler — Clone, pull, apply file changes, commit, and push directly.
Uses HTTPS + token auth (no SSH agent required) for headless CI/CD automation.
"""

import os
import subprocess
import logging
from pathlib import Path
from typing import List, Dict
from urllib.parse import urlparse

log = logging.getLogger(__name__)

DEFAULT_EXTENSIONS = [".md", ".txt"]
ALLOWED_FILENAMES = ["readme"]


class GitHandler:
    def __init__(self, ssh_passphrase: str, github_username: str, github_token: str):
        self.passphrase = ssh_passphrase
        self.username = github_username or ""
        self.token = github_token or ""

    def clone_or_pull(self, repo_url: str, local_path: str) -> str:
        """Clone repo if not present; otherwise fetch and reset to origin/default."""
        local_path = str(Path(local_path).resolve())
        authed_url = self._inject_token(repo_url)

        if not os.path.exists(os.path.join(local_path, ".git")):
            log.info(f"  Cloning {repo_url} → {local_path}")
            self._run(["git", "clone", authed_url, local_path])
        else:
            log.info(f"  Pulling latest for {local_path}")
            self._run(["git", "remote", "set-url", "origin", authed_url], cwd=local_path)
            self._run(["git", "fetch", "origin"], cwd=local_path)
            default_branch = self._default_branch(local_path)
            self._run(["git", "checkout", default_branch], cwd=local_path)
            self._run(["git", "reset", "--hard", f"origin/{default_branch}"], cwd=local_path)

        # Configure git identity dynamically from environment or generic defaults
        git_email = os.getenv("GIT_USER_EMAIL") or (f"{self.username}@users.noreply.github.com" if self.username else "bot@autoreadme.dev")
        git_name  = os.getenv("GIT_USER_NAME")  or self.username or "AutoREADME Bot"

        self._run(["git", "config", "user.email", git_email], cwd=local_path)
        self._run(["git", "config", "user.name",  git_name],  cwd=local_path)

        return local_path

    def get_source_files(
        self,
        repo_path: str,
        extensions: List[str] = None,
        exclude_dirs: List[str] = None,
        max_files: int = 5,
    ) -> List[Dict]:
        """Walk the repo and return root-level README files."""
        if extensions is None:
            extensions = DEFAULT_EXTENSIONS
        if exclude_dirs is None:
            exclude_dirs = ["node_modules", "dist", "build", "vendor", ".venv", "__pycache__"]
        results = []

        for root, dirs, files in os.walk(repo_path):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in exclude_dirs]

            rel_root = os.path.relpath(root, repo_path)
            if rel_root != ".":
                continue

            for fname in files:
                name_stem = Path(fname).stem
                if name_stem.lower() not in ALLOWED_FILENAMES:
                    continue
                
                if not any(fname.lower().endswith(ext) for ext in extensions):
                    continue

                fpath = os.path.join(root, fname)
                rel_path = os.path.relpath(fpath, repo_path)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read()
                    results.append({"path": rel_path, "content": content})
                except Exception as e:
                    log.warning(f"  Could not read README {rel_path}: {e}")

                if len(results) >= max_files:
                    return results

        if not results:
            results.append({"path": "README.md", "content": ""})

        return results

    def direct_commit_and_push(
        self,
        repo_path: str,
        changes: List[Dict],
        commit_message: str,
        repo_url: str,
    ) -> str:
        """Write improvements, commit directly to default branch, and push."""
        default_branch = self._default_branch(repo_path)
        self._run(["git", "checkout", default_branch], cwd=repo_path)

        for change in changes:
            fpath = os.path.join(repo_path, change["path"])
            os.makedirs(os.path.dirname(fpath) or ".", exist_ok=True)
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(change["improved_content"])

        self._run(["git", "add", "-A"], cwd=repo_path)
        
        status = self._run_safe(["git", "status", "--porcelain"], cwd=repo_path)
        if not status or not status.strip():
            log.info("  ℹ️  No file changes detected — nothing to commit")
            return ""

        self._run(["git", "commit", "-m", commit_message], cwd=repo_path)

        authed_url = self._inject_token(repo_url)
        self._run(["git", "push", authed_url, default_branch], cwd=repo_path)

        commit_hash = self._run_safe(["git", "rev-parse", "HEAD"], cwd=repo_path).strip()
        repo_full_name = self._extract_repo_full_name(repo_url)
        commit_url = f"https://github.com/{repo_full_name}/commit/{commit_hash}"

        log.info(f"  🚀 Direct commit pushed: {commit_url}")
        return commit_url

    def _inject_token(self, url: str) -> str:
        """Convert https://github.com/user/repo → https://user:token@github.com/user/repo"""
        parsed = urlparse(url)
        if parsed.scheme in ("http", "https") and self.token:
            user_prefix = f"{self.username}:" if self.username else "x-access-token:"
            return parsed._replace(
                netloc=f"{user_prefix}{self.token}@{parsed.hostname}"
            ).geturl()
        return url

    def _extract_repo_full_name(self, url: str) -> str:
        """Extract 'owner/repo' from GitHub URL."""
        clean = url.rstrip("/").replace(".git", "")
        parts = clean.split("/")
        return f"{parts[-2]}/{parts[-1]}"

    def _default_branch(self, repo_path: str) -> str:
        """Detect the default branch (falls back to 'main' or 'master')."""
        out = self._run_safe(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
            cwd=repo_path
        )
        if out:
            return out.strip().split("/")[-1]

        branches = self._run_safe(
            ["git", "branch", "-r"],
            cwd=repo_path
        ) or ""
        if "origin/main" in branches:
            return "main"
        if "origin/master" in branches:
            return "master"

        return "main"

    def _run(self, cmd: List[str], cwd: str = None, capture: bool = False) -> str:
        """Run a git command. Raises on failure."""
        try:
            result = subprocess.run(
                cmd, cwd=cwd,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, check=True
            )
            return result.stdout
        except subprocess.CalledProcessError as e:
            if self.token and self.token in str(e.stderr):
                e.stderr = str(e.stderr).replace(self.token, "***REDACTED***")
            raise e

    def _run_safe(self, cmd: List[str], cwd: str = None) -> str:
        """Run a git command safely."""
        try:
            result = subprocess.run(
                cmd, cwd=cwd,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, check=True
            )
            return result.stdout
        except Exception:
            return ""
