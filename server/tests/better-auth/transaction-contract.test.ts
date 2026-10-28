import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  createTransactionHarness,
  type HarnessUser,
  type TransactionHarness,
} from "./support/transaction-http-harness";

/*
 * The T01.03 (#515) transaction contract: the fixed-version Better Auth
 * directory writes run inside the executor's own transaction, two requests
 * never share one, a mid-command SQL failure keeps its first SQLSTATE while
 * every write rolls back, and the package scan fails on an unlisted direct
 * adapter write.
 *
 * Every HTTP request in this file is real (loopback TCP against the harness's
 * Hono ingress); every assertion about "the same transaction" is grounded in
 * `txid_current()` recorded by a database trigger on the BA tables, compared
 * with the executor's outer txid. See
 * docs/plans/better-auth/full-integration/interfaces.md §3.1 and
 * acceptance.md V-B.
 */

const repoRoot = join(import.meta.dirname, "../../..");

let harness: TransactionHarness;

beforeAll(async () => {
  harness = await createTransactionHarness();
}, 120_000);

afterAll(async () => {
  if (!harness) return;
  await harness.close();
  // Teardown removes only what the harness itself created; the probe below is
  // the same after-close check the T01.02 fixture contract established, so a
  // future change that strands a schema, table or routine fails here instead
  // of quietly piling up per-run objects in the shared test database.
  expect(await harness.leakedResources()).toEqual([]);
});

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}@example.test`;
}

interface PostOptions {
  cookie?: string;
  body?: unknown;
  query?: string;
}

async function post(path: string, options: PostOptions): Promise<Response> {
  return harness.request(`/tx${path}${options.query ?? ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: JSON.stringify(options.body ?? {}),
  });
}

interface CommandSetup {
  organizationId: string;
  owner: HarnessUser;
}

async function setupOrganization(prefix: string): Promise<CommandSetup> {
  const owner = await harness.signUp(
    unique(`${prefix}-owner`),
    `${prefix} owner`,
  );
  const organizationId = `org_${prefix}_${process.pid}_${++sequence}`;
  await harness.seedOrganization({
    id: organizationId,
    name: `${prefix} Org`,
    slug: `${prefix}-${process.pid}-${sequence}`,
  });
  await harness.seedMember({
    id: `mem_owner_${organizationId}`,
    organizationId,
    userId: owner.userId,
    role: "owner",
  });
  return { organizationId, owner };
}

/**
 * Reset the capture table, run one HTTP command through the harness ingress,
 * and prove every DML it produced ran in the executor's outer transaction.
 */
async function postSameTx(
  path: string,
  options: PostOptions,
): Promise<{
  response: Response;
  json: Record<string, unknown>;
}> {
  await harness.resetDmlEvents();
  const response = await post(path, options);
  expect(response.status).toBe(200);
  const outerTxid = response.headers.get("x-harness-outer-txid");
  expect(outerTxid).toBeTruthy();
  const events = await harness.dmlEvents();
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.txid === outerTxid)).toBe(true);
  const json = (await response.json()) as Record<string, unknown>;
  return { response, json };
}

