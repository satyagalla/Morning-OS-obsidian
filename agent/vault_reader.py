import json
import re
import logging
from pathlib import Path

from .prompts import FALLBACK_SYSTEM, FALLBACK_DAILY_NOTE, FALLBACK_GOALS, FALLBACK_BULLETS

logger = logging.getLogger(__name__)

WINS_VARIANTS = ["Wins", "I feel good about these after today"]


def _read_file(path: Path) -> str | None:
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _is_header(line: str, name: str) -> bool:
    stripped = line.strip().rstrip(":")
    lower = stripped.lower()
    target = name.lower()
    return (
        lower == target
        or lower == f"# {target}"
        or lower == f"## {target}"
        or lower == f"### {target}"
    )


def _extract_section(content: str, header_name: str, variants: list[str] | None = None) -> list[str]:
    lines = content.split("\n")
    names_to_check = [header_name] + (variants or [])

    start_idx = None
    for i, line in enumerate(lines):
        for name in names_to_check:
            if _is_header(line, name):
                start_idx = i + 1
                break
        if start_idx is not None:
            break

    if start_idx is None:
        return []

    items = []
    for line in lines[start_idx:]:
        stripped = line.strip()
        if stripped and (stripped.startswith("#") or _is_any_header(stripped)):
            break
        item = _parse_bullet(stripped)
        if item is not None:
            items.append(item)

    return items


def _is_any_header(line: str) -> bool:
    if re.match(r"^#{1,3}\s+", line):
        return True
    if line and not line.startswith("-") and line.endswith(":") and len(line) < 50:
        return True
    return False


def _parse_bullet(line: str) -> str | None:
    if not line:
        return None

    match = re.match(r"^-\s*\[.\]\s*(.*)", line)
    if not match:
        match = re.match(r"^-\s+(.*)", line)
    if not match:
        return None

    text = match.group(1).strip()
    if not text:
        return None

    if text.startswith("~~") and text.endswith("~~"):
        return None

    return text


def _parse_all_bullets(content: str) -> list[str]:
    items = []
    for line in content.split("\n"):
        item = _parse_bullet(line.strip())
        if item is not None:
            items.append(item)
    return items


def parse_daily_note(date_str: str, config: dict, llm_client) -> dict | None:
    vault_path = Path(config["vault_path"])
    source_pattern = config["sources"]["daily_note"]
    note_path = vault_path / source_pattern.format(date=date_str)

    content = _read_file(note_path)
    if content is None:
        return None

    sections = config["daily_note_sections"]

    red_alert = _extract_section(content, sections["red_alert"])
    regular = _extract_section(content, sections["regular"])
    wins = _extract_section(content, sections["wins"], variants=WINS_VARIANTS)

    if not red_alert and not regular and len(content.split("\n")) > 5:
        logger.info("Daily note parser found no tasks, falling back to LLM")
        try:
            prompt = FALLBACK_DAILY_NOTE.format(content=content)
            raw = llm_client.call_fallback(FALLBACK_SYSTEM, prompt)
            parsed = json.loads(raw)
            red_alert = parsed.get("red_alert", [])
            regular = parsed.get("regular", [])
            wins = parsed.get("wins", [])
        except Exception as e:
            logger.error(f"LLM fallback for daily note failed: {e}")

    return {"red_alert": red_alert, "regular": regular, "wins": wins}


def parse_yesterday_wins(today_str: str, config: dict, llm_client) -> list[str]:
    from datetime import date, timedelta
    today = date.fromisoformat(today_str)
    yesterday = (today - timedelta(days=1)).isoformat()

    vault_path = Path(config["vault_path"])
    source_pattern = config["sources"]["daily_note"]
    note_path = vault_path / source_pattern.format(date=yesterday)

    content = _read_file(note_path)
    if content is None:
        return []

    sections = config["daily_note_sections"]
    wins = _extract_section(content, sections["wins"], variants=WINS_VARIANTS)
    return wins


def parse_bullet_file(source_key: str, config: dict) -> list[str]:
    vault_path = Path(config["vault_path"])
    source_path = vault_path / config["sources"][source_key]

    content = _read_file(source_path)
    if content is None:
        return []

    return _parse_all_bullets(content)


def parse_goals(config: dict, llm_client) -> dict:
    vault_path = Path(config["vault_path"])
    source_path = vault_path / config["sources"]["goals"]

    content = _read_file(source_path)
    if content is None:
        return {"short_term": [], "long_term": []}

    sections = config["goals_sections"]
    short_term = _extract_section(content, sections["short_term"])
    long_term = _extract_section(content, sections["long_term"])

    if not short_term and not long_term and len(content.split("\n")) > 3:
        logger.info("Goals parser found nothing, falling back to LLM")
        try:
            prompt = FALLBACK_GOALS.format(content=content)
            raw = llm_client.call_fallback(FALLBACK_SYSTEM, prompt)
            parsed = json.loads(raw)
            short_term = parsed.get("short_term", [])
            long_term = parsed.get("long_term", [])
        except Exception as e:
            logger.error(f"LLM fallback for goals failed: {e}")

    return {"short_term": short_term, "long_term": long_term}
