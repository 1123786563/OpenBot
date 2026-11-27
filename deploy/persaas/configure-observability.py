from pathlib import Path
import json, secrets, base64, urllib.request, urllib.parse, urllib.error, subprocess

root = Path("/opt/persaas")
p = root / "credentials.json"
d = json.loads(p.read_text())
for k in ["openobserveRuntimeIngestToken", "openobserveAuditIngestToken"]:
    d.setdefault(k, secrets.token_hex(32))
p.write_text(json.dumps(d, indent=2))
p.chmod(0o600)
basic = (
    "Basic "
    + base64.b64encode(
        (d["openobserveEmail"] + ":" + d["openobservePassword"]).encode()
    ).decode()
)
token = ""


def request(url, body=None, method=None, headers=None):
    req = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=40) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def vault(path, body=None, method=None):
    return request(
        "http://127.0.0.1:18082/api/" + path,
        body,
        method,
        {"Authorization": "Bearer " + token} if token else {},
    )


token = vault(
    "v3/auth/login", {"email": d["adminEmail"], "password": d["infisicalPassword"]}
)["accessToken"]
token = vault("v3/auth/select-organization", {"organizationId": d["infisicalOrgId"]})[
    "token"
]


def upsert(project, folder, values):
    try:
        vault(
            "v2/folders",
            {"projectId": project, "environment": "prod", "name": folder, "path": "/"},
        )
    except urllib.error.HTTPError as e:
        if e.code not in (400, 409):
            raise
    query = urllib.parse.urlencode(
        {
            "projectId": project,
            "environment": "prod",
            "secretPath": "/" + folder,
            "expandSecretReferences": "false",
        }
    )
    old = {
        x["secretKey"]: x["secretValue"]
        for x in vault("v4/secrets?" + query)["secrets"]
    }
    for k, v in values.items():
        if old.get(k) == v:
            continue
        vault(
            "v4/secrets/" + k,
            {
                "projectId": project,
                "environment": "prod",
                "secretPath": "/" + folder,
                "secretValue": v,
            },
            "PATCH" if k in old else "POST",
        )


original = {
    k: json.loads(v)
    for k, v in (
        l.split("=", 1)
        for l in (root / "server.env").read_text().splitlines()
        if "=" in l
    )
}
deployment = original["DEPLOYMENT_ID"]
for stream, days in [("openbot_runtime", 30), ("openbot_audit", 90)]:
    request(
        "http://127.0.0.1:5080/api/default/" + stream + "/_json",
        [
            {
                "event_category": "platform_configuration_probe",
                "deployment_id": deployment,
            }
        ],
        headers={"Authorization": basic},
    )
    request(
        "http://127.0.0.1:5080/api/default/streams/" + stream + "/settings?type=logs",
        {
            "data_retention": days,
            "store_original_data": False,
            "index_original_data": False,
        },
        "PUT",
        {"Authorization": basic},
    )
    print(stream, "retention configured", days)
block = (
    """# BEGIN PERSAAS OBSERVE INGEST
location = /openbot-ingest/v1/logs {
    client_max_body_size 1m;
    access_by_lua_block {
        if ngx.req.get_method() ~= "POST" then return ngx.exit(405) end
        local headers = ngx.req.get_headers()
        local auth = headers["authorization"]
        local stream = headers["stream-name"]
        local expected
        if auth == "Bearer RUNTIME_TOKEN" then expected = "openbot_runtime"
        elseif auth == "Bearer AUDIT_TOKEN" then expected = "openbot_audit"
        else return ngx.exit(401) end
        if stream ~= expected then return ngx.exit(403) end
    }
    proxy_set_header Authorization "ROOT_AUTH";
    proxy_set_header stream-name $http_stream_name;
    proxy_pass http://127.0.0.1:5080/api/default/v1/logs;
}
# END PERSAAS OBSERVE INGEST
""".replace("RUNTIME_TOKEN", d["openobserveRuntimeIngestToken"])
    .replace("AUDIT_TOKEN", d["openobserveAuditIngestToken"])
    .replace("ROOT_AUTH", basic)
)
proxy = Path("/opt/1panel/1panel/www/sites/openobserve.persaas.cn/proxy/root.conf")
old = proxy.read_text()
start = old.find("# BEGIN PERSAAS OBSERVE INGEST")
if start >= 0:
    end = old.index("# END PERSAAS OBSERVE INGEST", start) + len(
        "# END PERSAAS OBSERVE INGEST"
    )
    old = old[:start] + old[end:]
proxy.write_text(old.rstrip() + "\n" + block)
proxy.chmod(0o600)
subprocess.run(
    ["docker", "exec", "1Panel-openresty-1334", "openresty", "-t"],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
)
subprocess.run(
    ["docker", "exec", "1Panel-openresty-1334", "openresty", "-s", "reload"],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.PIPE,
)
collector = {
    "OPENBOT_DEPLOYMENT_ID": deployment,
    "OPENBOT_OTEL_EXPORT": "on",
    "OPENBOT_RUNTIME_LOG_GLOB": "/runtime-logs/*/*.log",
    "OPENBOT_DOCKER_LOG_GLOB": "/docker-containers/*/*-json.log",
    "OPENBOT_RUNTIME_COMPONENT": "api",
    "OPENOBSERVE_OTLP_LOGS_URL": "https://openobserve.persaas.cn/openbot-ingest/v1/logs",
    "OPENOBSERVE_RUNTIME_AUTHORIZATION": "Bearer " + d["openobserveRuntimeIngestToken"],
    "OPENOBSERVE_AUDIT_AUTHORIZATION": "Bearer " + d["openobserveAuditIngestToken"],
}
f = root / "collector.env"
f.write_text("".join(k + "=" + json.dumps(v) + "\n" for k, v in collector.items()))
f.chmod(0o600)
upsert(d["infisicalInfrastructureProjectId"], "collector", {"ENV_FILE": f.read_text()})
upsert(
    d["infisicalInfrastructureProjectId"],
    "openobserve",
    {
        "RUNTIME_INGEST_TOKEN": d["openobserveRuntimeIngestToken"],
        "AUDIT_INGEST_TOKEN": d["openobserveAuditIngestToken"],
        "INGEST_GATEWAY_CONFIG": block,
    },
)
settings = {
    "OPENBOT_OTEL_EXPORT": "on",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://otel-collector:4318/v1/logs",
    "DEPLOYMENT_ID": deployment,
}
upsert(
    d["infisicalProjectId"],
    "server",
    {
        **settings,
        "OPENBOT_OPENOBSERVE_URL": "https://openobserve.persaas.cn/",
        "OPENBOT_OPIK_TRACE_OPERATORS": d["ownerPersonId"],
    },
)
upsert(d["infisicalProjectId"], "worker", settings)
print("Scoped log gateway and central OpenBot telemetry configuration ready")
