"""Synthetic provider and public HTTP checks for the Bifrost upgrade rehearsal."""

import base64
import http.cookiejar
import json
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "gpt-4o-mini"
ALIAS = "fixture-alias"
PROVIDER_KEY = "fixture-provider-key"
VIRTUAL_KEY = "sk-bf-upgrade-rehearsal"
ADMIN = {"username": "fixture-admin", "password": "fixture-admin-password"}
GATEWAY = "http://gateway:8080"


def configure(seed_database):
    config = json.load(sys.stdin)
    config["framework"] = {"pricing": {
        "pricing_url": "file:///fixture-pricing.json",
        "model_parameters_url": "file:///fixture-pricing.json",
        "mcp_library_sync_interval": 0,
    }}
    if not seed_database:
        json.dump(config, sys.stdout)
        return
    config["providers"] = {
        "openai": {
            "network_config": {
                "base_url": "http://upstream:8080",
                "allow_private_network": True,
            },
            "keys": [
                {
                    "name": "fixture-key",
                    "value": PROVIDER_KEY,
                    "weight": 1,
                    "models": [MODEL],
                }
            ],
        }
    }
    config["governance"] = {
        "auth_config": {
            "admin_username": ADMIN["username"],
            "admin_password": ADMIN["password"],
            "is_enabled": True,
        },
        "virtual_keys": [{
            "id": "fixture-virtual-key",
            "name": "Upgrade rehearsal",
            "value": VIRTUAL_KEY,
            "is_active": True,
            "provider_configs": [{
                "provider": "openai",
                "allowed_models": ["*"],
                "key_ids": ["*"],
            }],
        }],
        "routing_rules": [
            {
                "id": "fixture-route",
                "name": "Fixture alias route",
                "scope": "global",
                "enabled": True,
                "cel_expression": f'model == "{ALIAS}"',
                "targets": [{"provider": "openai", "model": MODEL, "weight": 1}],
            }
        ],
    }
    json.dump(config, sys.stdout)


class Upstream(BaseHTTPRequestHandler):
    def send_json(self, status, data):
        content = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if self.path == "/api/web/skills":
            self.send_json(200, {"code": 0, "data": {"items": []}})
            return
        if self.path.split("?")[0] != "/v1/models":
            self.send_error(404)
            return
        self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})

    def do_POST(self):
        if self.path in ("/api/v1/skills/catalog/publish", "/api/v1/publish"):
            self.send_json(201, {"published": True})
            return
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.headers.get("Authorization") != f"Bearer {PROVIDER_KEY}" or body.get("model") != MODEL:
            self.send_json(400, {"error": {"message": "Unexpected key or model"}})
            return
        self.send_json(200, {
            "id": "fixture-completion",
            "object": "chat.completion",
            "created": 1700000000,
            "model": MODEL,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "fixture model response"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
        })


def request(path, *, client=None, body=None, method=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        GATEWAY + path, data, {"Content-Type": "application/json", **(headers or {})}, method=method
    )
    try:
        open_request = client.open if client else urllib.request.urlopen
        with open_request(req, timeout=8) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise AssertionError(
            f"{req.get_method()} {path} returned {error.code}: {error.read().decode()}"
        ) from error


def admin():
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    request("/api/session/login", client=client, body=ADMIN)
    return client


def models():
    deadline = time.monotonic() + 300
    while True:
        try:
            with urllib.request.urlopen(GATEWAY + "/health", timeout=2):
                break
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)
    rules = request("/api/routing/rules", client=admin())["rules"]
    rule = next(rule for rule in rules if rule["name"] == "Fixture alias route")
    assert rule["enabled"] and rule["targets"][0]["model"] == MODEL, rule
    for model in (f"openai/{MODEL}", ALIAS):
        completion = request("/v1/chat/completions", headers={"x-bf-vk": VIRTUAL_KEY}, body={
            "model": model, "messages": [{"role": "user", "content": "fixture smoke test"}]
        })
        assert completion["choices"][0]["message"]["content"] == "fixture model response", completion
    print("Stored routing rule, direct model call, and routed model call passed")


