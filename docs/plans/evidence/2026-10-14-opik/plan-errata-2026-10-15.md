# Plan errata — defects the frontier workers found in my plans

Authoritative record of every defect the T01/T02/T05/T06 implementers found in the
`writing-plans` output, what they did about it, and what a re-run must do differently.

The plans' Self-Review sections claimed these were clean. They were not. Each item below was
found by a worker executing the plan against real code, which is exactly why the loop has
independent implementers and reviewers rather than trusting the plan author's own review.

Sources: `docs/tickets/opik-4/checkpoints/T01.md`, `T02.md`, `T05.md`, `T06.md`.

## E1 — Coordinator defect: repo-wide biome is an impossible gate (all 37 tickets)

**What I wrote:** `docs/tickets/opik-4/manifest.json` derived `handoff.verification` mechanically
from each ticket's owned_scope and appended `bunx biome lint --error-on-warnings . && bunx biome
format .` — repo-wide. That command is red at baseline (measured: lint 74 errors / 132 warnings /
29 infos over 2243 files; format 377 errors over 2222 files) and therefore can never pass.

**Consequence:** every one of the 37 tickets carried an unsatisfiable gate. A worker would either
chase noise outside its owned_scope (a scope violation) or falsely report failure.

**What the workers did:** T02, T05 and T06 all scoped biome to their own changed files, proved the
repo-wide numbers were identical on the untouched base, and recorded it as pre-existing instead of
silently "fixing" it. T06 additionally noted that `node_modules/.bin/biome` (locked) and
`bunx biome` (may fetch another version) can disagree, and used the locked binary to reproduce the
baseline numbers.

**Fix applied:** `gen_manifest_v2.py` now emits per-ticket scoped biome commands built from
owned_scope, plus an inline note that repo-wide biome and `server/tests/ready.test.ts` are red at
baseline. Regenerated; verified no repo-wide biome command remains in any of the 37 tickets.

## E2 — Coordinator defect: the baseline file recorded `server typecheck` as green

**What I wrote:** the baseline gates file claimed `cd server && bun run typecheck` → exit 0.

**Reality:** it was red on this branch — `webapp-proxy.ts(417,7) TS2322` (genuinely broken at the
branch base, since fixed on `main`) plus four `TS2307 Cannot find module 'pdf-lib'` (a stale
`node_modules`: the dependency is in `server/package.json` but was not installed here).

**Root cause of my error:** I measured on `main`, not on the branch the workers were given. The
baseline file even names both worktrees, which made the wrong number look authoritative.

**What the workers did:** T01, T05 and T06 each independently reproduced the failure on a detached
checkout of the base with the same `node_modules`, confirmed byte-identical diagnostics, and
reported their own files as contributing zero errors. None of them claimed a green gate they did
not have, and none of them patched `webapp-proxy.ts` (out of scope).

**Fix applied:** merged `main` into the branch and ran `bun install` (40 packages). Re-measured:
`cd server && bun run typecheck` exit 0, `cd app && bun run typecheck` clean. Baseline file
corrected with the measured error text and the two distinct causes.

## E3 — T01 plan: the `rejectingUser` test stub dropped its response

**What I wrote** (plan Task 2 Step 1):
```ts
const rejectingUser: MiddlewareHandler<{ Variables: AppVariables }> = async (context) => {
  await context.json({ error: "Authentication required." }, 401);
};
```
**Why it is wrong:** without `return`, the middleware does not short-circuit. Hono reports
"Context is not finalized" and any correct implementation yields 500, not the 401 the test asserts.
The real guard (`server/src/auth/guards.ts` `createRequireUser`) does `return context.json(..., 401)`.

**Correct form:**
```ts
const rejectingUser: MiddlewareHandler<{ Variables: AppVariables }> = async (context) => {
  return await context.json({ error: "Authentication required." }, 401);
};
```
Worker fixed it; assertion strength unchanged (still asserts 401 and that it precedes business logic).

## E4 — T01 plan: `requireUser` does not exist as a variable in `index.ts`

**What I wrote:** the plan assembled `createAiObservabilityRoutes({ requireUser, ... })` in
`index.ts` as if a `requireUser` binding existed there.

**Reality:** the repository's own convention is `createDeploymentRequireUser(config, auth,
roleRepository)`, exported from `app.ts`, whose docblock states it is "the one construction both
createApp and index.ts's seams mount". Likewise the store is `agentProfileStore`, not `agentStore`.

**Note:** the plan did anticipate signature drift for the store lookup ("以仓库当前实现为准") and
forbade the wrong permission function, which is why the worker landed on `canManageAgent` and never
on `canAccessAgent`. It did not anticipate the `requireUser` name being absent. A re-run should name
`createDeploymentRequireUser` explicitly.

## E5 — T05 plan: five contradictions between the plan's own tests and its own implementation

The plan's Self-Review claimed type consistency. It was not checked against the tests. T05 found
all five and adjudicated each against the plan's non-negotiable constraints (fail-closed wins):

1. **`ordinary prose is projected unchanged`** — the test called `projectSafeText("...")` with no
   opts, but the implementation defaults to `omitted(unhandled_free_text)`. The implementation is
   right (allowFreeText is an explicit caller assertion, not a default). **Test fixed** to pass
   `{ allowFreeText: true }`.
2. **`projectSafeUrl`** — implementation returned `omitted` for any URL with `search` or `hash`,
   contradicting both its own comment ("Query and fragment are dropped from what survives") and its
   own test (`?sig=abc#frag` → projected without query). **Implementation fixed**: raw-file /
   loopback → `omitted(raw_attachment)`; otherwise rebuild `scheme//host/path` (which drops query
   and fragment) and project.
