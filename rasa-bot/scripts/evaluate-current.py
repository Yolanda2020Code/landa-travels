#!/usr/bin/env python3
"""Run current held-out NLU/Core tests and isolated stratified NLU cross-validation.

This is intentionally resource-intensive: coordinate a quiet evaluation window
with the project owner before passing --allow-resource-intensive.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ISOLATED_CV_RUNNER = ROOT / "scripts" / "stratified-nlu-cv.py"
THREAD_DEFAULTS = {
    "TF_NUM_INTRAOP_THREADS": "2",
    "TF_NUM_INTEROP_THREADS": "1",
    "OMP_NUM_THREADS": "2",
    "MALLOC_ARENA_MAX": "2",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_hashes(path: Path) -> dict[str, str]:
    return {
        item.relative_to(ROOT).as_posix(): sha256_file(item)
        for item in sorted(path.rglob("*"))
        if item.is_file() and "__pycache__" not in item.parts
    }


def installed_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def git_revision() -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT.parent,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def run_command(
    label: str, command: list[str], output_dir: Path
) -> dict[str, Any]:
    log_path = output_dir / f"{label}.log"
    print(f"[{label}] running; raw stdout/stderr -> {log_path}", flush=True)
    started = time.perf_counter()
    with log_path.open("w", encoding="utf-8") as log:
        result = subprocess.run(
            command,
            cwd=ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
    elapsed = time.perf_counter() - started
    status = {
        "label": label,
        "command": command,
        "exit_code": result.returncode,
        "elapsed_seconds": round(elapsed, 3),
        "log": log_path.name,
    }
    print(f"[{label}] exit {result.returncode} after {elapsed:.1f}s", flush=True)
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        type=Path,
        default=ROOT / "models" / "landa-travels.tar.gz",
        help="Existing trained model archive (the script does not train a replacement)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="New evidence directory (default: evidence/runs/<UTC timestamp>)",
    )
    parser.add_argument(
        "--allow-resource-intensive",
        action="store_true",
        help="Required acknowledgment after coordinating a quiet window with the owner",
    )
    args = parser.parse_args()

    if not args.allow_resource_intensive:
        parser.error(
            "This run executes NLU, Core, and three-fold CV sequentially. "
            "Coordinate with the project owner, then pass --allow-resource-intensive."
        )

    model = args.model.resolve()
    if not model.is_file():
        parser.error(f"Model archive does not exist: {model}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_dir = (args.out or (ROOT / "evidence" / "runs" / stamp)).resolve()
    if output_dir.exists():
        parser.error(f"Refusing to overwrite evidence directory: {output_dir}")
    output_dir.mkdir(parents=True)

    config = ROOT / "config.yml"
    held_out_nlu = ROOT / "tests" / "test_nlu.yml"
    held_out_entities = ROOT / "tests" / "entity_held_out.yml"
    held_out_core = ROOT / "tests" / "test_stories.yml"
    training_nlu = ROOT / "data" / "nlu.yml"
    for name, value in THREAD_DEFAULTS.items():
        os.environ.setdefault(name, value)
    input_paths = [
        config,
        held_out_nlu,
        held_out_entities,
        held_out_core,
        training_nlu,
        ROOT / "data" / "stories.yml",
        ROOT / "data" / "rules.yml",
        ROOT / "domain.yml",
        ROOT / "actions" / "actions.py",
        ROOT / "tests" / "test_actions.py",
        ROOT / "requirements.txt",
        ISOLATED_CV_RUNNER,
        Path(__file__).resolve(),
    ]
    metadata = {
        "schema_version": 1,
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "git_revision": git_revision(),
        "model": {
            "path_relative_to_rasa_bot": os.path.relpath(model, ROOT),
            "sha256": sha256_file(model),
            "size_bytes": model.stat().st_size,
        },
        "inputs": {
            path.relative_to(ROOT).as_posix(): sha256_file(path)
            for path in input_paths
        },
        "versions": {
            "python": platform.python_version(),
            "rasa": installed_version("rasa"),
            "rasa-sdk": installed_version("rasa-sdk"),
            "spacy": installed_version("spacy"),
        },
        "test_data_location": {
            "held_out_nlu": held_out_nlu.relative_to(ROOT).as_posix(),
            "held_out_entities": held_out_entities.relative_to(ROOT).as_posix(),
            "held_out_core": held_out_core.relative_to(ROOT).as_posix(),
            "cross_validation_nlu": training_nlu.relative_to(ROOT).as_posix(),
            "cross_validation_runner": ISOLATED_CV_RUNNER.relative_to(ROOT).as_posix(),
            "note": "Held-out files remain under tests/, outside data/ training discovery.",
        },
        "execution_policy": (
            "Held-out checks and process-isolated cross-validation run sequentially. "
            "Every cross-validation fold trains and evaluates in separate subprocesses "
            "with bounded TensorFlow/OpenMP threads. Do not run alongside model "
            "training or another full evaluation."
        ),
    }
    (output_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
    )

    common_nlu = [
        "rasa", "test", "nlu", "--model", str(model),
        "--config", str(config), "--successes",
    ]
    runs = [
        run_command(
            "held-out-nlu",
            common_nlu + ["--nlu", str(held_out_nlu), "--out", str(output_dir / "nlu")],
            output_dir,
        ),
        run_command(
            "held-out-entities",
            common_nlu + ["--nlu", str(held_out_entities), "--out", str(output_dir / "entities")],
            output_dir,
        ),
        run_command(
            "held-out-core",
            [
                "rasa", "test", "core", "--model", str(model),
                "--stories", str(held_out_core), "--out", str(output_dir / "core"),
                "--successes",
            ],
            output_dir,
        ),
        run_command(
            "nlu-cross-validation-isolated",
            [
                sys.executable,
                str(ISOLATED_CV_RUNNER),
                "--allow-resource-intensive",
                "--out",
                str(output_dir / "cross-validation-isolated"),
            ],
            output_dir,
        ),
    ]
    summary = {
        "finished_at_utc": datetime.now(timezone.utc).isoformat(),
        "runs": runs,
        "all_commands_passed": all(item["exit_code"] == 0 for item in runs),
        "raw_results_policy": (
            "Rasa output folders, command logs, metadata and hashes are retained "
            "together. This script does not interpret away failures."
        ),
    }
    (output_dir / "run-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Evidence directory: {output_dir}")
    return 0 if summary["all_commands_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())