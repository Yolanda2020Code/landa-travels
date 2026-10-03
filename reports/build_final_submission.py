"""Revise the uploaded report in place structurally, preserving existing figures."""
import json
import re
import textwrap
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from docx.shared import Inches, Pt
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "reports/final-submission"
CV = ROOT / "reports/five-fold-cross-validation/isolated-results"

FR = [
    ("FR1", "Adaptive intake", "Traveller supplies route, future dates, party, currency/budget, priority and preferences.",
     "Rasa form validates each field; asks for missing/invalid values; review reflects the accepted inputs.",
     "Core/source tests + browser corrections; free-text NLU gaps remain."),
    ("FR2", "Optional location", "Traveller chooses skip, manual place or GPS.",
     "GPS requires explicit browser permission; manual/skip paths remain usable without GPS.",
     "Permission/consent branches; no hidden GPS requirement."),
    ("FR3", "Verified retrieval", "Traveller reviews carbon, flights, stays, transit and events.",
     "Sources and estimate/quote basis are visible; outages/missing coverage produce unavailable states.",
     "Provider/source tests; city coverage is incomplete."),
    ("FR4", "Weighted ranking", "Traveller chooses climate-first, balanced or comfort-first.",
     "Priority changes category-local weights; incompatible currency/quote bases are not compared.",
     "Ranking tests + documented weights; no claim of global optimality."),
    ("FR5", "Human assistance", "Traveller reviews the bounded summary and chooses consent.",
     "No submission before consent; advisor queue is role-protected; assignment/replies follow lifecycle rules.",
     "Handover and ownership tests; asynchronous, not instant service."),
    ("FR6", "Recovery and edits", "Traveller gives an invalid/ambiguous answer or changes one field.",
     "Clarify the field; preserve unrelated slots; invalidate approval and seek a fresh review.",
     "Core + browser evidence; unseen phrasing can still fail."),
    ("FR7", "Save and resume", "Signed-in traveller saves, reopens and resumes an owned trip.",
     "Persisted validated context is restored; another identity cannot read or update that trip.",
     "Persistence/authorization tests + hosted evidence."),
]
NFR = [
    ("NFR1", "Usability", "Plain prompts, review/correction, explanations and human-help discovery.",
     "Think-aloud tasks and item-level five-point survey; independent/assisted success kept separate.",
     "Participant study NOT completed. Automated proxy scores are not human feedback."),
    ("NFR2", "Reliability", "Desktop/mobile flows retain state; provider failure never creates invented inventory.",
     "Core/source/browser tests plus planned per-provider outage and concurrent-load checks.",
     "Passing fixed cases; no load or availability-SLA evidence."),
    ("NFR3", "Latency", "Target: under 3 s from send to visible reply on critical turns.",
     "Browser-observed elapsed time, including lookup/render; record warm/cold and concurrency separately.",
     "29 warm development turns met target; cold/load claims remain unverified."),
    ("NFR4", "Accessibility", "Text with colour, keyboard controls, announced statuses and manual alternatives.",
     "Keyboard/responsive checks; future assistive-technology audit against WCAG 2.2.",
     "Design controls present; no full screen-reader or conformance audit."),
    ("NFR5", "Privacy", "Owner-only context; consented bounded handover; 30-day conversation expiry.",
     "Authorization/retention tests; GPS/tokens/unrelated history excluded from handover.",
     "Verified controls do NOT establish complete GDPR compliance."),
    ("NFR6", "Environmental integrity", "Source/basis for estimates; certificates only from named official registry evidence.",
     "Provider evidence/label checks; show map/estimate/certification distinctions and separate offsets.",
     "Integrity controls present; no independent environmental-impact assessment."),
]


