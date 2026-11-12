"""Checks the settings server's plugin update detection against a fake ~/.claude.

Run: python3 -I tests/test_updates.py
"""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "server" / "settings_server.py"


def load_server(claude_dir: Path):
    os.environ["CLAUDE_CONFIG_DIR"] = str(claude_dir)
    sys.argv = ["settings_server.py", "token", str(claude_dir / "settings.json")]
    spec = importlib.util.spec_from_file_location("settings_server", SERVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


class UpdateDetection(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        # Ponytail's marketplace is its own repo (source "./"): its head commit is the latest.
        repo = self.dir / "plugins" / "marketplaces" / "ponytail"
        write(repo / ".claude-plugin" / "marketplace.json", {"plugins": [{"name": "ponytail", "source": "./"}]})
        write(repo / ".claude-plugin" / "plugin.json", {"name": "ponytail", "version": "6.0.0"})
        git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run([*git, "init", "-q"], check=True)
        subprocess.run([*git, "add", "."], check=True)
        subprocess.run([*git, "commit", "-qm", "x"], check=True)
        self.head = subprocess.run([*git, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        # Superpowers comes from a URL the official catalog pins by sha.
        write(
            self.dir / "plugins" / "marketplaces" / "claude-plugins-official" / ".claude-plugin" / "marketplace.json",
            {"plugins": [{"name": "superpowers", "source": {"source": "url", "url": "u", "sha": "new-sha"}}]},
        )

    def tearDown(self):
        self.tmp.cleanup()

    def installed(self, ponytail_sha, superpowers_sha):
        write(
            self.dir / "plugins" / "installed_plugins.json",
            {
                "plugins": {
                    "ponytail@ponytail": [{"version": "5.3.3", "gitCommitSha": ponytail_sha}],
                    "superpowers@claude-plugins-official": [{"version": "7.0.0", "gitCommitSha": superpowers_sha}],
                }
            },
        )
        return load_server(self.dir)

    def test_newer_commits_offer_an_update(self):
        s = self.installed("old-sha", "old-sha")
        self.assertEqual(s.plugin_update(s.TOOLS["ponytail"]), {"version": "6.0.0"})
        self.assertEqual(s.plugin_update(s.TOOLS["superpowers"]), {"version": None})

    def test_installed_latest_offers_none(self):
        s = self.installed(self.head, "new-sha")
        self.assertIsNone(s.plugin_update(s.TOOLS["ponytail"]))
        self.assertIsNone(s.plugin_update(s.TOOLS["superpowers"]))

    def test_missing_catalog_offers_none(self):
        s = self.installed("old-sha", "old-sha")
        (self.dir / "plugins" / "marketplaces" / "claude-plugins-official" / ".claude-plugin" / "marketplace.json").unlink()
        self.assertIsNone(s.plugin_update(s.TOOLS["superpowers"]))


if __name__ == "__main__":
    unittest.main()
