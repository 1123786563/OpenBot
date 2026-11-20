"""Run the sample Collector against synthetic runtime and audit privacy fixtures."""

from http.client import RemoteDisconnected
import json
import os
import socket
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from time import sleep, time, time_ns
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4

COLLECTOR = os.environ.get("OTELCOL_CONTRIB", "otelcol-contrib")
CONFIG = Path(__file__).resolve().with_name("openobserve-collector.yaml")
DEPLOYMENT = "fixture-east"
RAW_COMPONENT = "worker"
RAW_DIAGNOSTIC = "Unmigrated process log line."
CATALOGUE_DIAGNOSTIC = "No identity provider is configured."
UNTRUSTED_IDENTITY = "untrusted-deployment"
SENTINEL = "PRIVATE_FIXTURE_CONTENT"
OCCURRED_AT = "2026-01-01T12:00:00.000Z"

PRIVATE_FIELDS = dict.fromkeys(
    ("message", "prompt", "tool_arguments", "tool_result", "file_content",
     "credentials", "authorization", "diagnostic"), SENTINEL
)
PRIVATE_FIELDS["raw"] = {"nested": SENTINEL}


def attributes(values):
    types = {str: "stringValue", int: "intValue", dict: "kvlistValue"}
    return [
        {
            "key": key,
            "value": {
                types[type(value)]: {"values": attributes(value)}
                if isinstance(value, dict) else value
            },
        }
        for key, value in values.items()
    ]


def crio(body, channel="stdout", tag="F", timestamp=OCCURRED_AT):
    return f"{timestamp} {channel} {tag} {body}\n"


def audit_record(event_type, status, **fields):
    data = {
        "source": "openbot",
        "stream": "openbot_audit",
        "data_class": "audit",
        "canonical_source": "postgresql.audit_events",
        "schema_version": 1,
        "deployment_id": DEPLOYMENT,
        "projection_status": status,
        "audit_event_id": str(uuid4()),
        "occurred_at": OCCURRED_AT,
        "event_type": event_type,
        "target_type": "tool",
        "initiator_kind": "person",
        "surface": "bot",
        **PRIVATE_FIELDS,
        **fields,
    }
    return {
        "timeUnixNano": str(time_ns()),
        "eventName": SENTINEL,
        "severityText": SENTINEL,
        "traceId": "1234567890abcdef1234567890abcdef",
        "spanId": "1234567890abcdef",
        "body": {"kvlistValue": {"values": attributes({"raw": SENTINEL})}},
        "attributes": attributes({f"openbot.{key}": value for key, value in data.items()}),
    }


