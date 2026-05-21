def assemble_brief(
    date_str: str,
    parsed_tasks: dict,
    parsed_goals: dict,
    all_tactical_rules: list,
    all_emotional_rules: list,
    all_hobby_tasks: list,
    all_technical_tasks: list,
    yesterday_wins: list,
    llm_output: dict | None,
    config: dict,
) -> dict:
    fields = config["fields"]

    if fields["tactical_rules"]["mode"] == "llm" and llm_output:
        tactical_rules = llm_output["tactical_rules"]
    else:
        count = fields["tactical_rules"].get("count", 4)
        tactical_rules = all_tactical_rules[:count]

    if fields["identity_rules"]["mode"] == "llm" and llm_output:
        identity_rules = llm_output["identity_rules"]
    else:
        count = fields["identity_rules"].get("count", 3)
        identity_rules = all_emotional_rules[:count]

    if fields["goals"]["mode"] == "llm" and llm_output:
        goals = llm_output["goals"]
    else:
        goals = parsed_goals

    if fields["hobby_tasks"]["mode"] == "llm" and llm_output:
        hobby_tasks = llm_output["hobby_tasks"]
    else:
        count = fields["hobby_tasks"].get("count", 3)
        hobby_tasks = all_hobby_tasks[:count]

    if fields["suggestion"]["mode"] == "llm" and llm_output:
        suggestion = llm_output.get("suggestions", [])
    else:
        suggestion = []

    wins = yesterday_wins

    return {
        "date": date_str,
        "identity": {"rules": identity_rules},
        "goals": goals,
        "tasks": parsed_tasks,
        "tactical_rules": tactical_rules,
        "technical_tasks": all_technical_tasks[:config["fields"].get("technical_tasks", {}).get("count", 5)],
        "hobby_tasks": hobby_tasks,
        "suggestions": suggestion,
        "wins": wins,
    }
