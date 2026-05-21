"""Loads vault_config.yaml and .env into a single config dict used throughout the agent."""
import os
from pathlib import Path
import yaml
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).parent.parent
AGENT_DIR = Path(__file__).parent

load_dotenv(PROJECT_ROOT / ".env")


def load_config() -> dict:
    with open(AGENT_DIR / "vault_config.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)
