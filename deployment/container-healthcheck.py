#!/usr/bin/env python3
"""Private in-container readiness check for the Hugging Face Docker image."""

from __future__ import annotations

import socket
import sys
import urllib.request
import os


def check_http(url: str) -> None:
    with urllib.request.urlopen(url, timeout=1.5) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"HTTP check failed for {url}: {response.status}")


def check_action_socket() -> None:
    with socket.create_connection(("127.0.0.1", 5055), timeout=1.5):
        pass


def check_database() -> None:
    import psycopg2

    connection = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=2)
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            if cursor.fetchone() != (1,):
                raise RuntimeError("Database check returned an unexpected result.")
    finally:
        connection.close()


def main() -> int:
    try:
        check_http("http://127.0.0.1:7860/")
        check_http("http://127.0.0.1:5001/api/healthz")
        check_http("http://127.0.0.1:5005/status")
        check_action_socket()
        check_database()
    except Exception:
        # A healthcheck failure is a status bit, never a reason to print a
        # database URL or provider-specific connection detail into logs.
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())