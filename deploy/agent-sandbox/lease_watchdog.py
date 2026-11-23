#!/usr/bin/env python3
"""Linux lease watchdog for a single Flash instance. The control socket is root-only."""
import base64
import ctypes
import errno
import json
import os
from pathlib import Path
import select
import signal
import socket
import subprocess
import sys
import time

MAX_LEASE_MS = 15_000
EXIT_RESERVE_MS = 2_000
MAX_FUTURE_ISSUE_MS = 500
POLL_SECONDS = 0.05
MESSAGE_BYTES = 4096
WORKER_UID = 10001
STATE = Path("/var/lib/openbot-lease")
RUNTIME = Path("/opt/openbot")
WORKSPACE = RUNTIME / "workspace"
ENTRYPOINT = [str(RUNTIME / "worker")]
PR_SET_PDEATHSIG = 1
PR_SET_NO_NEW_PRIVS = 38
SCMP_CMP_MASKED_EQ = 7
SCMP_ACT_ALLOW = 0x7fff0000
SCMP_ACT_ERRNO = 0x00050000


class SeccompArgument(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int),
                ("value", ctypes.c_uint64), ("mask_value", ctypes.c_uint64)]


def install_no_child_filter():
    seccomp = ctypes.CDLL("libseccomp.so.2")
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint,
        ctypes.POINTER(SeccompArgument),
    ]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(SCMP_ACT_ALLOW)
    if not context:
        raise RuntimeError("Cannot initialize the process filter")

    def deny(syscall, error=errno.EPERM, condition=None):
        number = seccomp.seccomp_syscall_resolve_name(syscall.encode())
        if number < 0:
            raise RuntimeError(f"Unknown syscall: {syscall}")
        result = seccomp.seccomp_rule_add_array(
            context, SCMP_ACT_ERRNO | error, number, int(condition is not None),
            ctypes.byref(condition) if condition is not None else None,
        )
        if result < 0:
            raise OSError(-result, f"Cannot filter {syscall}")

    try:
        # Linux x86-64 and arm64 use argument 0 for legacy clone flags.
        # Every admitted task must share its thread group, VM and handlers.
        thread_flags = (0x10000, 0x100, 0x800)  # CLONE_THREAD, CLONE_VM, CLONE_SIGHAND
        for flag in thread_flags:
            deny("clone", condition=SeccompArgument(0, SCMP_CMP_MASKED_EQ, flag, 0))
        if os.uname().machine == "x86_64":
            deny("fork")
            deny("vfork")
        for syscall in ("unshare", "setns", "io_uring_setup"):
            deny(syscall)
        # clone3 flags are behind a pointer. ENOSYS lets libc use legacy clone for threads.
        deny("clone3", errno.ENOSYS)
        # prctl takes an int, so match only the low 32 bits of the syscall argument.
        deny("prctl", condition=SeccompArgument(
            0, SCMP_CMP_MASKED_EQ, 0xffffffff, PR_SET_PDEATHSIG,
        ))
        result = seccomp.seccomp_load(context)
        if result < 0:
            raise OSError(-result, "Cannot install the process filter")
    finally:
        seccomp.seccomp_release(context)


def check_pidfd():
    if os.uname().machine not in ("x86_64", "aarch64"):
        raise RuntimeError("Unsupported clone ABI")
    fd = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(fd, 0)
    finally:
        os.close(fd)


def wall_ms():
    return time.time_ns() // 1_000_000


def boot_ms():
    return time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1_000_000


class LeaseWatchdog:
    def __init__(self, state, command):
        self.state = state
        self.command = command
        self.boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        self.binding = None
        self.child = None
        self.pidfd = None
        self.exit_poll = select.poll()
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
        exited = bool(self.exit_poll.poll(0))
        if (self.sealed or exited or wall_ms() >= self.expires_at - EXIT_RESERVE_MS or
                boot_ms() >= self.stop_at_boot):
            self.sealed = True
            if not exited:
                try:
                    signal.pidfd_send_signal(self.pidfd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                exited = bool(self.exit_poll.poll(0))
            if exited:
                self.exited_at = wall_ms()
                self.child.wait()
                self.exit_poll.unregister(self.pidfd)
                os.close(self.pidfd)
                self.pidfd = None
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
                os.setgroups([])
                os.setgid(WORKER_UID)
                os.setuid(WORKER_UID)
                if (libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 or
                        libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0 or
                        os.getppid() != parent):
                    raise RuntimeError("Cannot guard the worker against watchdog exit")
                install_no_child_filter()
                if (boot_ms() >= stop_at_boot or
                        wall_ms() >= deadline - EXIT_RESERVE_MS):
                    raise RuntimeError("Work lease expired during launch")

            # Explicit environment keeps envd credentials and provider settings
            # out of the work process. The only credential it needs serves port 4100.
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": str(WORKSPACE),
                "WORKSPACE_DIR": str(WORKSPACE),
                "COMPUTER_TOKEN": token,
            }
            try:
                self.child = subprocess.Popen(self.command, env=env, preexec_fn=confine)
            except (OSError, subprocess.SubprocessError):
                self.sealed = True
                return {"kind": "rejected"}
            # Popen has not reaped the child, so its PID cannot have been reused.
            self.pidfd = os.pidfd_open(self.child.pid)
            self.exit_poll.register(self.pidfd, select.POLLIN)
            try:
                signal.pidfd_send_signal(self.pidfd, 0)
            except ProcessLookupError:
                pass  # advance() will return exit evidence, never a running grant.

        self.advance()
        return self.observation()


def serve(state, command):
    # An existing directory may contain a generation from a previous boot.
    # Starting a new watchdog in that instance must fail closed.
    state.mkdir(mode=0o700)
    watchdog = LeaseWatchdog(state, command)
    try:
        check_pidfd()
    except (AttributeError, OSError, RuntimeError):
        # Report a sealed never-started generation if confinement is unavailable.
        watchdog.sealed = True

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
            watchdog.sealed = True
            watchdog.advance()


def control(encoded):
    payload = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
    message = json.loads(payload)
    if len(payload) > MESSAGE_BYTES or message.get("action") not in ("start", "renew", "stop", "inspect"):
        raise ValueError("Invalid lease request")
    if not STATE.exists() and message["action"] in ("start", "stop"):
        # envd owns only the short control RPC. No envd stream, process group,
        # or client connection keeps the sandbox-local watchdog alive.
        subprocess.Popen(
            [sys.executable, __file__, "serve", str(STATE), *ENTRYPOINT],
            cwd=RUNTIME, start_new_session=True, stdin=subprocess.DEVNULL,
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
        state_path, *entrypoint = args
        serve(Path(state_path), entrypoint)
    elif mode == "control":
        control(args[0])
    else:
        raise SystemExit("Expected serve or control")