3. **`projectSafeName`** — the allowlist regex `[\w.:/@ -]{0,256}` capped character count *before*
   the 128-byte budget, so a 400-char name returned `omitted` instead of the `truncated` the test
   expected — precisely the "three states must not collapse" violation the plan forbids.
   **Implementation fixed**: regex is `*` (character set only); length is the budget's job.
4. **depth test leaf value `"value"`** — collides with the `SafeValue` union's own JSON key
   `"value":`, so `not.toContain("value")` can never pass. **Test fixed** to
   `"deep-secret-leaf"`; the assertion's meaning (content beyond the depth limit must not appear)
   is unchanged.
5. **`projectSafeException` subclass name** — under Bun, `class UpstreamTimeout extends Error {}`
   still reports `error.name === "Error"`, so the plan's implementation failed its own test
   ("an Error subclass keeps its name"). **Implementation fixed** to use
   `error.constructor?.name`, consistent with the plan's own non-Error branch; bare `Error` still
   renders without a prefix.

## E6 — T05 plan: `SECRET_CANARIES` was declared in Interfaces but used nowhere

The plan's Task 2 Interfaces block listed `export const SECRET_CANARIES` as a Produced symbol, but
neither the plan's test code nor its implementation referenced it — the canary list lives in the
test file, and the implementation holds only the deny-pattern table. The manifest's `produces` for
T05 does not mention it either.

**Resolution:** not exported. Exporting adversarial sample literals into a production module would
put the exact strings an attacker can test against into the shipped bundle. A re-run should delete
the line from the Interfaces block. If #43 (T37) needs a shared canary list, it should import from
the test module, not from production code.

## E7 — T06 plan: the storage-locator fingerprint collided for equal-length scope keys

**What I wrote:** `workspace: \`openbot-${scope.kind}-${fingerprint}\`` with
`fingerprint = String(scope.key.length)`.

**Why it is wrong:** two different scope keys of the same length produce the same fingerprint, so
two trusted scopes could land in the same upstream workspace — defeating the isolation the whole
seam exists to guarantee. The plan's own test (`storage locators are distinct and both namespaced by
scopeKey`) caught it.

**Worker's fix:** fingerprint is now `keyLen` plus a sha256 prefix of the scope key, so distinct
scopes cannot collide. **No test was weakened** to accommodate the original design.

**Note for downstream:** #14 (T08) and #25 (T19) own the real upstream naming and idempotent
creation. The only constraints on `resolveStorageLocator` are that it derives from the scope,
includes the scope key, and differs between scopes. If T08 needs a different layout, change the
mapping there and leave a comment — do not make this function read the upstream layout, and never
reconstruct a scope from a locator.

## E8 — Process violation, self-reported: T01 used `git stash` mid-task

AGENTS.md forbids using a shared `git stash` as a parallel-coordination mechanism. T01 ran
`git stash push -u -m t01-fmt-probe` to compare against the baseline.

**Self-reported and remediated:** the worker located its own entry by tag, used `git stash apply`
(not `pop`), dropped only that entry, and verified its working tree matched
`/tmp/t01-task3-wip.patch`.

**Coordinator verification:** `git stash list` afterwards contains exactly two entries, both from
`1123786563/billing-audit-remediation` (`task5-wip-check`, `task4-biome-probe`). No `t01-fmt-probe`
remains, and the billing workstream's `task4-biome-probe` — which the worker explicitly said it had
not touched — is still present. The self-report is accurate.

**Ruling requested from the coordinator (human):** the violation was real, self-reported without
being asked, remediated, and caused no collateral damage. Options: accept with the note recorded,
or require the worker's future baseline comparisons to use a detached worktree instead (which is
what T05 and T06 did, and is the better pattern — it needs no shared mutable state at all).

## What this says about the loop

Every defect above was found by an executor, not by the plan author's Self-Review. Two of them
(E1, E2) were coordinator-level and would have degraded all 37 tickets. The three workers that hit
E2 did not paper over it: each reproduced the failure on a clean base checkout and reported it as
pre-existing with evidence. That is the behaviour the task specs asked for, and it is why the
baseline file now records measured-on-branch numbers rather than measured-on-main ones.

## E9 — T03 plan: obtaining digests by `docker pull` hangs under an unstable registry

**What I wrote** (plan Task 1 Step 2): pull every image, then read
`docker image inspect --format '{{index .RepoDigests 0}}'`.

**Why it is wrong in practice:** it downloads every layer (~5 GB for this stack) and issues an
unbounded, un-timed network command per image. Observed on the live T03 dispatch: two
`docker pull -q redis:7.2.4-alpine3.19` processes hung for 25 and 11 minutes — the second one a
duplicate of the first — while `clickhouse` never landed. Root cause measured from the coordinator
side:

```
docker buildx imagetools inspect clickhouse/clickhouse-server:26.3.16.16-alpine
-> ERROR: failed to authorize: failed to fetch anonymous token:
   Get "https://auth.docker.io/token?...": net/http: TLS handshake timeout
