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


def crio(body):
    return f"{OCCURRED_AT} stdout F {body}\n"


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


def send_audit(port):
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
                        "facet.tool": {"secret": SENTINEL},
                        "facet.scope": SENTINEL,
                    }),
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
        "run_id": "run-fixture", "thread_id": {"secret": SENTINEL},
    }
    legacy = {
        **current, "event_category": "legacy_unstructured", "projection_status": "unknown",
        "legacy_event": "single_user_mode_enabled", "severity": "warn",
        "run_id": SENTINEL,
    }
    with path.open("a") as stream:
        stream.write(f"unrecognized container format {SENTINEL}\n")
        stream.write(crio(f"legacy plain text {SENTINEL}"))
        stream.write(crio(f'{{"prompt": "{SENTINEL}"'))
        for record in (current, legacy, {**legacy, "legacy_event": SENTINEL},
                       {**current, "deployment_id": "other"}):
            stream.write(crio(json.dumps(record)))


def read_stream(path, stream):
    raw = path.read_text()
    assert SENTINEL not in raw, f"Sensitive content escaped into {stream}"
    records = [
        record
        for line in raw.splitlines()
        for resource in json.loads(line)["resourceLogs"]
        for scope in resource["scopeLogs"]
        for record in scope["logRecords"]
    ]
    assert len(records) == 2, (stream, records)
    fields = []
    for record in records:
        assert record["body"] == {"stringValue": stream}, record
        assert not record.get("traceId") and not record.get("spanId"), record
        attrs = {item["key"]: next(iter(item["value"].values())) for item in record["attributes"]}
        assert attrs["stream"] == stream and attrs["deployment_id"] == DEPLOYMENT, attrs
        assert not (attrs.keys() & PRIVATE_FIELDS.keys()), attrs
        fields.append(attrs)
    return {record["event_category" if stream == "openbot_runtime" else "event_type"]: record
            for record in fields}


def check(directory):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    overlay = {
        "receivers": {"otlp/audit": {"protocols": {"http": {"endpoint": f"127.0.0.1:{port}"}}}},
        "exporters": {
            f"file/{stream}": {"path": str(directory / f"{stream}.jsonl"), "flush_interval": "100ms"}
            for stream in ("runtime", "audit")
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
        "OPENBOT_DEPLOYMENT_ID": DEPLOYMENT,
        "OPENBOT_RUNTIME_LOG_GLOB": str(source),
        "OPENOBSERVE_OTLP_LOGS_URL": "https://example.invalid/api/openbot/v1/logs",
        "OPENOBSERVE_RUNTIME_AUTHORIZATION": "Basic synthetic",
        "OPENOBSERVE_AUDIT_AUTHORIZATION": "Basic synthetic",
    }
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
        send_audit(port)
        append_runtime(source)
        deadline = time() + 30
        while time() < deadline:
            paths = [directory / f"{stream}.jsonl" for stream in ("runtime", "audit")]
            if all(path.exists() and path.stat().st_size for path in paths):
                break
            sleep(0.2)
        collector.terminate()
        assert collector.wait(timeout=5) == 0
        assert SENTINEL not in log_path.read_text(), "Sensitive content escaped into Collector logs"
        runtime = read_stream(directory / "runtime.jsonl", "openbot_runtime")
        assert runtime["api_listening"]["port"] == 3000
        assert runtime["api_listening"]["run_id"] == "run-fixture"
        assert "thread_id" not in runtime["api_listening"]
        legacy = runtime["legacy_unstructured"]
        assert legacy["legacy_event"] == "single_user_mode_enabled"
        assert not ({"run_id", "port"} & legacy.keys())
        audit = read_stream(directory / "audit.jsonl", "openbot_audit")
        approved = audit["approval.person_decided"]
        assert approved["facet_decision"] == "allow_once" and approved["audit_event_id"]
        assert "facet_tool" not in approved and "facet_scope" not in approved
        assert not any(key.startswith("facet_") for key in audit["future.event"])
    except Exception:
        print(log_path.read_text())
        raise
    finally:
        if collector.poll() is None:
            collector.kill()
            collector.wait(timeout=5)


if __name__ == "__main__":
    with TemporaryDirectory(prefix="openobserve-collector-") as fixture:
        check(Path(fixture).resolve())
    print("Collector fixture passed: two runtime and two audit records, no private content.")
