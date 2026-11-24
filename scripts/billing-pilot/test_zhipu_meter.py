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


class TokenizerTransportTest(unittest.TestCase):
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
