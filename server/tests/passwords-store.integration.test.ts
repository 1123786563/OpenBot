import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { AuditEventInput } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { personSeat } from "../src/computer/computer-key";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { savedLogins, signInRequests } from "../src/db/schema/passwords";
import { createPasswordRoutes } from "../src/passwords/routes";
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
const store = createPasswordStore(database);
const audit: AuditEventInput[] = [];
let releaseFill: (() => void) | undefined;
const service = createSignInService({
  store,
  encryptionKey: Buffer.alloc(32, 3).toString("base64"),
  auditStore: { insert: async (event) => void audit.push(event) },
  gateway: {
    seatFor: async (botId, personId) => personSeat(personId, botId),
    signIn: async () => {
      await new Promise<void>((resolve) => {
        releaseFill = resolve;
      });
      return {
        submitted: true,
        passwordFieldVisible: false,
        codeRequested: false,
        url: "https://example.com/",
      };
    },
    signInCode: async () => {
      throw new Error("not used");
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

/**
 * A site that asks for a verification code after the password. `code_required` is a status the
 * table's check constraint must accept (migration 0056), and an open request the person still sees.
 */
test("a request waiting on its verification code is stored, listed, and then signed in", async () => {
  const codes: string[] = [];
  const mfa = createSignInService({
    store,
    encryptionKey: Buffer.alloc(32, 3).toString("base64"),
    gateway: {
      seatFor: async (botId, personId) => personSeat(personId, botId),
      signIn: async () => ({
        submitted: true,
        passwordFieldVisible: false,
        codeRequested: true,
        url: "https://example.com/mfa",
      }),
      signInCode: async (_botId, input) => {
        codes.push(input.code);
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
  const request = await mfa.request({
    ownerUserId: owner,
    botId: `${prefix}-bot`,
    site: "https://example.com/login",
    actor,
  });
  const waiting = await mfa.submit(owner, request.id, actor, {
    username: "alice",
    password: PASSWORD,
  });
  expect(waiting.status).toBe("code_required");
  expect((await mfa.pending(owner)).map((row) => row.status)).toContain(
    "code_required",
  );
  const done = await mfa.submitCode(owner, request.id, actor, {
    code: "551234",
  });
  expect(done.status).toBe("signed_in");
  expect(codes).toEqual(["551234"]);
  const [stored] = await database
    .select()
    .from(signInRequests)
    .where(inArray(signInRequests.id, [request.id]));
  expect(JSON.stringify(stored)).not.toContain("551234");
  expect(JSON.stringify(stored)).not.toContain(PASSWORD);
});

/**
 * Deleting a saved login over the route, against the real store: two presses at once remove it once
 * and answer one of them, another person's id is a missing one, and the trail names the site only.
 */
test("deleting a saved login over the route removes it once, and the trail names the site only", async () => {
  const saved = createSignInService({
    store,
    encryptionKey: Buffer.alloc(32, 3).toString("base64"),
    auditStore: { insert: async (event) => void audit.push(event) },
    gateway: {
      seatFor: async (botId, personId) => personSeat(personId, botId),
      signIn: async () => ({
        submitted: true,
        passwordFieldVisible: false,
        codeRequested: false,
        url: "https://github.com/",
      }),
      signInCode: async () => {
        throw new Error("not used");
      },
      requestHelp: async () => {
        throw new Error("not used");
      },
    },
  });
  const request = await saved.request({
    ownerUserId: owner,
    botId: `${prefix}-bot`,
    site: "https://github.com/login",
    actor,
  });
  await saved.submit(owner, request.id, actor, {
    username: "octocat",
    password: PASSWORD,
    save: true,
  });
  const [login] = (await saved.logins(owner)).logins.filter(
    (row) => row.origin === "https://github.com",
  );
  if (!login) throw new Error("not saved");

  const root = new Hono<{ Variables: AppVariables }>();
  const asOwner = async (
    context: {
      set: (key: "actor", value: AppVariables["actor"]) => void;
    },
    next: () => Promise<void>,
  ) => {
    context.set("actor", {
      id: owner,
      email: `${owner}@example.test`,
    } as AppVariables["actor"]);
    await next();
  };
  root.route("/api/passwords", createPasswordRoutes(saved, asOwner as never));
  const remove = (id: string) =>
    root.fetch(
      new Request(`http://127.0.0.1/api/passwords/${id}`, { method: "DELETE" }),
    );

  // An id this person does not own answers as a missing one.
  expect((await remove(randomUUID())).status).toBe(404);

  const responses = await Promise.all([remove(login.id), remove(login.id)]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 404,
  ]);
  for (const body of await Promise.all(responses.map((r) => r.text())))
    expect(body).not.toContain(PASSWORD);
  expect(
    (await saved.logins(owner)).logins.filter((row) => row.id === login.id),
  ).toEqual([]);

  const recorded = audit.filter(
    (row) => row.eventType === "password.deleted" && row.targetId === login.id,
  );
  expect(recorded).toHaveLength(1);
  expect(recorded[0]?.payload).toMatchObject({ site: "https://github.com" });
  expect(JSON.stringify(recorded)).not.toContain(PASSWORD);
});