@lru_cache(maxsize=20)
def font(size, bold=False):
    candidates = list(Path("/usr/share/fonts").rglob("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")) if Path("/usr/share/fonts").exists() else []
    if not candidates:
        candidates = list(Path("/nix/store").glob("*/share/fonts/truetype/DejaVuSans-Bold.ttf" if bold else "*/share/fonts/truetype/DejaVuSans.ttf"))
    if not candidates:
        candidates = list(Path("/nix/store").glob("*/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "*/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
    return ImageFont.truetype(str(candidates[0]), size) if candidates else ImageFont.load_default(size=size)


def wrapped(draw, text, x, y, width, f, fill, spacing=6):
    words = text.split()
    line, lines = "", []
    for word in words:
        trial = (line + " " + word).strip()
        if draw.textlength(trial, font=f) > width and line:
            lines.append(line)
            line = word
        else:
            line = trial
    if line:
        lines.append(line)
    for line in lines:
        draw.text((x, y), line, font=f, fill=fill)
        y += f.size + spacing
    return y


def requirements_visual(rows, title, subtitle, columns, filename, row_height):
    w = 1800
    top = 250
    h = top + row_height * len(rows) + 90
    image = Image.new("RGB", (w, h), "#ffffff")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((22, 20, w-22, 140), radius=20, fill="#173e35")
    draw.text((52, 35), title, font=font(45, True), fill="white")
    draw.text((54, 96), subtitle, font=font(25), fill="#d1e8df")
    widths = [170, 480, 610, 500]
    xs = [40]
    for width in widths:
        xs.append(xs[-1] + width)
    for col, x in zip(columns, xs):
        draw.text((x+12, 170), col, font=font(29, True), fill="#173e35")
    draw.line((40, 224, w-40, 224), fill="#7ba590", width=3)
    for i, row in enumerate(rows):
        y = top + i * row_height
        draw.rounded_rectangle((40, y-5, w-40, y+row_height-12), radius=12,
                               fill="#f0f6f3" if i % 2 == 0 else "#f8faf9")
        draw.text((xs[0]+12, y+15), row[0], font=font(34, True), fill="#235a46")
        task = row[1] + "\n" + row[2]
        end = wrapped(draw, task, xs[1]+12, y+12, widths[1]-32, font(28), "#202c28")
        assert end <= y+row_height-12, (row[0], "task overflow")
        end = wrapped(draw, row[3], xs[2]+12, y+12, widths[2]-32, font(28), "#202c28")
        assert end <= y+row_height-12, (row[0], "criterion overflow")
        end = wrapped(draw, row[4], xs[3]+12, y+12, widths[3]-32, font(27), "#35463e")
        assert end <= y+row_height-12, (row[0], "evidence overflow")
    draw.text((50, h-60), "Read left to right: requirement → observable criterion → verification and evidence boundary.",
              font=font(25), fill="#466757")
    image.save(OUT / filename)


def use_case_visual():
    image = Image.new("RGB", (1800, 1530), "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((25, 20, 1775, 145), radius=20, fill="#173e35")
    draw.text((55, 40), "Functional use cases and access boundaries", font=font(43, True), fill="white")
    draw.text((55, 100), "What each actor can do — requirement IDs link this model to Table 2", font=font(26), fill="#d1e8df")
    draw.rounded_rectangle((360, 175, 1360, 1375), radius=28, fill="#f5faf7", outline="#688c78", width=4)
    draw.text((410, 195), "Landa Travels system boundary", font=font(34, True), fill="#173e35")
    def actor(x, y, label):
        draw.ellipse((x-23, y-78, x+23, y-32), outline="#173e35", width=5)
        draw.line((x, y-30, x, y+40), fill="#173e35", width=5)
        draw.line((x-42, y, x+42, y), fill="#173e35", width=5)
        draw.line((x, y+40, x-37, y+85), fill="#173e35", width=5)
        draw.line((x, y+40, x+37, y+85), fill="#173e35", width=5)
        wrapped(draw, label, x-120, y+100, 250, font(30, True), "#173e35")
    actor(125, 620, "Traveller")
    draw.line((170, 620, 290, 620), fill="#688c78", width=4)
    draw.line((290, 310, 290, 1290), fill="#688c78", width=4)
    titles = [
        "FR1  Plan and review a validated trip",
        "FR2  Skip / manually set / permit GPS",
        "FR3  Inspect sourced travel options",
        "FR4  Choose priority and compare ranking",
        "FR5  Review and consent to human help",
        "FR6  Clarify, edit and approve again",
        "FR7  Save and resume an owned trip",
    ]
    guards = [
        "Validated slots; missing / invalid fields asked again",
        "Optional location; no permission means no GPS",
        "Provider evidence; unavailable is not inventory",
        "Comparable categories, currency and quote basis",
        "Unticked consent; bounded summary; role checks",
        "Preserve unrelated details; invalidate old approval",
        "Verified identity and server-side ownership",
    ]
    centres = []
    for i, (title, guard) in enumerate(zip(titles, guards)):
        y = 275 + i*150
        centres.append(y+62)
        draw.line((290, y+62, 395, y+62), fill="#688c78", width=4)
        draw.ellipse((395, y, 1315, y+124), fill="white", outline="#3c755b", width=3)
        draw.text((442, y+22), title, font=font(32, True), fill="#173e35")
        draw.text((442, y+70), guard, font=font(25), fill="#466757")
    actor(1590, centres[2]-10, "Named data providers")
    actor(1590, centres[4]-10, "Human advisor")
    actor(1590, centres[6]-10, "Identity service")
    for i in [2, 4, 6]:
        draw.line((1315, centres[i], 1545, centres[i]), fill="#688c78", width=4)
    wrapped(draw, "Public planning does not require sign-in. FR7 requires authentication; FR5 requires explicit sharing consent.",
            80, 1420, 1630, font(29), "#466757")
    image.save(OUT / "functional-use-cases.png")


def para_before(anchor, text="", style=None):
    p = anchor.insert_paragraph_before(text, style)
    p.paragraph_format.space_after = Pt(6)
    return p


def picture_before(anchor, filename, caption, width=6.35):
    p = para_before(anchor)
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(str(filename), width=Inches(width))
    c = para_before(anchor, caption)
    for r in c.runs:
        r.font.size = Pt(9)
        r.italic = True


def add_table_before(doc, anchor, headers, rows):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    for c, value in zip(t.rows[0].cells, headers):
        c.text = value
    t.rows[0]._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
    for row in rows:
        for c, text in zip(t.add_row().cells, row):
            c.text = str(text)
    for row in t.rows:
        row._tr.get_or_add_trPr().append(OxmlElement("w:cantSplit"))
        for c in row.cells:
            for p in c.paragraphs:
                for r in p.runs:
                    r.font.size = Pt(9)
    anchor._p.addprevious(t._tbl)
    return t


def main(source_docx):
    OUT.mkdir(parents=True, exist_ok=True)
    summary_path = CV / "summary.json"
    status = json.loads((CV / "run-status.json").read_text())
    if status["state"] != "completed":
        raise RuntimeError("Final report requires completed five-fold evidence.")
    cv = json.loads(summary_path.read_text())
    assert cv["folds_completed"] == 5
    manifest = json.loads((CV / "split-manifest.json").read_text())
    d = Document(source_docx)
    original = list(d.paragraphs)
    def replace(index, text):
        original[index].text = text

    # Retain the user's document, original images and academic front matter.
    replace(86,
        "Tables 2–3 translate the brief into observable acceptance criteria, implementation boundaries and evidence status. "
        "Figures R1–R2 expose their traceability: a passing code test is not proof of usability, legal compliance or "
        "environmental benefit. Environmental integrity is an explicit quality requirement.")
    # Expand evidence/status wording without adding new unsupported functionality.
    for i, row in enumerate(d.tables[1].rows[1:]):
        fr = FR[i]
        row.cells[2].text = fr[3]
        row.cells[3].text = fr[4]
    for i, row in enumerate(d.tables[2].rows[1:]):
        nfr = NFR[i]
        row.cells[2].text = nfr[2] + " Check: " + nfr[3]
        row.cells[3].text = nfr[4]

    requirements_visual(FR, "Functional requirements: behaviour and evidence",
                        "Traveller actions → validated system behaviour → acceptance evidence",
                        ["ID", "User task / requirement", "System acceptance criterion", "Verification / limitation"],
                        "functional-requirements.png", 205)
    requirements_visual(NFR, "Non-functional requirements: measurable quality",
                        "Quality targets are separated from tested controls and unverified claims",
                        ["ID", "Quality attribute / target", "Verification method", "Evidence boundary"],
                        "non-functional-requirements.png", 245)
    use_case_visual()
    picture_before(original[91], OUT / "functional-use-cases.png",
                   "Figure R0. Functional use-case model with traveller, provider, advisor and identity boundaries; FR IDs link to Table 2.")
    picture_before(original[91], OUT / "functional-requirements.png",
                   "Figure R1. Functional requirements traceability across traveller tasks, acceptance behaviour and verification.")
    picture_before(original[91], OUT / "non-functional-requirements.png",
                   "Figure R2. Quality-attribute verification model, including latency scope, privacy controls and participant-study gaps.")

    # The short helper already exists in the cited published action code.
    api_anchor = next(p for p in original if p.text == "5.4 Weighted ranking")
    para_before(api_anchor,
        "The provider helper below bounds HTTP waits and distinguishes request/JSON failures from usable data. "
        "Returning None allows the calling action to label the result unavailable; the helper alone does not prove every user-facing failure branch.")
    para_before(api_anchor, "Listing 1. Actual API error handling, rasa-bot/actions/actions.py (published source, lines 435–451).")
    code = para_before(api_anchor)
    snippet = (
        "def _request_json(method: str, url: str, *,\n"
        "                  headers: dict[str, str] | None = None,\n"
        "                  data: dict[str, Any] | None = None,\n"
        "                  timeout: float = 2.3) -> dict[str, Any] | None:\n"
        "    try:\n"
        "        response = requests.request(\n"
        "            method, url, headers=headers, json=data, timeout=timeout)\n"
        "        response.raise_for_status()\n"
        "        return response.json()\n"
        "    except (requests.RequestException, ValueError) as exc:\n"
        "        logger.warning(\"External API request failed: %s\", exc)\n"
        "        return None"
    )
    r = code.add_run(snippet)
    r.font.name = "Consolas"
    r.font.size = Pt(8)
    code.paragraph_format.keep_together = True

    replace(195,
        "Testing separates deployed-model NLU, Core action prediction, source checks, browser observations and "
        "new fold-trained NLU models. The published revision/model anchors the existing results; five-fold evaluation "
        "uses the same immutable source corpus but different newly trained models. Figure 22 separates these evidence layers.")
    replace(202,
        "The eight intent errors (Table 7) include carbon-method/footprint confusion, short routes sent to fallback "
        "and access needs interpreted as location choices. Main-set entity precision 1.000 and recall 0.750 indicate "
        "conservative extraction. The separate held-out drop limits generalisation claims; cross-validation below "
        "does not replace these deployed-model results.")
    anchor = original[205]
    para_before(anchor,
        "I additionally evaluated 496 Rasa-loaded examples across 21 intents using five stratified folds "
        "(split seed 42; no excluded classes). Each fold trained the unchanged 100-epoch DIET configuration on four folds "
        "and tested the remaining fifth through separate native Rasa processes. The original one-process cross-validation "
        "command was memory-stopped; Table CV1 reports the completed alternative, not a successful run of that command.")
    para_before(anchor, "Table CV1. Five-fold held-out intent metrics for newly trained models.")
    rows = [
        [r["fold"], r["n"], f'{100*r["accuracy"]:.2f}%', f'{r["macro_f1"]:.4f}', f'{r["weighted_f1"]:.4f}']
        for r in cv["fold_metrics"]
    ]
    rows.append(["Pooled", cv["test_examples"], f'{100*cv["pooled_out_of_fold_accuracy"]:.2f}%',
                 f'{cv["pooled_macro_f1"]:.4f}', f'{cv["pooled_weighted_f1"]:.4f}'])
    add_table_before(d, anchor, ["Fold", "Test n", "Accuracy", "Macro F1", "Weighted F1"], rows)
    para_before(anchor,
        f'Pooled accuracy was {cv["correct"]}/{cv["test_examples"]}; mean fold accuracy was '
        f'{100*cv["mean_fold_accuracy"]:.2f}% with population SD {100*cv["std_fold_accuracy_population"]:.2f} '
        "percentage points (not a confidence interval). Figure CV1 pools one held-out prediction per example. "
        "Exact text did not overlap train/test within folds, but related templates may cross folds. "
        "Native per-extractor entity scores are not the merged-span F1 in Table 6.")
    matrix_files = list((CV / "pooled-intent-results").glob("*confusion_matrix*.png"))
    assert len(matrix_files) == 1, matrix_files
    picture_before(anchor, matrix_files[0],
                   "Figure CV1. Pooled out-of-fold intent confusion matrix (496 predictions; actual labels on rows, predicted labels on columns).",
                   width=6.45)
    matrix = cv["confusion_matrix"]
    labels = cv["confusion_matrix_labels"]
    confusions = sorted(
        [(matrix[i][j], labels[i], labels[j]) for i in range(len(labels)) for j in range(len(labels))
         if i != j and matrix[i][j]], reverse=True
    )
    top = "; ".join(f"{a} → {b} ({n})" for n, a, b in confusions[:4])
    para_before(anchor, "The largest observed confusion cells were " + top +
                ". These indicate where more varied labelled utterances and separate held-out checks are needed; "
                "cross-validation alone does not establish real-world travel understanding.")

    replace(208,
        "No real participants have completed this study. Three earlier scripted walkthroughs were scored by one "
        "automated evaluator: only one reached recommendations; clarity/trust averaged 2.33, ease 2.00 and persuasion "
        "without pressure 4.00. These are proxy judgements, not human Likert data. Appendix C defines four think-aloud "
        "tasks, consent, six survey items and outcome recording for 3–5 adults; participant results remain unavailable.")
    replace(226,
        "Landa Travels combines validated Rasa dialogue, explicit trade-offs and consented handover. Provenance is "
        "its main contribution, not a demonstrated change in travel behaviour. Five-fold evaluation now supplements "
        "the deployed-model tests, with within-corpus limitations. Unseen phrasing, typed currencies and data coverage "
        "remain weaknesses; genuine participant sessions and accessibility/load testing are still required.")

    # Append an honest, immediately usable study protocol instead of fabricated sessions.
    d.add_page_break()
    d.add_heading("Appendix C. Real-user study protocol and evidence status", level=1)
    d.add_paragraph(
        "Status: prepared, not conducted. No participant responses, timings, quotations or Likert results are claimed. "
        "Recruit 3–5 consenting adults who did not develop the system; use anonymous IDs and fictional trip details. "
        "Test individually for 25–35 minutes on the same app revision and device/browser conditions. "
        "Record any technical block separately from an interaction difficulty; never silently score assistance as independent success.")
    d.add_paragraph(
        "Consent script: Participation is voluntary; you may stop or skip questions. I will record anonymous task "
        "observations and survey responses for this assignment. Use fictional details only. No voice/screen recording "
        "or identifying details will be retained without separate permission. Agree a deletion date before starting.")
    d.add_paragraph(
        "Think-aloud prompt: Say what you are looking for, what you expect to happen and what is confusing. "
        "The observer should not suggest the correct action; after silence ask only, 'What are you thinking now?'")
    tasks = [
        ["T1", "Plan Berlin–Paris for two adults, future dates, EUR 1,000 and balanced priority; review and approve.",
         "Correct context retained; reaches results or an explicitly unavailable outcome. Record those outcomes separately.", "10 min"],
        ["T2", "Change only the departure city to Leipzig; review and approve again.",
         "Origin changes; destination/other details persist; previous approval invalidated.", "5 min"],
        ["T3", "Explain a carbon estimate/source and one limitation; distinguish mapped/certified stays from availability.",
         "Record the participant's actual explanation, not whether a control opened.", "5 min"],
        ["T4", "Find human help and explain summary, consent and asynchronous replies. Do not submit a live request.",
         "Discovery and comprehension only; no claim of advisor receipt or delivery.", "5 min"],
    ]
    # Append table via an end anchor to keep standard document structure.
    end = d.add_paragraph()
    add_table_before(d, end, ["Task", "Participant task", "Success criterion", "Time cap"], tasks)
    d.add_paragraph(
        "Observer fields: anonymous ID; date/revision; device/browser; task; independent success / assisted success / "
        "partial / failed / technical block / not attempted; elapsed seconds; cap reached; assistance count; "
        "anonymous observation and suggested change. Summarise per-task counts and median/range times with denominators.")
    d.add_paragraph(
        "Survey: 1 strongly disagree, 2 disagree, 3 neutral, 4 agree, 5 strongly agree; N/A if not experienced. "
        "These are study-specific items, not a validated SUS or trust scale.")
    items = [
        "The assistant's questions and instructions were clear.",
        "It was easy to complete the planning tasks.",
        "I understood why a travel option was recommended.",
        "I understood the sources and limitations of carbon/sustainability claims.",
        "I felt in control when correcting details or choosing human assistance.",
        "I could judge when to rely on the information from its labels and limitations.",
    ]
    for i, item in enumerate(items, 1):
        d.add_paragraph(f"Q{i}. {item}")
    d.add_paragraph(
        "Open questions: What was most confusing? What helped explain a recommendation? What one change would help? "
        "Report each item's valid n, median/range and N/A count after real sessions. No significance or general-population "
        "claim is justified by 3–5 convenience-sample participants. Keep proxy and participant scores separate.")

    d.add_heading("Appendix D. Cross-validation reproducibility and source sync", level=1)
    d.add_paragraph(
        "The original command and failed raw log are retained in reports/five-fold-cross-validation/. "
        "The completed process-isolated runner uses Rasa generate_folds and separate native train/test processes. "
        "The split manifest retains eligible counts, hashes, held-out sizes and exact-text overlap checks; each fold retains "
        "native reports, predictions and logs. Evaluation models are temporary evidence, not deployment replacements.")
    for command in [
        "python reports/run_five_fold_cv.py  # original memory-stopped attempt",
        "python reports/run_isolated_five_fold_cv.py  # completed alternative",
        "python reports/package_five_fold_cv.py",
    ]:
        p = d.add_paragraph(command)
        for r in p.runs:
            r.font.name = "Consolas"
            r.font.size = Pt(9)
    d.add_paragraph("Evaluation source revision: " + cv["source_revision"] +
                    ". The deployable archive/hash in Appendix A is unchanged. Do not overwrite evidence or treat a "
                    "newly trained fold model as the deployed archive.")
    d.add_paragraph(
        "Preparation used automated evaluation and code-assisted document editing. The author must follow the "
        "institution's disclosure rules for such assistance. No human participant responses have been generated or invented.")
    sync_file = OUT / "repository-sync.json"
    if sync_file.exists():
        sync = json.loads(sync_file.read_text())
        d.add_paragraph(
            "Evaluation code and non-personal evidence were added to both repositories; the private academic report "
            "was not uploaded. GitHub commit: " + sync["github_commit"] + ". Hugging Face commit: " + sync["huggingface_commit"] + ".")

    # Rebuild a simple contents list; LibreOffice fills PAGE references on render.
    for p in original[30:63]:
        if p.text:
            p._element.getparent().remove(p._element)
    toc_anchor = original[64]
    toc = para_before(toc_anchor)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), 'TOC \\o "1-2" \\h \\z \\u')
    toc._p.append(field)
    settings = d.settings.element
    update = OxmlElement("w:updateFields")
    update.set(qn("w:val"), "true")
    settings.append(update)

    # Report the actual narrative count, rather than retaining the old 2,998.
    narrative = []
    inside = False
    for p in d.paragraphs:
        if p.text == "1. Introduction":
            inside = True
        if p.text == "References":
            inside = False
        if inside and p.text and not re.match(r"^(Figure |Table |Listing |\\d+(?:\\.\\d+)?\\.?)", p.text):
            if not any(r.font.name == "Consolas" for r in p.runs):
                narrative.append(p.text)
    word_count = len(re.findall(r"\b\S+\b", " ".join(narrative)))
    original[27].text = (
        f"Main narrative word count: {word_count:,} (excludes headings, tables, captions, code listings, references and appendices; "
        "verify against the institution's counting rules).")
    (OUT / "report-validation.json").write_text(json.dumps({
        "main_narrative_words": word_count, "original_figures_preserved": 26,
        "final_inline_shapes": len(d.inline_shapes), "five_folds_completed": cv["folds_completed"],
        "actual_user_participants": 0, "user_study_status": "not conducted",
        "source_revision": cv["source_revision"],
    }, indent=2))
    d.save(OUT / "Landa-Travels-Final-Report.docx")
    print("Final Word report saved; narrative words:", word_count)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="The author's original Word report (not uploaded to the repositories).")
    main(parser.parse_args().source)