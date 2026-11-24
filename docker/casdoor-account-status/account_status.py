"""Account status for one private trial application on Casdoor SQLite."""

import argparse
from contextlib import closing
from functools import partial
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit


STATUS_PATH = "/openbot-account-status"
SCHEMA = {
    "openbot_trial_status_scope": """
CREATE TABLE openbot_trial_status_scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    issuer TEXT NOT NULL,
    organization TEXT NOT NULL
)
""",
    "openbot_trial_disablements": """
CREATE TABLE openbot_trial_disablements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL CHECK (subject <> ''),
    effective_at INTEGER NOT NULL CHECK (effective_at >= 0)
)
""",
    "openbot_trial_disablements_subject": """
CREATE INDEX openbot_trial_disablements_subject ON openbot_trial_disablements(subject)
""",
    "openbot_trial_status_guard_insert": """
CREATE TRIGGER openbot_trial_status_guard_insert BEFORE INSERT ON user
WHEN NEW.owner = (SELECT organization FROM openbot_trial_status_scope)
 AND (NEW.id IS NULL OR NEW.id = ''
      OR EXISTS (SELECT 1 FROM user WHERE owner = NEW.owner AND (id = NEW.id OR name = NEW.name))
      OR EXISTS (SELECT 1 FROM openbot_trial_disablements WHERE subject = NEW.id))
BEGIN
    SELECT RAISE(ABORT, 'OpenBot trial requires a new, stable Casdoor subject');
END
""",
    "openbot_trial_status_guard_update": """
CREATE TRIGGER openbot_trial_status_guard_update BEFORE UPDATE ON user
WHEN (OLD.owner = (SELECT organization FROM openbot_trial_status_scope)
      OR NEW.owner = (SELECT organization FROM openbot_trial_status_scope))
 AND (OLD.owner IS NOT NEW.owner OR OLD.id IS NOT NEW.id
      OR (OLD.name IS NOT NEW.name AND EXISTS (
          SELECT 1 FROM user WHERE owner = NEW.owner AND name = NEW.name
      )))
BEGIN
    SELECT RAISE(ABORT, 'OpenBot trial requires an unchanged Casdoor organization and subject');
END
""",
    "openbot_trial_status_on_insert": """
CREATE TRIGGER openbot_trial_status_on_insert AFTER INSERT ON user
WHEN NEW.owner = (SELECT organization FROM openbot_trial_status_scope)
 AND (coalesce(NEW.is_forbidden, 0) <> 0 OR coalesce(NEW.is_deleted, 0) <> 0)
BEGIN
    INSERT INTO openbot_trial_disablements(subject, effective_at)
    VALUES (NEW.id, CAST(round(unixepoch('subsec') * 1000) AS INTEGER));
END
""",
    "openbot_trial_status_on_update": """
CREATE TRIGGER openbot_trial_status_on_update AFTER UPDATE ON user
WHEN OLD.owner = (SELECT organization FROM openbot_trial_status_scope)
 AND coalesce(OLD.is_forbidden, 0) = 0 AND coalesce(OLD.is_deleted, 0) = 0
 AND (coalesce(NEW.is_forbidden, 0) <> 0 OR coalesce(NEW.is_deleted, 0) <> 0)
BEGIN
    INSERT INTO openbot_trial_disablements(subject, effective_at)
    VALUES (OLD.id, CAST(round(unixepoch('subsec') * 1000) AS INTEGER));
END
""",
    "openbot_trial_status_on_delete": """
CREATE TRIGGER openbot_trial_status_on_delete AFTER DELETE ON user
WHEN OLD.owner = (SELECT organization FROM openbot_trial_status_scope)
 AND coalesce(OLD.is_forbidden, 0) = 0 AND coalesce(OLD.is_deleted, 0) = 0
BEGIN
    INSERT INTO openbot_trial_disablements(subject, effective_at)
    VALUES (OLD.id, CAST(round(unixepoch('subsec') * 1000) AS INTEGER));
END
""",
}
SCHEMA = {name: sql.strip() for name, sql in SCHEMA.items()}


