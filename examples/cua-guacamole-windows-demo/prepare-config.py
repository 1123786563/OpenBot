#!/usr/bin/env python3
import os
import xml.etree.ElementTree as ET
from pathlib import Path


root = Path(__file__).resolve().parent
env_file = root / ".env"
values: dict[str, str] = {}
for raw_line in env_file.read_text(encoding="utf-8").splitlines():
    line = raw_line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key.strip()] = value.strip().strip("\"'")
values.update({key: value for key, value in os.environ.items() if key in values})

required = [
    "WINDOWS_RDP_HOST",
    "WINDOWS_RDP_USERNAME",
    "WINDOWS_RDP_PASSWORD",
    "GUACAMOLE_USERNAME",
    "GUACAMOLE_PASSWORD",
]
missing = [key for key in required if not values.get(key) or "replace-with-" in values[key] or "change-this-" in values[key]]
if missing:
    raise SystemExit("Set these values in .env: " + ", ".join(missing))

port = values.get("WINDOWS_RDP_PORT", "3389")
if not port.isdigit() or not 1 <= int(port) <= 65535:
    raise SystemExit("WINDOWS_RDP_PORT must be a TCP port number")

mapping = ET.Element("user-mapping")
authorize = ET.SubElement(
    mapping,
    "authorize",
    username=values["GUACAMOLE_USERNAME"],
    password=values["GUACAMOLE_PASSWORD"],
)
connection = ET.SubElement(authorize, "connection", name="Windows CUA desktop")
ET.SubElement(connection, "protocol").text = "rdp"
params = {
    "hostname": values["WINDOWS_RDP_HOST"],
    "port": port,
    "username": values["WINDOWS_RDP_USERNAME"],
    "password": values["WINDOWS_RDP_PASSWORD"],
    "security": "nla",
    "ignore-cert": "true",
    "enable-wallpaper": "true",
    "resize-method": "display-update",
}
if values.get("WINDOWS_RDP_DOMAIN"):
    params["domain"] = values["WINDOWS_RDP_DOMAIN"]
for name, value in params.items():
    ET.SubElement(connection, "param", name=name).text = value

runtime = root / "runtime"
runtime.mkdir(exist_ok=True)
output = runtime / "user-mapping.xml"
ET.indent(mapping, space="  ")
ET.ElementTree(mapping).write(output, encoding="utf-8", xml_declaration=True)
output.chmod(0o600)
print("Generated local Guacamole RDP mapping (credentials are excluded from git).")
