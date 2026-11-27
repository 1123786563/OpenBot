#!/usr/bin/env python3
"""Run authenticated HTTP acceptance on the data node; never print credentials."""
import datetime
import http.cookiejar
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path("/opt/persaas")
BASE = "https://www.persaas.cn"
LOGIN = "https://casdoor.persaas.cn"


def main():
    credentials = json.loads((ROOT / "credentials.json").read_text())
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    passed = []

    def call(url, body=None, origin=BASE):
        request = urllib.request.Request(
            url,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Origin": origin},
        )
        try:
            with client.open(request, timeout=40) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"HTTP {error.code}: {urllib.parse.urlparse(url).path}") from None

    def check(name, condition):
        if not condition:
            raise RuntimeError(name)
        passed.append(name)
        print(f"PASS {name}", flush=True)

    check("public HTTPS health", json.loads(call(BASE + "/health"))["status"] == "ok")
    try:
        urllib.request.urlopen(BASE + "/api/me", timeout=15)
        raise RuntimeError("Anonymous request was admitted")
    except urllib.error.HTTPError as error:
        check("anonymous account request refused", error.code == 401)

    start = json.loads(call(BASE + "/api/auth/sign-in/social", {"provider": "okta", "callbackURL": BASE}))
    query = {key: values[0] for key, values in urllib.parse.parse_qs(urllib.parse.urlparse(start["url"]).query).items()}
    check("OAuth uses the configured Casdoor", urllib.parse.urlparse(start["url"]).netloc == "casdoor.persaas.cn")
    query["clientId"] = query.pop("client_id")
    query["redirectUri"] = query.pop("redirect_uri")
    query["responseType"] = query.pop("response_type")
    form = {"type": "login", "organization": "persaas", "username": "admin", "password": credentials["ownerPassword"], "application": "openbot", "autoSignin": True}
    check("Casdoor owner login", json.loads(call(LOGIN + "/api/login", form, LOGIN))["status"] == "ok")
    form["type"] = "code"
    form["clientId"] = credentials["clientId"]
    authorized = json.loads(call(LOGIN + "/api/login?" + urllib.parse.urlencode(query), form, LOGIN))
    check("OAuth authorization code", authorized["status"] == "ok" and isinstance(authorized.get("data"), str))
    callback = query["redirectUri"] + "?" + urllib.parse.urlencode({"code": authorized["data"], "state": query["state"]})
    call(callback)
    try:
        user = json.loads(call(BASE + "/api/me"))["user"]
        check("signed-in owner is administrator", user.get("role") == "admin")
        bots = json.loads(call(BASE + "/api/v2/organizations/default/bots"))
        check("authenticated Bot list", isinstance(bots.get("bots"), list))
        state_file = ROOT / "acceptance-chat.json"
        if state_file.exists():
            state = json.loads(state_file.read_text())
        else:
            bot = json.loads(call(BASE + "/api/agents", {"name": "部署验收", "title": "Deployment verification", "roleDescription": "用于部署验收。按用户要求回复指定文本，不调用工具。", "visibility": "private"}))["agent"]
            channel = json.loads(call(BASE + "/api/channels", {"agentIds": [bot["id"]]}))["channel"]
            state = {"botId": bot["id"], "channelId": channel["id"]}
            state_file.write_text(json.dumps(state))
            state_file.chmod(0o600)
        marker = "deployment-check-" + uuid.uuid4().hex[:12]
        route = BASE + "/api/delivery/conversations/" + state["channelId"]
        accepted = json.loads(call(route + "/messages", {"agentId": state["botId"], "text": "Reply exactly: " + marker + ". Do not use tools.", "externalId": str(uuid.uuid4())}))
        check("conversation request queued", accepted.get("queued") is True)
        answered = False
        for _ in range(30):
            history = json.loads(call(route + "/history?agentId=" + state["botId"]))["history"]
            if any(message.get("role") == "assistant" and marker in str(message.get("content", "")) for message in history["messages"]):
                answered = True
                break
            time.sleep(2)
        check("new model response persisted in conversation", answered)
        check("Flexprice health", json.loads(call("http://127.0.0.1:18083/health"))["status"] == "ok")
        config = json.loads(call("https://infisical.persaas.cn/api/v1/admin/config"))["config"]
        check("Infisical initialized and registration closed", config["initialized"] and not config["allowSignUp"])
    finally:
        call(BASE + "/api/auth/sign-out", {})
    check("sign-out invalidates session", json.loads(call(BASE + "/api/auth/get-session")) is None)
    report = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "passed": passed, "blocked": ["CubeSandbox browser/template/volume: existing API key is unavailable", "OpenBot to Flexprice usage delivery: integration is not implemented", "Redis Sentinel topology decision is pending"]}
    target = ROOT / "acceptance-report.json"
    target.write_text(json.dumps(report, indent=2))
    target.chmod(0o600)


if __name__ == "__main__":
    main()
