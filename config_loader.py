"""
ConfigLoader — Utility for loading YAML configuration.
Merges config.yaml values with environment variables (environment variables take precedence).
"""

import yaml
import os
import logging

log = logging.getLogger(__name__)

def load_config(path: str = "config.yaml") -> dict:
    """Load configuration from a YAML file with environment variable overrides."""
    if not os.path.exists(path):
        log.error(f"Config file not found: {path}")
        raise FileNotFoundError(f"Config file not found: {path}")

    try:
        with open(path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)
    except Exception as e:
        log.error(f"Failed to parse config file: {e}")
        raise e

    if config is None:
        config = {}
    
    if "repos" not in config or not isinstance(config["repos"], list):
        config["repos"] = []
    
    # Merge environment variables (overrides values in config.yaml)
    _env_override(config, "gemini_api_key",     "GEMINI_API_KEY")
    _env_override(config, "groq_api_key",       "GROQ_API_KEY")
    _env_override(config, "openrouter_api_key", "OPENROUTER_API_KEY")
    _env_override(config, "github_token",       "GITHUB_TOKEN")
    _env_override(config, "github_username",    "GITHUB_USERNAME")
    _env_override(config, "supabase_url",       "SUPABASE_URL")
    _env_override(config, "supabase_key",       "SUPABASE_KEY")

    return config


def _env_override(config: dict, yaml_key: str, env_key: str):
    """Override YAML configuration with environment variable if present."""
    env_val = os.getenv(env_key, "").strip()
    if env_val:
        config[yaml_key] = env_val
