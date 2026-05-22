"""Loads config from two sources:
- vault_config.yaml (repo): only vault_path — the one-time bootstrap value.
- data.json (vault): all other settings, written by the Obsidian plugin Settings tab.
Credentials are injected into os.environ so existing providers need no changes.
"""
import json
import os
from pathlib import Path
import yaml

AGENT_DIR = Path(__file__).parent
PROJECT_ROOT = AGENT_DIR.parent


def load_config() -> dict:
    with open(AGENT_DIR / "vault_config.yaml", encoding="utf-8") as f:
        bootstrap = yaml.safe_load(f)

    vault_path = Path(bootstrap["vault_path"])
    data_json = vault_path / ".obsidian" / "plugins" / "morning-os" / "data.json"

    if not data_json.exists():
        raise FileNotFoundError(
            f"Plugin settings not found at {data_json}.\n"
            "Open Obsidian → Settings → Morning OS and configure the plugin first."
        )

    with open(data_json, encoding="utf-8") as f:
        s = json.load(f)

    _inject_credentials(s)

    return {
        "vault_path": str(vault_path),
        "output_dir": s.get("briefsDir", "_generated/briefs"),
        "feedback_dir": s.get("feedbackDir", "_generated/feedback"),
        "llm": {
            "intelligence": _llm_slot(s, "intelligence"),
            "fallback": _llm_slot(s, "fallback"),
        },
        "fields": {
            "tactical_rules": {"mode": _mode(s, "modeTacticalRules", True),  "count": s.get("tacticalRulesCount", 4)},
            "identity_rules": {"mode": _mode(s, "modeIdentityRules", False), "count": s.get("identityRulesCount", 3)},
            "goals": {
                "mode": _mode(s, "modeGoals", True),
                "short_term_count": s.get("goalsShortTermCount", 2),
                "long_term_count":  s.get("goalsLongTermCount", 1),
            },
            "hobby_tasks":     {"mode": _mode(s, "modeHobbyTasks",     True),  "count": s.get("hobbyTasksCount", 3)},
            "suggestion":      {"mode": _mode(s, "modeSuggestion",     True),  "count": s.get("suggestionCount", 3)},
            "technical_tasks": {"mode": _mode(s, "modeTechnicalTasks", False), "count": s.get("technicalTasksCount", 5)},
            "tasks":           {"mode": _mode(s, "modeTasks",          False)},
            "wins":            {"mode": _mode(s, "modeWins",           False)},
        },
        "sources": {
            "daily_note":      s.get("dailyNoteDir", "Essential/Daily") + "/{date}.md",
            "tactical_rules":  s.get("sourceTacticalRules", "Essential/State of Mind/Tactical Rules.md"),
            "emotional_rules": s.get("sourceEmotionalRules", "Essential/State of Mind/Emotional Rules.md"),
            "goals":           s.get("sourceGoals", "Essential/State of Mind/Long-term and Short-term.md"),
            "technical_tasks": s.get("sourceTechnicalTasks", "Essential/Pending Tasks/Technical Tasks.md"),
            "hobby_tasks":     s.get("sourceHobbyTasks", "Essential/Pending Tasks/Hobby Tasks.md"),
        },
        "daily_note_sections": {
            "red_alert": s.get("sectionRedAlert", "Red alert"),
            "regular":   s.get("sectionRegular", "Regular"),
            "thoughts":  s.get("sectionThoughts", "Thoughts"),
            "pending":   s.get("sectionPending", "Top 3 pending"),
            "wins":      s.get("sectionWins", "Wins"),
        },
        "goals_sections": {
            "short_term": s.get("goalsShortTerm", "Short Term"),
            "long_term":  s.get("goalsLongTerm", "Long Term"),
        },
    }


def _mode(s: dict, key: str, default: bool) -> str:
    return "llm" if s.get(key, default) else "direct"


def _llm_slot(s: dict, slot: str) -> dict:
    provider = s.get(f"{slot}Provider", "ollama")
    cfg = {"provider": provider, "model": s.get(f"{slot}Model", "")}
    if provider == "bedrock":
        cfg["region"] = s.get("awsRegion", "us-east-2")
    if provider == "ollama":
        cfg["base_url"] = s.get(f"{slot}BaseUrl", "http://localhost:11434")
    return cfg


def _inject_credentials(s: dict) -> None:
    if s.get("awsAccessKeyId"):
        os.environ["AWS_ACCESS_KEY_ID"] = s["awsAccessKeyId"]
    if s.get("awsSecretAccessKey"):
        os.environ["AWS_SECRET_ACCESS_KEY"] = s["awsSecretAccessKey"]
    if s.get("awsRegion"):
        os.environ["AWS_DEFAULT_REGION"] = s["awsRegion"]
    if s.get("openaiApiKey"):
        os.environ["OPENAI_API_KEY"] = s["openaiApiKey"]
    if s.get("geminiApiKey"):
        os.environ["GEMINI_API_KEY"] = s["geminiApiKey"]
    if s.get("groqApiKey"):
        os.environ["GROQ_API_KEY"] = s["groqApiKey"]