def skills():
    client = admin()
    path = "/api/skills"
    asset = b"\x00\xff\x10"
    files = [
        {"path": "scripts/check.sh", "source_type": "text", "content": "echo fixture\n"},
        {"path": "references/nested/notes.md", "source_type": "text", "content": "Fixture notes.\n"},
        {
            "path": "assets/fixture.bin",
            "source_type": "dataurl",
            "dataurl": "data:application/octet-stream;base64," + base64.b64encode(asset).decode(),
        },
    ]
    body = {
        "name": "upgrade-rehearsal",
        "description": "Synthetic skill for the upgrade rehearsal",
        "version": "1.0.0",
        "skill_md_body": "Fixture instructions.",
        "files": files,
    }
    created = request(path, client=client, body=body)["skill"]
    skill_path = f"{path}/{created['id']}"
    updated = request(skill_path, client=client, method="PUT", body={
        "version": "1.1.0",
        "description": "Updated synthetic skill",
        "skill_md_body": "New fixture instructions.",
        "files": [{"path": "references/new.md", "source_type": "text", "content": "New version.\n"}],
    })["skill"]
    assert updated["latest_version"] == "1.1.0", updated

    historical = request(skill_path + "?version=1.0.0", client=client)["skill"]
    assert historical["id"] == created["id"] and historical["latest_version"] == "1.0.0", historical
    assert historical["skill_md_body"] == body["skill_md_body"], historical
    expected = {
        "scripts/check.sh": b"echo fixture\n",
        "references/nested/notes.md": b"Fixture notes.\n",
        "assets/fixture.bin": asset,
    }
    assert sorted(file["path"] for file in historical["files"]) == sorted(expected), historical

    # The management response describes exact-version attachments. The raw file
    # route serves the active version, so switch it only in the isolated fixture.
    shift = skill_path + "/shift-version"
    request(shift, client=client, body={"version": "1.0.0"})
    assert request(skill_path, client=client)["skill"]["latest_version"] == "1.0.0"
    try:
        for file in expected:
            file_url = f"{GATEWAY}{path}/serve/{body['name']}/files/{file}"
            with urllib.request.urlopen(file_url, timeout=8) as response:
                assert response.read() == expected[file], file
    finally:
        request(shift, client=client, body={"version": "1.1.0"})
    print("Administrator created two skill versions and read back 1.0.0 with all three original attachments")


def seed_market():
    client = admin()
    path = "/api/skills"
    body = {
        "name": "market-rehearsal",
        "description": "Historical market rehearsal",
        "version": "1.0.0",
        "skill_md_body": "Original instructions.\n",
        "files": [
            {"path": "scripts/check.sh", "source_type": "text", "content": "echo old\n"},
            {"path": "references/nested/notes.md", "source_type": "text", "content": "Original reference.\n"},
            {"path": "assets/fixture.bin", "source_type": "dataurl", "dataurl": "data:application/octet-stream;base64,AP8Q"},
        ],
    }
    skill = request(path, client=client, body=body)["skill"]
    request(f"{path}/{skill['id']}", client=client, method="PUT", body={
        "version": "2.0.0",
        "description": "Current market rehearsal",
        "skill_md_body": "Current instructions.\n",
        "files": [{"path": "assets/fixture.bin", "source_type": "text", "content": "current bytes"}],
    })
    for slug in ["missing-blob", "wrong-size", "mutable-url"]:
        files = body["files"][:1]
        if slug == "mutable-url":
            files = [{"path": "references/live.md", "source_type": "url", "source_url": "http://upstream:8080/v1/models", "mime_type": "text/plain"}]
        request(path, client=client, body={**body, "name": slug, "files": files})
    check_market_pointer()


