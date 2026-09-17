"""Role permissions and workflow rules, read from shared/*.json so the API and the web app agree."""
from __future__ import annotations

import json
from functools import lru_cache

from .settings import SHARED_DIR


@lru_cache
def access_rules() -> dict:
    return json.loads((SHARED_DIR / "access.json").read_text())


@lru_cache
def workflow_rules() -> dict:
    return json.loads((SHARED_DIR / "workflow.json").read_text(encoding="utf-8"))


def module_level(role: str, module: str) -> str:
    return access_rules()["roles"].get(role, {}).get(module, "none")


def identities_visible(clearance: str) -> bool:
    return clearance not in access_rules()["restrictedClearance"]


def can_move_stage(current: str, target: str) -> tuple[bool, str | None]:
    stages = workflow_rules()["stages"]
    if target not in stages:
        return False, f'Unknown stage "{target}"'
    if current == target:
        return True, None
    i, j = stages.index(current), stages.index(target)
    if abs(j - i) == 1:
        return True, None
    nxt = stages[i + 1] if i + 1 < len(stages) else current
    return False, f'Cases move one stage at a time; "{current}" can only go to "{nxt}"'


def can_set_status(status: str, stage: str) -> tuple[bool, str | None]:
    rules = workflow_rules()
    if status not in rules["statuses"]:
        return False, f'Unknown status "{status}"'
    minimum = rules["statusMinStage"].get(status)
    stages = rules["stages"]
    if not minimum or stages.index(stage) >= stages.index(minimum):
        return True, None
    return False, f'"{status}" needs the case to reach "{minimum}" first'
