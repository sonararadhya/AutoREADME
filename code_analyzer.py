"""
CodeAnalyzer — Read-only source code scanner.

Walks the target repository and extracts a structured summary of:
  - File structure and language composition
  - Function and class definitions
  - Imports and dependencies
  - API routes, CLI arguments, environment variable usage
  - Key features that should be documented in the README

SECURITY GUARANTEE: This module NEVER writes to or modifies any source file.
                    It is 100% read-only.
"""

import os
import re
import logging
from pathlib import Path
from typing import List, Dict, Set

log = logging.getLogger(__name__)

# File extensions to scan for feature extraction
DEFAULT_SOURCE_EXTENSIONS = [
    ".py", ".js", ".ts", ".jsx", ".tsx",
    ".java", ".go", ".rb", ".rs",
    ".html", ".css", ".scss",
    ".json", ".toml", ".cfg", ".ini",
    ".sh", ".bash", ".yml", ".yaml",
]

# Directories to always ignore
SKIP_DIRS = {
    ".git", "node_modules", "dist", "build", "vendor",
    ".venv", "venv", "__pycache__", ".next", ".cache",
    "env", ".env", ".idea", ".vscode", "coverage",
    "target", "bin", "obj", ".tox", "egg-info",
}

MAX_FILE_CHARS = 5_000

# Regex patterns for feature extraction
PYTHON_CLASS_RE    = re.compile(r"^class\s+(\w+)", re.MULTILINE)
PYTHON_FUNC_RE     = re.compile(r"^def\s+(\w+)", re.MULTILINE)
PYTHON_IMPORT_RE   = re.compile(r"^(?:import|from)\s+([\w.]+)", re.MULTILINE)
PYTHON_ROUTE_RE    = re.compile(r'@(?:app|router|api)\.\w+\(\s*["\']([^"\']+)', re.MULTILINE)
PYTHON_ARGPARSE_RE = re.compile(r'add_argument\(\s*["\']([^"\']+)', re.MULTILINE)
PYTHON_ENVVAR_RE   = re.compile(r'os\.(?:getenv|environ)\s*[\[(]\s*["\'](\w+)', re.MULTILINE)

JS_FUNC_RE         = re.compile(r"(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:async\s*)?\(|[\(])", re.MULTILINE)
JS_CLASS_RE        = re.compile(r"class\s+(\w+)", re.MULTILINE)
JS_IMPORT_RE       = re.compile(r"(?:import|require)\s*\(?['\"]([^'\"]+)", re.MULTILINE)
JS_ROUTE_RE        = re.compile(r'(?:app|router)\.\w+\(\s*["\']([^"\']+)', re.MULTILINE)

JAVA_CLASS_RE      = re.compile(r"(?:public|private)?\s*class\s+(\w+)", re.MULTILINE)
JAVA_METHOD_RE     = re.compile(r"(?:public|private|protected)\s+\w+\s+(\w+)\s*\(", re.MULTILINE)

SHELL_FUNC_RE      = re.compile(r"^(?:function\s+)?(\w+)\s*\(\s*\)", re.MULTILINE)
SHELL_ALIAS_RE     = re.compile(r"^\s*alias\s+(\w+)=", re.MULTILINE)
SHELL_EXPORT_RE    = re.compile(r"^\s*export\s+(\w+)=", re.MULTILINE)
SHELL_COMMENT_RE   = re.compile(r"^\s*#\s*(.{10,80})$", re.MULTILINE)


