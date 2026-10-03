import importlib.util
import json
import os
from pathlib import Path
import stat
import unittest

source = Path(__file__).resolve().parents[2] / "deployment" / "render-tracker-endpoints.py"
spec = importlib.util.spec_from_file_location("hosted_endpoints", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class HostedEndpointTests(unittest.TestCase):
    def test_full_uri_has_no_duplicate_or_unexpanded_constructor_arguments(self):
        uri = "postgresql://synthetic:synthetic@localhost:5432/synthetic?sslmode=require"
        config = module.tracker_configuration({"RASA_TRACKER_DB_URL": uri})
        self.assertEqual(config["tracker_store"], {"type": "SQL", "dialect": "postgresql", "url": uri})
        self.assertEqual(config["action_endpoint"]["url"], "http://127.0.0.1:5055/webhook")

    def test_rejects_incomplete_credentials_and_non_database_urls(self):
        for uri in ["localhost:5432", "postgresql://localhost/synthetic", "https://example.invalid/test", ""]:
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                module.tracker_configuration({"RASA_TRACKER_DB_URL": uri})

    def test_private_runtime_file_is_owner_only_and_valid_json(self):
        config = {"tracker_store": {"url": "synthetic-uri"}}
        path = module.write_configuration(config)
        try:
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            with open(path) as file:
                self.assertEqual(json.load(file), config)
        finally:
            os.unlink(path)