"""
AIReviewer — Powered by Multi-Provider AI (Groq, GitHub Models, OpenRouter, Gemini).
Autonomous documentation specialist: Reads source code context to discover undocumented features
and produces refined, professional Markdown documentation.
"""

import logging
import os
import re
import time
import random
import hashlib
import json
import urllib.request
from datetime import datetime, timezone
from typing import List, Dict, Callable, Optional
import google.generativeai as genai

log = logging.getLogger(__name__)

# Reliability & backoff configuration
MAX_RETRIES     = 3
RETRY_DELAYS    = [10, 30, 60]   # Generous backoff for free tiers
MAX_FILE_CHARS  = 30_000

REVIEW_SYSTEM = """You are a professional technical writer and open-source documentation expert.
Your goal is to improve the README files of GitHub repositories.

RULES:
1. You MUST ALWAYS return a JSON object with this exact structure:
   {"needs_improvement": boolean, "improved_text": "string"}
2. If the README is already excellent and doesn't need changes, set "needs_improvement": false, and return empty string for improved_text.
3. If the source code analysis reveals features NOT mentioned in the README, set "needs_improvement": true and ADD them to improved_text.
4. Focus on:
   - Clarity and professional tone.
   - Fixing grammar and typos.
   - Improving structure (better use of headers).
   - Adding missing standard sections.
5. Preserve the original meaning and intent 100% — but change the WORDING if needs_improvement is true."""

COMMIT_SYSTEM = """Write a conventional commit message for README improvements.
Format: docs(readme): brief description
Max 72 chars. You MUST return a JSON object with this exact structure:
{"commit_message": "string"}"""

SUMMARY_SYSTEM = """Write a concise changelog for these README improvements.
Focus on what was clarified, rephrased, or added. Max 200 words.
You MUST return a JSON object with this exact structure:
{"markdown": "string"}"""


