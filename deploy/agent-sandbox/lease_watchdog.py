#!/usr/bin/python3
"""Linux lease watchdog for a single Flash instance. The control socket is root-only."""
import base64
import ctypes
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

MAX_LEASE_MS = 15_000
EXIT_RESERVE_MS = 1_000
MAX_FUTURE_ISSUE_MS = 500
POLL_SECONDS = 0.05
MESSAGE_BYTES = 4096
WORKER_UID = 10001
STATE = Path("/var/lib/openbot-lease")
CGROUP = Path("/sys/fs/cgroup/openbot-work")
ENTRYPOINT = ["/usr/local/bin/bun", "--no-env-file", "/app/src/index.ts"]
PR_SET_PDEATHSIG = 1
PR_SET_NO_NEW_PRIVS = 38


def wall_ms():
    return time.time_ns() // 1_000_000


def boot_ms():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000


class LeaseWatchdog:
    def __init__(self, state, cgroup, command):
        self.state = state
        self.cgroup = cgroup
        self.command = command
        self.boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        self.binding = None
        self.child = None
        self.issued_at = 0
        self.expires_at = 0
        self.stop_at_boot = 0
        self.sealed = False
        self.exited_at = None
        self.evidence_saved = False

    def advance(self):
        if self.child is None or self.exited_at is not None:
            self.save_evidence()
            return
        if (self.sealed or self.child.poll() is not None or
                wall_ms() >= self.expires_at - EXIT_RESERVE_MS or
                boot_ms() >= self.stop_at_boot):
            self.sealed = True
            # A kernel cgroup kill covers concurrent forks and descendants in
            # other sessions. Never report exit while a descendant is alive.
            (self.cgroup / "cgroup.kill").write_text("1")
            if (self.child.poll() is not None and
                    "populated 0" in (self.cgroup / "cgroup.events").read_text().splitlines()):
                self.exited_at = wall_ms()
                self.save_evidence()

    def save_evidence(self):
        if self.evidence_saved or self.binding is None:
            return
        observation = self.observation()
        if observation["kind"] not in ("exited", "never_started"):
            return
        temporary = self.state / "exit.tmp"
        with temporary.open("w") as output:
            json.dump({"binding": self.binding, "observation": observation}, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(self.state / "exit.json")
        directory = os.open(self.state, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        self.evidence_saved = True

    def observation(self):
        if self.exited_at is not None:
            return {"kind": "exited", "exitedAt": self.exited_at,
                    "issuedAt": self.issued_at, "leaseExpiresAt": self.expires_at,
                    "pid": self.child.pid, "bootId": self.boot_id}
        if self.sealed:
            return {"kind": "never_started" if self.child is None else "unconfirmed"}
        if self.child is None:
            return {"kind": "starting"}
        return {"kind": "running", "issuedAt": self.issued_at,
                "leaseExpiresAt": self.expires_at, "pid": self.child.pid,
                "bootId": self.boot_id}

    def request(self, message):
        action = message.get("action")
        binding = message.get("binding")
        if (not isinstance(binding, dict) or
                set(binding) != {"workspaceId", "generation", "epoch", "sandboxId"} or
                type(binding["epoch"]) is not int or binding["epoch"] < 0 or
                any(not isinstance(binding[key], str) or not binding[key]
                    for key in ("workspaceId", "generation", "sandboxId")) or
                (self.binding is not None and binding != self.binding)):
            return {"kind": "rejected"}
        self.advance()
        if action == "inspect":
            return self.observation()
        if action == "stop":
            self.binding = binding
            self.sealed = True
            self.advance()
            return self.observation()
        if (self.sealed or action not in ("start", "renew") or
                (action == "start") != (self.child is None)):
            return {"kind": "rejected"}

        issued = message.get("issuedAt")
        deadline = message.get("expiresAt")
        now = wall_ms()
        if (type(issued) is not int or type(deadline) is not int or
                issued <= self.issued_at or deadline <= self.expires_at or
                not 0 < deadline - issued <= MAX_LEASE_MS or
                issued > now + MAX_FUTURE_ISSUE_MS):
            return {"kind": "rejected"}
        remaining = deadline - max(now, issued) - EXIT_RESERVE_MS
        if remaining <= 0:
            return {"kind": "rejected"}
        stop_at_boot = boot_ms() + remaining

        token = message.get("token")
        if action == "start" and (not isinstance(token, str) or not token):
            return {"kind": "rejected"}

        self.issued_at = issued
        self.expires_at = deadline
        self.stop_at_boot = stop_at_boot

        if action == "start":
            self.binding = binding
            parent = os.getpid()
            libc = ctypes.CDLL(None, use_errno=True)

            def confine():
                (self.cgroup / "cgroup.procs").write_text(str(os.getpid()))
                os.setgroups([])
                os.setgid(WORKER_UID)
                os.setuid(WORKER_UID)
                if (libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 or
                        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0 or
                        os.getppid() != parent or boot_ms() >= stop_at_boot or
                        wall_ms() >= deadline - EXIT_RESERVE_MS):
                    os._exit(125)

            # Explicit environment keeps envd credentials and provider settings
            # out of the work process. The only credential it needs serves port 4100.
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": "/workspace",
                "WORKSPACE_DIR": "/workspace",
                "PROFILES_DIR": "/workspace/.profiles",
                "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
                "OPENBOT_RECORDER_DIR": "/recorder",
                "COMPUTER_BROWSER_MODE": "headless",
                "COMPUTER_PERSON_ID": binding["workspaceId"],
                "COMPUTER_TOKEN": token,
                "PORT": "4100",
            }
            try:
                self.child = subprocess.Popen(self.command, env=env, preexec_fn=confine)
            except (OSError, subprocess.SubprocessError):
                self.sealed = True
                return {"kind": "rejected"}

        self.advance()
        return self.observation()


def serve(state, cgroup, command):
    # An existing directory may contain a generation from a previous boot.
    # Starting a new watchdog in that instance must fail closed.
    state.mkdir(mode=0o700)
    watchdog = LeaseWatchdog(state, cgroup, command)
    try:
        cgroup.mkdir()
        (cgroup / "cgroup.kill").write_text("1")
    except OSError:
        # Report a sealed never-started generation if confinement is unavailable.
        watchdog.sealed = True
    confinement_ready = not watchdog.sealed

    def terminate(*_):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, terminate)
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as server:
        server.bind(str(state / "control"))
        server.listen(4)
        server.settimeout(POLL_SECONDS)
        try:
            while True:
                watchdog.advance()
                try:
                    client, _ = server.accept()
                except TimeoutError:
                    continue
                with client:
                    client.settimeout(POLL_SECONDS)
                    try:
                        payload = json.loads(client.recv(MESSAGE_BYTES))
                        result = (watchdog.request(payload) if isinstance(payload, dict)
                                  else {"kind": "rejected"})
                        binding = payload.get("binding") if isinstance(payload, dict) else None
                        reply = {"binding": binding, "observation": result}
                        client.sendall(json.dumps(reply).encode())
                    except (ConnectionError, TimeoutError, ValueError):
                        continue
        finally:
            if confinement_ready:
                (cgroup / "cgroup.kill").write_text("1")


