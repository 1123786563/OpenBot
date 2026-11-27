from pathlib import Path
import json, subprocess, urllib.request, urllib.error, urllib.parse

root = Path("/opt/persaas")
p = root / "credentials.json"
d = json.loads(p.read_text())
if not d.get("lagoUsageApiKey"):
    script = "o=Organization.find_by!(name: 'Persaas'); k=o.api_keys.first || o.api_keys.create!; puts 'PERSAAS_KEY='+k.value"
    out = subprocess.check_output(
        [
            "docker",
            "exec",
            "persaas-lago-api",
            "ruby",
            "/lago-secrets.rb",
            "bundle",
            "exec",
            "rails",
            "runner",
            script,
        ],
        stderr=subprocess.DEVNULL,
    ).decode()
    d["lagoUsageApiKey"] = next(
        l.split("=", 1)[1] for l in out.splitlines() if l.startswith("PERSAAS_KEY=")
    )
    p.write_text(json.dumps(d, indent=2))
    p.chmod(0o600)
key = d["lagoUsageApiKey"]


def api(path, body=None):
    req = urllib.request.Request(
        "http://127.0.0.1:13000/api/v1" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def ensure(path, collection, body):
    try:
        return api(path)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise
        return api(collection, body)


ensure(
    "/billable_metrics/model-usage",
    "/billable_metrics",
    {
        "billable_metric": {
            "name": "OpenBot microcredits",
            "code": "model-usage",
            "aggregation_type": "sum_agg",
            "field_name": "microcredits",
            "recurring": False,
        }
    },
)
customer = "persaas-openbot-usage"
ensure(
    "/customers/" + customer,
    "/customers",
    {
        "customer": {
            "external_id": customer,
            "name": "Persaas OpenBot usage reconciliation (zero rate)",
            "currency": "USD",
            "timezone": "UTC",
        }
    },
)
plan = "persaas-openbot-zero-usage"
ensure(
    "/plans/" + plan,
    "/plans",
    {
        "plan": {
            "name": "OpenBot usage reconciliation — zero rate",
            "code": plan,
            "interval": "monthly",
            "amount_currency": "USD",
            "amount_cents": 0,
            "pay_in_advance": False,
            "charges": [
                {
                    "billable_metric_id": api("/billable_metrics/model-usage")[
                        "billable_metric"
                    ]["lago_id"],
                    "charge_model": "standard",
                    "properties": {"amount": "0"},
                    "min_amount_cents": 0,
                }
            ],
        }
    },
)
subscription = "persaas-openbot-usage"
ensure(
    "/subscriptions/" + subscription,
    "/subscriptions",
    {
        "subscription": {
            "external_customer_id": customer,
            "external_id": subscription,
            "plan_code": plan,
        }
    },
)
subscription_record = api("/subscriptions/" + subscription)["subscription"]
assert int(subscription_record["plan"]["amount_cents"]) == 0
assert str(subscription_record["plan"]["charges"][0]["properties"]["amount"]) == "0"
print("Lago UTC customer, microcredit sum metric and zero-rate subscription ready")
token = ""


def vault(path, body=None, method=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        "http://127.0.0.1:18082/api/" + path,
        data=None if body is None else json.dumps(body).encode(),
        headers=h,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


token = vault(
    "v3/auth/login", {"email": d["adminEmail"], "password": d["infisicalPassword"]}
)["accessToken"]
token = vault("v3/auth/select-organization", {"organizationId": d["infisicalOrgId"]})[
    "token"
]
project = d["infisicalProjectId"]
folder = "worker"
query = urllib.parse.urlencode(
    {"projectId": project, "environment": "prod", "secretPath": "/" + folder}
)
old = {
    s["secretKey"]: s["secretValue"] for s in vault("v4/secrets?" + query)["secrets"]
}
for name, value in {
    "LAGO_URL": "https://lago-api.persaas.cn/",
    "LAGO_API_KEY": key,
    "LAGO_USAGE_SUBSCRIPTION_ID": subscription,
}.items():
    vault(
        "v4/secrets/" + name,
        {
            "projectId": project,
            "environment": "prod",
            "secretPath": "/" + folder,
            "secretValue": value,
        },
        "PATCH" if name in old else "POST",
    )
print("Worker usage exporter configured in Infisical")
