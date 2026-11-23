"""Run as root inside a disposable Linux cgroup namespace."""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import URLError
from urllib.request import Request, urlopen

WATCHDOG = Path(__file__).with_name("lease_watchdog.py")
BINDING = {"workspaceId": "workspace", "generation": "generation", "epoch": 3,
           "sandboxId": "sandbox"}
WORK = """
import os, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"],
                         start_new_session=True)
pathlib.Path(sys.argv[1]).write_text(f"{os.getpid()} {child.pid}")
while True:
    time.sleep(1)
"""


def now():
    return time.time_ns() // 1_000_000


class WatchdogTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.root.chmod(0o777)
        self.control = self.root / "state" / "control"
        self.pids_file = self.root / "worker-pids"
        self.cgroup = Path("/sys/fs/cgroup") / f"openbot-test-{os.getpid()}"
        self.addCleanup(self.remove_cgroup)
        self.watchdog = subprocess.Popen([
            sys.executable, str(WATCHDOG), "serve", str(self.control.parent),
            str(self.cgroup), sys.executable, "-c", WORK, str(self.pids_file),
        ])
        self.addCleanup(self.stop_watchdog)
        self.wait_for(self.control.exists)

    def stop_watchdog(self):
        self.watchdog.terminate()
        self.watchdog.wait(timeout=5)

    def remove_cgroup(self):
        if self.cgroup.exists():
            (self.cgroup / "cgroup.kill").write_text("1")
            self.cgroup.rmdir()

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
                                       **fields}).encode() + b"\n")
            return json.loads(client.recv(4096))["observation"]

    def test_partition_kills_the_worker_and_session_detached_descendant(self):
        start = now()
        self.assertEqual(self.call("start", issuedAt=start, expiresAt=start + 15_000,
                                   token="synthetic-token")["kind"], "running")
        self.wait_for(self.pids_file.exists)
        worker, descendant = map(int, self.pids_file.read_text().split())
        for pid in (worker, descendant):
            self.assertEqual(Path(f"/proc/{pid}/cgroup").read_text().strip(),
                             f"0::/{self.cgroup.name}")
        time.sleep(0.1)
        issued = now()
        deadline = issued + 15_000
        self.assertEqual(self.call("renew", issuedAt=issued, expiresAt=deadline)["kind"],
                         "running")
        self.assertEqual(self.call("renew", issuedAt=start, expiresAt=start + 15_000)["kind"],
                         "rejected")
        self.assertEqual(self.call("renew", {**BINDING, "epoch": 4},
                                   issuedAt=now(), expiresAt=deadline)["kind"], "rejected")
        # Partition: the parent sends neither renewal nor destroy. Observe via /proc only.
        while now() < deadline:
            if not Path(f"/proc/{worker}").exists() and self.cgroup_empty():
                break
            time.sleep(0.02)
        self.assertLessEqual(now(), deadline)
        self.assertFalse(Path(f"/proc/{worker}").exists())
        self.assertTrue(self.cgroup_empty())
        self.assertEqual(self.call("renew", issuedAt=now(), expiresAt=now() + 14_000)["kind"],
                         "rejected")
        evidence = self.call("inspect")
        self.assertEqual(evidence["kind"], "exited")
        self.assertEqual(evidence["pid"], worker)
        self.assertEqual(evidence["leaseExpiresAt"], deadline)
        self.assertLessEqual(evidence["exitedAt"], deadline)

    def cgroup_empty(self):
        return "populated 0" in (self.cgroup / "cgroup.events").read_text()

    def test_expired_start_and_start_after_stop_are_rejected(self):
        self.assertEqual(self.call("start", issuedAt=now() - 15_001,
                                   expiresAt=now() - 1, token="synthetic-token")["kind"],
                         "rejected")
        self.assertEqual(self.call("stop")["kind"], "never_started")
        self.assertEqual(self.call("start", issuedAt=now(), expiresAt=now() + 14_000,
                                   token="synthetic-token")["kind"], "rejected")
        self.assertFalse(self.pids_file.exists())


@unittest.skipUnless(Path("/usr/local/bin/openbot-lease").exists(),
                     "requires the Flash template image")
class AgentComputerTest(unittest.TestCase):
    def request(self, path, body=None):
        headers = {
            "x-openbot-bot-id": "partition-bot",
            "x-openbot-person-id": BINDING["workspaceId"],
            "x-openbot-computer-token": "synthetic-token",
            "content-type": "application/json",
        }
        request = Request(f"http://127.0.0.1:4100{path}", body, headers)
        with urlopen(request, timeout=1) as response:
            return response.read()

    def control(self, action, **fields):
        payload = {"action": action, "binding": BINDING, **fields}
        encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
        output = subprocess.check_output(["/usr/local/bin/openbot-lease", "control", encoded])
        return json.loads(output)["observation"]

    def test_real_agent_computer_serves_files_then_exits_without_control(self):
        issued = now()
        lease = {"issuedAt": issued, "expiresAt": issued + 15_000}
        self.assertEqual(self.control("start", token="synthetic-token", **lease)["kind"], "running")
        for _ in range(300):
            try:
                self.request("/health")
                break
            except URLError:
                time.sleep(0.02)
        else:
            self.fail(f"agent-computer did not start: {self.control('inspect')}")

        self.request("/files/write", b'{"path":"lease.txt","contents":"lease probe"}')
        read = self.request("/files/read", b'{"path":"lease.txt"}')
        self.assertIn(b"lease probe", read)
        pids = Path("/sys/fs/cgroup/openbot-work/cgroup.procs").read_text().split()
        self.assertEqual(len(pids), 1)
        pid = pids[0]
        self.assertIn(b"/app/src/index.ts", Path(f"/proc/{pid}/cmdline").read_bytes())

        while now() < lease["expiresAt"] and Path(f"/proc/{pid}").exists():
            time.sleep(0.02)
        self.assertLessEqual(now(), lease["expiresAt"])
        self.assertFalse(Path(f"/proc/{pid}").exists())
        with self.assertRaises(URLError):
            self.request("/files/read", b'{"path":"lease.txt"}')
        late = now()
        self.assertEqual(self.control("renew", issuedAt=late, expiresAt=late + 15_000)["kind"], "rejected")
        self.assertEqual(self.control("inspect")["pid"], int(pid))


if __name__ == "__main__":
    unittest.main()
