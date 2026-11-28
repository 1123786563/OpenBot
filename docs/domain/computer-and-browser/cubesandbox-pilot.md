# Run the CubeSandbox browser pilot

## Prepare the browser runtime

1. Use a dedicated CubeSandbox cluster or project with volumes, create-time
   envd variables, restricted public ingress, and private node port mappings.
2. Build `agent-computer/Dockerfile` from the repository root for the Cube
   compute node's architecture. Derive a template image from it with
   `CMD ["/usr/bin/sleep", "infinity"]`. OpenBot starts the browser service
   through envd after Cube mounts the profiles volume and installs the instance's environment.
3. Create the template from the derived image. Inject envd with
   `--enable-inject-envd`, expose ports `4100` and `49983`, and use
   `--probe 49983 --probe-path /health`. The template must contain
   `/usr/bin/flock`, `/usr/local/bin/bun`, and `/app/src/index.ts`.
4. Create one empty, writable Cube volume per enrolled OpenBot user. Keep the
   volumes through sandbox replacements. Use storage that preserves Chromium's
   file and locking semantics across compute nodes.
5. Set up private ingress for browser HTTP and WebSocket traffic on `4100`
   and envd on `49983`. Resolve the sandbox's node mappings with CubeAPI
   `GET /sandboxes/{sandboxID}/exposed-ports/{containerPort}`. Allow access to
   the API, ingress, and mapped node ports from the OpenBot server only.
   Restrict them from Bot workloads and the public network. Cube's public
   proxy is disabled for these sandboxes. Direct node mappings require their
   own network restrictions.

See [CubeSandbox custom template images](https://docs.cubesandbox.com/guide/tutorials/bring-your-own-image),
[private port mapping](https://docs.cubesandbox.com/guide/sandbox-to-sandbox),
and [volume setup](https://docs.cubesandbox.com/guide/volume).

## Enroll test users

Obtain consent from each test user before adding their OpenBot user ID to the
volume map. Enroll each of those users in OpenShell on every API replica.
Keep the existing computer gateway configured and set the variables below on
every replica. [OpenShell execution pilot](../../configuration.md#openshell-execution-pilot)

On a machine started by `scripts/start.sh` or `bun run dev`, these variables
can live in `deploy/.local/pilot.env` instead of the settings files: both
launches read it, a value there wins over the settings files and over
Infisical, and a machine without the file is unaffected.

```dotenv
OPENBOT_CUBE_API_URL=https://cube-api.pilot.internal
OPENBOT_CUBE_BROWSER_TEMPLATE=template-id
OPENBOT_CUBE_BROWSER_URL=https://browser.pilot.internal/{{sandbox}}
OPENBOT_CUBE_ENVD_URL=https://envd.pilot.internal/{{sandbox}}
OPENBOT_CUBE_BROWSER_VOLUMES={"openbot-user-id":"cube-volume-name"}
```

Set `OPENBOT_CUBE_API_KEY` if CubeAPI requires it. Generate a dedicated
`OPENBOT_CUBE_BROWSER_SECRET` with at least 32 characters and keep it
consistent across replicas and restarts. Changing it changes the sandbox
lookup label and authentication token. Use the same bindings on every replica.
Remove a user from the volume map and restart OpenBot to return that user to
the legacy browser backend.

## Verify and replace a sandbox

1. Sign in as two enrolled test users. Open **Browser** and verify that each
   user sees their own live screen and can interact with it. Open the screen
   for the same public Bot as both users and verify takeover.
2. Sign in to a disposable test site in one user's own browser and in one of
   their Bot profiles. Check the other Bot profiles and the second user's
   public Bot for the expected signed-out state.
3. Close the browsers to flush their profiles. Delete only the first test
   user's sandbox in CubeSandbox and keep the associated volume.
4. Reopen from the same OpenBot entries. Confirm Cube created a different
   sandbox ID, the OpenBot browser ID stayed the same, and each profile
   retained its own login state.

## Verify the target deployment

Disposable tests used real CubeSandbox, Chromium, and OpenShell to check
same-node volume reattachment, profile isolation, streaming, and a browser
download delivered to an OpenShell workspace. A later disposable test verified
a one-time upload approval over HTTPS. Decline sent zero uploads. Allow once
sent exactly one upload, with a receipt matching the source bytes. That run
also checked browser egress after tightening policy on an open seat and checked
that the tested private management listeners were unreachable. An earlier
OpenShell test verified default deny, explicit HTTPS allow, and denial of a
different destination.

On the target deployment, repeat the replacement and streaming checks above
and verify both Bot file transfers through OpenBot. For upload, record the
enrolled person's approval outcome and compare the receipt with the disposable source
file. Validate browser and execution egress against that deployment's network
and management endpoints. Check that a browser outage leaves an already
delivered file available to OpenShell, and that an execution outage leaves the
browser available for viewing and takeover. For rollback, restart the API with
both pilot enrollments removed and verify that the legacy browser and execution
routes work. The disposable runs used synthetic identities and disposable
infrastructure. Deployment acceptance requires evidence from the target
configuration.