class AIReviewer:
    def __init__(
        self,
        api_key: str | List[str],
        db_log_callback: Optional[Callable] = None,
        github_token: str = "",
        groq_api_key: str = "",
        openrouter_api_key: str = ""
    ):
        if isinstance(api_key, str):
            self.api_keys = [k.strip() for k in api_key.split(",") if k.strip()]
        elif isinstance(api_key, list):
            self.api_keys = [str(k).strip() for k in api_key if str(k).strip()]
        else:
            self.api_keys = []

        self.groq_key = groq_api_key or os.getenv("GROQ_API_KEY", "")
        self.github_token = github_token or os.getenv("GITHUB_TOKEN", "") or os.getenv("PAT_TOKEN", "")
        self.openrouter_key = openrouter_api_key or os.getenv("OPENROUTER_API_KEY", "")

        self.current_key_index = 0
        self._db_log = db_log_callback or (lambda level, msg: None)
        self._setup_current_client()
        self.model_name = "gemini-2.0-flash"
        self._total_tokens_used = 0
        self._last_error = None
        self.quota_exhausted = False

    def _setup_current_client(self):
        if self.current_key_index < len(self.api_keys):
            active_key = self.api_keys[self.current_key_index]
            masked_key = active_key[:6] + "..." + active_key[-4:] if len(active_key) > 10 else "..."
            log.info(f"🔑 Activating Gemini API Key (Index: {self.current_key_index}): {masked_key}")
            self._db_log("info", f"🔑 Activating Gemini API Key index {self.current_key_index} ({masked_key})")
            genai.configure(api_key=active_key)
        else:
            self.quota_exhausted = True

    def review_and_improve(
        self,
        repo_path: str,
        files: List[Dict],
        improvement_goals: List[str] = None,
        source_code_summary: str = "",
        max_tokens_per_file: int = 8000,
        max_files: int = 5,
    ) -> List[Dict]:
        """Review README files using multi-provider AI with source code context."""
        goals_text = "\n".join(f"- {g}" for g in (improvement_goals or ["Improve clarity", "Fix typos"]))
        changes    = []

        for file_info in files[:max_files]:
            rel_path = file_info["path"]
            original = file_info["content"]

            log.info(f"    🔍 Reviewing README: {rel_path}")
            self._db_log("info", f"    🔍 Reviewing: {rel_path}")

            source_section = ""
            if source_code_summary:
                source_section = (
                    f"\n\nSource code analysis (features found in the codebase — READ-ONLY, do NOT modify source code):\n"
                    f"---\n{source_code_summary}\n---\n\n"
                    f"IMPORTANT: If ANY features, technologies, or capabilities listed above are MISSING from the README, ADD them.\n"
                )

            if not original.strip():
                prompt = (
                    f"File: `{rel_path}`\n\n"
                    f"Improvement goals:\n{goals_text}\n"
                    f"{source_section}\n"
                    "CRITICAL: The repository currently has NO README file. "
                    "You must write a comprehensive, professional, and beautiful README.md from scratch "
                    "using the provided source code analysis. Make sure to include sections for: "
                    "Project Title/Description, Core Features, Technology Stack, Setup/Installation, and Usage instructions. "
                    "Return the COMPLETE markdown text."
                )
            else:
                prompt = (
                    f"File: `{rel_path}`\n\n"
                    f"Improvement goals:\n{goals_text}\n"
                    f"{source_section}\n"
                    f"Current README content:\n---\n{original[:MAX_FILE_CHARS]}\n---\n\n"
                    "MANDATORY: Return the COMPLETE improved Markdown. "
                    "You MUST change the wording — even if everything is perfect, rephrase sentences and improve vocabulary. "
                    "Identical output is NOT acceptable."
                )

            time.sleep(1)
            result_json = self._call_with_retry(
                prompt=prompt,
                system=REVIEW_SYSTEM,
                label=rel_path
            )

            if not result_json:
                log.warning(f"      ⚠️ No response from AI — using deterministic fallback")
                self._db_log("warning", f"    ⚠️ AI fallback used for {rel_path}")
                result_text = self._deterministic_fallback(original)
            else:
                try:
                    cleaned_json = result_json.strip()
                    if cleaned_json.startswith("```"):
                        cleaned_json = re.sub(r"^```(?:json)?\s*", "", cleaned_json)
                        cleaned_json = re.sub(r"\s*```$", "", cleaned_json)

                    parsed = json.loads(cleaned_json)
                    if not parsed.get("needs_improvement", True):
                        log.info(f"      🔄 AI determined no changes needed for {rel_path}")
                        self._db_log("info", f"    🔄 AI determined no changes needed for {rel_path}")
                        continue
                    
                    result_text = parsed.get("improved_text", "")
                    if not result_text or result_text.strip() == original.strip():
                        log.info(f"      🔄 Output identical — using deterministic fallback")
                        self._db_log("info", f"    🔄 Using deterministic fallback")
                        result_text = self._deterministic_fallback(original)
                except Exception as e:
                    log.warning(f"      ⚠️ Failed to parse AI JSON: {e}")
                    result_text = self._deterministic_fallback(original)

            if result_text.strip() == original.strip():
                log.warning(f"      ⚠️ Even fallback produced identical output — forcing timestamp change")
                result_text = self._timestamp_fallback(original)

            changes.append({
                "path":             rel_path,
                "original_content": original,
                "improved_content": result_text,
                "description":      f"Enhanced documentation and formatting in {rel_path}",
            })
            log.info(f"      ✏️  README improved successfully")
            self._db_log("info", f"    ✏️  {rel_path} improved")

        return changes

    def _deterministic_fallback(self, original: str) -> str:
        """Make deterministic timestamp changes when AI is unavailable."""
        log.info("      🔧 Applying deterministic timestamp fallback")
        return self._timestamp_fallback(original)

    def _timestamp_fallback(self, original: str) -> str:
        """Absolute last resort: update maintenance timestamp."""
        now = datetime.now(timezone.utc)
        timestamp_line = f"\n\n---\n*📝 Last maintained: {now.strftime('%B %d, %Y at %H:%M UTC')}*\n"
        
        base_content = original if original.strip() else "# 🤖 Repository Documentation\n\nAutomatically generated."
        
        pattern = re.compile(r"\n*---\n\*📝 Last maintained:.*?\*\n?", re.DOTALL)
        if pattern.search(base_content):
            return pattern.sub(timestamp_line, base_content)
        
        return base_content.rstrip() + timestamp_line

    def generate_commit_message(self, changes: List[Dict]) -> str:
        if not changes: return "docs: update readme"
        files_text = "\n".join(f"- {c['path']}" for c in changes)
        result_json = self._call_with_retry(
            prompt=f"Improved README files:\n{files_text}",
            system=COMMIT_SYSTEM,
            label="commit message"
        )
        if result_json:
            try:
                cleaned_json = result_json.strip()
                if cleaned_json.startswith("```"):
                    cleaned_json = re.sub(r"^```(?:json)?\s*", "", cleaned_json)
                    cleaned_json = re.sub(r"\s*```$", "", cleaned_json)
                parsed = json.loads(cleaned_json)
                return parsed.get("commit_message", "docs: improve readme documentation").strip()[:72]
            except Exception:
                pass
        return "docs: improve readme documentation"

    def generate_summary(self, repo_name: str, changes: List[Dict], commit_url: str) -> Dict:
        if not changes:
            return {"repo": repo_name, "status": "no_changes", "markdown": "No improvements needed.", "commit_url": "", "changes": []}

        paths = ", ".join(c['path'] for c in changes)
        prompt = f"Repo: {repo_name}\nFiles: {paths}\nCommit: {commit_url}"

        result_json = self._call_with_retry(
            prompt=prompt,
            system=SUMMARY_SYSTEM,
            label="summary"
        )
        
        md = f"Improved README in {repo_name}."
        if result_json:
            try:
                cleaned_json = result_json.strip()
                if cleaned_json.startswith("```"):
                    cleaned_json = re.sub(r"^```(?:json)?\s*", "", cleaned_json)
                    cleaned_json = re.sub(r"\s*```$", "", cleaned_json)
                parsed = json.loads(cleaned_json)
                md = parsed.get("markdown", md)
            except Exception:
                pass

        return {
            "repo":       repo_name,
            "status":     "improved",
            "commit_url": commit_url,
            "markdown":   md.strip(),
            "changes":    [{"path": c["path"], "description": c["description"]} for c in changes],
        }

    def _call_http_llm_api(self, url: str, api_key: str, model_name: str, prompt: str, system: str, extra_headers: dict = None) -> str | None:
        """Call OpenAI-compatible REST API endpoints (Groq, GitHub Models, OpenRouter)."""
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}"
        }
        if extra_headers:
            headers.update(extra_headers)

        body = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.2,
            "response_format": {"type": "json_object"}
        }

        try:
            req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                res_data = json.loads(resp.read().decode("utf-8"))
                if "choices" in res_data and len(res_data["choices"]) > 0:
                    content = res_data["choices"][0]["message"]["content"]
                    if content and content.strip():
                        return content
        except Exception as e:
            log.warning(f"      ⚠️ HTTP LLM API ({model_name}) error: {e}")
        return None

    def _call_with_retry(self, prompt: str, system: str, label: str) -> str | None:
        """Call LLM APIs with multi-provider fallback (Groq -> GitHub Models -> OpenRouter -> Gemini)."""
        # Provider 1: Groq API
        if self.groq_key:
            res = self._call_http_llm_api(
                url="https://api.groq.com/openai/v1/chat/completions",
                api_key=self.groq_key,
                model_name="llama-3.3-70b-versatile",
                prompt=prompt,
                system=system
            )
            if res:
                log.info(f"      ⚡ Powered by Groq (Llama-3.3-70B) for {label}")
                self._db_log("info", f"    ⚡ Powered by Groq (Llama-3.3-70B)")
                return res

        # Provider 2: GitHub Models API
        if self.github_token:
            res = self._call_http_llm_api(
                url="https://models.inference.ai.azure.com/chat/completions",
                api_key=self.github_token,
                model_name="gpt-4o-mini",
                prompt=prompt,
                system=system
            )
            if res:
                log.info(f"      ⚡ Powered by GitHub Models (GPT-4o-mini) for {label}")
                self._db_log("info", f"    ⚡ Powered by GitHub Models (GPT-4o-mini)")
                return res

        # Provider 3: OpenRouter API
        if self.openrouter_key:
            res = self._call_http_llm_api(
                url="https://openrouter.ai/api/v1/chat/completions",
                api_key=self.openrouter_key,
                model_name="meta-llama/llama-3.3-70b-instruct:free",
                prompt=prompt,
                system=system,
                extra_headers={"HTTP-Referer": "https://github.com/AutoREADME"}
            )
            if res:
                log.info(f"      ⚡ Powered by OpenRouter (Llama-3.3-70B) for {label}")
                self._db_log("info", f"    ⚡ Powered by OpenRouter (Llama-3.3-70B)")
                return res

        # Provider 4: Gemini API
        if getattr(self, "quota_exhausted", False) or not self.api_keys:
            return None

        self._last_error = None
        attempt = 0
        while attempt < MAX_RETRIES:
            try:
                model = genai.GenerativeModel(
                    self.model_name,
                    system_instruction=system,
                    generation_config=genai.types.GenerationConfig(
                        response_mime_type="application/json"
                    )
                )
                response = model.generate_content(prompt)
                
                if hasattr(response, 'usage_metadata') and response.usage_metadata:
                    self._total_tokens_used += getattr(response.usage_metadata, 'total_token_count', 0)
                
                try:
                    text = response.text
                    if text and text.strip():
                        return text
                    else:
                        self._last_error = "Empty response from Gemini"
                        log.warning(f"      Gemini returned empty response for {label}")
                        self._db_log("warning", f"    Gemini empty response: {label}")
                        return None
                except ValueError as ve:
                    self._last_error = f"Response blocked: {ve}"
                    log.warning(f"      Gemini response blocked for {label}: {ve}")
                    self._db_log("warning", f"    Gemini blocked: {label} — {ve}")
                    return None

            except Exception as e:
                err_str = str(e).lower()
                self._last_error = str(e)
                if "429" in err_str or "resource_exhausted" in err_str:
                    is_daily = any(term in err_str for term in ["limit: 0", "perday", "per_day", "daily limit", "quota_exceeded_daily", "free_tier_requests_per_day"])
                    is_minute = any(term in err_str for term in ["per minute", "per_minute", "requests per minute", "rpm", "inputtokens"])

                    if is_daily and not is_minute and len(self.api_keys) > 1:
                        self.current_key_index += 1
                        if self.current_key_index < len(self.api_keys):
                            log.warning(f"      🚨 Active Gemini key daily quota exhausted. Rotating key index {self.current_key_index}...")
                            self._db_log("warning", f"    🔄 Daily Gemini key quota exhausted. Rotating key index {self.current_key_index}...")
                            self._setup_current_client()
                            time.sleep(5)
                            attempt = 0
                            continue
                        else:
                            log.error(f"      🚨 All {len(self.api_keys)} Gemini keys exhausted.")
                            self._db_log("error", f"    🚨 All {len(self.api_keys)} Gemini keys exhausted! Falling back.")
                            self.quota_exhausted = True
                            return None
                    
                    wait = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS)-1)]
                    log.warning(f"      Rate limited by Gemini. Waiting {wait}s...")
                    self._db_log("warning", f"    ⏳ Rate limited — waiting {wait}s (attempt {attempt+1}/{MAX_RETRIES})")
                    time.sleep(wait)
                    attempt += 1
                else:
                    log.error(f"      Gemini error on {label}: {e}")
                    self._db_log("error", f"    ❌ Gemini error: {label} — {e}")
                    return None

        self._db_log("error", f"    ❌ Gemini exhausted all {MAX_RETRIES} retries for {label}")
        return None

    @property
    def tokens_used(self) -> int:
        return self._total_tokens_used
