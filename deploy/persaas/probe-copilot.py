#!/usr/bin/env python3
"""An anonymous native-chat connection must reach the app's JSON auth guard."""

import json
import urllib.error
import urllib.request

request = urllib.request.Request(
    "https://www.persaas.cn/api/copilotkit/agent/platform-probe/connect",
    data=json.dumps(
        {
            "context": [
                {"description": "A sandboxed UI example: <script>alert(1)</script>"}
            ]
        }
    ).encode(),
    headers={"Content-Type": "application/json", "Origin": "https://www.persaas.cn"},
)
try:
    response = urllib.request.urlopen(request, timeout=15)
except urllib.error.HTTPError as error:
    response = error
body = response.read()
try:
    result = json.loads(body)
except ValueError:
    raise SystemExit(
        f"FAIL native-chat route returns HTTP {response.status} HTML before application auth"
    )
if response.status != 401 or not isinstance(result, dict):
    raise SystemExit(
        f"FAIL native-chat route returned HTTP {response.status}; expected JSON 401"
    )
print("PASS native-chat route reaches application authentication (JSON 401)")
