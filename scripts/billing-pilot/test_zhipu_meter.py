import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class TokenizerTransportTest(unittest.TestCase):
    def test_meter_proof_binds_request_id_and_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = importlib.util.spec_from_file_location(
                "zhipu_meter", Path(__file__).with_name("zhipu-meter.py")
            )
            meter = importlib.util.module_from_spec(spec)
            with patch.dict(os.environ, {
                "METER_ROUTES": json.dumps({
                    "zhipu/fixture-model": {"gatewayRevision": "gw", "meteringRevision": "mt"},
                }),
                "OPENBOT_BIFROST_METER_TOKEN": "fixture-meter-token",
                "ZHIPU_API_KEY": "fixture-provider-key",
                "METER_LOG": str(Path(tmp) / "meter.jsonl"),
            }):
                spec.loader.exec_module(meter)
            with (
                meter._log,
                patch.object(meter, "tokenize", return_value=(12, "tokenizer-id")),
                HTTPServer(("127.0.0.1", 0), meter.Meter) as server,
            ):
                server.timeout = 3
                thread = Thread(target=server.handle_request)
                thread.start()
                try:
                    body = b'{"model":"zhipu/fixture-model","messages":[{"role":"user","content":"Hello"}]}'
                    request_id = "57b2e9f9-884c-48aa-b428-793d0267818e"
                    request = Request(f"http://127.0.0.1:{server.server_port}/meter", body, {
                        "Authorization": "Bearer fixture-meter-token",
                        "Content-Type": "application/json",
                        "X-Request-Id": request_id,
                        "X-OpenBot-Bifrost-Gateway-Revision": "gw",
                        "X-OpenBot-Bifrost-Metering-Revision": "mt",
                    })
                    with urlopen(request, timeout=3) as response:
                        self.assertEqual(json.load(response), {
                            "requestId": request_id,
                            "requestSha256": hashlib.sha256(body).hexdigest(),
                            "gatewayRevision": "gw",
                            "meteringRevision": "mt",
                            "inputTokenUpperBound": 14,
                        })
                finally:
                    thread.join()

    def test_redirect_does_not_forward_tokenizer_credentials(self):
        received = []

        class Tokenizer(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.path, self.headers.get("Authorization")))
                self.send_response(302)
                self.send_header("Location", "/redirected")
                self.end_headers()

            def do_GET(self):
                received.append((self.path, self.headers.get("Authorization")))
                data = json.dumps({"usage": {"prompt_tokens": 12}}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        with HTTPServer(("127.0.0.1", 0), Tokenizer) as server, tempfile.TemporaryDirectory() as tmp:
            spec = importlib.util.spec_from_file_location(
                "zhipu_meter", Path(__file__).with_name("zhipu-meter.py")
            )
            meter = importlib.util.module_from_spec(spec)
            with patch.dict(os.environ, {
                "METER_ROUTES": "{}",
                "OPENBOT_BIFROST_METER_TOKEN": "fixture-meter-token",
                "ZHIPU_API_KEY": "fixture-provider-key",
                "METER_LOG": str(Path(tmp) / "meter.jsonl"),
            }):
                spec.loader.exec_module(meter)
            self.addCleanup(meter._log.close)
            meter.TOKENIZER_URL = f"http://127.0.0.1:{server.server_port}/tokenizer"
            thread = Thread(target=server.serve_forever)
            thread.start()
            try:
                with self.assertRaises(HTTPError) as error:
                    meter.tokenize("fixture-model", {"messages": []})
                self.assertEqual(error.exception.code, 302)
                error.exception.close()
                self.assertEqual(received, [("/tokenizer", "Bearer fixture-provider-key")])
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
