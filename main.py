"""
AutoREADME — Main Orchestrator.
Fully autonomous repository & documentation maintenance pipeline.
"""

import os
import sys
import logging
import traceback
from datetime import datetime, timezone

# Setup logging
os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("logs/improver.log"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)

from config_loader   import load_config
from git_handler     import GitHandler
from ai_reviewer     import AIReviewer
from supabase_logger import SupabaseLogger
from optimizer       import SmartOptimizer
from code_analyzer   import CodeAnalyzer

def run():
    import time
    import math
    run_start_time = time.time()
    
    log.info("=" * 65)
    log.info("🤖 AutoREADME — Autonomous AI Documentation System")
    log.info(f"   Execution Time: {datetime.now(timezone.utc).isoformat()} UTC")
    log.info("=" * 65)

    # 1. Load configuration
    try:
        config = load_config("config.yaml")
    except Exception as e:
        log.critical(f"❌ Cannot load config: {e}")
        sys.exit(1)

    # 2. Initialize cloud telemetry
    db = _init_supabase(config)

    # 3. Safety kill switch check
    disable_bot = os.getenv("DISABLE_BOT") == "true"
    if db:
        db_disable = db.get_system_config("DISABLE_BOT")
        if db_disable is not None:
            disable_bot = (db_disable == "true")
            
    if disable_bot:
        log.warning("🛑 KILL SWITCH ENGAGED (DISABLE_BOT=true). Exiting safely.")
        return

    optimizer = SmartOptimizer(supabase_logger=db)
    git       = GitHandler(
        ssh_passphrase=config.get("ssh_passphrase", ""),
        github_username=config.get("github_username") or os.getenv("GITHUB_USERNAME", ""),
        github_token=config.get("github_token") or os.getenv("GITHUB_TOKEN", ""),
    )

    def db_log_callback(level, msg):
        _db_log(db, level, msg)

    reviewer = _init_reviewer(config, db_log_callback)
    
    analyzer = CodeAnalyzer(
        extensions=config.get("source_scan_extensions", None),
        max_total_chars=config.get("source_scan_max_chars", 15000),
    )

    force_change = config.get("force_change", True)
    maintenance_mode = config.get("maintenance_mode", False)
    
    if db:
        db_maint = db.get_system_config("MAINTENANCE_MODE")
        if db_maint is not None:
            maintenance_mode = (db_maint == "true")
    
    repos_to_process = config.get("repos", [])
    if db:
        db_repos_json = db.get_system_config("REPOSITORIES")
        if db_repos_json:
            try:
                import json
                repos_to_process = json.loads(db_repos_json)
            except Exception as e:
                log.warning(f"  ⚠️ Could not parse REPOSITORIES from DB: {e}")

    if db:
        db.start_run(repos_to_process)
        db.cleanup_old_data()

    _db_log(db, "info", f"🔧 Config: force_change={force_change}, repos={len(repos_to_process)}")
    _db_log(db, "info", f"🔧 Reviewer: {'✅ initialized' if reviewer else '❌ MISSING API KEY'}")

    all_summaries  = []
    total_changed  = 0
    run_status     = "success"

    for repo_url in repos_to_process:
        repo_name = repo_url.rstrip("/").split("/")[-1].replace(".git", "")
        log.info(f"\n{'─'*55}")
        log.info(f"📦 Processing: {repo_name}")
        _db_log(db, "info", f"📦 Processing: {repo_name}")

        try:
            repo_path = git.clone_or_pull(repo_url, f"workspace/{repo_name}")
            _db_log(db, "info", "  ✅ Repository sync complete")

            readme_files = git.get_source_files(repo_path)
            _db_log(db, "info", f"  📄 Found {len(readme_files)} README file(s)")
            
            if not readme_files:
                log.info("  ⏭️ No README files found - skipping")
                _db_log(db, "warning", "  ⚠️ No README found - skipped")
                if db: db.log_repo_result(repo_name, "no_readme", "", [], "")
                continue

            if force_change:
                files_to_review = readme_files
                log.info(f"  🔄 Force mode: processing all {len(files_to_review)} README(s)")
                _db_log(db, "info", f"  🔄 Force mode: processing {len(files_to_review)} README(s)")
            else:
                files_to_review = optimizer.filter_changed_files(repo_name, readme_files)
                if not files_to_review:
                    log.info("  ⏭️ README unchanged since last run - skipping")
                    _db_log(db, "info", "  README unchanged - skip")
                    if db: db.log_repo_result(repo_name, "no_changes", "", [], "")
                    continue

            if not reviewer:
                log.warning("  ⚠️ API keys missing - using deterministic fallback")
                _db_log(db, "warning", "  ⚠️ No API key — deterministic fallback only")
                changes = []
                for f in files_to_review:
                    fallback_result = _deterministic_readme_change(f["content"])
                    if fallback_result != f["content"]:
                        changes.append({
                            "path": f["path"],
                            "original_content": f["content"],
                            "improved_content": fallback_result,
                            "description": f"Refreshed documentation wording in {f['path']}",
                        })
                if changes:
                    commit_msg = "docs: refresh readme wording and formatting"
                    commit_url = git.direct_commit_and_push(
                        repo_path=repo_path, changes=changes,
                        commit_message=commit_msg, repo_url=repo_url,
                    )
                    if commit_url:
                        total_changed += len(changes)
                        _db_log(db, "info", f"  ✅ Fallback commit: {commit_url}")
                        if db: db.log_repo_result(repo_name, "improved", commit_url, [{"path": c["path"]} for c in changes], commit_msg)
                continue

            source_summary = analyzer.analyze_repo(repo_path)
            if source_summary:
                _db_log(db, "info", f"  📊 Source code analyzed ({len(source_summary)} chars)")
            else:
                _db_log(db, "info", f"  ℹ️  No source files found for analysis")

            if maintenance_mode:
                log.info("  🛠️ Maintenance Mode active: skipping AI calls")
                _db_log(db, "info", "  🛠️ Maintenance Mode: skipping AI, updating timestamp only")
                changes = []
                for f in files_to_review:
                    updated = _deterministic_readme_change(f["content"])
                    if updated != f["content"]:
                        changes.append({
                            "path": f["path"],
                            "original_content": f["content"],
                            "improved_content": updated,
                            "description": "Maintenance: Updated 'Last maintained' timestamp"
                        })
            else:
                _db_log(db, "info", f"  🤖 Starting AI review...")
                changes = reviewer.review_and_improve(
                    repo_path=repo_path,
                    files=files_to_review,
                    improvement_goals=config.get("readme_goals", [
                        "Improve clarity", "Fix grammar", "Modernize formatting"
                    ]),
                    source_code_summary=source_summary,
                )

            _db_log(db, "info", f"  📝 AI produced {len(changes)} change(s)")

            if not changes:
                log.info("  ℹ️ AI determined no improvements needed. Using timestamp fallback.")
                _db_log(db, "info", "  ℹ️ AI needed no changes. Using fallback for commit streak.")
                changes = []
                for f in files_to_review:
                    updated = _deterministic_readme_change(f["content"])
                    if updated != f["content"]:
                        changes.append({
                            "path": f["path"],
                            "original_content": f["content"],
                            "improved_content": updated,
                            "description": "Maintenance: Updated 'Last maintained' timestamp"
                        })
                if not changes:
                    if db: db.log_repo_result(repo_name, "no_changes", "", [], "")
                    continue

            commit_msg = reviewer.generate_commit_message(changes)
            _db_log(db, "info", f"  📤 Pushing commit: {commit_msg}")

            commit_url = git.direct_commit_and_push(
                repo_path=repo_path,
                changes=changes,
                commit_message=commit_msg,
                repo_url=repo_url,
            )

            if not commit_url:
                log.info("  ℹ️  No actual file changes — commit skipped")
                _db_log(db, "warning", "  ⚠️ Git detected no diff — commit skipped")
                if db: db.log_repo_result(repo_name, "no_changes", "", [], "")
                continue

            total_changed += len(changes)
            optimizer.save_hashes(repo_name, changes)
            
            summary = reviewer.generate_summary(repo_name, changes, commit_url)
            all_summaries.append(summary)
            
            _db_log(db, "info", f"  🚀 Committed: {commit_url}")
            if db:
                db.log_repo_result(
                    repo_name, "improved", commit_url,
                    [{"path": c["path"]} for c in changes],
                    commit_msg
                )

        except Exception as e:
            run_status = "partial"
            err_msg = str(e)
            tb = traceback.format_exc()
            log.error(f"  ❌ Failed {repo_name}: {err_msg}")
            log.debug(tb)
            _db_log(db, "error", f"  ❌ {repo_name} FAILED: {err_msg}")
            _db_log(db, "error", f"  📋 Traceback: {tb[-500:]}")
            if db: db.log_repo_result(repo_name, "error", "", [], "", error=err_msg)

    tokens = reviewer.tokens_used if reviewer else 0
    summary_md = _build_final_summary(all_summaries)
    
    log.info(f"\n{'='*65}")
    log.info(f"✅ Run complete | Improved: {total_changed} | Tokens: {tokens:,}")
    log.info(f"{'='*65}")

    _db_log(db, "info", f"✅ DONE | Improved: {total_changed} | Tokens: {tokens:,}")

    if db:
        duration_mins = max(1, math.ceil((time.time() - run_start_time) / 60.0))
        try:
            current_mins_str = db.get_system_config("GITHUB_ACTIONS_MINUTES")
            current_mins = int(current_mins_str) if current_mins_str and current_mins_str.isdigit() else 0
            new_mins = current_mins + duration_mins
            db.update_system_config("GITHUB_ACTIONS_MINUTES", str(new_mins))
        except Exception:
            pass

        db.flush_logs()
        db.finish_run(run_status, summary_md, total_changed)

    with open("logs/last_summary.md", "w") as f:
        f.write(summary_md)


