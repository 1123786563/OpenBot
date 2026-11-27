#!/usr/bin/env python3
"""Apply bounded production health probes to the 1Panel Opik backend."""

from pathlib import Path
import subprocess
import yaml
import xml.etree.ElementTree as ET

profile = Path("/opt/1panel/apps/clickhouse/clickhouse/persaas-opik-user.xml")
previous = profile.read_text()
tree = ET.parse(profile)
node = tree.find("./profiles/persaas_opik")
if node is None:
    raise RuntimeError("Expected scoped Opik profile is missing")
codec = node.find("network_compression_method")
if codec is None:
    codec = ET.SubElement(node, "network_compression_method")
codec.text = "LZ4"
tree.write(profile, encoding="unicode")
subprocess.run(
    [
        "docker",
        "exec",
        "1Panel-clickhouse-qp1A",
        "clickhouse-client",
        "--query",
        "SYSTEM RELOAD CONFIG",
    ],
    check=True,
)
base = Path("/opt/1panel/apps/local/opik/opik")
p = base / "docker-compose.yml"
d = yaml.safe_load(p.read_text())
for service in d["services"].values():
    if service.get("container_name") == "persaas-opik-backend":
        service.setdefault("environment", {})[
            "ANALYTICS_DB_HEALTH_CHECK_TIMEOUT"
        ] = "10s"
        service["healthcheck"] = {
            "test": [
                "CMD",
                "curl",
                "-fsS",
                "--max-time",
                "8",
                "http://localhost:8080/health-check",
            ],
            "interval": "30s",
            "timeout": "10s",
            "start_period": "90s",
            "retries": 3,
        }
p.write_text(yaml.safe_dump(d, sort_keys=False))
subprocess.run(
    ["docker", "compose", "-f", str(p), "up", "-d", "--no-deps", "backend"],
    cwd=base,
    check=True,
)
if previous != profile.read_text():
    subprocess.run(["docker", "restart", "persaas-opik-backend"], check=True)
