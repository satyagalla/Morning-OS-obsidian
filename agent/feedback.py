import json
from pathlib import Path
from datetime import date, timedelta

from .carry_detector import _fuzzy_match


def compute_feedback(today_tasks: dict, config: dict) -> dict | None:
    vault_path = Path(config["vault_path"])
    output_dir = vault_path / config["output_dir"]
    feedback_dir = vault_path / config["feedback_dir"]

    yesterday = (date.today() - timedelta(days=1)).isoformat()
    yesterday_brief_path = output_dir / f"{yesterday}.json"

    if not yesterday_brief_path.exists():
        return None

    yesterday_brief = json.loads(yesterday_brief_path.read_text(encoding="utf-8"))

    today_all_texts = [
        t["text"] if isinstance(t, dict) else t
        for cat in ("red_alert", "regular")
        for t in today_tasks.get(cat, [])
    ]

    yesterday_all_tasks = (
        yesterday_brief.get("tasks", {}).get("red_alert", [])
        + yesterday_brief.get("tasks", {}).get("regular", [])
    )

    resolved = []
    still_open = []
    days_carried = {}

    for task in yesterday_all_tasks:
        task_text = task["text"]
        still_present = any(_fuzzy_match(task_text, t) for t in today_all_texts)
        if still_present:
            still_open.append(task_text)
        else:
            resolved.append(task_text)
            if task.get("carried_from"):
                days = (date.today() - date.fromisoformat(task["carried_from"])).days
                days_carried[task_text] = days

    suggestion = yesterday_brief.get("suggestion")
    suggestion_resolved = None
    if suggestion and suggestion.get("text"):
        suggestion_resolved = any(
            _fuzzy_match(r, word)
            for r in resolved
            for word in suggestion["text"].split("'") if len(word) > 10
        )

    reactions_dir = feedback_dir / "reactions"
    reaction_file = reactions_dir / f"{yesterday}.json"
    user_reaction = None
    if reaction_file.exists():
        user_reaction = json.loads(reaction_file.read_text(encoding="utf-8"))

    feedback = {
        "date": yesterday,
        "picks": {
            "tactical_rules_shown": yesterday_brief.get("tactical_rules", []),
            "identity_rules_shown": yesterday_brief.get("identity", {}).get("rules", []),
            "hobby_tasks_shown": yesterday_brief.get("hobby_tasks", []),
            "suggestion": suggestion,
        },
        "outcomes": {
            "suggestion_task_resolved": suggestion_resolved,
            "carried_tasks_resolved": resolved,
            "carried_tasks_still_open": still_open,
            "days_carried_before_resolve": days_carried,
            "new_tasks_added": len(today_all_texts) - len(still_open),
        },
        "user_reaction": user_reaction,
    }

    feedback_dir.mkdir(parents=True, exist_ok=True)
    feedback_path = feedback_dir / f"{yesterday}.json"
    feedback_path.write_text(json.dumps(feedback, indent=2), encoding="utf-8")

    return feedback
