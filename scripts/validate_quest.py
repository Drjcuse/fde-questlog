#!/usr/bin/env python3
"""Validate data/quest-data.json, data/state.json and data/srs-queue.json.

Usage:
    python3 scripts/validate_quest.py [--data DIR]

Exits 0 when all three files are valid, 1 otherwise. Standard library only.
Run in CI before a claude/quest-* branch is merged, and by the nightly task
before it commits.
"""
import argparse
import json
import re
import sys
from pathlib import Path

TREES = ("python", "aws", "wargames")
TIER_XP = {"quick": 50, "standard": 150, "double": 325}
TIER_MINUTES = {"quick": 15, "standard": 45, "double": 90}
SRS_INTERVALS = (1, 3, 7, 21)
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
INTEL_BULLETS_MIN = 3
INTEL_BULLETS_MAX = 5
RESTED_STACK_MAX = 2
TOTAL_DAYS = 21


def is_text(value):
    return isinstance(value, str) and value.strip() != ""


def is_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def is_date(value):
    return isinstance(value, str) and ISO_DATE.match(value) is not None


def check_quest_item(quest, where, errors):
    if not isinstance(quest, dict):
        errors.append(f"{where}: quest must be an object")
        return
    for key in ("id", "title", "brief", "done_condition"):
        if not is_text(quest.get(key)):
            errors.append(f"{where}: missing or empty '{key}'")
    if quest.get("tree") not in TREES:
        errors.append(f"{where}: 'tree' must be one of {TREES}")
    if not is_count(quest.get("minutes")) or quest.get("minutes") == 0:
        errors.append(f"{where}: 'minutes' must be a positive integer")
    tasks = quest.get("tasks")
    if not isinstance(tasks, list) or not tasks or not all(is_text(t) for t in tasks):
        errors.append(f"{where}: 'tasks' must be a non-empty list of strings")
    if "code" in quest and not is_text(quest["code"]):
        errors.append(f"{where}: 'code' must be a non-empty string when present")
    if "answer_key" in quest:
        key = quest["answer_key"]
        if not isinstance(key, list) or not key or not all(is_text(a) for a in key):
            errors.append(f"{where}: 'answer_key' must be a non-empty list of strings when present")


def check_quest(data, errors):
    if not isinstance(data, dict):
        errors.append("quest-data: top level must be an object")
        return
    if not is_date(data.get("date")):
        errors.append("quest-data: 'date' must be YYYY-MM-DD")
    day = data.get("day")
    if not is_count(day) or not 1 <= day <= TOTAL_DAYS:
        errors.append(f"quest-data: 'day' must be an integer 1..{TOTAL_DAYS}")
    headline = data.get("headline")
    if not isinstance(headline, dict) or not is_text(headline.get("quick")) or not is_text(headline.get("dungeon")):
        errors.append("quest-data: 'headline.quick' and 'headline.dungeon' are required")

    intel = data.get("intel")
    if not isinstance(intel, dict):
        errors.append("quest-data: 'intel' is required")
    else:
        if not is_text(intel.get("title")) or not is_text(intel.get("why")):
            errors.append("quest-data: intel needs 'title' and 'why'")
        bullets = intel.get("bullets")
        if (not isinstance(bullets, list)
                or not INTEL_BULLETS_MIN <= len(bullets) <= INTEL_BULLETS_MAX
                or not all(is_text(b) for b in bullets)):
            errors.append(f"quest-data: intel.bullets must hold {INTEL_BULLETS_MIN}-{INTEL_BULLETS_MAX} strings")
        source = intel.get("source")
        if (not isinstance(source, dict) or not is_text(source.get("title"))
                or not is_text(source.get("url")) or not source["url"].startswith("https://")):
            errors.append("quest-data: intel.source needs 'title' and an https 'url'")
        question = intel.get("question")
        if not isinstance(question, dict) or not all(is_text(question.get(k)) for k in ("id", "q", "a")):
            errors.append("quest-data: intel.question needs 'id', 'q' and 'a'")

    tiers = data.get("tiers")
    if not isinstance(tiers, dict):
        errors.append("quest-data: 'tiers' is required")
        return
    seen_ids = set()
    for name, expected_xp in TIER_XP.items():
        tier = tiers.get(name)
        if not isinstance(tier, dict):
            errors.append(f"quest-data: tier '{name}' is missing")
            continue
        if tier.get("xp") != expected_xp:
            errors.append(f"quest-data: tiers.{name}.xp must be {expected_xp}")
        if tier.get("minutes") != TIER_MINUTES[name]:
            errors.append(f"quest-data: tiers.{name}.minutes must be {TIER_MINUTES[name]}")
        tree_xp = tier.get("tree_xp")
        if (not isinstance(tree_xp, dict) or not tree_xp
                or any(k not in TREES for k in tree_xp)
                or not all(is_count(v) for v in tree_xp.values())
                or sum(tree_xp.values()) != expected_xp):
            errors.append(f"quest-data: tiers.{name}.tree_xp must use {TREES} and sum to {expected_xp}")
        quests = tier.get("quests")
        if not isinstance(quests, list) or not quests:
            errors.append(f"quest-data: tiers.{name}.quests must be a non-empty list")
            continue
        for index, quest in enumerate(quests):
            check_quest_item(quest, f"quest-data: tiers.{name}.quests[{index}]", errors)
            quest_id = quest.get("id") if isinstance(quest, dict) else None
            if quest_id in seen_ids:
                errors.append(f"quest-data: duplicate quest id '{quest_id}'")
            seen_ids.add(quest_id)


