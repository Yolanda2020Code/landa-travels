# Landa Travels — evaluation evidence

These utilities reproduce offline NLU evaluation. They do not replace the deployed Rasa model or change traveller data.

## Evaluation source

The recorded evaluation uses immutable GitHub revision
`bbe39be9be5a50cd8ab48c2976201ff3b8d73806`. Source copies, checksums, metrics and raw evidence are retained under `reports/five-fold-cross-validation/`.

The Rasa loader merges repeated YAML intent blocks: the corpus contains **496 examples across 21 intents**, all eligible for five-fold evaluation.

## Reproduction

Use Linux, Python 3.10 and Rasa 3.6.21 with the existing Rasa/spaCy/scikit-learn environment.

```sh
# Original single-process attempt; stopped by the memory guard.
python reports/run_five_fold_cv.py

# Completed alternative: five separate native Rasa train/test process pairs.
# Stratified splits, seed 42, unchanged training configuration.
python reports/run_isolated_five_fold_cv.py

# Package only completed evaluation evidence.
python reports/package_five_fold_cv.py
```

Archive existing outputs before another run. These commands reuse evaluation paths and can consume several GB of memory; run them separately from live application use.

## Results and interpretation

The pooled out-of-fold results are **66.53% intent accuracy**, **0.658 weighted F1** and **0.636 macro F1**, based on one held-out prediction per example.

- Mean-fold and pooled metrics are distinct; fold-score standard deviation is not a confidence interval.
- Native per-extractor entity scores are not the deployed model's merged exact-span entity scores.
- Native Rasa classifier-intent evaluation reverses FallbackClassifier selection; it does not measure fallback-dialogue recovery.
- Exact texts do not cross fold boundaries, but related templates can; this is not paraphrase-group-independent evaluation.
- Training remains stochastic beyond the recorded split seed.

The failed single-process attempt and its raw log are retained. Temporary fold models are not published; the evaluated deployed model is unchanged.

## Evidence integrity and privacy

Do not present automated or proxy evaluations as human participant studies. Real think-aloud or survey findings require actual consenting participants. Keep participant identities, recordings, private responses and credentials out of public repositories.

The final report is published separately at the author's request: [Landa Travels final report](Landa-Travels-Final-Report-2026.pdf).

For application setup and test commands, see [Setup and deployment](../docs/SETUP.md).