test("two_parallel_requests_never_share_tx", { timeout: 120_000 }, async () => {
  const { organizationId, owner } = await setupOrganization("parallel");
  await harness.resetDmlEvents();
  const [a, b] = await Promise.all([
    post("/organization/invite-member", {
      cookie: owner.cookie,
      query: "?holdMs=400",
      body: {
        organizationId,
        email: unique("parallel-a"),
        role: "member",
      },
    }),
    post("/organization/invite-member", {
      cookie: owner.cookie,
      query: "?holdMs=400",
      body: {
        organizationId,
        email: unique("parallel-b"),
        role: "member",
      },
    }),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);

  const txA = a.headers.get("x-harness-outer-txid");
  const txB = b.headers.get("x-harness-outer-txid");
  expect(txA).toBeTruthy();
  expect(txB).toBeTruthy();
  expect(txA).not.toBe(txB);
  // Separate transactions on separate backends: the pool handed each request
  // its own connection while both were held open by the harness.
  expect(a.headers.get("x-harness-backend-pid")).not.toBe(
    b.headers.get("x-harness-backend-pid"),
  );

  const events = await harness.dmlEvents();
  expect(events.length).toBeGreaterThan(0);
  expect(events.some((event) => event.txid === txA)).toBe(true);
  expect(events.some((event) => event.txid === txB)).toBe(true);
  expect(
    events.every((event) => event.txid === txA || event.txid === txB),
  ).toBe(true);
});

test("invite_accept_nested_tx_rolls_back_every_write", {
  timeout: 120_000,
}, async () => {
  const { organizationId, owner } = await setupOrganization("rollback");
  const invitee = await harness.signUp(
    unique("rollback-invitee"),
    "rollback invitee",
  );
  const invitationId = `inv_rollback_${process.pid}_${++sequence}`;
  await harness.seedInvitation({
    id: invitationId,
    organizationId,
    email: invitee.email,
    inviterId: owner.userId,
  });

  await harness.resetDmlEvents();
  const before = {
    invitation: await harness.readInvitation(invitationId),
    members: await harness.readMembers(organizationId),
    activeOrganizationId: await harness.readSessionActiveOrganization(
      invitee.sessionToken,
    ),
    dmlEvents: await harness.dmlEvents(),
  };
  expect(before.invitation?.status).toBe("pending");

  await harness.installMemberFault(invitee.userId);
  try {
    const response = await post("/organization/accept-invitation", {
      cookie: invitee.cookie,
      body: { invitationId },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { code: string; message: string };
    /*
     * The failure mid-way through the command is the injected SQLSTATE
     * 23505 from the member insert. The invitation compensation then runs
     * on the aborted transaction and would surface 25P02; the contract is
     * that the first SQLSTATE — and its original message — is what reaches
     * the caller, and 25P02 never masks it.
     */
    expect(body.code).toBe("23505");
    expect(body.message).toContain("injected member write fault");
  } finally {
    await harness.removeMemberFault();
  }

  const after = {
    invitation: await harness.readInvitation(invitationId),
    members: await harness.readMembers(organizationId),
    activeOrganizationId: await harness.readSessionActiveOrganization(
      invitee.sessionToken,
    ),
    dmlEvents: await harness.dmlEvents(),
  };
  // Whole-command rollback: the accepted flag, the member insert, the
  // session update and even the trigger's own evidence rows are all gone.
  expect(after).toEqual(before);
});

test("native_http_handler_is_never_used_for_directory_writes", {
  timeout: 300_000,
}, async () => {
  const { organizationId, owner } = await setupOrganization("sweep");
  const inviteeA = await harness.signUp(unique("sweep-a"), "sweep a");
  const inviteeB = await harness.signUp(unique("sweep-b"), "sweep b");
  const inviteeC = await harness.signUp(unique("sweep-c"), "sweep c");
  const inviteeD = await harness.signUp(unique("sweep-d"), "sweep d");

  /*
   * Positive sweep: every directory write method the harness ingress mounts
   * is driven from a real HTTP request; the fixed plugin's DML must land in
   * the harness executor's outer transaction (txid equality), never on a
   * pool connection of its own.
   */
  const invitedA = await postSameTx("/organization/invite-member", {
    cookie: owner.cookie,
    body: { organizationId, email: inviteeA.email, role: "member" },
  });
  const invitationA = invitedA.json.id as string;
  expect(invitationA).toBeTruthy();

  const acceptedA = await postSameTx("/organization/accept-invitation", {
    cookie: inviteeA.cookie,
    body: { invitationId: invitationA },
  });
  expect(
    (acceptedA.json.member as { userId: string } | undefined)?.userId,
  ).toBe(inviteeA.userId);

  const createdTeam = await postSameTx("/organization/create-team", {
    cookie: owner.cookie,
    body: { organizationId, name: "Sweep Team" },
  });
  const teamId = createdTeam.json.id as string;
  expect(teamId).toBeTruthy();

  await postSameTx("/organization/add-team-member", {
    cookie: owner.cookie,
    body: { teamId, organizationId, userId: inviteeA.userId },
  });
  await postSameTx("/organization/remove-team-member", {
    cookie: owner.cookie,
    body: { teamId, organizationId, userId: inviteeA.userId },
  });
  await postSameTx("/organization/update-team", {
    cookie: owner.cookie,
    body: { teamId, data: { name: "Sweep Team Renamed", organizationId } },
  });

  const memberIdA = await harness.memberIdOf(organizationId, inviteeA.userId);
  expect(memberIdA).toBeTruthy();
  await postSameTx("/organization/update-member-role", {
    cookie: owner.cookie,
    body: { memberId: memberIdA, role: "admin", organizationId },
  });

  await postSameTx("/organization/update", {
    cookie: owner.cookie,
    body: { organizationId, data: { name: "Sweep Org Renamed" } },
  });

  await postSameTx("/organization/leave", {
    cookie: inviteeA.cookie,
    body: { organizationId },
  });

  const invitedB = await postSameTx("/organization/invite-member", {
    cookie: owner.cookie,
    body: { organizationId, email: inviteeB.email, role: "member" },
  });
  const invitationB = invitedB.json.id as string;
  await postSameTx("/organization/accept-invitation", {
    cookie: inviteeB.cookie,
    body: { invitationId: invitationB },
  });
  const memberIdB = await harness.memberIdOf(organizationId, inviteeB.userId);
  expect(memberIdB).toBeTruthy();
  await postSameTx("/organization/remove-member", {
    cookie: owner.cookie,
    body: { memberIdOrEmail: memberIdB, organizationId },
  });

  const invitedC = await postSameTx("/organization/invite-member", {
    cookie: owner.cookie,
    body: { organizationId, email: inviteeC.email, role: "member" },
  });
  await postSameTx("/organization/reject-invitation", {
    cookie: inviteeC.cookie,
    body: { invitationId: invitedC.json.id as string },
  });

  const invitedD = await postSameTx("/organization/invite-member", {
    cookie: owner.cookie,
    body: { organizationId, email: inviteeD.email, role: "member" },
  });
  await postSameTx("/organization/cancel-invitation", {
    cookie: owner.cookie,
    body: { invitationId: invitedD.json.id as string },
  });

  /*
   * Closed methods (interfaces §3.2 disposition X): the ingress refuses them
   * before any transaction opens — a 403 with zero DML is the proof.
   */
  for (const path of [
    "/organization/create",
    "/organization/delete",
    "/organization/remove-team",
    "/organization/create-role",
    "/organization/update-role",
    "/organization/delete-role",
    "/organization/get-role",
    "/organization/list-roles",
    "/organization/list",
    "/organization/get-invitation",
    "/organization/list-user-invitations",
    "/organization/list-user-teams",
  ]) {
    await harness.resetDmlEvents();
    const refused = await post(path, {
      cookie: owner.cookie,
      body: { organizationId, name: "x", slug: "x", teamId },
    });
    expect(refused.status).toBe(403);
    const refusedBody = (await refused.json()) as { code: string };
    expect(refusedBody.code).toBe("DIRECTORY_WRITE_DISABLED");
    expect(await harness.dmlEvents()).toEqual([]);
  }

  /*
   * Deliberate wiring error: the same request served by auth.handler. The
   * handler re-binds the ALS store per request (isTransactionActive:false)
   * and opens its own pool transaction even inside the executor's outer
   * transaction, so its DML txid cannot equal the outer txid — and the
   * handler's writes commit despite the outer rollback. If the harness or
   * the capture trigger were broken, this control would not detect it.
   */
  const inviteeE = await harness.signUp(unique("sweep-e"), "sweep e");
  const invitedE = await postSameTx("/organization/invite-member", {
    cookie: owner.cookie,
    body: { organizationId, email: inviteeE.email, role: "member" },
  });
  const invitationE = invitedE.json.id as string;

  await harness.resetDmlEvents();
  const viaHandler = await post("/organization/accept-invitation", {
    cookie: inviteeE.cookie,
    query: "?mode=handler",
    body: { invitationId: invitationE },
  });
  expect(viaHandler.status).toBe(200);
  expect(viaHandler.headers.get("x-harness-mode")).toBe("handler");
  const outerTxid = viaHandler.headers.get("x-harness-outer-txid");
  expect(outerTxid).toBeTruthy();
  const handlerEvents = await harness.dmlEvents();
  expect(handlerEvents.length).toBeGreaterThan(0);
  const observedTxidMismatch = handlerEvents.some(
    (event) => event.txid !== outerTxid,
  );
  expect(observedTxidMismatch).toBe(true);
  // And the handler's write really committed outside the executor.
  expect(
    (await harness.readMembers(organizationId)).some(
      (member) => member.userId === inviteeE.userId,
    ),
  ).toBe(true);

  // The negative control leaves committed rows the outer rollback cannot
  // undo; remove exactly them.
  await harness.cleanupOutsideExecutor({
    organizationId,
    userId: inviteeE.userId,
    invitationId: invitationE,
  });
  await harness.resetDmlEvents();
});

test("unlisted_direct_adapter_write_fails_fixed_package_scan", {
  timeout: 300_000,
}, async () => {
  const script = join(repoRoot, "scripts/check-better-auth-adapter-writes.mjs");
  const manifest = join(
    repoRoot,
    "tests/config/better-auth-adapter-writes.json",
  );
  const packages = [
    "better-auth",
    "@better-auth/sso",
    "@better-auth/scim",
    "@better-auth/core",
  ];
  const realPackageRoot = join(repoRoot, "server/node_modules");

  /** sha256 of every file the scan reads in the real tree. */
  function hashScannedFiles(root: string): string[] {
    const digests: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(mjs|json)$/.test(entry)) {
          digests.push(
            `${full}#${createHash("sha256").update(readFileSync(full)).digest("hex")}`,
          );
        }
      }
    };
    for (const pkg of packages) walk(realpathSync(join(root, pkg)));
    return digests.sort();
  }

  // The fixed installed packages satisfy the manifest item by item.
  const real = spawnSync("node", [script], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8",
  });
  expect(real.status).toBe(0);

  const digestsBefore = hashScannedFiles(realPackageRoot);

  // Copy the fixed packages to a scratch root and inject one unlisted
  // direct write; the scan of that root must fail. The real node_modules
  // is never touched.
  const scratch = mkdtempSync(join(tmpdir(), "ba-adapter-writes-"));
  try {
    const packageRoot = join(scratch, "node_modules");
    for (const pkg of packages) {
      cpSync(join(realPackageRoot, pkg), join(packageRoot, pkg), {
        recursive: true,
        dereference: true,
      });
    }
    appendFileSync(
      join(
        packageRoot,
        "better-auth/dist/plugins/organization/routes/crud-invites.mjs",
      ),
      '\nctx.context.adapter.create({ model: "organizationRole", data: { injectedBy: "T01.03 scan gate proof" } });\n',
    );
    const injected = spawnSync("node", [script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        BA_ADAPTER_WRITES_PACKAGE_ROOT: packageRoot,
        BA_ADAPTER_WRITES_MANIFEST: manifest,
      },
      encoding: "utf8",
    });
    expect(injected.status).not.toBe(0);
    expect(`${injected.stdout}\n${injected.stderr}`).toContain(
      "crud-invites.mjs",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  expect(hashScannedFiles(realPackageRoot)).toEqual(digestsBefore);
});
