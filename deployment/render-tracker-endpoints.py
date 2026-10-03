"""Render secret-bearing Rasa configuration without relying on YAML interpolation."""
import json
import os
import tempfile
from urllib.parse import urlsplit


def tracker_configuration(environment):
    url = environment.get("RASA_TRACKER_DB_URL", "")
    parsed = urlsplit(url)
    if (parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname
            or not parsed.username or not parsed.password or not parsed.path.strip("/")):
        raise ValueError("A complete PostgreSQL tracker URI is required.")
    return {
        "action_endpoint": {"url": "http://127.0.0.1:5055/webhook"},
        # Rasa passes endpoint 'url' as SQLTrackerStore's 'host'.
        # Full URIs already include credentials, database, port, and SSL options.
        "tracker_store": {"type": "SQL", "dialect": "postgresql", "url": url},
    }


def write_configuration(configuration):
    with tempfile.NamedTemporaryFile(mode="w", prefix="landa-endpoints-", suffix=".json", delete=False) as target:
        json.dump(configuration, target)
        return target.name


if __name__ == "__main__":
    try:
        print(write_configuration(tracker_configuration(os.environ)))
    except Exception:
        raise SystemExit("Tracker configuration requires a complete PostgreSQL URI.")