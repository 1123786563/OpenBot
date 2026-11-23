"""Exercise the Flash launch and control protocol on Linux as root."""
import base64
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

WATCHDOG = Path(__file__).with_name("lease_watchdog.py")
BINDING = {"workspaceId": "workspace", "generation": "generation", "epoch": 3,
           "sandboxId": "sandbox"}
PROBE = """
import errno, os, pathlib, subprocess, sys, threading, time
try:
    pid = os.fork()
except OSError as error:
    assert error.errno == errno.EPERM
else:
    if pid == 0:
        os._exit(0)
    os.waitpid(pid, 0)
    raise AssertionError("fork escaped confinement")
try:
    subprocess.run(["/bin/true"], start_new_session=True, check=True)
except OSError as error:
    assert error.errno in (errno.EPERM, errno.ENOSYS)
else:
    raise AssertionError("spawn escaped confinement")
def thread():
    pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
worker = threading.Thread(target=thread)
worker.start()
worker.join()
time.sleep(120)
"""


def now():
    return time.time_ns() // 1_000_000


def observe_exit(pidfd, deadline):
    poll = select.poll()
    poll.register(pidfd, select.POLLIN)
    if not poll.poll(max(0, deadline - now())):
        raise AssertionError("pidfd did not report exit before deadline")
    return now()


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.root.chmod(0o777)
        self.control = self.root / "state" / "control"
        self.proof = self.root / "worker-pid"
        self.watchdog = subprocess.Popen([
            sys.executable, str(WATCHDOG), "serve", str(self.control.parent),
            sys.executable, "-c", PROBE, str(self.proof),
        ])
        self.addCleanup(self.stop_watchdog)
        def accepting():
            try:
                return self.call("inspect")["kind"] == "starting"
            except (FileNotFoundError, ConnectionRefusedError):
                return False

        self.wait_for(accepting)

    def stop_watchdog(self):
        if self.watchdog.poll() is None:
            self.watchdog.terminate()
            self.watchdog.wait(timeout=5)

    def wait_for(self, check):
        for _ in range(250):
            if check():
                return
            if self.watchdog.poll() is not None:
                self.fail(f"Watchdog exited with {self.watchdog.returncode}")
            time.sleep(0.02)
        self.fail("Timed out waiting for process state")

    def call(self, action, binding=BINDING, **fields):
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
            client.settimeout(2)
            client.connect(str(self.control))
            client.sendall(json.dumps({"action": action, "binding": binding,
                                       **fields}).encode())
            return json.loads(client.recv(4096))["observation"]

    def start(self):
        issued = now()
        lease = {"issuedAt": issued, "expiresAt": issued + 15_000}
        observation = self.call("start", token="synthetic-token", **lease)
        self.assertEqual(observation["kind"], "running")
        self.wait_for(lambda: self.proof.exists() and self.proof.stat().st_size)
        self.assertEqual(int(self.proof.read_text()), observation["pid"])
        pidfd = os.pidfd_open(observation["pid"])
        self.addCleanup(os.close, pidfd)
        return lease, pidfd, observation["pid"]

    def test_partition_seals_process_after_absolute_cutoff(self):
        first, pidfd, pid = self.start()
        issued = now()
        deadline = issued + 15_000
        self.assertEqual(self.call("renew", issuedAt=issued, expiresAt=deadline)["kind"],
                         "running")
        self.assertEqual(self.call("renew", **first)["kind"], "rejected")
        self.assertEqual(self.call("renew", {**BINDING, "epoch": 4},
                                   issuedAt=now(), expiresAt=deadline)["kind"], "rejected")
        self.assertLessEqual(observe_exit(pidfd, deadline) + 500, deadline)
        self.assertEqual(self.call("renew", issuedAt=now(), expiresAt=now() + 14_000)["kind"],
                         "rejected")
        self.assertEqual(self.call("start", issuedAt=now(), expiresAt=now() + 14_000,
                                   token="stale")["kind"], "rejected")
        evidence = self.call("inspect")
        self.assertEqual(evidence["kind"], "exited")
        self.assertEqual(evidence["pid"], pid)
        self.assertEqual(evidence["leaseExpiresAt"], deadline)
        self.assertLessEqual(evidence["exitedAt"] + 500, deadline)

    def test_worker_dies_if_watchdog_is_killed(self):
        _, pidfd, _ = self.start()
        self.watchdog.kill()
        self.watchdog.wait(timeout=2)
        observe_exit(pidfd, now() + 1000)

    def test_expired_start_and_start_after_stop_are_rejected(self):
        self.assertEqual(self.call("start", issuedAt=now() - 15_001,
                                   expiresAt=now() - 1, token="synthetic-token")["kind"],
                         "rejected")
        self.assertEqual(self.call("stop")["kind"], "never_started")
        self.assertEqual(self.call("start", issuedAt=now(), expiresAt=now() + 14_000,
                                   token="synthetic-token")["kind"], "rejected")
        self.assertFalse(self.proof.exists())