def control(encoded):
    payload = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
    message = json.loads(payload)
    if len(payload) > MESSAGE_BYTES or message.get("action") not in ("start", "renew", "stop", "inspect"):
        raise ValueError("Invalid lease request")
    if not STATE.exists() and message["action"] in ("start", "stop"):
        # envd owns only the short control RPC. No envd stream, process group,
        # or client connection keeps the sandbox-local watchdog alive.
        subprocess.Popen(
            [sys.executable, __file__, "serve", str(STATE), str(CGROUP), *ENTRYPOINT],
            cwd="/app", start_new_session=True, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
        )

    path = STATE / "control"
    for _ in range(20):
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as client:
                client.settimeout(2)
                client.connect(str(path))
                client.sendall(payload)
                result = client.recv(MESSAGE_BYTES)
                if not result:
                    raise RuntimeError("Missing lease evidence")
                print(result.decode())
                return
        except (FileNotFoundError, ConnectionRefusedError):
            proof = STATE / "exit.json"
            if message["action"] in ("inspect", "stop") and proof.exists():
                print(proof.read_text())
                return
            time.sleep(POLL_SECONDS)
    raise RuntimeError("Lease watchdog unavailable")


if __name__ == "__main__":
    mode, *args = sys.argv[1:]
    if mode == "serve":
        state_path, cgroup_path, *entrypoint = args
        serve(Path(state_path), Path(cgroup_path), entrypoint)
    elif mode == "control":
        control(args[0])
    else:
        raise SystemExit("Expected serve or control")
