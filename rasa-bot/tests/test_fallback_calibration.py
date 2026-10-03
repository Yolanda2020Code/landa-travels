import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("calibration", Path(__file__).parents[1] / "scripts/tune_fallback.py")
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)


def test_learned_fallback_is_not_removed():
    ranks = [{"name": "nlu_fallback", "confidence": .9}, {"name": "inform", "confidence": .08}]
    assert calibration.raw_ranking({"intent_ranking": ranks}, .55) == ranks


def test_only_one_inserted_fallback_is_removed():
    ranks = [{"name": "nlu_fallback", "confidence": .55},
             {"name": "nlu_fallback", "confidence": .3}, {"name": "inform", "confidence": .2}]
    assert calibration.raw_ranking({"intent_ranking": ranks}, .55) == ranks[1:]


def test_threshold_and_ambiguity_are_both_respected():
    ranking = [{"name": "inform", "confidence": .5}, {"name": "deny", "confidence": .44}]
    assert calibration.calibrated_intent(ranking, .4, .1) == "nlu_fallback"
    assert calibration.calibrated_intent(ranking, .4, .05) == "inform"
    assert calibration.calibrated_intent(ranking, .55, .05) == "nlu_fallback"