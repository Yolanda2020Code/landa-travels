"""Run the requested native Rasa CV against the report's immutable public source.

Only evaluation copies and output files are written. Serving models are untouched.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "reports" / "five-fold-cross-validation"
SOURCE = OUT / "source" / "rasa-bot"
REVISION = "bbe39be9be5a50cd8ab48c2976201ff3b8d73806"
FILES = ["config.yml", "domain.yml", "data/nlu.yml",
         "travel_nlu/__init__.py", "travel_nlu/entity_extractor.py",
         "travel_nlu/entity_rules.py", "travel_nlu/value_normalisation.py"]


def get_source(name):
    url = f"https://raw.githubusercontent.com/Yolanda2020Code/landa-travels/{REVISION}/rasa-bot/{name}"
    with urllib.request.urlopen(url, timeout=40) as r:
        content = r.read()
    target = SOURCE / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return {"path": name, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(get_source, FILES))
    command = ["rasa", "test", "nlu", "--cross-validation", "--folds", "5",
               "--nlu", "data/nlu.yml", "--config", "config.yml",
               "--domain", "domain.yml", "--out", str(OUT / "native-results")]
    record = {
        "source_revision": REVISION,
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "command": command, "working_directory": str(SOURCE.relative_to(ROOT)),
        "source_files": files, "state": "running",
        "scope": "Five newly trained native cross-validation NLU models; not evaluation or replacement of the deployed full-data archive.",
        "split_scope": "Native Rasa stratified shuffled utterance splits; no explicit seed or group deduplication. Held-out regression datasets are excluded.",
        "resource_guard": "Stop CV if the container uses over 7.2 GiB or evaluation parent exceeds 3.0 GiB RSS. Do not stop serving services.",
    }
    status = OUT / "run-status.json"
    status.write_text(json.dumps(record, indent=2))
    env = dict(os.environ, PYTHONPATH=str(SOURCE), TF_NUM_INTRAOP_THREADS="1",
               TF_NUM_INTEROP_THREADS="1", OMP_NUM_THREADS="1", MALLOC_ARENA_MAX="2")
    print("Starting native five-fold cross-validation; deployed model will not change.", flush=True)
    with (OUT / "native-cross-validation.log").open("w") as log:
        log.write("COMMAND: " + " ".join(command) + "\n")
        log.flush()
        child = subprocess.Popen(command, cwd=SOURCE, env=env, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        while child.poll() is None:
            time.sleep(8)
            proc_status = Path(f"/proc/{child.pid}/status")
            rss = 0
            if proc_status.exists():
                for line in proc_status.read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1]) * 1024
            usage = int(Path("/sys/fs/cgroup/memory.current").read_text())
            if usage > 7.2 * 1024**3 or rss > 3 * 1024**3:
                record["resource_stopped"] = True
                log.write("\nSTOPPED: memory guard; no complete cross-validation score is claimed.\n")
                log.flush()
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                break
    record["exit_code"] = child.returncode
    record["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    record["state"] = "completed" if child.returncode == 0 else "failed"
    record["outputs"] = [str(p.relative_to(OUT)) for p in sorted(OUT.rglob("*"))
                         if p.is_file() and SOURCE not in p.parents]
    status.write_text(json.dumps(record, indent=2))
    print(json.dumps({k: record[k] for k in ["state", "exit_code", "finished_at_utc"]}), flush=True)


if __name__ == "__main__":
    main()