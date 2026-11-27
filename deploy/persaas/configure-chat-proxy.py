#!/usr/bin/env python3
"""Run on entry host: narrowly exempt native chat bodies from WAF inspection."""

from pathlib import Path
import subprocess

p = Path("/opt/1panel/1panel/www/sites/www.persaas.cn/proxy/root.conf")
original = p.read_text()
marker = "# OpenBot native chat: tool schemas contain legitimate code examples."
if marker not in original:
    # The catch-all must permit this anchored regex sibling to be selected.
    base = original.replace("location ^~ / {", "location / {", 1)
    body = original[original.index("{") + 1 : original.rindex("}")]
    exception = "\n" + marker + """
location ~ ^/api/copilotkit/agent/[A-Za-z0-9_-]+/(connect|run)$ {
    # Override inherited WAF access handler only here. Application session,
    # ownership and origin checks still run. Other routes retain WAF inspection.
    access_by_lua_block {
        if ngx.req.get_method() ~= "POST" then
            return ngx.exit(405)
        end
    }
""" + body + "}\n"
    backup = p.with_suffix(".conf.before-chat")
    if not backup.exists():
        backup.write_text(original)
    p.write_text(base + exception)
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
print("Chat proxy configuration validated")
