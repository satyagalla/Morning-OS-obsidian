import json
import logging
import re
from datetime import date
from pathlib import Path

from .config import load_config
from .llm import LLMClient
from .vault_reader import parse_daily_note, parse_yesterday_wins, parse_bullet_file, parse_goals
from .carry_detector import detect_carries
from .assembler import assemble_brief
from .feedback import compute_feedback
from .prompts import INTELLIGENCE_SYSTEM, INTELLIGENCE_USER

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(Path(__file__).parent / "agent.log"),
    ],
)
logger = logging.getLogger(__name__)


def _parse_json_response(raw: str) -> dict:
    text = raw.strip()
    match = re.search(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
    if match:
        text = match.group(1)
    return json.loads(text)


def run():
    config = load_config()
    vault_path = Path(config["vault_path"])
    output_dir = vault_path / config["output_dir"]
    today_str = date.today().isoformat()

    logger.info(f"Starting briefing agent for {today_str}")

    llm_client = LLMClient(config)

    daily_data = parse_daily_note(today_str, config, llm_client)
    if daily_data is None:
        logger.warning(f"No daily note found for {today_str}. Skipping.")
        return

    tactical_rules = parse_bullet_file("tactical_rules", config)
    emotional_rules = parse_bullet_file("emotional_rules", config)
    technical_tasks = parse_bullet_file("technical_tasks", config)
    hobby_tasks_raw = parse_bullet_file("hobby_tasks", config)
    goals = parse_goals(config, llm_client)
    yesterday_wins = parse_yesterday_wins(today_str, config, llm_client)

    tasks_with_carry = detect_carries(
        {"red_alert": daily_data["red_alert"], "regular": daily_data["regular"]},
        config,
    )

    compute_feedback(
        {"red_alert": daily_data["red_alert"], "regular": daily_data["regular"]},
        config,
    )

    fields = config["fields"]
    needs_llm = any(
        fields[f]["mode"] == "llm"
        for f in ("tactical_rules", "identity_rules", "goals", "hobby_tasks", "suggestion")
    )

    llm_output = None
    if needs_llm:
        carried = [
            f"- {t['text']} (carried since {t['carried_from']})"
            for cat in ("red_alert", "regular")
            for t in tasks_with_carry[cat]
            if t["carried_from"]
        ]

        prompt = INTELLIGENCE_USER.format(
            red_alert_tasks="\n".join(f"- {t['text']}" for t in tasks_with_carry["red_alert"]),
            regular_tasks="\n".join(f"- {t['text']}" for t in tasks_with_carry["regular"]),
            carried_summary="\n".join(carried) if carried else "None",
            tactical_rules="\n".join(f"- {r}" for r in tactical_rules),
            emotional_rules="\n".join(f"- {r}" for r in emotional_rules),
            short_term_goals="\n".join(f"- {g}" for g in goals["short_term"]),
            long_term_goals="\n".join(f"- {g}" for g in goals["long_term"]),
            technical_tasks="\n".join(f"- {t}" for t in technical_tasks[:15]),
            hobby_tasks="\n".join(f"- {t}" for t in hobby_tasks_raw) if hobby_tasks_raw else "None",
            yesterday_wins="\n".join(f"- {w}" for w in yesterday_wins) if yesterday_wins else "None",
        )

        try:
            raw_response = llm_client.call_intelligence(INTELLIGENCE_SYSTEM, prompt)
            llm_output = _parse_json_response(raw_response)
            logger.info("Intelligence LLM call succeeded")
        except Exception as e:
            logger.error(f"Intelligence LLM failed: {e}. Retrying once...")
            try:
                raw_response = llm_client.call_intelligence(INTELLIGENCE_SYSTEM, prompt)
                llm_output = _parse_json_response(raw_response)
            except Exception as e2:
                logger.error(f"Retry failed: {e2}. Falling back to direct mode.")
                llm_output = None

    brief = assemble_brief(
        date_str=today_str,
        parsed_tasks=tasks_with_carry,
        parsed_goals=goals,
        all_tactical_rules=tactical_rules,
        all_emotional_rules=emotional_rules,
        all_hobby_tasks=hobby_tasks_raw,
        all_technical_tasks=technical_tasks,
        yesterday_wins=yesterday_wins,
        llm_output=llm_output,
        config=config,
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{today_str}.json"
    output_path.write_text(json.dumps(brief, indent=2), encoding="utf-8")

    logger.info(f"Brief written to {output_path}")


if __name__ == "__main__":
    run()
