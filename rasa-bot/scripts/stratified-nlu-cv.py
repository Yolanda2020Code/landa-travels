#!/usr/bin/env python3
"""Run process-isolated, leak-checked, stratified three-fold Rasa NLU CV.

Each fold is trained and evaluated in separate child processes so TensorFlow
state is released between commands. The script prepares fold files outside
Rasa's automatic data-discovery directory and preserves raw logs and hashes.
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
import unicodedata
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = Path(__file__).resolve()
SOURCE_NLU = ROOT / "data" / "nlu.yml"
CONFIG = ROOT / "config.yml"
N_SPLITS = 3
RANDOM_STATE = 42
DEFAULT_THREADS = {
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


def sha256_value(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def normalized_utterance(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
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


def prepare_folds(output_directory: Path) -> int:
    """Parse with Rasa, stratify utterance groups, and write isolated YAML folds."""
    from copy import deepcopy
    from io import StringIO

    from rasa.shared.nlu.training_data.formats.rasa_yaml import (
        RasaYAMLReader,
        RasaYAMLWriter,
    )
    from rasa.shared.nlu.training_data.synonyms_parser import add_synonyms_from_entities
    from rasa.shared.nlu.training_data.training_data import TrainingData
    from ruamel.yaml import YAML
    import numpy as np
    from sklearn.model_selection import StratifiedGroupKFold

    source_text = SOURCE_NLU.read_text(encoding="utf-8")
    yaml_loader = YAML(typ="safe")
    source_document = yaml_loader.load(source_text)
    if not isinstance(source_document, dict) or not isinstance(
        source_document.get("nlu"), list
    ):
        raise ValueError(f"Expected a Rasa NLU YAML document: {SOURCE_NLU}")

    reader = RasaYAMLReader()
    complete_data = reader.reads(source_text)
    examples = list(complete_data.nlu_examples)
    if not examples:
        raise ValueError("The current training corpus has no Rasa NLU examples.")

    labels: list[str] = []
    utterance_keys: list[str] = []
    for index, example in enumerate(examples):
        label = example.get("intent")
        text = example.get("text")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"Training example {index} has no intent label.")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"Training example {index} has no utterance text.")
        labels.append(label)
        utterance_keys.append(normalized_utterance(text))

    # Read only explicitly declared synonyms, regexes, lookups, and responses.
    # Inline entity synonyms are re-added from each fold's training examples
    # below, preventing a held-out example from leaking its alias mapping.
    metadata_document = {
        key: deepcopy(value)
        for key, value in source_document.items()
        if key != "nlu"
    }
    metadata_document["nlu"] = [
        deepcopy(block)
        for block in source_document["nlu"]
        if isinstance(block, dict) and "intent" not in block
    ]
    metadata_stream = StringIO()
    YAML().dump(metadata_document, metadata_stream)
    explicit_metadata = RasaYAMLReader().reads(metadata_stream.getvalue())

    group_ids_by_utterance: dict[str, int] = {}
    groups = []
    for key in utterance_keys:
        if key not in group_ids_by_utterance:
            group_ids_by_utterance[key] = len(group_ids_by_utterance)
        groups.append(group_ids_by_utterance[key])

    splitter = StratifiedGroupKFold(
        n_splits=N_SPLITS,
        shuffle=True,
        random_state=RANDOM_STATE,
    )
    with warnings.catch_warnings(record=True) as captured_warnings:
        warnings.simplefilter("always")
        splits = list(splitter.split(np.zeros(len(examples)), labels, groups))

    if len(splits) != N_SPLITS:
        raise RuntimeError(f"Expected {N_SPLITS} folds, got {len(splits)}.")

    # Resolve and validate output placement: generated evaluation utterances
    # must not be added to Rasa's automatic data/ training directory.
    output_directory = output_directory.resolve()
    if output_directory == ROOT / "data" or ROOT / "data" in output_directory.parents:
        raise ValueError("Cross-validation outputs must stay outside rasa-bot/data/.")
    output_directory.mkdir(parents=True, exist_ok=True)

    from collections import Counter

    all_class_counts = dict(sorted(Counter(labels).items()))
    fold_records = []
    writer = RasaYAMLWriter()

    for fold_number, (train_indices, test_indices) in enumerate(splits, start=1):
        fold_directory = output_directory / f"fold-{fold_number:02d}"
        fold_directory.mkdir(parents=True, exist_ok=True)
        train_index_set = {int(index) for index in train_indices}
        test_index_set = {int(index) for index in test_indices}
        train_examples = [
            deepcopy(example)
            for i, example in enumerate(examples)
            if i in train_index_set
        ]
        test_examples = [
            deepcopy(example)
            for i, example in enumerate(examples)
            if i in test_index_set
        ]

        train_keys = {utterance_keys[index] for index in train_index_set}
        test_keys = {utterance_keys[index] for index in test_index_set}
        overlap = sorted(train_keys.intersection(test_keys))
        if overlap:
            raise RuntimeError(
                f"Fold {fold_number} has {len(overlap)} utterance leaks."
            )

        fold_synonyms = deepcopy(explicit_metadata.entity_synonyms)
        for example in train_examples:
            add_synonyms_from_entities(
                example.get("text", ""),
                example.get("entities", []),
                fold_synonyms,
            )

        train_data = TrainingData(
            training_examples=train_examples,
            entity_synonyms=fold_synonyms,
            regex_features=deepcopy(explicit_metadata.regex_features),
            lookup_tables=deepcopy(explicit_metadata.lookup_tables),
            responses=deepcopy(explicit_metadata.responses),
        )
        test_data = TrainingData(training_examples=test_examples)

        train_path = fold_directory / "train-nlu.yml"
        test_path = fold_directory / "test-nlu.yml"
        writer.dump(train_path, train_data)
        writer.dump(test_path, test_data)
        if not train_path.is_file() or not test_path.is_file():
            raise RuntimeError(
                f"Rasa YAML writer did not create fold {fold_number} files."
            )

        # Re-read exactly what will be supplied to Rasa and verify both
        # utterance separation and retention of corpus metadata.
        written_train = RasaYAMLReader().reads(train_path.read_text(encoding="utf-8"))
        written_test = RasaYAMLReader().reads(test_path.read_text(encoding="utf-8"))
        written_train_keys = {
            normalized_utterance(example.get("text", ""))
            for example in written_train.nlu_examples
        }
        written_test_keys = {
            normalized_utterance(example.get("text", ""))
            for example in written_test.nlu_examples
        }
        if written_train_keys.intersection(written_test_keys):
            raise RuntimeError(
                f"Fold {fold_number} contains a serialized utterance leak."
            )
        if not set(explicit_metadata.entity_synonyms.items()).issubset(
            set(written_train.entity_synonyms.items())
        ):
            raise RuntimeError(f"Fold {fold_number} lost explicit synonym mappings.")
        if written_train.regex_features != explicit_metadata.regex_features:
            raise RuntimeError(f"Fold {fold_number} lost regex training features.")
        if written_train.lookup_tables != explicit_metadata.lookup_tables:
            raise RuntimeError(f"Fold {fold_number} lost lookup-table data.")

        fold_records.append(
            {
                "fold": fold_number,
                "train_file": str(train_path),
                "test_file": str(test_path),
                "train_file_sha256": sha256_file(train_path),
                "test_file_sha256": sha256_file(test_path),
                "train_examples": len(written_train.nlu_examples),
                "test_examples": len(written_test.nlu_examples),
                "train_class_counts": dict(
                    sorted(
                        Counter(
                            example.get("intent")
                            for example in written_train.nlu_examples
                        ).items()
                    )
                ),
                "test_class_counts": dict(
                    sorted(
                        Counter(
                            example.get("intent")
                            for example in written_test.nlu_examples
                        ).items()
                    )
                ),
                "normalized_utterance_overlap": 0,
                "metadata_retained": {
                    "explicit_synonyms": len(explicit_metadata.entity_synonyms),
                    "regex_features": len(explicit_metadata.regex_features),
                    "lookup_tables": len(explicit_metadata.lookup_tables),
                },
            }
        )

    split_document = {
        "schema_version": 1,
        "splitter": "sklearn.model_selection.StratifiedGroupKFold",
        "folds": N_SPLITS,
        "random_state": RANDOM_STATE,
        "source_nlu": str(SOURCE_NLU),
        "source_nlu_sha256": sha256_file(SOURCE_NLU),
        "config": str(CONFIG),
        "config_sha256": sha256_file(CONFIG),
        "total_examples": len(examples),
        "unique_normalized_utterances": len(group_ids_by_utterance),
        "class_counts": all_class_counts,
        "stratification_warnings": [str(item.message) for item in captured_warnings],
        "leakage_policy": (
            "Case-folded, NFKC-normalized, whitespace-collapsed identical utterances "
            "are grouped into a single fold. Test examples are never written to the "
            "training file. Explicit corpus synonyms/lookups/regexes are retained; "
            "inline entity synonym aliases are reconstructed only from that fold's "
            "training examples."
        ),
        "folds_data": fold_records,
    }
    write_json(output_directory / "split-manifest.json", split_document)
    print(
        f"Prepared {N_SPLITS} stratified folds from {len(examples)} examples "
        f"({len(group_ids_by_utterance)} unique utterance groups).",
        flush=True,
    )
    return 0


def make_child_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name, value in DEFAULT_THREADS.items():
        environment[name] = value
    return environment


def run_logged(
    label: str,
    command: list[str],
    output_directory: Path,
    environment: dict[str, str],
) -> dict[str, Any]:
    output_directory.mkdir(parents=True, exist_ok=True)
    command_record = {
        "label": label,
        "command": command,
        "command_sha256": sha256_value(command),
        "cwd": str(ROOT),
        "thread_environment": {
            name: environment.get(name) for name in DEFAULT_THREADS
        },
    }
    write_json(output_directory / f"{label}-command.json", command_record)
    log_path = output_directory / f"{label}.log"
    print(f"[{label}] starting; stdout/stderr -> {log_path}", flush=True)
    started = time.perf_counter()
    launch_error = None
    with log_path.open("wb") as log:
        try:
            result = subprocess.run(
                command,
                cwd=ROOT,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                check=False,
            )
            exit_code = result.returncode
        except OSError as error:
            launch_error = f"{type(error).__name__}: {error}"
            log.write(f"Failed to start subprocess: {launch_error}\n".encode("utf-8"))
            exit_code = 127
    elapsed = time.perf_counter() - started
    record = {
        **command_record,
        "exit_code": exit_code,
        "elapsed_seconds": round(elapsed, 3),
        "log": log_path.name,
        "log_sha256": sha256_file(log_path),
    }
    if launch_error is not None:
        record["launch_error"] = launch_error
    write_json(output_directory / f"{label}-result.json", record)
    print(f"[{label}] exit {exit_code} after {elapsed:.1f}s", flush=True)
    return record


def read_json_if_present(path: Path) -> Any | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def prediction_records(evaluation_directory: Path) -> list[dict[str, str]]:
    successes = (
        read_json_if_present(evaluation_directory / "intent_successes.json") or []
    )
    errors = read_json_if_present(evaluation_directory / "intent_errors.json") or []
    if not isinstance(successes, list) or not isinstance(errors, list):
        raise ValueError("Rasa intent prediction output is not a JSON list.")

    records = []
    for item in [*successes, *errors]:
        if not isinstance(item, dict) or not isinstance(item.get("intent"), str):
            raise ValueError("Rasa intent prediction output has an invalid target.")
        prediction = item.get("intent_prediction")
        if isinstance(prediction, dict):
            predicted = prediction.get("name")
        else:
            predicted = prediction
        if not isinstance(predicted, str):
            raise ValueError("Rasa intent prediction output has no predicted intent.")
        records.append({"target": item["intent"], "prediction": predicted})
    return records


def pooled_metrics(
    records: list[dict[str, str]], output_directory: Path
) -> dict[str, Any]:
    from sklearn.metrics import accuracy_score, classification_report, confusion_matrix

    targets = [item["target"] for item in records]
    predictions = [item["prediction"] for item in records]
    labels = sorted(set(targets).union(predictions))
    matrix = confusion_matrix(targets, predictions, labels=labels)
    report = classification_report(
        targets,
        predictions,
        labels=labels,
        output_dict=True,
        zero_division=0,
    )
    result = {
        "status": "complete",
        "source": "pooled per-example predictions written by Rasa test nlu",
        "evaluation_examples": len(records),
        "labels": labels,
        "confusion_matrix": {
            "rows": "true intent",
            "columns": "predicted intent",
            "values": matrix.tolist(),
        },
        "accuracy": float(accuracy_score(targets, predictions)),
        "classification_report": report,
    }
    write_json(output_directory / "pooled-report.json", result)
    return result


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    if args_list and args_list[0] == "_prepare":
        if len(args_list) != 2:
            print(
                "Internal preparation mode requires one output directory.",
                file=sys.stderr,
            )
            return 2
        try:
            return prepare_folds(Path(args_list[1]))
        except Exception as error:
            print(
                f"Fold preparation failed: {type(error).__name__}: {error}",
                file=sys.stderr,
            )
            return 1

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        help=(
            "New evidence directory "
            "(default: evidence/runs/<UTC timestamp>-isolated-cv)"
        ),
    )
    parser.add_argument(
        "--allow-resource-intensive",
        action="store_true",
        help=(
            "Required after coordinating a quiet evaluation window "
            "with the project owner"
        ),
    )
    args = parser.parse_args(args_list)
    if not args.allow_resource_intensive:
        parser.error(
            "Coordinate a quiet resource window, then pass --allow-resource-intensive."
        )
    if not SOURCE_NLU.is_file() or not CONFIG.is_file():
        parser.error(f"Required current corpus/config not found under {ROOT}.")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_directory = (
        args.out or (ROOT / "evidence" / "runs" / f"{stamp}-isolated-cv")
    ).resolve()
    data_directory = (ROOT / "data").resolve()
    if output_directory == data_directory or data_directory in output_directory.parents:
        parser.error("Cross-validation outputs must stay outside rasa-bot/data/.")
    if output_directory.exists():
        parser.error(
            "Refusing to overwrite existing evidence directory: "
            f"{output_directory}"
        )
    output_directory.mkdir(parents=True)
    folds_directory = output_directory / "folds"
    folds_directory.mkdir()
    environment = make_child_environment()

    metadata = {
        "schema_version": 1,
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "git_revision": git_revision(),
        "runner": str(SCRIPT),
        "runner_sha256": sha256_file(SCRIPT),
        "source_nlu": str(SOURCE_NLU),
        "source_nlu_sha256": sha256_file(SOURCE_NLU),
        "config": str(CONFIG),
        "config_sha256": sha256_file(CONFIG),
        "folds": N_SPLITS,
        "splitter": "sklearn.model_selection.StratifiedGroupKFold",
        "random_state": RANDOM_STATE,
        "versions": {
            "python": platform.python_version(),
            "rasa": package_version("rasa"),
            "rasa-sdk": package_version("rasa-sdk"),
            "scikit-learn": package_version("scikit-learn"),
        },
        "thread_limits": {
            name: environment.get(name) for name in DEFAULT_THREADS
        },
        "process_isolation": (
            "Fold preparation, every fold's training, and every fold's evaluation "
            "are separate subprocesses. Training and evaluation never share a "
            "TensorFlow/Rasa process."
        ),
        "data_boundary": (
            "Only rasa-bot/data/nlu.yml is split. Existing held-out files remain "
            "outside the training tree; generated test folds are written under "
            "the evidence directory, never under rasa-bot/data/."
        ),
    }
    write_json(output_directory / "metadata.json", metadata)

    prep_command = [sys.executable, str(SCRIPT), "_prepare", str(folds_directory)]
    preparation = run_logged(
        "prepare-folds",
        prep_command,
        output_directory,
        environment,
    )
    progress: dict[str, Any] = {
        "schema_version": 1,
        "preparation": preparation,
        "folds": [],
        "pooled_report_status": "not generated",
    }
    write_json(output_directory / "progress.json", progress)
    if preparation["exit_code"] != 0:
        summary = {
            **progress,
            "finished_at_utc": datetime.now(timezone.utc).isoformat(),
            "all_requested_folds_completed": False,
            "reason": (
                "Fold preparation subprocess failed; no model metrics "
                "were generated."
            ),
        }
        write_json(output_directory / "run-summary.json", summary)
        print(f"Evidence directory: {output_directory}", flush=True)
        return 1

    split_manifest_path = folds_directory / "split-manifest.json"
    split_manifest = json.loads(split_manifest_path.read_text(encoding="utf-8"))
    fold_results = []
    pooled_predictions: list[dict[str, str]] = []
    every_fold_complete = True

    for fold in split_manifest["folds_data"]:
        fold_number = int(fold["fold"])
        fold_directory = folds_directory / f"fold-{fold_number:02d}"
        model_directory = fold_directory / "models"
        evaluation_directory = fold_directory / "evaluation"
        model_directory.mkdir(exist_ok=True)
        model_name = f"nlu-cv-fold-{fold_number:02d}"

        train_command = [
            "rasa",
            "train",
            "nlu",
            "--config",
            str(CONFIG),
            "--nlu",
            fold["train_file"],
            "--out",
            str(model_directory),
            "--fixed-model-name",
            model_name,
            "--num-threads",
            "2",
        ]
        training = run_logged("train", train_command, fold_directory, environment)
        model_candidates = sorted(model_directory.glob(f"{model_name}*.tar.gz"))
        model_archive = model_candidates[0] if len(model_candidates) == 1 else None
        if len(model_candidates) > 1:
            training["archive_error"] = "Multiple model archives were created."
        elif model_archive is None and training["exit_code"] == 0:
            training["archive_error"] = (
                "Training exited successfully but no model archive was found."
            )

        evaluation: dict[str, Any] | None = None
        intent_report = None
        predictions: list[dict[str, str]] = []
        fold_complete = (
            training["exit_code"] == 0
            and model_archive is not None
            and training.get("archive_error") is None
        )
        if fold_complete and model_archive is not None:
            evaluation_directory.mkdir(exist_ok=True)
            evaluation_command = [
                "rasa",
                "test",
                "nlu",
                "--model",
                str(model_archive),
                "--nlu",
                fold["test_file"],
                "--out",
                str(evaluation_directory),
                "--successes",
                "--no-plot",
            ]
            evaluation = run_logged(
                "evaluate",
                evaluation_command,
                fold_directory,
                environment,
            )
            if evaluation["exit_code"] == 0:
                intent_report_path = evaluation_directory / "intent_report.json"
                try:
                    intent_report = read_json_if_present(intent_report_path)
                    predictions = prediction_records(evaluation_directory)
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    fold["prediction_output_error"] = (
                        f"{type(error).__name__}: {error}"
                    )
                fold_complete = (
                    isinstance(intent_report, dict)
                    and len(predictions) == int(fold["test_examples"])
                    and intent_report_path.is_file()
                )
                if not fold_complete:
                    fold["metrics_validation_error"] = (
                        "Expected a Rasa intent report and one genuine per-example "
                        f"prediction for each of {fold['test_examples']} "
                        "held-out examples; "
                        f"found {len(predictions)} predictions."
                    )
            else:
                fold_complete = False
        else:
            fold["metrics_validation_error"] = (
                "Training did not produce one usable model archive."
            )

        if model_archive is not None and model_archive.is_file():
            fold["model_archive"] = {
                "path": str(model_archive),
                "sha256": sha256_file(model_archive),
                "size_bytes": model_archive.stat().st_size,
            }
        else:
            fold["model_archive"] = None

        if evaluation is not None:
            report_path = evaluation_directory / "intent_report.json"
            if intent_report is None:
                try:
                    intent_report = read_json_if_present(report_path)
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    fold["intent_report_parse_error"] = (
                        f"{type(error).__name__}: {error}"
                    )
            rasa_reports = {}
            report_parse_errors = []
            for report_file in sorted(evaluation_directory.glob("*_report.json")):
                try:
                    report = json.loads(report_file.read_text(encoding="utf-8"))
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    report_parse_errors.append(
                        f"{report_file.name}: {type(error).__name__}: {error}"
                    )
                    continue
                rasa_reports[report_file.name] = {
                    "sha256": sha256_file(report_file),
                    "report": report,
                }
            fold["metrics"] = {
                "source": str(report_path),
                "sha256": sha256_file(report_path) if report_path.is_file() else None,
                "rasa_intent_report": intent_report,
                "rasa_reports": rasa_reports,
                "prediction_count": len(predictions),
                "expected_test_examples": int(fold["test_examples"]),
                "evaluation_exit_code": evaluation["exit_code"],
                "report_parse_errors": report_parse_errors,
            }
            if fold_complete:
                pooled_predictions.extend(predictions)
        else:
            fold["metrics"] = None

        fold_result = {
            **fold,
            "training": training,
            "evaluation": evaluation,
            "completed_with_valid_metrics": fold_complete,
        }
        write_json(fold_directory / "fold-summary.json", fold_result)
        fold_results.append(fold_result)
        every_fold_complete = every_fold_complete and fold_complete
        progress["folds"] = fold_results
        progress["pooled_report_status"] = (
            "eligible after all folds complete"
            if every_fold_complete
            else "not generated"
        )
        write_json(output_directory / "progress.json", progress)

    pooled_report = None
    pooled_status = (
        "not generated: at least one fold did not produce complete genuine metrics"
    )
    expected_total = sum(
        int(fold["test_examples"]) for fold in split_manifest["folds_data"]
    )
    if every_fold_complete and len(pooled_predictions) == expected_total:
        pooled_report = pooled_metrics(pooled_predictions, output_directory)
        pooled_status = "complete"
    elif every_fold_complete:
        every_fold_complete = False
        pooled_status = (
            f"not generated: expected {expected_total} genuine predictions, "
            f"found {len(pooled_predictions)}"
        )

    summary = {
        "schema_version": 1,
        "finished_at_utc": datetime.now(timezone.utc).isoformat(),
        "all_requested_folds_completed": every_fold_complete,
        "fold_count": N_SPLITS,
        "completed_fold_count": sum(
            bool(fold["completed_with_valid_metrics"]) for fold in fold_results
        ),
        "preparation": preparation,
        "folds": fold_results,
        "pooled_report_status": pooled_status,
        "pooled_report": pooled_report,
        "interpretation": (
            "No result is inferred from an incomplete fold. The pooled report and "
            "confusion matrix are written only from genuine Rasa per-example "
            "success/error outputs after all three folds validate."
        ),
    }
    write_json(output_directory / "run-summary.json", summary)
    progress["pooled_report_status"] = pooled_status
    write_json(output_directory / "progress.json", progress)
    print(f"Evidence directory: {output_directory}", flush=True)
    print(
        "Completed folds with genuine metrics: "
        f"{summary['completed_fold_count']}/{N_SPLITS}",
        flush=True,
    )
    return 0 if every_fold_complete and pooled_report is not None else 1


if __name__ == "__main__":
    sys.exit(main())