class Unavailable(Exception):
    pass


class InvalidClient(Exception):
    pass


def connect(path, mode="ro"):
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode={mode}", uri=True, timeout=2)


def capture_schema(db):
    placeholders = ",".join("?" for _ in SCHEMA)
    return dict(db.execute(
        f"SELECT name, sql FROM sqlite_schema WHERE name IN ({placeholders})", tuple(SCHEMA)
    ))


def verify_casdoor(db):
    fields = {name: (kind.upper(), rank)
              for _, name, kind, _, _, rank in db.execute("PRAGMA table_info(user)")}
    expected_fields = {
        "owner": ("TEXT", 1),
        "name": ("TEXT", 2),
        "id": ("TEXT", 0),
        "is_forbidden": ("INTEGER", 0),
        "is_deleted": ("INTEGER", 0),
    }
    unique_index_origins = [origin for _, _, unique, origin, _ in db.execute("PRAGMA index_list(user)")
                            if unique]
    if (
        any(fields.get(name) != field for name, field in expected_fields.items())
        or unique_index_origins != ["pk"]
        or db.execute("SELECT unixepoch('subsec')").fetchone()[0] is None
    ):
        raise Unavailable("Unsupported Casdoor SQLite schema or SQLite version")


def verify_capture(db, issuer, organization):
    verify_casdoor(db)
    if capture_schema(db) != SCHEMA:
        raise Unavailable("The account status capture schema is missing or has changed")
    scope = db.execute("SELECT issuer, organization FROM openbot_trial_status_scope").fetchall()
    if scope != [(issuer, organization)]:
        raise Unavailable("The configured account status scope differs from the installed scope")
    if not db.execute("SELECT 1 FROM organization WHERE name = ?", (organization,)).fetchone():
        raise Unavailable("The installed trial organization no longer exists")


def install(path, issuer, organization):
    with closing(connect(path, "rw")) as db, db:
        db.execute("BEGIN IMMEDIATE")
        verify_casdoor(db)
        if capture_schema(db):
            verify_capture(db, issuer, organization)
            return
        if not db.execute("SELECT 1 FROM organization WHERE name = ?", (organization,)).fetchone():
            raise Unavailable("The trial organization must exist before installing capture")
        if db.execute("SELECT 1 FROM user WHERE owner = ? LIMIT 1", (organization,)).fetchone():
            raise Unavailable("Install capture before creating accounts in the trial organization")
        for sql in SCHEMA.values():
            db.execute(sql)
        db.execute(
            "INSERT INTO openbot_trial_status_scope VALUES (1, ?, ?)", (issuer, organization)
        )
        verify_capture(db, issuer, organization)


def snapshot(path, issuer, organization, client_id, client_secret, subject):
    with closing(connect(path)) as db:
        db.execute("BEGIN")
        # This bound precedes the first read that establishes the SQLite snapshot.
        observed_at = time.time_ns() // 1_000_000
        verify_capture(db, issuer, organization)
        application = db.execute(
            "SELECT client_secret FROM application WHERE organization = ? AND client_id = ?",
            (organization, client_id),
        ).fetchall()
        if len(application) != 1 or not isinstance(application[0][0], str):
            raise Unavailable("The configured trial application is unavailable")
        if not hmac.compare_digest(application[0][0].encode(), client_secret.encode()):
            raise InvalidClient
        account = db.execute(
            """SELECT coalesce(is_forbidden, 0) = 0 AND coalesce(is_deleted, 0) = 0
               FROM user WHERE owner = ? AND id = ?""",
            (organization, subject),
        ).fetchall()
        history = db.execute(
            """SELECT id, effective_at FROM openbot_trial_disablements
               WHERE subject = ? ORDER BY id""",
            (subject,),
        ).fetchall()
    active = account == [(1,)]
    if (
        len(account) > 1
        or (not active and not history)
        or any(effective_at > observed_at for _, effective_at in history)
    ):
        raise Unavailable("SQLite cannot confirm account status and complete history")
    return {
        "issuer": issuer,
        "subject": subject,
        "active": active,
        "observedAt": observed_at,
        "disablements": [{"id": str(event), "effectiveAt": at} for event, at in history],
    }


