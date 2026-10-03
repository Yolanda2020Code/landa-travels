"""Sync only allow-listed, non-personal evaluation files to the existing Space."""
import json
from pathlib import Path

from huggingface_hub import CommitOperationAdd, HfApi

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "reports/final-submission/public-evidence-manifest.json"
REPO = "yolandankala/landa-travels"


def main():
    paths = json.loads(MANIFEST.read_text())["paths"]
    assert paths
    for value in paths:
        path = Path(value)
        assert not path.is_absolute() and ".." not in path.parts
        assert value.startswith("reports/")
        assert path.suffix not in {".docx", ".pdf"}
        assert path.name != "Landa-Travels-Final-Report.docx"
        assert ".env" not in path.parts and "models" not in path.parts
        assert (ROOT / path).is_file()
    api = HfApi()  # Uses the configured HF_TOKEN internally; never prints it.
    previous = api.repo_info(REPO, repo_type="space", timeout=30).sha
    result = api.create_commit(
        repo_id=REPO, repo_type="space",
        operations=[CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(ROOT / p)) for p in paths],
        commit_message="Add completed five-fold NLU evaluation and non-personal report tools",
        parent_commit=previous,
    )
    receipt = {"repo": REPO, "previous_revision": previous,
               "commit": result.oid, "url": result.commit_url,
               "files_added_or_updated": len(paths)}
    (ROOT / "reports/final-submission/huggingface-sync.json").write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()