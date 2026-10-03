"""Compare fallback thresholds on a validation set kept separate from training."""

from __future__ import annotations

import argparse
import asyncio
import json
import hashlib
import urllib.request
from pathlib import Path
from typing import Any

def raw_ranking(result: dict[str, Any], current_threshold: float) -> list[dict[str, Any]]:
    ranking = list(result.get("intent_ranking") or [result.get("intent", {})])
    # Rasa inserts one synthetic fallback at the configured threshold. A
    # naturally learned nlu_fallback is a real class and must not be discarded.
    if (len(ranking) > 1 and ranking[0].get("name") == "nlu_fallback"
            and ranking[0].get("confidence") == current_threshold):
        ranking = ranking[1:]
    return ranking


def calibrated_intent(ranking, threshold, ambiguity):
    top = ranking[0]
    margin = top.get("confidence", 0) - (ranking[1].get("confidence", 0) if len(ranking) > 1 else 0)
    return top["name"] if top.get("confidence", 0) >= threshold and margin >= ambiguity else "nlu_fallback"


async def evaluate(
    model: Path, validation: Path, thresholds: list[float], selected: float,
    url=None, current_threshold=0.55
) -> dict[str, Any]:
    from rasa.shared.nlu.training_data.loading import load_data
    if not url:
        from rasa.core.agent import Agent
        agent = Agent.load(model)
    examples = load_data(str(validation)).intent_examples
    predictions = []

    for example in examples:
        if url:
            request = urllib.request.Request(url.rstrip("/") + "/model/parse",
                data=json.dumps({"text": example.get("text")}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(request, timeout=10) as response:
                parsed = json.load(response)
        else:
            parsed = await agent.parse_message(example.get("text"))
        ranking = raw_ranking(parsed, current_threshold)
        predictions.append(
            {
                "text": example.get("text"),
                "expected_intent": example.get("intent"),
                "raw_intent": ranking[0]["name"],
                "raw_confidence": ranking[0]["confidence"],
                "ranking": ranking,
            }
        )

    candidates = []
    for threshold in thresholds:
        for ambiguity in [0.05, 0.10, 0.15]:
            guessed = [calibrated_intent(p["ranking"], threshold, ambiguity) for p in predictions]
            correct = sum(g == p["expected_intent"] for g, p in zip(guessed, predictions))
            candidates.append({
                "threshold": threshold,
                "ambiguity_threshold": ambiguity,
                "accuracy": round(correct / len(predictions), 4),
                "correct": correct,
                "fallback_count": guessed.count("nlu_fallback"),
                "example_count": len(predictions),
            })
    best = max(candidates, key=lambda c: (c["correct"], c["threshold"], c["ambiguity_threshold"]))

    return {
        "model": str(model),
        "validation_set": str(validation),
        "model_sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
        "validation_sha256": hashlib.sha256(validation.read_bytes()).hexdigest(),
        "selection_rule": (
            "Choose the highest threshold/margin among equally accurate candidates "
            "on the explicitly separate calibration dataset only, "
            "then verify held-out regressions separately."
        ),
        "reference_threshold": selected,
        "recommended": best,
        "candidates": candidates,
        "predictions": predictions,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--validation", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--selected", type=float, default=0.55)
    parser.add_argument("--url")
    parser.add_argument("--current-threshold", type=float, default=0.55)
    parser.add_argument(
        "--thresholds",
        type=float,
        nargs="+",
        default=[0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65],
    )
    args = parser.parse_args()
    if args.out.exists():
        parser.error("Refusing to overwrite existing evidence")

    report = asyncio.run(
        evaluate(args.model, args.validation, args.thresholds, args.selected,
                 args.url, args.current_threshold)
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["candidates"], indent=2))


if __name__ == "__main__":
    main()