```

Docker Hub anonymous token auth was intermittently failing. The ghcr.io Opik images and most
Docker Hub images had already landed, so this was tag-specific flakiness, not a total outage —
which is exactly the condition under which an unbounded pull stalls instead of failing.

**Correct method** (verified working from the coordinator side in seconds, downloading nothing):

```bash
docker buildx imagetools inspect <ref> --format '{{.Manifest.Digest}}'
# or: docker manifest inspect <ref>   (returns the index; read the digest field)
```

This returns the registry manifest digest, which is precisely what pinning needs — the same value
`image@sha256:...` resolves. A re-run of this plan should use it instead of pull-then-inspect, and
should bound every registry command with `timeout`, resolve each ref once, and never issue a
duplicate pull.

**Digests obtained while diagnosing** (handed to the worker as a cross-check only, with an explicit
instruction to re-derive them rather than trust a coordinator-supplied value, because this ticket
forbids fabricated upstream evidence):

| Image | Digest |
| --- | --- |
| `redis:7.2.4-alpine3.19` | `sha256:c8bb255c3559b3e458766db810aa7b3c7af1235b204cfdb304e79ff388fe1a5a` |
| `clickhouse/clickhouse-server:26.3.16.16-alpine` | `sha256:b45ab149f0d331b944b4aa2ccdd47d0242238fd39e68ec524ad63338e4b9d8f8` (retrieved once; an immediate retry hit the TLS timeout, so it must be re-confirmed) |

**Correction — the "stuck worker" diagnosis in this entry was wrong.**

The registry flakiness, the two hung `docker pull` processes and the value of
`imagetools inspect` are all real and verified. The inference drawn from them was not: I reported
T03 as blocked inside an un-timed tool call and unable to reach a checkpoint. Re-measured properly,
T03 had 67 assistant turns with the last six spaced 0–4 seconds apart, the most recent 2 seconds
before observation. It was never blocked. It completed Task 1, committed, and produced a
`versions.json` whose redis and clickhouse digests **match the values I derived independently**,
with zero floating tags, zero missing digests, and `compatibility.status` correctly left
`unverified` for #10.

Two measurement errors produced the false alarm, and both are worth recording because they will
recur:

1. **Heartbeat recency is not activity.** Heartbeats are emitted on a fixed cadence from the
   preamble, so a stale `lastHeartbeatAt` says nothing about progress. The guide already states a
   heartbeat proves liveness rather than completion; the converse trap is treating its absence as
   stall.
2. **A paged transcript tail can look sparse and is not the real tail.** Reading with a small
   `--limit` and following `nextCursor` returned a sample whose apparent cadence was ~2 minutes per
   turn. The true cadence was seconds. Any stall claim must be made against a fully paged tail with
   the current time beside it.

The orphaned `docker pull` processes were real but harmless: the worker had already moved past
them. Host-side `ps` shows resource waste, not agent state, and must not be read as evidence about
the agent.

**Reaffirmed by this episode:** the recovery reference's table is the authority — `ready` or active
means *keep waiting*, and stall requires positive proof (`exited` liveness, the worker's own
observation of process exit, or a transcript whose final turn sent no `worker_done`). An unchanged
`worker-read` tail is absence, not proof. Had I acted on the false diagnosis I would have stopped a
healthy worker; the reference is what stopped me, not my own judgement.
