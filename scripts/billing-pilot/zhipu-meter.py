"""Operator meter for Zhipu GLM routes on the pinned Bifrost pilot.

Implements the meter contract from scripts/billing-pilot/bifrost.md: receive the
exact gateway Chat Completions body, refuse unknown routes or revisions, and
return a conservative input-token upper bound computed with the provider's own
tokenizer API (https://open.bigmodel.cn/api/paas/v4/tokenizer). The tokenizer
count equals the provider's reported prompt_tokens for text, tool-schema and
tool-result shapes (verified in docs/billing-zhipu-output-cap.md), so a small
framing margin keeps the bound conservative without drifting over route caps.

Run next to the verification workload:

  ZHIPU_API_KEY=... \
  OPENBOT_BIFROST_METER_TOKEN=<secret> \
  METER_ROUTES='{"zhipu/glm-5.3-flash":{"gatewayRevision":"gw","meteringRevision":"mt"},"zhipu/glm-5.3":{"gatewayRevision":"gw","meteringRevision":"mt"}}' \
  METER_LOG=/path/meter.jsonl python3 zhipu-meter.py 32813

Requests outside the approved routes, revisions or tokenizer's ability to bound
are refused, so the probe never dispatches an unbounded step.
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen

TOKENIZER_URL = "https://open.bigmodel.cn/api/paas/v4/tokenizer"
FRAMING_MARGIN = 2

try:
    APPROVED = json.loads(os.environ["METER_ROUTES"])
    METER_TOKEN = os.environ["OPENBOT_BIFROST_METER_TOKEN"].strip()
    API_KEY = os.environ["ZHIPU_API_KEY"].strip()
    LOG_PATH = os.environ.get("METER_LOG", "meter.jsonl")
except KeyError as missing:
    sys.exit(f"missing environment: {missing.args[0]}")

_log = open(LOG_PATH, "a", buffering=1)


def tokenize(model, payload):
    request = Request(
        TOKENIZER_URL,
        json.dumps({"model": model, **payload}).encode(),
        {
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=20) as response:
        usage = json.load(response)["usage"]
    return usage["prompt_tokens"] + usage.get("image_tokens", 0), usage.get("request_id")


class Meter(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        record = {
            "at": datetime.now(timezone.utc).isoformat(),
            "requestId": self.headers.get("x-request-id"),
            "operationId": self.headers.get("x-openbot-operation-id"),
        }
        try:
            payload = json.loads(body)
            route = APPROVED[payload["model"]]
            if (
                self.headers.get("authorization") != f"Bearer {METER_TOKEN}"
                or self.headers.get("x-openbot-bifrost-gateway-revision")
                != route["gatewayRevision"]
                or self.headers.get("x-openbot-bifrost-metering-revision")
                != route["meteringRevision"]
                or not isinstance(payload.get("messages"), list)
            ):
                raise KeyError("unapproved request")
            tokenizer_payload = {"messages": payload["messages"]}
            if payload.get("tools") is not None:
                tokenizer_payload["tools"] = payload["tools"]
            bound, tokenizer_id = tokenize(payload["model"].split("/", 1)[1], tokenizer_payload)
            record.update(
                model=payload["model"],
                requestSha256=hashlib.sha256(body).hexdigest(),
                inputTokenUpperBound=bound + FRAMING_MARGIN,
                tokenizerRequestId=tokenizer_id,
            )
            proof = {
                "inputTokenUpperBound": bound + FRAMING_MARGIN,
                "gatewayRevision": route["gatewayRevision"],
                "meteringRevision": route["meteringRevision"],
                "requestSha256": record["requestSha256"],
            }
            status = 200
        except KeyError:
            record["refused"] = "unapproved route, revision or payload"
            proof, status = None, 400
        except Exception as error:  # noqa: BLE001 - the probe must see a refusal, never a crash.
            record["refused"] = f"tokenizer unavailable: {error.__class__.__name__}"
            proof, status = None, 503
        _log.write(json.dumps(record) + "\n")
        data = json.dumps(proof).encode() if proof else b"{}"
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 32813), Meter).serve_forever()
