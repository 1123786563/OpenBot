# Validate the Personal SaaS Agent Sandbox in Hangzhou

[Issue #143](https://github.com/1123786563/OpenBot/issues/143) covers the private-trial lifecycle for [Agent Sandbox](adr/0013-use-agent-sandbox-and-agenticfs-for-the-personal-saas-computer-pilot.md). Use an isolated Alibaba Cloud Team, an empty database for the trial, and two test workspace owners. The historical #143 run used synthetic files and a template without mounts. To run this protocol on the current pilot, first [provision AgenticFS](personal-saas-agenticfs.md).

Hangzhou returned approximately 60 seconds of provider TTL for a 10-second create request and a 5-second timeout update. Fresh commands succeeded past 15 seconds in both trials. OpenBot gives Alibaba a five-minute resource TTL and issues absolute work leases of at most 15 seconds. A root-owned watchdog runs the file worker as UID and GID 10001. It applies Linux seccomp before exec, allowing threads in the same process and denying new processes. It checks wall time and monotonic boot time, reserves two seconds for termination, sends SIGKILL through a Linux pidfd and waits for that pidfd to report process exit. It seals the generation so delayed starts and renewals cannot restart it. [Hangzhou probe evidence](https://github.com/1123786563/OpenBot/pull/148) · [Flash lifecycle](https://www.alibabacloud.com/help/en/agent-sandbox/lifecycle)

## Build and configure the private trial

1. Use an AgenticFS-capable template in the Hangzhou Team. On a disposable instance verify `uname -m`, root envd commands and file upload, and that TCP 4100 is initially unused. The runtime needs Python 3 with `os.pidfd_open` and `signal.pidfd_send_signal`, `libseccomp.so.2`, a glibc-compatible Bun binary, `tar`, `sha256sum` and `install`. Confirm UID and GID 10001 are free for OpenBot's worker. Require port 4100 to reject traffic when the Flash traffic token is omitted. Destroy the disposable instance and verify detail and inventory. [Flash private port access](https://www.alibabacloud.com/help/en/agent-sandbox/network-access-control)

2. From the repository root, use the Bun version in `package.json` and build the worker at the same revision as the server. The example assumes `uname -m` returned `x86_64`. Pass `aarch64` for an ARM instance.

   ```sh
   bun install --frozen-lockfile
   deploy/agent-sandbox/build-artifact.sh /tmp/openbot-flash-runtime.tar.gz x86_64
   shasum -a 256 /tmp/openbot-flash-runtime.tar.gz
   ```

3. On each Personal SaaS server replica make the artifact readable at the configured absolute path. Apply the normal server migrations, including `0118_agent_sandbox_flash` if not already applied. Use the same database, encryption key, Team key, template and artifact on each replica. Use the template identifier returned in the Flash create response. The #143 Hangzhou trial returned `code-interpreter-v1`. Choose the identifier for your AgenticFS-capable template. Set a positive `OPENBOT_PERSONAL_QUOTA_COMPUTER_STORAGE_BYTES` within `OPENBOT_PERSONAL_QUOTA_STORAGE_BYTES`. Leave the Docker supervisor and former authority settings unset. Drain existing Flash generations before deploying this worker protocol or changing region, template, Team key or provider.

   ```sh
   export OPENBOT_PERSONAL_SAAS_MODE=private-trial
   export OPENBOT_AGENT_SANDBOX_FLASH_REGION=cn-hangzhou
   export OPENBOT_AGENT_SANDBOX_FLASH_TEMPLATE="replace-with-agenticfs-template-id"
   export OPENBOT_AGENT_SANDBOX_FLASH_ARTIFACT=/tmp/openbot-flash-runtime.tar.gz
   # Supply E2B_API_KEY through the deployment's secret mechanism.
   (cd server && bun --no-env-file scripts/migrate.ts)
   (cd server && bun --no-env-file src/personal-saas/index.ts)
   ```

On each start request, OpenBot reserves one slot, creates a fresh private instance with public traffic and internet access disabled, uploads the archive in parts of at most 24 MiB through root envd, reassembles it, checks its SHA-256 and installs it in `/opt/openbot`. The Flash HTTP gateway accepts up to 32 MiB per upload request. The instance needs no registry or package download. [Flash large file uploads](https://help.aliyun.com/zh/agent-sandbox/upload-large-files-to-fc-agent-sandbox) The setup reservation has a 30-second deadline. OpenBot rechecks account authorization after setup before issuing the initial work lease. Downloads, list, read and write use the same workspace implementation as the Docker computer. Flash exposes these file routes and health. OpenBot's gateway sends both the Flash traffic token and the worker token. Each issued lease applies to one generation and Flash keeps the original five-minute provider TTL. Run each scenario with a fresh instance.

A request whose create result is unknown keeps its slot occupied until reconciliation finds its exact metadata. An empty list by itself cannot close that intent. A delete response also leaves the slot occupied. The server saves worker exit evidence and then requests deletion. It requires an instance-specific Flash 404 and a complete generation-filtered inventory with no matches before releasing the slot. An instance that vanishes before OpenBot collects worker evidence remains pending. Preserve the database record and use the independent operator to investigate that generation.

## Run the cloud trials

1. Have owner A call `POST /api/workspace/computer/start` twice concurrently. Check `GET /api/workspace/computer` advances from `starting` to `running` and only one allocation appears in Flash inventory. Check owner B sees only B's state. Have a newly authorized Bot run write and read a synthetic file. Use `POST /api/workspace/computer/stop` and hold back delete confirmation in the test network path. Even with worker exit and an accepted delete, verify A sees `stopping` and cannot start another instance. Release confirmation and verify the slot opens.
2. For the account trial, take a fresh running generation and record its last accepted lease. Have the independent operator start an observer before disabling A in Casdoor. From inside the instance, use `/opt/openbot/openbot-lease control <encoded-request>` with the root-only `inspect` action to record the instance binding, PID, boot ID, and deadline. Its argument is unpadded Base64URL of JSON with `action: "inspect"` and `binding: {workspaceId, generation, epoch, sandboxId}`. As a separate observation, poll a Linux PID file descriptor for that PID with `os.pidfd_open` and `select.poll`. When the PID exits, record current Unix time and verify that the pidfd was opened for the OpenBot worker at `/opt/openbot/worker` and that `/proc/<pid>/status` showed UID/GID 10001, `NoNewPrivs: 1` and `Seccomp: 2` before exit. Collect the watchdog's `/var/lib/openbot-lease/exit.json` while available and compare its PID and boot ID. Keep the observer independent of the OpenBot connection. Reject new starts and task dispatch after disablement. Re-enable A, check the old generation stays stopped, manually start, and prove the old task is refused while a newly submitted task can use the file tools.
3. For the partition trial, hold both OpenBot's Flash control and envd paths for 20 seconds immediately after an acknowledged renewal. Keep the instance and independent observer running. Observe the process exit while the paths are blocked. Use the independent observer's connection to deliver a newer-but-delayed renewal after exit and confirm the watchdog rejects it. Also verify an out-of-order renewal and delayed start cannot re-arm the generation. Restore OpenBot's connectivity and verify it captures exit evidence, requests deletion, and releases the slot only after separate Flash confirmation.
4. Use a 30-second setup and a 30-second post-fault observation limit for each trial. Record region, template ID, artifact SHA-256, SDK version, binding, last accepted `issuedAt` and `leaseExpiresAt`, observed worker exit time, clock uncertainty, Flash request IDs, deletion confirmation time, and the first status that released the slot. Require `leaseExpiresAt - issuedAt <= 15000` and `observedExit + uncertainty <= leaseExpiresAt`. Verify the clock uncertainty between OpenBot and the instance is at most 500 ms, including during the partition. Check Alibaba inventory separately for running and paused instances and confirm the Console reports the instance gone. Finish cleanup before starting the next trial. Attach sanitized evidence to [target-cloud acceptance #74](https://github.com/1123786563/OpenBot/issues/74).

### Observe worker exit independently

Run this as a separate root envd command with the PID from the watchdog's `inspect` response. Keep its connection independent of the OpenBot fault injection. Wait for `ready` before triggering the fault.

```sh
python3 - "$worker_pid" <<'PYTHON'
import json
import os
from pathlib import Path
import select
import sys
import time

pid = int(sys.argv[1])
fd = os.pidfd_open(pid)
status = dict(line.split(":", 1) for line in Path(f"/proc/{pid}/status").read_text().splitlines())
assert status["Uid"].split() == ["10001"] * 4
assert status["Gid"].split() == ["10001"] * 4
assert status["NoNewPrivs"].strip() == "1"
assert status["Seccomp"].strip() == "2"
assert Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")[0] == b"/opt/openbot/worker"
boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
poll = select.poll()
poll.register(fd, select.POLLIN)
print(json.dumps({"kind": "ready", "pid": pid, "bootId": boot_id}), flush=True)
if not poll.poll(30_000):
    raise SystemExit("Worker exit unconfirmed")
exited = time.time_ns() // 1_000_000
print(json.dumps({"kind": "exit", "pid": pid, "bootId": boot_id, "observedExit": exited}))
PYTHON
```

For the partition trial, use the last acknowledged deadline before blocking connectivity. If another renewal was acknowledged before account disablement, compare the independent observation with the latest accepted lease recorded by the watchdog.

## Hangzhou pilot evidence

On 2026-11-23, the pilot used `code-interpreter-v1` in `cn-hangzhou` with envd 0.6.1, an x86-64 artifact, and isolated PostgreSQL through migration 0118. The OpenBot trial used a local Casdoor-compatible identity fixture and a synthetic Bot runner. Sandbox creation, envd traffic, guarded worker file actions, process observation, and deletion used Alibaba Cloud.

- Parallel starts across two OpenBot app instances yielded one accepted request and one quota refusal. A second owner saw an empty Computer state. Holding back the provider deletion confirmation left the first workspace in `stopping` and refused a new start.
- Both a first-generation Bot task and a newly authorized task after restart wrote and read a synthetic file through the OpenBot gateway. A task queued before restart stopped before its runner dispatched.
- After an acknowledged renewal, the cutoff run paused renewal and withheld Flash control connectivity for 20 seconds. An independent pidfd observer saw worker exit 13,011 ms after lease issue, with a 52 ms clock uncertainty estimate. The watchdog refused a renewal submitted after expiry. A separate account-disablement run observed worker exit 13,006 ms after lease issue, with a 70 ms clock uncertainty estimate.
- The workspace released its slot after the provider confirmed deletion. Post-trial lookups returned 404 for all disposable instances.

The built-in template denied `cgroup.kill`, so the trial used the no-child seccomp and pidfd path. A single archive upload failed with HTTP 400. Three upload parts, each at most 24 MiB, delivered the 51,824,275-byte archive and the in-sandbox hash check passed.

## Repeat the local checks

Run the process tests as root in an isolated Linux container with its normal read-only cgroup mount. The Python image must have `libseccomp.so.2`. Use `x86_64` on an x64 Linux host and `aarch64` on an ARM64 Linux host. The tests cover denied fork and detached subprocess creation, permitted threads, watchdog death, stale grants, and the shipped file worker.

```sh
deploy/agent-sandbox/build-artifact.sh /tmp/openbot-flash-test.tar.gz "$(docker info --format '{{.Architecture}}')"
docker run --rm --network none \
    -v /tmp/openbot-flash-test.tar.gz:/runtime.tar.gz:ro \
    -v "$PWD/deploy/agent-sandbox:/tests:ro" python:3.12-slim sh -ec '
      install -d -m 0755 /opt/openbot
      tar --no-same-owner -xzf /runtime.tar.gz -C /opt/openbot
      install -d -o 10001 -g 10001 -m 0700 /mnt/openbot-workspace
      python3 -B /tests/lease_watchdog_test.py
    '
bun test --no-env-file --env-file=.env.test \
    server/tests/agent-sandbox-provider.test.ts
bun test --no-env-file --env-file=.env.test --timeout 30000 \
    server/tests/personal-saas-entry.integration.test.ts --test-name-pattern 'Flash|Agent Sandbox'
```

The server contract tests use a local Flash HTTP fixture and dedicated PostgreSQL database. Run the target-cloud trials to verify Hangzhou envd upload, the template's seccomp behavior, clock uncertainty and provider cleanup.