class StatusHandler(BaseHTTPRequestHandler):
    def __init__(self, path, issuer, organization, client_id, client_secret, *args):
        self.database = path
        self.issuer = issuer
        self.organization = organization
        self.client_id = client_id.encode()
        self.client_secret = client_secret.encode()
        super().__init__(*args)

    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, *_args):
        # The reverse proxy owns access logging. Never log a request target or body.
        pass

    def respond(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != STATUS_PATH:
            self.respond(404, {"error": "not_found"})
            return

        try:
            lengths = self.headers.get_all("Content-Length") or []
            if (len(lengths) != 1 or not 0 < int(lengths[0]) <= 4096
                    or self.headers.get("Transfer-Encoding")
                    or self.headers.get_content_type() != "application/x-www-form-urlencoded"):
                raise ValueError
            body = self.rfile.read(int(lengths[0]))
            if len(body) != int(lengths[0]):
                raise ValueError
            form = parse_qs(body.decode(), strict_parsing=True, max_num_fields=3, errors="strict")
            if set(form) != {"client_id", "client_secret", "subject"}:
                raise ValueError
            client_id, client_secret, subject = (form[field][0] for field in (
                "client_id", "client_secret", "subject"
            ))
            if len(subject) > 255:
                raise ValueError
        except (ValueError, TimeoutError):
            self.respond(400, {"error": "invalid_request"})
            return

        id_matches = hmac.compare_digest(client_id.encode(), self.client_id)
        secret_matches = hmac.compare_digest(client_secret.encode(), self.client_secret)
        if not (id_matches and secret_matches):
            self.respond(401, {"error": "invalid_client"})
            return

        try:
            status = snapshot(
                self.database, self.issuer, self.organization, client_id, client_secret, subject
            )
        except InvalidClient:
            self.respond(401, {"error": "invalid_client"})
            return
        except (Unavailable, sqlite3.Error):
            self.respond(503, {"error": "status_unavailable"})
            return
        self.respond(200, status)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "serve"))
    args = parser.parse_args()
    try:
        path = Path(os.environ["CASDOOR_SQLITE_PATH"])
        issuer = os.environ["CASDOOR_ISSUER"]
        organization = os.environ["CASDOOR_TRIAL_ORGANIZATION"]
        url = urlsplit(issuer)
        if url.scheme != "https" or not url.hostname or url.username or url.query or url.fragment:
            raise ValueError("CASDOOR_ISSUER must be the trial application's HTTPS issuer")
        if not organization or organization == "built-in":
            raise ValueError("CASDOOR_TRIAL_ORGANIZATION must be a dedicated organization")
        if args.command == "install":
            install(path, issuer, organization)
            return
        client_id = os.environ["CASDOOR_CLIENT_ID"]
        client_secret = os.environ["CASDOOR_CLIENT_SECRET"]
        if not client_id or not client_secret:
            raise ValueError("Both trial application credentials must be set")
        port = int(os.environ.get("CASDOOR_ACCOUNT_STATUS_PORT", "19444"))
        with closing(connect(path)) as db:
            db.execute("BEGIN")
            verify_capture(db, issuer, organization)
    except (KeyError, Unavailable, ValueError) as error:
        parser.exit(1, f"Casdoor account status configuration failed: {error}\n")
    except sqlite3.Error:
        parser.exit(1, "Casdoor account status could not open or verify the SQLite database\n")

    handler = partial(StatusHandler, path, issuer, organization, client_id, client_secret)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Casdoor account status is listening on loopback port {server.server_port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
