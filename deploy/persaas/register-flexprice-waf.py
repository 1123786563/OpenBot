#!/usr/bin/env python3
"""Register the manually configured Flexprice vhost in the entry host's WAF."""

import json
from pathlib import Path
import shutil
import subprocess

base = Path("/opt/1panel/apps/openresty/openresty/1pwaf/data")
domain = "flexprice.persaas.cn"
profile = base / "sites" / domain
if not profile.exists():
    shutil.copytree(base / "sites/bifrost.persaas.cn", profile)
p = base / "conf/sites.json"
original = p.read_text()
sites = json.loads(original)
if not any(site.get("key") == domain for site in sites):
    backup = p.with_suffix(".json.before-flexprice")
    if not backup.exists():
        backup.write_text(original)
    sites.append(
        {"key": domain, "domains": [domain], "host": [domain + ":80", domain + ":443"]}
    )
    p.write_text(json.dumps(sites))
    try:
        subprocess.run(
            ["docker", "exec", "1Panel-openresty-1334", "openresty", "-t"], check=True
        )
        subprocess.run(
            ["docker", "exec", "1Panel-openresty-1334", "openresty", "-s", "reload"],
            check=True,
        )
    except Exception:
        p.write_text(original)
        raise
print("Flexprice WAF domain registration present")