def check_state(data, errors):
    if not isinstance(data, dict):
        errors.append("state: top level must be an object")
        return
    for key in ("owner", "repo"):
        if not is_text(data.get(key)):
            errors.append(f"state: '{key}' is required")
    for key in ("start_date", "target_date"):
        if not is_date(data.get(key)):
            errors.append(f"state: '{key}' must be YYYY-MM-DD")
    for key in ("total_xp", "missed_days", "days_checked_in", "rested_stack"):
        if not is_count(data.get(key)):
            errors.append(f"state: '{key}' must be a non-negative integer")
    if is_count(data.get("rested_stack")) and data["rested_stack"] > RESTED_STACK_MAX:
        errors.append(f"state: 'rested_stack' must be 0..{RESTED_STACK_MAX}")
    if not isinstance(data.get("rested_xp_active"), bool):
        errors.append("state: 'rested_xp_active' must be true or false")
    elif is_count(data.get("rested_stack")) and data["rested_xp_active"] != (data["rested_stack"] > 0):
        errors.append("state: 'rested_xp_active' must be true exactly when rested_stack > 0")
    last = data.get("last_checkin")
    if last is not None and not is_date(last):
        errors.append("state: 'last_checkin' must be null or YYYY-MM-DD")
    trees = data.get("trees")
    if not isinstance(trees, dict) or set(trees) != set(TREES):
        errors.append(f"state: 'trees' must have exactly {TREES}")
    elif not all(isinstance(trees[t], dict) and is_count(trees[t].get("xp")) for t in TREES):
        errors.append("state: each tree needs a non-negative integer 'xp'")
    for key in ("titles", "aws_weak_domains", "stuck_on", "history"):
        if not isinstance(data.get(key), list):
            errors.append(f"state: '{key}' must be a list")


def check_queue(data, errors):
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        errors.append("srs-queue: 'items' list is required")
        return
    seen_ids = set()
    for index, item in enumerate(data["items"]):
        where = f"srs-queue: items[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{where}: must be an object")
            continue
        for key in ("id", "q", "a"):
            if not is_text(item.get(key)):
                errors.append(f"{where}: missing or empty '{key}'")
        if item.get("tree") not in TREES:
            errors.append(f"{where}: 'tree' must be one of {TREES}")
        if item.get("interval_days") not in SRS_INTERVALS:
            errors.append(f"{where}: 'interval_days' must be one of {SRS_INTERVALS}")
        if not is_date(item.get("due_date")):
            errors.append(f"{where}: 'due_date' must be YYYY-MM-DD")
        if item.get("id") in seen_ids:
            errors.append(f"{where}: duplicate id '{item.get('id')}'")
        seen_ids.add(item.get("id"))


CHECKS = (
    ("quest-data.json", check_quest),
    ("state.json", check_state),
    ("srs-queue.json", check_queue),
)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", default=str(Path(__file__).resolve().parent.parent / "data"),
                        help="directory holding the three JSON files (default: ../data)")
    args = parser.parse_args()
    data_dir = Path(args.data)

    errors = []
    for filename, check in CHECKS:
        path = data_dir / filename
        try:
            with path.open(encoding="utf-8") as handle:
                parsed = json.load(handle)
        except FileNotFoundError:
            errors.append(f"{filename}: file not found in {data_dir}")
            continue
        except json.JSONDecodeError as exc:
            errors.append(f"{filename}: invalid JSON ({exc})")
            continue
        check(parsed, errors)

    if errors:
        for error in errors:
            print(f"FAIL {error}", file=sys.stderr)
        print(f"{len(errors)} error(s)", file=sys.stderr)
        return 1
    print("OK: quest-data.json, state.json and srs-queue.json are valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
