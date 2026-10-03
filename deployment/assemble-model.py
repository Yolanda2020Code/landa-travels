#!/usr/bin/env python3
"""Reassemble the evaluated model without training or changing its contents."""

import hashlib
from pathlib import Path

EXPECTED_SHA256 = "954da34118ed358fb80d8a2c60bca9081f78d2a6209c6dc8a6980482fa44b320"
EXPECTED_BYTES = 47263571
PART_COUNT = 6


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    model_dir = Path(__file__).resolve().parent.parent / "rasa-bot" / "models"
    target = model_dir / "landa-travels.tar.gz"
    if target.exists():
        if target.stat().st_size != EXPECTED_BYTES or checksum(target) != EXPECTED_SHA256:
            raise SystemExit("Existing model does not match the evaluated archive.")
        print("Evaluated model verified; no reassembly needed.")
        return

    parts = [
        model_dir / "parts" / f"landa-travels.tar.gz.part{number:03d}"
        for number in range(PART_COUNT)
    ]
    if not all(part.is_file() for part in parts):
        raise SystemExit("Evaluated model is missing or its six storage parts are incomplete.")
    temporary = target.with_suffix(".assembling")
    try:
        with temporary.open("wb") as output:
            for part in parts:
                with part.open("rb") as source:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        output.write(block)
        if temporary.stat().st_size != EXPECTED_BYTES or checksum(temporary) != EXPECTED_SHA256:
            raise SystemExit("Model parts do not reconstruct the evaluated archive.")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print("Evaluated model reassembled and SHA-256 verified; no retraining performed.")


if __name__ == "__main__":
    main()