class CodeAnalyzer:
    """Read-only source code analyzer that extracts feature summaries for AI context."""

    def __init__(
        self,
        extensions: List[str] = None,
        max_total_chars: int = 15_000,
    ):
        self.extensions = set(extensions or DEFAULT_SOURCE_EXTENSIONS)
        self.max_total_chars = max_total_chars

    def analyze_repo(self, repo_path: str) -> str:
        """Scan the repo and return a structured text summary of features found."""
        log.info("    🔎 Scanning source code (read-only)...")
        
        files_info = self._collect_files(repo_path)
        
        if not files_info:
            log.info("    ℹ️  No source files found to analyze")
            return ""

        all_classes:    Set[str] = set()
        all_functions:  Set[str] = set()
        all_imports:    Set[str] = set()
        all_routes:     List[str] = []
        all_cli_args:   List[str] = []
        all_env_vars:   Set[str] = set()
        file_tree:      List[str] = []
        frameworks:     Set[str] = set()
        key_snippets:   List[str] = []

        for finfo in files_info:
            rel_path = finfo["rel_path"]
            content  = finfo["content"]
            ext      = finfo["ext"]
            file_tree.append(rel_path)

            frameworks.update(self._detect_frameworks(rel_path, content))

            if ext == ".py":
                all_classes.update(PYTHON_CLASS_RE.findall(content))
                all_functions.update(PYTHON_FUNC_RE.findall(content))
                all_imports.update(PYTHON_IMPORT_RE.findall(content))
                all_routes.extend(PYTHON_ROUTE_RE.findall(content))
                all_cli_args.extend(PYTHON_ARGPARSE_RE.findall(content))
                all_env_vars.update(PYTHON_ENVVAR_RE.findall(content))

            elif ext in (".js", ".ts", ".jsx", ".tsx"):
                all_classes.update(JS_CLASS_RE.findall(content))
                all_functions.update(JS_FUNC_RE.findall(content))
                all_imports.update(JS_IMPORT_RE.findall(content))
                all_routes.extend(JS_ROUTE_RE.findall(content))

            elif ext == ".java":
                all_classes.update(JAVA_CLASS_RE.findall(content))
                all_functions.update(JAVA_METHOD_RE.findall(content))

            elif ext in (".sh", ".bash"):
                all_functions.update(SHELL_FUNC_RE.findall(content))
                aliases = SHELL_ALIAS_RE.findall(content)
                if aliases:
                    key_snippets.append(f"Shell aliases: {', '.join(aliases[:15])}")
                exports = SHELL_EXPORT_RE.findall(content)
                all_env_vars.update(exports)
                comments = SHELL_COMMENT_RE.findall(content)
                useful_comments = [c.strip() for c in comments if not c.strip().startswith("!") and len(c.strip()) > 15][:5]
                if useful_comments:
                    key_snippets.append(f"[{rel_path}] Comments: {'; '.join(useful_comments)}")

            if ext == ".py":
                doc_match = re.search(r'^"""(.*?)"""', content, re.DOTALL)
                if doc_match and len(doc_match.group(1).strip()) > 20:
                    snippet = doc_match.group(1).strip()[:300]
                    key_snippets.append(f"[{rel_path}] {snippet}")

            if rel_path.endswith("package.json"):
                self._extract_package_json(content, frameworks, key_snippets)

            if rel_path.endswith(("requirements.txt", "Pipfile")):
                deps = [line.strip().split("==")[0].split(">=")[0].split("<=")[0]
                        for line in content.splitlines()
                        if line.strip() and not line.startswith("#")]
                if deps:
                    key_snippets.append(f"Python dependencies: {', '.join(deps[:20])}")

        public_functions = {f for f in all_functions if not f.startswith("_")}
        public_classes   = {c for c in all_classes if not c.startswith("_")}

        summary = self._build_summary(
            file_tree=file_tree,
            classes=sorted(public_classes),
            functions=sorted(public_functions),
            imports=sorted(all_imports),
            routes=all_routes,
            cli_args=all_cli_args,
            env_vars=sorted(all_env_vars),
            frameworks=sorted(frameworks),
            key_snippets=key_snippets,
        )

        if len(summary) > self.max_total_chars:
            summary = summary[:self.max_total_chars] + "\n... (truncated)"

        log.info(f"    📊 Source analysis: {len(files_info)} files scanned")
        return summary

    def _collect_files(self, repo_path: str) -> List[Dict]:
        """Walk repo and read source files. STRICTLY READ-ONLY."""
        results = []
        total_chars = 0

        for root, dirs, files in os.walk(repo_path):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]

            for fname in sorted(files):
                ext = Path(fname).suffix.lower()
                if ext not in self.extensions:
                    continue

                fpath = os.path.join(root, fname)
                rel_path = os.path.relpath(fpath, repo_path)

                try:
                    with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                        content = f.read(MAX_FILE_CHARS)
                except Exception:
                    continue

                if not content.strip():
                    continue

                results.append({
                    "rel_path": rel_path,
                    "content":  content,
                    "ext":      ext,
                })
                total_chars += len(content)

                if total_chars > self.max_total_chars * 3:
                    return results

        return results

    def _detect_frameworks(self, rel_path: str, content: str) -> Set[str]:
        """Detect frameworks/technologies from file content and names."""
        found = set()
        lower_content = content.lower()
        lower_path = rel_path.lower()

        detections = {
            "Flask":        ("from flask", "import flask"),
            "Django":       ("from django", "import django", "django.conf"),
            "FastAPI":      ("from fastapi", "import fastapi"),
            "Express.js":   ("require('express')", "from 'express'", "require(\"express\")"),
            "React":        ("from 'react'", "import react", "from \"react\""),
            "Next.js":      ("from 'next", "next.config", "from \"next"),
            "Vue.js":       ("from 'vue'", "createapp", "from \"vue\""),
            "TensorFlow":   ("import tensorflow", "from tensorflow"),
            "PyTorch":      ("import torch", "from torch"),
            "Scikit-learn": ("from sklearn", "import sklearn"),
            "Pandas":       ("import pandas", "from pandas"),
            "NumPy":        ("import numpy", "from numpy"),
            "Streamlit":    ("import streamlit", "from streamlit"),
            "SQLAlchemy":   ("from sqlalchemy", "import sqlalchemy"),
            "MongoDB":      ("pymongo", "mongoose", "mongodb"),
            "PostgreSQL":   ("psycopg", "postgresql", "postgres"),
            "Redis":        ("import redis", "from redis"),
            "Docker":       ("dockerfile",),
            "Supabase":     ("supabase",),
        }

        for framework, keywords in detections.items():
            if any(kw in lower_content or kw in lower_path for kw in keywords):
                found.add(framework)

        if lower_path.endswith("dockerfile") or lower_path.endswith("docker-compose.yml"):
            found.add("Docker")

        return found

    def _extract_package_json(self, content: str, frameworks: Set[str], snippets: List[str]):
        """Extract scripts and dependencies from package.json."""
        import json
        try:
            pkg = json.loads(content)
            scripts = pkg.get("scripts", {})
            if scripts:
                snippets.append(f"npm scripts: {', '.join(scripts.keys())}")
            
            all_deps = list(pkg.get("dependencies", {}).keys()) + \
                       list(pkg.get("devDependencies", {}).keys())
            if all_deps:
                snippets.append(f"npm packages: {', '.join(all_deps[:20])}")
        except Exception:
            pass

    def _build_summary(
        self,
        file_tree: List[str],
        classes: List[str],
        functions: List[str],
        imports: List[str],
        routes: List[str],
        cli_args: List[str],
        env_vars: List[str],
        frameworks: List[str],
        key_snippets: List[str],
    ) -> str:
        """Build structured feature summary for AI prompt context."""
        sections = []
        sections.append("## Repository Source Code Analysis")

        if frameworks:
            sections.append(f"### Frameworks & Technologies\n{', '.join(frameworks)}")

        if file_tree:
            tree_str = "\n".join(f"  - {f}" for f in file_tree[:40])
            sections.append(f"### File Structure ({len(file_tree)} source files)\n{tree_str}")

        if classes:
            sections.append(f"### Classes\n{', '.join(classes[:30])}")

        if functions:
            sections.append(f"### Key Functions\n{', '.join(functions[:40])}")

        if routes:
            route_str = "\n".join(f"  - `{r}`" for r in routes[:20])
            sections.append(f"### API Routes / Endpoints\n{route_str}")

        if cli_args:
            args_str = "\n".join(f"  - `{a}`" for a in cli_args[:15])
            sections.append(f"### CLI Arguments\n{args_str}")

        if env_vars:
            env_str = "\n".join(f"  - `{v}`" for v in env_vars[:15])
            sections.append(f"### Environment Variables\n{env_str}")

        if key_snippets:
            snip_str = "\n".join(f"  - {s}" for s in key_snippets[:10])
            sections.append(f"### Key Details\n{snip_str}")

        if imports:
            notable = [i for i in imports if "." in i or len(i) > 3][:25]
            if notable:
                sections.append(f"### Notable Imports\n{', '.join(notable)}")

        return "\n\n".join(sections)