def check_market_pointer():
    path = "/api/skills/serve/market-rehearsal/files/assets/fixture.bin"
    with urllib.request.urlopen(GATEWAY + path, timeout=8) as response:
        assert response.read() == b"current bytes"


def check_market_edge(host, local):
    global GATEWAY
    GATEWAY = host
    headers = {"Host": "bifrost.persaas.cn"}
    target = urllib.parse.urlsplit(host)
    deadline = time.monotonic() + 10
    while True:
        try:
            with socket.create_connection((target.hostname, target.port or 80), timeout=1):
                break
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.25)
    for path in [
        "/api/skills",
        "/api/skills/serve/market-rehearsal/download.zip",
        "/api/skills/serve/market-rehearsal/files/assets/fixture.bin",
        "/api/skills/serve/claude-code.git/info/refs",
        "/api/skills/serve/codex/.agents/plugins/marketplace.json",
    ]:
        try:
            with urllib.request.urlopen(urllib.request.Request(host + path, headers=headers), timeout=8):
                pass
        except urllib.error.HTTPError as error:
            assert error.code == 404, (path, error.code)
        else:
            raise AssertionError(f"Native skill route was exposed: {path}")
    if local:
        for model in (f"openai/{MODEL}", ALIAS):
            completion = request("/v1/chat/completions", headers={**headers, "x-bf-vk": VIRTUAL_KEY}, body={
                "model": model, "messages": [{"role": "user", "content": "edge smoke test"}],
            })
            assert completion["choices"][0]["message"]["content"] == "fixture model response", completion
        print("Middleware serves direct and routed inference while denying native skill routes")
    else:
        print("External clients cannot reach the native skill routes through middleware")


def publication(phase):
    global GATEWAY
    GATEWAY = "http://registry:8080"
    models()
    client = admin()
    skills = request("/api/skills", client=client)["skills"]
    body = {
        "name": f"publication-{phase}",
        "description": "Cutover publication fixture",
        "version": "1.0.0",
        "skill_md_body": "Fixture instructions.",
    }
    try:
        skill = request("/api/skills", client=client, body=body)["skill"]
        assert phase != "frozen", skill
    except AssertionError as failure:
        assert phase == "frozen" and "returned 503" in str(failure), failure

    if phase == "frozen":
        created = next(skill for skill in skills if skill["name"] == "publication-open")
        skill_path = f"/api/skills/{created['id']}"
        for path, method, data in [
            (skill_path, "PUT", {"version": "1.1.0", "skill_md_body": "Frozen update."}),
            (skill_path + "/shift-version", "POST", {"version": "1.0.0"}),
        ]:
            try:
                request(path, client=client, method=method, body=data)
            except AssertionError as failure:
                assert "returned 503" in str(failure), failure
            else:
                raise AssertionError(f"Registry accepted {method} {path} during the freeze")

    GATEWAY = "http://edge"
    headers = {"Host": "skillhub.fixture.test"}
    assert request("/api/web/skills", headers=headers)["code"] == 0
    for path in ("/api/v1/skills/catalog/publish", "/api/v1/publish"):
        try:
            result = request(path, headers=headers, body={})
            assert phase == "open" and result["published"], result
        except AssertionError as failure:
            assert phase != "open" and "returned 503" in str(failure), failure
    print(f"Publication checks passed ({phase}): Bifrost management, inference and SkillHub ingress")


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "upstream":
        ThreadingHTTPServer(("", 8080), Upstream).serve_forever()
    elif command in ("seed", "restore"):
        configure(seed_database=command == "seed")
    elif command == "models":
        models()
    elif command == "skills":
        skills()
    elif command == "seed-market":
        seed_market()
    elif command == "market-pointer":
        check_market_pointer()
    elif command == "market-edge":
        check_market_edge(sys.argv[2], sys.argv[3] == "local")
    elif command == "publication":
        publication(sys.argv[2])
