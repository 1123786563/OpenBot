# Validate the Personal SaaS Agent Sandbox in Hangzhou

[Issue #143](https://github.com/1123786563/OpenBot/issues/143) covers the private-trial lifecycle for [Agent Sandbox](adr/0013-use-agent-sandbox-and-agenticfs-for-the-personal-saas-computer-pilot.md). Use an isolated Alibaba Cloud Team, an empty database for the trial, and two test workspace owners. Use synthetic files and a template without mounts. AgenticFS and its quota belong to #144.

Hangzhou returned approximately 60 seconds of provider TTL for a 10-second create request and a 5-second timeout update. Fresh commands succeeded past 15 seconds in both trials. OpenBot therefore gives Alibaba a five-minute resource TTL and sends absolute leases to the watchdog inside the instance. The watchdog starts the actual `agent-computer` process in a root-owned cgroup under a separate unprivileged UID. It reserves one second for kill and exit confirmation before the authorized deadline. It checks the absolute wall clock and a monotonic boot clock. It rejects later starts and renewals once sealed. [Hangzhou probe evidence](https://github.com/1123786563/OpenBot/pull/148) · [Flash lifecycle](https://www.alibabacloud.com/help/en/agent-sandbox/lifecycle)

## Build and preflight the template

1. Build the standard agent-computer image and the Flash image from the same commit. Use a private registry reachable by the Flash template builder. The names below assume GHCR and a registry namespace you control.

   ```sh
   openbot_revision=$(git rev-parse --short=12 HEAD)
   computer_image="openbot-computer-flash-base:$openbot_revision"
   flash_image="ghcr.io/$FLASH_REGISTRY_NAMESPACE/openbot-computer-flash:$openbot_revision"
   docker buildx build --platform linux/amd64 --load --tag "$computer_image" --file agent-computer/Dockerfile .
   docker buildx build --platform linux/amd64 --load --tag "$flash_image" \
       --build-arg "COMPUTER_IMAGE=$computer_image" --file deploy/agent-sandbox/Dockerfile deploy/agent-sandbox
   docker push "$flash_image"
   ```

2. In the Hangzhou console, select **Flash Edition**, the pilot Team, then **Sandbox Templates** and **Create Template**. Select the **MicroVM** runtime and use the Flash image from step 1. For automation, use Alibaba Cloud's native `CreateTemplate` operation with runtime generation `2` and a scoped Alibaba Cloud identity. The Team E2B key is for creating instances from the resulting template. Save the Ready template ID and the image digest. To check runtime availability before publishing the OpenBot image, use the same console flow with the official Hangzhou MicroVM base image. [Console template setup](https://help.aliyun.com/zh/agent-sandbox/console-management-custom-templates) · [Native OpenAPI configuration](https://www.alibabacloud.com/help/en/agent-sandbox/build-and-manage-custom-templates-with-code/)

3. Create a disposable instance from the Ready template with E2B JS `2.31.0`. Set `secure: true`, `network: { allowPublicTraffic: false }`, and `allowInternetAccess: false`. Keep auto-pause and auto-resume disabled. Require a root envd command to succeed with the envd token and require port 4100 to reject traffic with the traffic token omitted. Before sending a work grant, verify port 4100 has no listener. From a root envd command, preflight the cgroup within the instance.

   ```sh
   mkdir /sys/fs/cgroup/openbot-preflight
   test -w /sys/fs/cgroup/openbot-preflight/cgroup.procs
   printf 1 > /sys/fs/cgroup/openbot-preflight/cgroup.kill
   grep -qx 'populated 0' /sys/fs/cgroup/openbot-preflight/cgroup.events
   rmdir /sys/fs/cgroup/openbot-preflight
   ```

   Require the worker UID to lack write access to the cgroup, runtime files and watchdog state. Require a writable, instance-local cgroup v2 hierarchy with working `cgroup.kill`. If the Flash runtime denies these operations, keep work admission disabled. Destroy the disposable instance and verify provider detail and inventory. [Flash private port access](https://www.alibabacloud.com/help/en/agent-sandbox/network-access-control)

The Hangzhou trial Team exposed `code-interpreter-v1` and `browser-bkbn`. Both provided cgroup v2 and root command execution. Both denied writes to `cgroup.kill`. Alibaba lookups confirmed deletion of both disposable instances. A Ready MicroVM template still needs this preflight before work admission or lease acceptance.

## Configure the private trial

Apply migrations through `0118_agent_sandbox_flash` with the normal migration entrypoint. Set `OPENBOT_PERSONAL_SAAS_MODE=private-trial`, `OPENBOT_AGENT_SANDBOX_FLASH_REGION=cn-hangzhou`, `OPENBOT_AGENT_SANDBOX_FLASH_TEMPLATE=<immutable-template-id>` and `E2B_API_KEY` in the Personal SaaS deployment. Use the same region, template, Team API key, PostgreSQL database, and encryption key across replicas. Set a positive `OPENBOT_PERSONAL_QUOTA_COMPUTER_STORAGE_BYTES` within `OPENBOT_PERSONAL_QUOTA_STORAGE_BYTES` to enable start admission. Leave the Docker supervisor and former authority settings unset on the Flash deployment. Drain outstanding generations before changing the template, key, or provider.

The Personal SaaS server calls Flash create, detail, list, and delete on the regional endpoint. EnvD commands carry only watchdog requests. They never execute Bot file actions. The existing computer gateway sends file actions to port 4100 using separate Flash traffic and OpenBot worker tokens. The worker serves only while its cgroup is live. Flash does not extend the five-minute resource TTL in this pilot. Run each scenario with a fresh instance.

A request whose create result is unknown keeps its slot occupied until reconciliation finds its exact metadata. An empty list by itself cannot close that intent. A delete response also leaves the slot occupied. The server saves worker exit evidence and then requests deletion. It requires an instance-specific Flash 404 and a complete generation-filtered inventory with no matches before releasing the slot. An instance that vanishes before OpenBot collects worker evidence remains pending. Preserve the database record and use the independent operator to investigate that generation.

## Run the cloud trials

1. Have owner A call `POST /api/workspace/computer/start` twice concurrently. Check `GET /api/workspace/computer` advances from `starting` to `running` and only one allocation appears in Flash inventory. Check owner B sees only B's state. Have a newly authorized Bot run write and read a synthetic file. Use `POST /api/workspace/computer/stop` and hold back delete confirmation in the test network path. Even with worker exit and an accepted delete, verify A sees `stopping` and cannot start another instance. Release confirmation and verify the slot opens.
2. For the account trial, take a fresh running generation and record its last accepted lease. Have the independent operator start an observer before disabling A in Casdoor. From inside the instance, use the root-only watchdog `inspect` command to record the instance binding, PID, boot ID, and deadline. Its argument is unpadded Base64URL of JSON with `action: "inspect"` and `binding: {workspaceId, generation, epoch, sandboxId}`. As a separate observation, poll a Linux PID file descriptor for that PID with `os.pidfd_open` and `select.poll`. When the PID exits, record current Unix time and verify `/sys/fs/cgroup/openbot-work/cgroup.events` reports `populated 0`. Collect the watchdog's `/var/lib/openbot-lease/exit.json` while available and compare its PID and boot ID. Keep the observer independent of the OpenBot connection. Reject new starts and task dispatch after disablement. Re-enable A, check the old generation stays stopped, manually start, and prove the old task is refused while a newly submitted task can use the file tools.
3. For the partition trial, hold both OpenBot's Flash control and envd paths for 20 seconds immediately after an acknowledged renewal. Keep the instance and independent observer running. Observe the process exit while the paths are blocked. Use the independent observer's connection to deliver a newer-but-delayed renewal after exit and confirm the watchdog rejects it. Also verify an out-of-order renewal and delayed start cannot re-arm the generation. Restore OpenBot's connectivity and verify it captures exit evidence, requests deletion, and releases the slot only after separate Flash confirmation.
4. Use a 30-second setup and a 30-second post-fault observation limit for each trial. Record region, template ID, image digest, SDK version, binding, last accepted `issuedAt` and `leaseExpiresAt`, observed worker exit time, clock uncertainty, Flash request IDs, deletion confirmation time, and the first status that released the slot. Require `leaseExpiresAt - issuedAt <= 15000` and `observedExit + uncertainty <= leaseExpiresAt`. Verify the clock uncertainty between OpenBot and the MicroVM is at most 500 ms, including during the partition. Check Alibaba inventory separately for running and paused instances and confirm the Console reports the instance gone. Finish cleanup before starting the next trial. Attach sanitized evidence to [target-cloud acceptance #74](https://github.com/1123786563/OpenBot/issues/74).

## Repeat the local checks

Run the process tests on the Flash image with a private Linux cgroup namespace. Substitute the locally built image tag for `$flash_image`. The tests drive the watchdog, a session-detached child, and the real agent-computer file routes. No cloud credential is required.

```sh
docker run --rm --privileged --cgroupns private --network none \
    -v "$PWD/deploy/agent-sandbox:/tests:ro" "$flash_image" \
    python3 /tests/lease_watchdog_test.py
bun test --no-env-file --env-file=.env.test \
    server/tests/agent-sandbox-provider.test.ts
bun test --no-env-file --env-file=.env.test --timeout 30000 \
    server/tests/personal-saas-entry.integration.test.ts --test-name-pattern 'Flash|Agent Sandbox'
```

The server contract tests use a local Flash HTTP fixture and dedicated PostgreSQL database. Hangzhou template support, clock uncertainty, and final cleanup semantics still require the target-cloud trials.
