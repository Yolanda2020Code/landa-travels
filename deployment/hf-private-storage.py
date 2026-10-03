#!/usr/bin/env python3
"""Private, non-versioned CV storage. Called only by the API, never the browser."""
import base64
import json
import os
import re
import sys
import tempfile
from pathlib import Path

os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
from huggingface_hub import HfApi
from huggingface_hub.errors import HfHubHTTPError

MAX_SIZE = 5 * 1024 * 1024


def main():
    operation, key = sys.argv[1:]
    if not re.fullmatch(r"recruitment/[a-f0-9-]{36}/[A-Za-z0-9._-]{1,120}", key) or ".." in key:
        raise ValueError("Invalid object path")
    bucket = os.environ["HF_PRIVATE_UPLOAD_BUCKET"]
    api = HfApi(token=os.environ["HF_STORAGE_TOKEN"])
    if operation == "put":
        payload = json.loads(sys.stdin.read(MAX_SIZE * 2))
        content = base64.b64decode(payload["content"], validate=True)
        if not 0 < len(content) <= MAX_SIZE:
            raise ValueError("Invalid file size")
        api.batch_bucket_files(bucket, add=[(content, key)])
        return {"stored": True}
    if operation == "delete":
        api.batch_bucket_files(bucket, delete=[key])
        return {"deleted": True}
    entries = list(api.get_bucket_paths_info(bucket, [key]))
    if not entries:
        return None
    entry = entries[0]
    if entry.size > MAX_SIZE:
        raise ValueError("Stored file exceeds limit")
    if operation == "head":
        return {"size": entry.size}
    if operation == "get":
        with tempfile.TemporaryDirectory(prefix="private-cv-") as directory:
            target = Path(directory) / "cv"
            api.download_bucket_files(bucket, [(key, target)], raise_on_missing_files=True)
            return {"content": base64.b64encode(target.read_bytes()).decode("ascii")}
    raise ValueError("Unsupported storage operation")


if __name__ == "__main__":
    try:
        print(json.dumps(main()))
    except HfHubHTTPError as error:
        if len(sys.argv) > 1 and sys.argv[1] != "put" and error.response is not None and error.response.status_code == 404:
            print("null")
        else:
            print('{"error":"Private storage operation failed"}')
            sys.exit(1)
    except Exception:
        # Never print tokens, file contents, provider URLs, or exception details.
        print('{"error":"Private storage operation failed"}')
        sys.exit(1)