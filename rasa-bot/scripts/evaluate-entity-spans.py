#!/usr/bin/env python3
"""Evaluate the real merged Rasa entity output with exact-span metrics.

These metrics are deliberately separate from Rasa's per-extractor token reports:
a correct prediction must have the same entity type and character boundaries.
Each dataset is outside the training discovery path. No trackers or API calls.
"""

import argparse
import asyncio
import hashlib
import json
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

LABELS = {"origin", "destination", "stopover", "travel_dates", "budget", "travelers"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def span(entity):
    return entity["entity"], entity["start"], entity["end"]


def metrics(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {"true_positive": tp, "false_positive": fp, "false_negative": fn,
            "precision": precision, "recall": recall,
            "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0}


async def run(args):
    from rasa.shared.nlu.training_data.loading import load_data
    from tune_fallback import raw_ranking
    agent = None
    if not args.url:
        from rasa.core.agent import Agent
        agent = Agent.load(str(args.model))
    output = {"measured_at_utc": datetime.now(timezone.utc).isoformat(),
              "metric": "exact entity type and character span, real merged pipeline output",
              "model_sha256": digest(args.model), "datasets": []}
    output["execution"] = "private running Rasa /model/parse" if args.url else "offline Agent.parse_message"
    if args.url:
        with urllib.request.urlopen(args.url.rstrip("/") + "/status", timeout=5) as response:
            output["server_status"] = json.load(response)
    root = Path(__file__).resolve().parents[1]
    output["current_source_sha256"] = {
        str(path.relative_to(root)): digest(path)
        for path in [root / "config.yml", root / "data/nlu.yml",
                     root / "travel_nlu/entity_rules.py", root / "travel_nlu/entity_extractor.py",
                     root / "travel_nlu/value_normalisation.py", root / "actions/actions.py"]
    }
    output["provenance_note"] = (
        "Current source hashes identify the workspace at evaluation time, not necessarily "
        "the source used to train the model. Model SHA identifies the evaluated archive. "
        "The existing entity_held_out dataset is a previously inspected regression set. "
        "The entity_generalisation examples were authored separately and not inspected "
        "by the implementer before the initial candidate was frozen. Its first result "
        "is independent evidence; subsequent safety refinement inspected its failed "
        "negative controls, so later results on this set are regression evidence."
    )
    supported_intents = set(load_data(str(root / "data/nlu.yml")).intents)
    for path in args.nlu:
        examples = load_data(str(path)).training_examples
        counts = {label: Counter() for label in LABELS}
        intent_correct = classifier_correct = applicable = controls = controls_with_entities = 0
        rows = []
        for example in examples:
            text = example.get("text")
            if agent is not None:
                prediction = await agent.parse_message(text)
            else:
                request = urllib.request.Request(
                    args.url.rstrip("/") + "/model/parse",
                    data=json.dumps({"text": text}).encode(),
                    headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(request, timeout=10) as response:
                    prediction = json.load(response)
            gold = {span(e) for e in example.get("entities", []) if e["entity"] in LABELS}
            predicted = {span(e) for e in prediction.get("entities", []) if e["entity"] in LABELS}
            for label in LABELS:
                g = {s for s in gold if s[0] == label}
                p = {s for s in predicted if s[0] == label}
                counts[label].update(tp=len(g & p), fp=len(p - g), fn=len(g - p))
            if not gold:
                controls += 1
                controls_with_entities += bool(predicted)
            expected = example.get("intent")
            ranking = raw_ranking(prediction, args.fallback_threshold)
            if expected in supported_intents:
                applicable += 1
                intent_correct += prediction.get("intent", {}).get("name") == expected
                classifier_correct += ranking[0].get("name") == expected
            rows.append({"text": text, "gold": sorted(gold), "predicted": sorted(predicted),
                         "predicted_intent": prediction.get("intent"),
                          "classifier_intent": ranking[0], "expected_intent": expected,
                         "exact_match": gold == predicted})
        totals = Counter()
        for count in counts.values():
            totals.update(count)
        report = {"path": str(path), "sha256": digest(path), "utterances": len(examples),
                  "micro": metrics(totals["tp"], totals["fp"], totals["fn"]),
                  "per_entity": {k: metrics(v["tp"], v["fp"], v["fn"]) for k, v in sorted(counts.items())},
                  "exact_utterance_matches": sum(r["exact_match"] for r in rows),
                  "intent_correct": intent_correct if applicable else None,
                  "classifier_intent_correct": classifier_correct if applicable else None,
                  "intent_evaluable_examples": applicable,
                  "fallback_threshold_used_for_classifier_attribution": args.fallback_threshold,
                  "negative_controls": controls,
                  "negative_controls_with_entities": controls_with_entities,
                  "predictions": rows}
        output["datasets"].append(report)
        print(json.dumps({k: v for k, v in report.items() if k != "predictions"}), flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--nlu", type=Path, nargs="+", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--url", help="Optional private running Rasa URL (no tracker writes)")
    parser.add_argument("--fallback-threshold", type=float, default=0.35)
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Refusing to overwrite existing evidence")
    asyncio.run(run(args))