# Landa Travels — report evaluation tools

These tools are offline evidence utilities, not application startup commands.
They do not replace the deployed Rasa model or change traveller data.

## Evaluation source

The report evaluation uses immutable GitHub revision
`bbe39be9be5a50cd8ab48c2976201ff3b8d73806`, not whichever revision happens to be
checked out later. Minimal source copies and SHA-256 provenance are retained
under `reports/five-fold-cross-validation/`.

The actual Rasa loader merges repeated YAML intent blocks: this corpus has
496 examples across 21 intents. All classes meet the five-fold minimum.
Do not count only the last YAML block for each intent.

## Commands (repository root, Linux / Python 3.10 / Rasa 3.6.21)

```sh
# Original native attempt: downloads pinned source, then invokes the requested
# command. This attempt was stopped by the memory guard in the assessment run.
python reports/run_five_fold_cv.py

# Alternative: native Rasa stratified splits and five separate train/test
# process pairs; split seed 42 and unchanged training configuration.
python reports/run_isolated_five_fold_cv.py

# Refuses to package incomplete evaluation as completed evidence.
python reports/package_five_fold_cv.py

# Blank volunteer protocol/forms; no participant responses are generated.
python reports/build_user_testing_pack.py

# Requires completed CV evidence and the author's own input Word file.
python reports/build_final_submission.py --source /path/to/original-report.docx
```

Archive existing evaluation output before another run. Otherwise these
assessment runners write to the same paths; do not overwrite retained evidence.
Run offline grading away from live user testing. It can consume several GB of
memory and take substantial time; memory guards stop only evaluation children.
The native single-process command and alternative procedure are different
attempts and must be labelled separately.

## Metrics and limitations

`isolated-results/summary.json` pools one held-out prediction per eligible
example. It reports both pooled and mean-fold intent metrics. The population
standard deviation over five fold scores is not a confidence interval.

Entity JSON outputs are native per-extractor evaluations. They are not the
deployed-model merged exact-span F1 measurements and must not replace those.
No exact text crosses a fold's train/test split in this manifest, but related
templates can occur across folds; this is not grouped paraphrase-independent
evaluation. Training remains stochastic beyond the recorded split seed.

The original single-process run's raw log and failure record are retained.
Temporary fold model archives are deliberately not uploaded to either source
repository. The deployed full-data archive remains unchanged.

## Human-study integrity and privacy

Real think-aloud and Likert results require actual consenting participants.
The study documents are protocols, not completed studies. Automated proxy
evaluations remain labelled as proxy evaluations.

Do not publish participant identities, recordings, private responses, secrets,
or the author's private assignment file to GitHub or Hugging Face. Only these
tools and non-personal evaluation evidence are intended for repository sync.

## API excerpt

The report's short `_request_json` excerpt is already implemented in
`rasa-bot/actions/actions.py`: bounded request timeout, HTTP/JSON failure
handling, warning and `None` return. It is not a new production-code change.