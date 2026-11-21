import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import account_status


ISSUER = "https://casdoor.example.test"
ORGANIZATION = "isolated-trial"
CLIENT = "fixture-client"
SECRET = "fixture-secret"
SUBJECT = "51a466a3-77c6-4060-b930-e04618220ee9"


class AccountStatusTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.database = Path(directory.name) / "fixture.sqlite"
        self.db = sqlite3.connect(self.database)
        self.addCleanup(self.db.close)
        self.db.executescript("""
          PRAGMA journal_mode = WAL;
          CREATE TABLE organization(name TEXT PRIMARY KEY);
          CREATE TABLE application (organization TEXT, client_id TEXT, client_secret TEXT);
          CREATE TABLE user (
              owner TEXT, name TEXT, id TEXT, is_forbidden INTEGER, is_deleted INTEGER,
              PRIMARY KEY(owner, name)
          );
        """)
        with self.db:
            self.db.executemany("INSERT INTO organization VALUES (?)", [(ORGANIZATION,), ("foreign",)])
            self.db.execute("INSERT INTO application VALUES (?, ?, ?)", (ORGANIZATION, CLIENT, SECRET))
        account_status.install(self.database, ISSUER, ORGANIZATION)

    def create_account(self, subject=SUBJECT, organization=ORGANIZATION, forbidden=0):
        with self.db:
            self.db.execute(
                "INSERT INTO user VALUES (?, ?, ?, ?, 0)",
                (organization, subject, subject, forbidden),
            )

    def mutate_account(self, statement):
        with self.db:
            self.db.execute(f"{statement} WHERE owner = ? AND id = ?", (ORGANIZATION, SUBJECT))

    def snapshot(self):
        return account_status.snapshot(self.database, ISSUER, ORGANIZATION, CLIENT, SECRET, SUBJECT)

    def start_server(self):
        environment = dict(os.environ, CASDOOR_SQLITE_PATH=str(self.database),
                           CASDOOR_ISSUER=ISSUER, CASDOOR_TRIAL_ORGANIZATION=ORGANIZATION,
                           CASDOOR_CLIENT_ID=CLIENT, CASDOOR_CLIENT_SECRET=SECRET,
                           CASDOOR_ACCOUNT_STATUS_PORT="0")
        server = subprocess.Popen(
            [sys.executable, "-B", str(Path(account_status.__file__)), "serve"],
            env=environment, stdout=subprocess.PIPE, text=True,
        )
        self.addCleanup(self.stop_server, server)
        port_line = server.stdout.readline()
        self.assertIn("listening on loopback port", port_line)
        url = f"http://127.0.0.1:{int(port_line.split()[-1])}{account_status.STATUS_PATH}"
        return server, url

    def stop_server(self, server):
        if server.poll() is None:
            server.terminate()
            server.wait(timeout=5)
        server.stdout.close()

    def post(self, url, secret=SECRET):
        form = urlencode(dict(client_id=CLIENT, client_secret=secret, subject=SUBJECT))
        try:
            response = urlopen(Request(url, data=form.encode()), timeout=5)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, json.load(response)

    def test_http_retains_short_disablement_across_recovery_restart_and_deletion(self):
        self.create_account()
        server, url = self.start_server()
        code, original = self.post(url)
        self.assertEqual(code, 200)
        self.assertTrue(original["active"])
        self.assertEqual(original["disablements"], [])
        self.mutate_account("UPDATE user SET is_forbidden = 1")
        self.mutate_account("UPDATE user SET is_forbidden = 0")
        account_status.install(self.database, ISSUER, ORGANIZATION)
        self.stop_server(server)
        _, url = self.start_server()
        code, recovered = self.post(url)
        self.assertEqual(code, 200)
        self.assertEqual(recovered["issuer"], ISSUER)
        self.assertEqual(recovered["subject"], SUBJECT)
        self.assertTrue(recovered["active"])
        events = recovered["disablements"]
        self.assertEqual(len(events), 1)
        self.assertLessEqual(original["observedAt"], events[0]["effectiveAt"])
        self.assertLessEqual(events[0]["effectiveAt"], recovered["observedAt"])
        self.mutate_account("UPDATE user SET name = 'renamed'")
        self.mutate_account("DELETE FROM user")
        code, deleted = self.post(url)
        self.assertEqual(code, 200)
        self.assertFalse(deleted["active"])
        self.assertEqual(deleted["disablements"][:1], events)
        self.assertEqual(len(deleted["disablements"]), 2)
        with self.assertRaises(sqlite3.IntegrityError):
            self.create_account()

    def test_http_rejects_invalid_credentials_and_unverified_state(self):
        self.create_account(organization="foreign")
        _, url = self.start_server()
        self.assertEqual(self.post(url, "wrong")[0], 401)
        self.assertEqual(self.post(url)[0], 503)
        self.create_account()
        self.assertEqual(self.post(url)[0], 200)
        with self.db:
            self.db.execute("UPDATE application SET client_secret = 'rotated'")
        self.assertEqual(self.post(url)[0], 401)
        with self.db:
            self.db.execute("UPDATE application SET client_secret = ?", (SECRET,))
            self.db.execute("DROP TRIGGER openbot_trial_status_on_update")
        self.assertEqual(self.post(url)[0], 503)
        with self.assertRaises(account_status.Unavailable):
            account_status.install(self.database, ISSUER, ORGANIZATION)

    def test_capture_checks_initial_state_and_transaction_rollback(self):
        self.create_account(forbidden=1)
        original = self.snapshot()
        self.assertFalse(original["active"])
        self.assertEqual(len(original["disablements"]), 1)
        self.mutate_account("UPDATE user SET is_forbidden = 0")
        self.db.execute("UPDATE user SET is_deleted = 1")
        self.db.rollback()
        self.assertTrue(self.snapshot()["active"])
        self.assertEqual(self.snapshot()["disablements"], original["disablements"])
        self.mutate_account("UPDATE user SET is_deleted = 1")
        self.assertFalse(self.snapshot()["active"])
        self.mutate_account("DELETE FROM user")
        self.assertEqual(len(self.snapshot()["disablements"]), 2)

    def test_status_and_history_share_one_read_snapshot(self):
        self.create_account()
        verify_capture = account_status.verify_capture

        def mutate_after_reader_enters_snapshot(*args):
            verify_capture(*args)
            self.mutate_account("UPDATE user SET is_forbidden = 1")

        with patch.object(account_status, "verify_capture", mutate_after_reader_enters_snapshot):
            original = self.snapshot()
        self.assertTrue(original["active"])
        self.assertEqual(original["disablements"], [])
        latest = self.snapshot()
        self.assertFalse(latest["active"])
        self.assertEqual(len(latest["disablements"]), 1)

    def test_install_requires_untouched_trial_organization_and_same_scope(self):
        self.create_account(organization="foreign")
        with self.assertRaises(account_status.Unavailable):
            account_status.install(self.database, ISSUER, "foreign")
        with self.db:
            for name, sql in reversed(account_status.SCHEMA.items()):
                self.db.execute(f"DROP {sql.split()[1]} {name}")
        with self.assertRaisesRegex(account_status.Unavailable, "before creating accounts"):
            account_status.install(self.database, ISSUER, "foreign")
        self.assertEqual(account_status.capture_schema(self.db), {})


if __name__ == "__main__":
    unittest.main()
