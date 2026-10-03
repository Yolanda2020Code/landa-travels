"""Package only completed, genuine isolated CV output for the report."""
import csv
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from docx import Document
from docx.shared import Inches, Pt

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "reports/five-fold-cross-validation"
OUT = BASE / "isolated-results"


def main():
    state = json.loads((OUT / "run-status.json").read_text())
    assert state["state"] == "completed", "Refusing to package an incomplete run."
    summary = json.loads((OUT / "summary.json").read_text())
    split = json.loads((OUT / "split-manifest.json").read_text())
    assert summary["folds_completed"] == state["completed_test_folds"] == 5
    assert sum(r["n"] for r in summary["fold_metrics"]) == summary["test_examples"]
    percent = lambda value: f"{100 * value:.2f}%"
    d = Document()
    d.styles["Normal"].font.size = Pt(10)
    for s in d.sections:
        s.left_margin = s.right_margin = Inches(.7)
    d.add_heading("Landa Travels: five-fold NLU cross-validation", 0)
    d.add_paragraph("Completed alternative process-isolated evaluation. All figures below derive from retained native Rasa output.")
    d.add_heading("Procedure and identity", 1)
    d.add_paragraph("Immutable public source revision: " + summary["source_revision"])
    d.add_paragraph("Started (UTC): " + state["started_at_utc"] + ". Finished (UTC): " + state["finished_at_utc"] + ".")
    d.add_paragraph(
        f"Rasa loaded {split['original_examples']} examples across {len(split['original_intent_counts'])} intents. "
        f"The eligible corpus contains {split['eligible_examples']} examples and {split['eligible_intents']} intents; "
        f"excluded classes: {split['excluded_intents_below_five'] or 'none'}. "
        "Five stratified utterance-level folds use split seed 42. Each fold trains a fresh NLU model on four folds "
        "and evaluates the fifth using separate native Rasa CLI processes. The unchanged configuration specifies DIET "
        "100 epochs and ResponseSelector 100 epochs; native logs show which components trained. "
        "Held-out regression datasets are not used as training or CV input.")
    d.add_heading("Intent classification results", 1)
    t = d.add_table(rows=1, cols=5)
    t.style = "Light Shading Accent 1"
    headers = ["Fold", "Test examples", "Accuracy", "Macro F1", "Weighted F1"]
    for c, h in zip(t.rows[0].cells, headers):
        c.text = h
    for r in summary["fold_metrics"]:
        row = [str(r["fold"]), str(r["n"]), percent(r["accuracy"]),
               f"{r['macro_f1']:.4f}", f"{r['weighted_f1']:.4f}"]
        for c, value in zip(t.add_row().cells, row):
            c.text = value
    d.add_paragraph(
        f"Pooled out-of-fold intent accuracy: {summary['correct']}/{summary['test_examples']} "
        f"({percent(summary['pooled_out_of_fold_accuracy'])}). "
        f"Pooled macro F1: {summary['pooled_macro_f1']:.4f}; weighted F1: {summary['pooled_weighted_f1']:.4f}. "
        f"Mean fold accuracy: {percent(summary['mean_fold_accuracy'])}; population standard deviation: "
        f"{100 * summary['std_fold_accuracy_population']:.2f} percentage points. "
        "Pooled and mean-of-fold metrics have different denominators/weighting; the standard deviation is not a confidence interval.")
    d.add_heading("Limitations and the original command", 1)
    d.add_paragraph(
        "The requested single-process 'rasa test nlu --cross-validation --folds 5' attempt was stopped by the memory guard "
        "and did not complete. Its raw log and failure record are included. The completed alternative performs equivalent "
        "stratified train/test roles in separate processes, but uses a fixed split seed and is not claimed to be that "
        "successful original command or its identical randomly chosen splits.")
    d.add_paragraph(
        "These scores concern five newly trained NLU models, not the deployed full-data archive. They do not replace "
        "the report's 40/48 held-out intent result, merged-span entity metrics, Core stories or real-user study. "
        "Native entity outputs remain per-extractor; do not label their values as merged-span F1. "
        "No exact training/test text overlap was found in the fold manifest, but related templates/paraphrases may occur "
        "across folds. Model training is stochastic beyond the recorded split seed.")
    d.add_heading("Paragraph to adapt for Section 6.2", 1)
    d.add_paragraph(
        f"A process-isolated stratified five-fold evaluation was completed using the published-source NLU corpus "
        f"({summary['test_examples']} examples, {summary['eligible_intents']} intents; no excluded classes). "
        f"Each fold trained a new NLU pipeline and evaluated its held-out fifth. Pooled intent accuracy was "
        f"{summary['correct']}/{summary['test_examples']} ({percent(summary['pooled_out_of_fold_accuracy'])}), "
        f"with macro F1 {summary['pooled_macro_f1']:.4f}. The original one-process command was memory-stopped, "
        "so this alternative procedure is reported explicitly. These results estimate within-corpus generalisation "
        "of fold-trained models, not the performance of the deployed archive or unseen travel phrasings. "
        "The existing independent held-out evaluation remains separate.")
    d.add_heading("Files and visual to use", 1)
    d.add_paragraph(
        "Use isolated-results/summary.json and fold-*/test-results/intent_report.json for numbers. "
        "The aggregate native Rasa confusion matrix is in isolated-results/pooled-intent-results/. "
        "Read its off-diagonal cells alongside the actual intent_errors.json files before writing error analysis. "
        "Keep tables/matrix captions labelled as cross-validation, distinct from the held-out model results.")
    d.save(BASE / "Landa-CV-Summary.docx")
    with (BASE / "Landa-CV-Fold-Metrics.csv").open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["fold", "n", "accuracy", "macro_f1", "weighted_f1"])
        writer.writeheader()
        writer.writerows(summary["fold_metrics"])
    checksums = []
    for p in sorted(BASE.rglob("*")):
        if p.is_file() and "models" not in p.relative_to(BASE).parts and ".rasa" not in p.relative_to(BASE).parts:
            if p.name == "SHA256SUMS.txt":
                continue
            checksums.append(hashlib.sha256(p.read_bytes()).hexdigest() + "  " + str(p.relative_to(BASE)))
    (BASE / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n")
    print("Completed CV summary ready; render Word to PDF before packaging the final ZIP.")


if __name__ == "__main__":
    main()