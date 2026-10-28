import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import type { AuditEventInput } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { savedLogins, signInRequests } from "../src/db/schema/passwords";
import { createSignInService } from "../src/passwords/service";
import { createPasswordStore } from "../src/passwords/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The Postgres store behind the private sign-in form, against a real database: every read is the
 * owner's own, two submits racing end in one sign-in, and the stored password is the envelope.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `passwords-${randomUUID()}`;
const owner = `${prefix}-owner`;
const stranger = `${prefix}-stranger`;
const PASSWORD = "correct-horse-battery-staple-91";
const CODE = "424242-fixture-only";
const store = createPasswordStore(database);
const audit: AuditEventInput[] = [];
let releaseFill: (() => void) | undefined;
let releaseCode: (() => void) | undefined;
const service = createSignInService({
  store,
  encryptionKey: Buffer.alloc(32, 3).toString("base64"),
  auditStore: { insert: async (event) => void audit.push(event) },
  onResolved: async () => {},
  gateway: {
    signIn: async () => {
      await new Promise<void>((resolve) => {
        releaseFill = resolve;
      });
      return {
        submitted: true,
        passwordFieldVisible: false,
        url: "https://example.com/",
      };
    },
    // Held until the test lets it go: a delivery whose outcome nobody knows yet.
    signInCode: async () => {
      await new Promise<void>((resolve) => {
        releaseCode = resolve;
      });
      return {
        submitted: true,
        codeFieldVisible: false,
        passwordFieldVisible: false,
        url: "https://example.com/",
      };
    },
    requestHelp: async () => {
      throw new Error("not used");
    },
  },
});
const actor = { id: owner, userId: owner };

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: stranger, email: `${stranger}@example.test` },
  ]);
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, stranger]));
  await database.$client.close();
});

test("a request and a saved login are their owner's alone, and only the envelope is stored", async () => {
  const request = await service.request({
    ownerUserId: owner,
    botId: `${prefix}-bot`,
    site: "https://example.com/login",
    actor,
  });
  expect(await store.request(stranger, request.id)).toBeNull();
  expect((await service.pending(owner)).map((row) => row.id)).toEqual([
    request.id,
  ]);

  const first = service.submit(owner, request.id, actor, {
    username: "alice",
    password: PASSWORD,
    save: true,
  });
  // The second submit arrives while the first is still being typed, and is refused.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect(
    service.submit(owner, request.id, actor, {
      username: "alice",
      password: PASSWORD,
    }),
  ).rejects.toThrow(/already being entered/);
  releaseFill?.();
  expect((await first).status).toBe("signed_in");

  const rows = await database
    .select()
    .from(savedLogins)
    .where(inArray(savedLogins.ownerUserId, [owner, stranger]));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.encryptedPassword).not.toContain(PASSWORD);
  expect(JSON.parse(rows[0]?.encryptedPassword ?? "{}")).toMatchObject({
    version: 1,
  });
  const [stored] = await database
    .select()
    .from(signInRequests)
    .where(inArray(signInRequests.id, [request.id]));
  expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  expect(JSON.stringify(audit)).not.toContain(PASSWORD);

  expect(await store.deleteLogin(stranger, rows[0]?.id ?? "")).toBe(false);
  expect(
    (await service.deleteLogin(owner, rows[0]?.id ?? "", actor)).deleted,
  ).toBe(true);
});

/*
 * The code step, against the real store: `code_required` is an open state the pending list still
 * shows, the code lease is a conditional update two racers cannot both win, and a request that
 * closes while a code is in flight keeps its close.
 */
test("the code lease is claimed once, and a closed request keeps its close", async () => {
  const request = await service.request({
    ownerUserId: owner,
    botId: `${prefix}-bot-2`,
    site: "https://example.com/login",
    actor,
  });
  // What the password step leaves behind when the site asks for a code.
  await store.transition(owner, request.id, ["pending"], {
    status: "filling",
    method: "typed",
    fillingUntil: new Date(Date.now() + 60_000),
  });
  const atCode = await store.transition(owner, request.id, ["filling"], {
    status: "code_required",
    fillingUntil: null,
  });
  expect(atCode?.status).toBe("code_required");
  expect(atCode?.fillingUntil).toBeNull();
  // Open: the pending list shows it, so the form can ask for the code.
  expect((await service.pending(owner)).map((row) => row.id)).toContain(
    request.id,
  );

  // Two racers claim the same lease; the conditional update lets exactly one through.
  const [a, b] = await Promise.all([
    store.transition(owner, request.id, ["code_required"], {
      status: "filling",
      fillingUntil: new Date(Date.now() + 60_000),
    }),
    store.transition(owner, request.id, ["code_required"], {
      status: "filling",
      fillingUntil: new Date(Date.now() + 60_000),
    }),
  ]);
  expect([a !== null, b !== null].filter(Boolean)).toHaveLength(1);
  // Back to the code step, the way a finished attempt leaves it.
  await store.transition(owner, request.id, ["filling"], {
    status: "code_required",
    fillingUntil: null,
  });

  // The code submission claims the lease, then the request closes under it; the late outcome
  // lands on nothing, saves nothing and resumes nothing.
  const inFlight = service.submitCode(owner, request.id, actor, { code: CODE });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closed = await store.transition(owner, request.id, ["filling"], {
    status: "cancelled",
    resolvedAt: new Date(),
  });
  expect(closed?.status).toBe("cancelled");
  releaseCode?.();
  await expect(inFlight).rejects.toThrow(/changed while it was being entered/);
  const [row] = await database
    .select()
    .from(signInRequests)
    .where(inArray(signInRequests.id, [request.id]));
  expect(row?.status).toBe("cancelled");
  expect(JSON.stringify(audit)).not.toContain(CODE);
});

test("the code step finishes signed_in, and an abandoned lease ends failed, not open", async () => {
  const request = await service.request({
    ownerUserId: owner,
    botId: `${prefix}-bot-3`,
    site: "https://example.com/login",
    actor,
  });
  await store.transition(owner, request.id, ["pending"], {
    status: "filling",
    method: "typed",
    fillingUntil: new Date(Date.now() + 60_000),
  });
  await store.transition(owner, request.id, ["filling"], {
    status: "code_required",
    fillingUntil: null,
  });
  const submitting = service.submitCode(owner, request.id, actor, {
    code: CODE,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseCode?.();
  const done = await submitting;
  expect(done.status).toBe("signed_in");
  // The method the password step recorded survives the code step.
  expect(done.method).toBe("typed");
  expect(
    audit.find(
      (event) =>
        event.eventType === "computer.sign_in_completed" &&
        event.payload.verificationCode === true,
    ),
  ).toBeTruthy();
  expect(JSON.stringify(audit)).not.toContain(CODE);

  const abandoned = await service.request({
    ownerUserId: owner,
    botId: `${prefix}-bot-4`,
    site: "https://example.com/login",
    actor,
  });
  // What a server that died mid-fill leaves behind.
  await store.transition(owner, abandoned.id, ["pending"], {
    status: "filling",
    fillingUntil: new Date(Date.now() - 1_000),
  });
  const view = await service.get(owner, abandoned.id);
  expect(view.status).toBe("failed");
  expect(view.outcome).toMatch(/not known whether/);
  expect(view.resolvedAt).not.toBeNull();
  await expect(
    service.submit(owner, abandoned.id, actor, {
      username: "alice",
      password: PASSWORD,
    }),
  ).rejects.toThrow(/no longer open/);
});
