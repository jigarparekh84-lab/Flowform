"""Rewrite golden fixtures from the current engine. Review the diff before committing."""

from __future__ import annotations

import json
from pathlib import Path

from .cases import CASES

HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    for name, fn in CASES.items():
        (HERE / f"{name}.json").write_text(json.dumps(fn(), indent=2, sort_keys=True) + "\n")
        print("wrote", name)
