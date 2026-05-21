"""Detects carried-over tasks by fuzzy-matching today's tasks against yesterday's brief.
`carried_from` is chain-propagated — it always points to the first day a task appeared,
not just yesterday.
"""
import json
from pathlib import Path
from datetime import date, timedelta
from difflib import SequenceMatcher

MATCH_THRESHOLD = 0.8


def _normalize(text: str) -> str:
    return text.lower().strip().rstrip(".")


def _fuzzy_match(a: str, b: str) -> bool:
    return SequenceMatcher(None, _normalize(a), _normalize(b)).ratio() >= MATCH_THRESHOLD


def detect_carries(today_tasks: dict, config: dict) -> dict:
    vault_path = Path(config["vault_path"])
    output_dir = vault_path / config["output_dir"]

    yesterday = (date.today() - timedelta(days=1)).isoformat()
    yesterday_brief_path = output_dir / f"{yesterday}.json"

    yesterday_tasks = []
    if yesterday_brief_path.exists():
        brief = json.loads(yesterday_brief_path.read_text(encoding="utf-8"))
        yesterday_tasks = (
            brief.get("tasks", {}).get("red_alert", [])
            + brief.get("tasks", {}).get("regular", [])
        )

    result = {}
    for category in ("red_alert", "regular"):
        result[category] = []
        for task_text in today_tasks.get(category, []):
            carried_from = None
            for prev_task in yesterday_tasks:
                if _fuzzy_match(task_text, prev_task["text"]):
                    carried_from = prev_task["carried_from"] or yesterday
                    break
            result[category].append({"text": task_text, "carried_from": carried_from})

    return result