def _init_supabase(config: dict) -> SupabaseLogger | None:
    url = config.get("supabase_url") or os.getenv("SUPABASE_URL")
    key = config.get("supabase_key") or os.getenv("SUPABASE_KEY")
    if not url or not key:
        log.warning("⚠️  Supabase not configured — running without cloud logging")
        return None
    try:
        db = SupabaseLogger(url=url, key=key)
        db.health_check()
        return db
    except Exception as e:
        log.warning(f"⚠️  Supabase init failed: {e} — running offline")
        return None

def _init_reviewer(config: dict, db_log_callback=None) -> AIReviewer | None:
    gemini_key = config.get("gemini_api_key") or os.getenv("GEMINI_API_KEY", "")
    github_token = config.get("github_token") or os.getenv("GITHUB_TOKEN", "") or os.getenv("PAT_TOKEN", "")
    groq_key = config.get("groq_api_key") or os.getenv("GROQ_API_KEY", "")
    openrouter_key = config.get("openrouter_api_key") or os.getenv("OPENROUTER_API_KEY", "")

    if not gemini_key and not github_token and not groq_key and not openrouter_key:
        log.warning("⚠️ No AI keys configured — AI review disabled")
        return None
    try:
        return AIReviewer(
            api_key=gemini_key,
            db_log_callback=db_log_callback,
            github_token=github_token,
            groq_api_key=groq_key,
            openrouter_api_key=openrouter_key
        )
    except Exception as e:
        log.error(f"⚠️ Failed to init AI reviewer: {e}")
        return None

def _db_log(db, level, msg):
    if db:
        try:
            db.log_event(level, msg)
        except Exception:
            pass

def _deterministic_readme_change(content: str) -> str:
    import re
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    ts_line = f"\n\n---\n*📝 Last maintained: {now.strftime('%B %d, %Y at %H:%M UTC')}*\n"
    ts_pattern = re.compile(r"\n*---\n\*📝 Last maintained:.*?\*\n?", re.DOTALL)
    
    base_content = content if content.strip() else "# 🤖 Repository Documentation\n\nAutomatically generated."
    
    if ts_pattern.search(base_content):
        return ts_pattern.sub(ts_line, base_content)
    else:
        return base_content.rstrip() + ts_line

def _build_final_summary(summaries):
    if not summaries: return "# 🤖 AutoREADME Execution Summary\n\nNo README files were improved in this run."
    lines = ["# 🤖 README Refinement Summary\n"]
    for s in summaries:
        repo = s.get("repo", "unknown")
        md = s.get("markdown", "Improved documentation.")
        commit = s.get("commit_url", "")
        lines.append(f"### ✅ `{repo}`\n{md}")
        if commit:
            lines.append(f"[View Commit]({commit})\n")
    return "\n".join(lines)

if __name__ == "__main__":
    run()