@unittest.skipUnless(Path("/opt/openbot/worker").is_file(), "requires installed Flash artifact")
class FileWorkerTest(unittest.TestCase):
    def request(self, path, body=None, token="synthetic-token"):
        headers = {
            "x-openbot-bot-id": "partition-bot",
            "x-openbot-person-id": BINDING["workspaceId"],
            "x-openbot-computer-token": token,
            "content-type": "application/json",
        }
        request = Request(f"http://127.0.0.1:4100{path}", body, headers)
        with urlopen(request, timeout=1) as response:
            return response.read()

    def control(self, action, **fields):
        payload = {"action": action, "binding": BINDING, **fields}
        encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        output = subprocess.check_output(["/opt/openbot/openbot-lease", "control", encoded])
        return json.loads(output)["observation"]

    def test_artifact_serves_files_under_lease_and_exits_without_control(self):
        with self.assertRaises(URLError):
            self.request("/health")

        issued = now()
        lease = {"issuedAt": issued, "expiresAt": issued + 15_000}
        started = self.control("start", token="synthetic-token", **lease)
        self.assertEqual(started["kind"], "running")
        self.addCleanup(self.control, "stop")
        pid = started["pid"]
        pidfd = os.pidfd_open(pid)
        self.addCleanup(os.close, pidfd)
        for _ in range(250):
            try:
                self.request("/health")
                break
            except URLError:
                time.sleep(0.02)
        else:
            self.fail(f"File worker did not start: {self.control('inspect')}")

        status = Path(f"/proc/{pid}/status").read_text()
        self.assertRegex(status, r"Uid:\s+10001\s+10001\s+10001\s+10001")
        self.assertRegex(status, r"Gid:\s+10001\s+10001\s+10001\s+10001")
        self.assertIn("NoNewPrivs:\t1", status)
        self.assertIn("Seccomp:\t2", status)
        self.request("/files/write", b'{"path":"lease.txt","contents":"lease probe"}')
        self.request("/files/write", b'{"path":"lease.txt","contents":"!","append":true}')
        self.assertIn(b"lease probe!", self.request("/files/read", b'{"path":"lease.txt"}'))
        self.assertIn(b"lease.txt", self.request("/files/list", b"{}"))
        self.assertEqual(self.request("/files/download?path=lease.txt"), b"lease probe!")
        for path, body, token, expected in [
            ("/files/read", b'{"path":"lease.txt"}', "invalid", 401),
            ("/files/read", b'{"path":"../worker"}', "synthetic-token", 403),
            ("/exec", b'{"command":"true"}', "synthetic-token", 404),
            ("/navigate", b'{"url":"https://example.test"}', "synthetic-token", 404),
        ]:
            with self.assertRaises(HTTPError) as failure:
                self.request(path, body, token)
            self.assertEqual(failure.exception.code, expected)

        self.assertLessEqual(observe_exit(pidfd, lease["expiresAt"]) + 500,
                             lease["expiresAt"])
        with self.assertRaises(URLError):
            self.request("/health")
        evidence = self.control("inspect")
        self.assertEqual(evidence["kind"], "exited")
        self.assertEqual(evidence["pid"], pid)
        self.assertEqual(evidence["bootId"], started["bootId"])
        self.assertLessEqual(evidence["exitedAt"] + 500, lease["expiresAt"])


if __name__ == "__main__":
    unittest.main()
