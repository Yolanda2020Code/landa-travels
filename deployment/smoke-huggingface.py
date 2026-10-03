#!/usr/bin/env python3
"""Run a safe, anonymous smoke check against a Hugging Face Space URL."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit


def request(
    url: str,
    method: str = "GET",
    payload: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Accept": "application/json, text/html"}
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        exc.close()
        return status, b""


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python3 deployment/smoke-huggingface.py https://<space>.hf.space", file=sys.stderr)
        return 2

    base = sys.argv[1].rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        print("Provide an HTTP(S) Space URL without credentials, query, or fragment.", file=sys.stderr)
        return 2

    checks = [
        ("frontend", base + "/"),
        ("api-health", base + "/api/healthz"),
    ]
    failed = False
    for label, url in checks:
        try:
            status, body = request(url)
            passed = 200 <= status < 300
            if label == "api-health":
                health = json.loads(body)
                passed = passed and isinstance(health, dict) and health.get("status") == "ok"
            print(f"{label}: {'PASS' if passed else 'FAIL'} (HTTP {status})")
            failed = failed or not passed
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"{label}: FAIL ({type(exc).__name__})")
            failed = True

    try:
        status, _ = request(
            base + "/webhooks/rest/webhook",
            method="POST",
            payload={"sender": f"deployment-private-route-{uuid.uuid4()}", "message": "hello"},
        )
        passed = status == 404
        print(f"private-rasa-webhook: {'PASS' if passed else 'FAIL'} (HTTP {status})")
        failed = failed or not passed
    except OSError as exc:
        print(f"private-rasa-webhook: FAIL ({type(exc).__name__})")
        failed = True

    try:
        session_id = f"deployment-smoke-{uuid.uuid4()}"
        empty_context = {
            "origin": None,
            "destination": None,
            "currentLocation": None,
            "stopovers": [],
            "dateRange": None,
            "travellerCount": None,
            "budget": None,
            "transportPreferences": [],
            "accessibilityNeeds": [],
            "sustainabilityPriority": None,
            "accommodationNeeds": [],
            "locationConsentMode": None,
            "reviewConfirmation": None,
            "handoverRequested": False,
        }
        status, body = request(
            base + "/api/assistant/message",
            method="POST",
            payload={
                "sessionId": session_id,
                "message": "hello",
                "context": empty_context,
            },
            headers={"X-Conversation-Session": session_id},
        )
        if not 200 <= status < 300:
            print(f"api-assistant-flow: FAIL (HTTP {status})")
            failed = True
        else:
            response = json.loads(body)
            messages = response.get("messages") if isinstance(response, dict) else None
            passed = isinstance(messages, list) and bool(messages)
            print(f"api-assistant-flow: {'PASS' if passed else 'FAIL'} (HTTP {status})")
            failed = failed or not passed
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"api-assistant-flow: FAIL ({type(exc).__name__})")
        failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())