def send_audit(port, deployment):
    payload = {
        "resourceLogs": [{
            "schemaUrl": f"https://example.invalid/{SENTINEL}",
            "resource": {"attributes": attributes({"secret": SENTINEL})},
            "scopeLogs": [{
                "schemaUrl": f"https://example.invalid/{SENTINEL}",
                "scope": {"name": "openbot.audit", "version": SENTINEL,
                          "attributes": attributes({"secret": SENTINEL})},
                "logRecords": [
                    audit_record("approval.person_decided", "known", **{
                        "facet.decision": "allow_once",
                        "work_item_key": "work:fixture",
                        "routine_run_id": {"private": SENTINEL},
                        "facet.tool": {"secret": SENTINEL},
                        "facet.scope": SENTINEL,
                    }),
                    audit_record("routines.run_requested", "known", deployment_id=deployment,
                                 routine_run_id="routine-run-1"),
                    audit_record("responsibility.triggered", "known", responsibility_run_id="responsibility-run-1"),
                    audit_record("approval.evaluated", "known", **{
                        "facet.outcome": "ask", "facet.reason_code": "personal_rule",
                        "facet.policy_rule_id": "3c55db61-f955-4596-b96d-7d2c5dfaf256",
                    }),
                    audit_record("app_access.requested", "known", **{"facet.app_key": "github"}),
                    audit_record("future.event", "unknown", **{"facet.tool": SENTINEL}),
                    audit_record("approval.person_decided", "known", deployment_id="other"),
                ],
            }],
        }],
    }
    request = Request(
        f"http://127.0.0.1:{port}/v1/logs",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    for _ in range(150):
        try:
            with urlopen(request, timeout=2) as response:
                assert response.status == 200
                return
        except (RemoteDisconnected, ConnectionResetError):
            sleep(0.2)
        except URLError as error:
            if not isinstance(error.reason, ConnectionRefusedError):
                raise
            sleep(0.2)
    raise RuntimeError("Collector OTLP receiver did not start")


def append_runtime(path):
    current = {
        **PRIVATE_FIELDS,
        "source": "openbot", "stream": "openbot_runtime", "data_class": "runtime",
        "canonical_source": "openbot.stdout", "schema_version": 1,
        "deployment_id": DEPLOYMENT, "projection_status": "known",
        "occurred_at": OCCURRED_AT, "severity": "info", "component": "api",
        "event_category": "api_listening", "outcome": "succeeded", "port": 3000,
        "service": "openbot-api",
        "run_id": "run-fixture", "thread_id": {"secret": SENTINEL},
    }
    legacy = {
        **current, "event_category": "legacy_unstructured", "projection_status": "unknown",
        "legacy_event": "single_user_mode_enabled", "severity": "warn",
        "run_id": SENTINEL,
    }
    with path.open("a") as stream:
        stream.write(f"unrecognized container format {SENTINEL}\n")
        stream.write(f"2026-99-01T12:00:00.000Z stdout F {SENTINEL}\n")
        stream.write(f"{OCCURRED_AT} stdout X {SENTINEL}\n")
        stream.write(crio(f"legacy plain text {SENTINEL}"))
        stream.write(crio(json.dumps({
            "deployment_id": UNTRUSTED_IDENTITY, "component": "migration",
            "run_id": SENTINEL, "diagnostic": SENTINEL, "cri_stream": "stdout",
        }), channel="stderr", timestamp="2026-01-01T13:00:00.000+01:00"))
        stream.write(crio(f'{{"prompt": "{SENTINEL}"'))
        structured = json.dumps(current)
        stream.write(crio(structured[:100], tag="P"))
        stream.write(crio(structured[100:]))
        for record in (legacy, {**legacy, "diagnostic": "Old producer help text."},
                       {**current, "event_category": "migration_failed", "outcome": "failed",
                        "service": {"private": SENTINEL}},
                       {**legacy, "legacy_event": SENTINEL, "diagnostic": RAW_DIAGNOSTIC},
                       {**current, "deployment_id": UNTRUSTED_IDENTITY}):
            stream.write(crio(json.dumps(record)))


def read_stream(path, stream):
    raw = path.read_text()
    assert SENTINEL not in raw, f"Sensitive content escaped into {stream}"
    assert UNTRUSTED_IDENTITY not in raw, f"Untrusted identity escaped into {stream}"
    records = [
        record
        for line in raw.splitlines()
        for resource in json.loads(line)["resourceLogs"]
        for scope in resource["scopeLogs"]
        for record in scope["logRecords"]
    ]
    fields = []
    for record in records:
        assert record["body"] == {"stringValue": stream}, record
        assert not record.get("traceId") and not record.get("spanId"), record
        attrs = {item["key"]: next(iter(item["value"].values())) for item in record["attributes"]}
        assert attrs["stream"] == stream and attrs["deployment_id"] == DEPLOYMENT, attrs
        assert not (attrs.keys() & (PRIVATE_FIELDS.keys() - {"diagnostic"})), attrs
        fields.append(attrs)
    return fields


def check(directory, deployment=DEPLOYMENT, switch="on", endpoint="https://example.invalid/api/openbot/v1/logs"):
    enabled = deployment == DEPLOYMENT and switch == "on" and endpoint
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    overlay = {
        "receivers": {"otlp/audit": {"protocols": {"http": {"endpoint": f"127.0.0.1:{port}"}}}},
        "exporters": {
            **{
                f"file/{stream}": {"path": str(directory / f"{stream}.jsonl"), "flush_interval": "100ms"}
                for stream in ("runtime", "audit")
            },
            # The Collector validates unused exporters as well. These remain outside both pipelines.
            **{
                f"otlphttp/{stream}": {"logs_endpoint": "http://127.0.0.1:1/v1/logs"}
                for stream in ("runtime", "audit")
            },
        },
        "service": {
            "telemetry": {"metrics": {"level": "none", "readers": []}},
            "pipelines": {
                f"logs/{stream}": {"exporters": [f"file/{stream}"]}
                for stream in ("runtime", "audit")
            },
        },
    }
    (directory / "overlay.json").write_text(json.dumps(overlay))
    source = directory / "input.log"
    source.write_text(crio("initial synthetic line"))
    env = {
        **os.environ,
        "OPENBOT_DEPLOYMENT_ID": deployment,
        "OPENBOT_OTEL_EXPORT": switch,
        "OPENBOT_RUNTIME_LOG_GLOB": str(source),
        "OPENBOT_RUNTIME_COMPONENT": RAW_COMPONENT,
        "OPENOBSERVE_OTLP_LOGS_URL": endpoint,
        "OPENOBSERVE_RUNTIME_AUTHORIZATION": "Basic synthetic",
        "OPENOBSERVE_AUDIT_AUTHORIZATION": "Basic synthetic",
    }
    if deployment is None:
        env.pop("OPENBOT_DEPLOYMENT_ID")
    log_path = directory / "collector.log"
    with log_path.open("w") as log:
        collector = subprocess.Popen(
            [COLLECTOR, f"--config={CONFIG}", f"--config={directory / 'overlay.json'}"],
            env=env, stdout=log, stderr=subprocess.STDOUT,
        )
    try:
        deadline = time() + 30
        while time() < deadline:
            if collector.poll() is not None:
                raise RuntimeError("Collector exited before the runtime receiver started")
            if "Started watching file" in log_path.read_text():
                break
            sleep(0.2)
        else:
            raise RuntimeError("Runtime file receiver did not start watching")
        send_audit(port, deployment or "")
        append_runtime(source)
        deadline = time() + (30 if enabled else 2)
        while time() < deadline:
            paths = [directory / f"{stream}.jsonl" for stream in ("runtime", "audit")]
            if all(path.exists() and path.stat().st_size for path in paths):
                break
            sleep(0.2)
        collector.terminate()
        assert collector.wait(timeout=5) == 0
        internal_logs = log_path.read_text()
        assert SENTINEL not in internal_logs, "Sensitive content escaped into Collector logs"
        assert UNTRUSTED_IDENTITY not in internal_logs, "Untrusted identity escaped into Collector logs"
        assert "2026-99-01" not in internal_logs, "Collector logged an invalid CRI timestamp"
        if not enabled:
            for path in paths:
                assert not path.exists() or not path.stat().st_size, f"Disabled pipeline wrote to {path}"
            return
        runtime_records = read_stream(directory / "runtime.jsonl", "openbot_runtime")
        markers = [record for record in runtime_records if record.get("diagnostic") == RAW_DIAGNOSTIC]
        assert len(markers) == 3, f"Expected three fixed CRI legacy markers, got {markers}"
        assert sorted(marker["canonical_source"] for marker in markers) == [
            "openbot.stderr", "openbot.stdout", "openbot.stdout",
        ], markers
        for marker in markers:
            assert marker == {
                "source": "openbot", "stream": "openbot_runtime", "data_class": "runtime",
                "schema_version": "1", "deployment_id": DEPLOYMENT, "component": RAW_COMPONENT,
                "event_category": "legacy_unstructured", "projection_status": "unknown",
                "diagnostic": RAW_DIAGNOSTIC, "occurred_at": OCCURRED_AT,
                "canonical_source": marker["canonical_source"],
            }, marker
        assert len(runtime_records) == 7, runtime_records
        [current] = [record for record in runtime_records if record["event_category"] == "api_listening"]
        assert current["port"] == 3000 and current["run_id"] == "run-fixture"
        assert "thread_id" not in current and "diagnostic" not in current
        assert current["service"] == "openbot-api"
        [failure] = [record for record in runtime_records if record["event_category"] == "migration_failed"]
        assert failure["diagnostic"] == "Database migrations did not complete."
        assert "service" not in failure
        notices = [record for record in runtime_records if "legacy_event" in record]
        assert len(notices) == 2
        assert {record.get("diagnostic") for record in notices} == {CATALOGUE_DIAGNOSTIC}
        for notice in notices:
            assert notice["legacy_event"] == "single_user_mode_enabled"
            assert not ({"run_id", "port"} & notice.keys())
        audit_records = read_stream(directory / "audit.jsonl", "openbot_audit")
        assert len(audit_records) == 6, audit_records
        assert all("diagnostic" not in record for record in audit_records)
        audit = {record["event_type"]: record for record in audit_records}
        approved = audit["approval.person_decided"]
        assert approved["facet_decision"] == "allow_once" and approved["audit_event_id"]
        assert "facet_tool" not in approved and "facet_scope" not in approved
        assert approved["work_item_key"] == "work:fixture" and "routine_run_id" not in approved
        assert audit["routines.run_requested"]["routine_run_id"] == "routine-run-1"
        assert audit["responsibility.triggered"]["responsibility_run_id"] == "responsibility-run-1"
        evaluated = audit["approval.evaluated"]
        assert evaluated["facet_outcome"] == "ask"
        assert evaluated["facet_reason_code"] == "personal_rule"
        assert evaluated["facet_policy_rule_id"] == "3c55db61-f955-4596-b96d-7d2c5dfaf256"
        assert audit["app_access.requested"]["facet_app_key"] == "github"
        assert not any(key.startswith("facet_") for key in audit["future.event"])
    except Exception:
        print(log_path.read_text())
        raise
    finally:
        if collector.poll() is None:
            collector.kill()
            collector.wait(timeout=5)


if __name__ == "__main__":
    for options in ({}, {"deployment": None}, {"deployment": "invalid deployment"},
                    {"switch": " OFF "}, {"endpoint": ""}):
        with TemporaryDirectory(prefix="openobserve-collector-") as fixture:
            check(Path(fixture).resolve(), **options)
    print("Collector fixture passed: seven runtime and six audit records, disabled streams empty.")
