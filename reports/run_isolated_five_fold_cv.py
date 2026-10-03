"""Process-isolated five-fold alternative; native Rasa trains/tests every fold."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "reports/five-fold-cross-validation"
SOURCE = BASE / "source/rasa-bot"
OUT = BASE / "isolated-results"
SCRIPT = Path(__file__).resolve()
ENV = dict(os.environ, PYTHONPATH=str(SOURCE), TF_NUM_INTRAOP_THREADS="1",
           TF_NUM_INTEROP_THREADS="1", OMP_NUM_THREADS="1", MALLOC_ARENA_MAX="2")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2))


def prepare():
    import numpy as np
    from rasa.shared.nlu.training_data.loading import load_data
    from rasa.shared.nlu.training_data.formats.rasa_yaml import RasaYAMLWriter
    from rasa.nlu.test import drop_intents_below_freq, generate_folds

    np.random.seed(42)
    original = load_data(str(SOURCE / "data/nlu.yml"), language="en")
    counts = Counter(x.get_full_intent() for x in original.intent_examples)
    data = drop_intents_below_freq(original, cutoff=5)
    excluded = {k: v for k, v in counts.items() if v < 5}
    records = []
    for i, (train, test) in enumerate(generate_folds(5, data), 1):
        fold = OUT / f"fold-{i:02d}"
        fold.mkdir(parents=True, exist_ok=True)
        for name, dataset in [("train.yml", train), ("test.yml", test)]:
            RasaYAMLWriter().dump(str(fold / name), dataset)
        train_text = {x.get("text") for x in train.intent_examples}
        test_text = {x.get("text") for x in test.intent_examples}
        records.append({
            "fold": i, "train_examples": len(train.intent_examples),
            "test_examples": len(test.intent_examples),
            "identical_texts_shared_across_train_test": sorted(train_text & test_text),
            "train_sha256": hashlib.sha256((fold / "train.yml").read_bytes()).hexdigest(),
            "test_sha256": hashlib.sha256((fold / "test.yml").read_bytes()).hexdigest(),
        })
    write_json(OUT / "split-manifest.json", {
        "folds": 5, "split_seed": 42, "original_intent_counts": counts,
        "excluded_intents_below_five": excluded,
        "original_examples": len(original.intent_examples),
        "eligible_examples": len(data.intent_examples),
        "eligible_intents": len(data.intents),
        "split_method": "Rasa native generate_folds / sklearn StratifiedKFold with numpy seed 42. No grouped paraphrase deduplication.",
        "training_configuration": "Unchanged pinned public config: DIET 100 epochs, ResponseSelector 100 epochs.",
        "records": records,
    })
    print("Prepared five native stratified folds.", flush=True)


def run_step(name, command, log):
    start = datetime.now(timezone.utc).isoformat()
    print("Starting " + name, flush=True)
    stopped = False
    with log.open("w") as handle:
        handle.write("COMMAND: " + " ".join(command) + "\n")
        handle.flush()
        child = subprocess.Popen(command, cwd=SOURCE, env=ENV, stdout=handle,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        while child.poll() is None:
            time.sleep(6)
            usage = int(Path("/sys/fs/cgroup/memory.current").read_text())
            status = Path(f"/proc/{child.pid}/status")
            rss = 0
            if status.exists():
                for line in status.read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1]) * 1024
            if usage > 7.2 * 1024**3 or rss > 3 * 1024**3:
                stopped = True
                handle.write(f"\nMEMORY GUARD: container={usage} bytes; child RSS={rss} bytes.\n")
                handle.flush()
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                break
    return {"step": name, "command": command, "started_at_utc": start,
            "finished_at_utc": datetime.now(timezone.utc).isoformat(),
            "exit_code": child.returncode, "memory_guard_stopped": stopped,
            "log": str(log.relative_to(BASE))}


def aggregate():
    import numpy as np
    from sklearn.metrics import classification_report, accuracy_score, confusion_matrix

    manifest = json.loads((OUT / "split-manifest.json").read_text())
    fold_metrics, true, predicted, all_rows = [], [], [], []
    for i in range(1, 6):
        folder = OUT / f"fold-{i:02d}/test-results"
        report = json.loads((folder / "intent_report.json").read_text())
        rows = []
        for name in ["intent_successes.json", "intent_errors.json"]:
            path = folder / name
            if path.exists():
                rows.extend(json.loads(path.read_text()))
        assert len(rows) == manifest["records"][i-1]["test_examples"], (i, len(rows))
        for row in rows:
            true.append(row["intent"])
            predicted.append(row["intent_prediction"]["name"])
        all_rows.extend(rows)
        fold_metrics.append({"fold": i, "n": len(rows), "accuracy": report["accuracy"],
                             "weighted_f1": report["weighted avg"]["f1-score"],
                             "macro_f1": report["macro avg"]["f1-score"]})
    assert len(true) == manifest["eligible_examples"]
    labels = sorted(set(true) | set(predicted))
    full = classification_report(true, predicted, output_dict=True, zero_division=0)
    summary = {
        "source_revision": json.loads((BASE / "run-status.json").read_text())["source_revision"],
        "procedure": "Alternative process-isolated native Rasa train/test on five stratified folds. The original one-process CV command was memory-stopped and is not claimed to have completed.",
        "folds_completed": 5, "test_examples": len(true),
        "eligible_intents": manifest["eligible_intents"],
        "excluded_intents_below_five": manifest["excluded_intents_below_five"],
        "held_out_predictions": len(true), "correct": sum(a == b for a, b in zip(true, predicted)),
        "pooled_out_of_fold_accuracy": accuracy_score(true, predicted),
        "pooled_weighted_f1": full["weighted avg"]["f1-score"],
        "pooled_macro_f1": full["macro avg"]["f1-score"],
        "mean_fold_accuracy": float(np.mean([x["accuracy"] for x in fold_metrics])),
        "std_fold_accuracy_population": float(np.std([x["accuracy"] for x in fold_metrics])),
        "fold_metrics": fold_metrics, "pooled_classification_report": full,
        "confusion_matrix_labels": labels,
        "confusion_matrix": confusion_matrix(true, predicted, labels=labels).tolist(),
        "scope": "New fold-trained NLU models, not the deployed archive. Utterance-level splits; closely related templates may cross folds. Native entity reports are per-extractor, not merged-span scores.",
    }
    write_json(OUT / "summary.json", summary)
    # Use Rasa's evaluation rendering for an aggregate confusion matrix, not a
    # fabricated or hand-labelled plot. This creates normal Rasa report outputs.
    from rasa.nlu.test import IntentEvaluationResult, evaluate_intents
    (OUT / "pooled-intent-results").mkdir(exist_ok=True)
    results = [
        IntentEvaluationResult(
            intent_target=row["intent"],
            intent_prediction=row["intent_prediction"]["name"],
            message=row["text"],
            confidence=row["intent_prediction"]["confidence"],
        ) for row in all_rows
    ]
    evaluate_intents(results, str(OUT / "pooled-intent-results"), False, False,
                     False, report_as_dict=True)
    print("Aggregated all five out-of-fold test sets.", flush=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    record = {"state": "running", "started_at_utc": datetime.now(timezone.utc).isoformat(),
              "procedure": "Five separate native Rasa NLU training and testing process pairs.",
              "completed_test_folds": 0, "steps": []}
    status = OUT / "run-status.json"
    def execute(name, command, log):
        step = run_step(name, command, log)
        record["steps"].append(step)
        write_json(status, record)
        if step["exit_code"] != 0:
            raise RuntimeError(f"{name} failed with exit code {step['exit_code']}")
    write_json(status, record)
    try:
        execute("prepare-folds", [sys.executable, str(SCRIPT), "_prepare"], OUT / "prepare.log")
        for i in range(1, 6):
            fold = OUT / f"fold-{i:02d}"
            execute(f"fold-{i}-train",
                    ["rasa", "train", "nlu", "--nlu", str(fold / "train.yml"),
                     "--config", "config.yml", "--out", str(fold / "models"),
                     "--fixed-model-name", f"fold-{i}"], fold / "train.log")
            models = list((fold / "models").glob("*.tar.gz"))
            assert len(models) == 1, models
            execute(f"fold-{i}-test",
                    ["rasa", "test", "nlu", "--model", str(models[0]),
                     "--nlu", str(fold / "test.yml"), "--out", str(fold / "test-results"),
                     "--successes"], fold / "test.log")
            record["completed_test_folds"] = i
            write_json(status, record)
            print(f"Completed test fold {i}/5.", flush=True)
        execute("aggregate-results", [sys.executable, str(SCRIPT), "_aggregate"], OUT / "aggregate.log")
        record["state"] = "completed"
    except Exception as exc:
        record["state"] = "failed"
        record["error"] = str(exc)
    record["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    write_json(status, record)
    print(json.dumps({"state": record["state"], "completed_test_folds": record["completed_test_folds"]}), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "_prepare":
        prepare()
    elif len(sys.argv) > 1 and sys.argv[1] == "_aggregate":
        aggregate()
    else:
        main()