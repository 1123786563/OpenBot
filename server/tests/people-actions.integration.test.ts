import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents, revokedAccess, sessions, users } from "../src/db/schema";
import { createPeopleStore, type PeopleStore } from "../src/people/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Two administrators deciding the same thing at once, and one administrator asking again after the
 * answer was lost. Both are what the People screen's retry and its duplicate guard are for, and
 * neither can be seen against a fake store: the deny list's conflict rule, the session deletion and
 * the trail's rows are the database's own.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const adminId = `people-admin-${suite}`;
const ADMIN = {
  id: adminId,
  email: `${adminId}@openbot.test`,
  name: "An Administrator",
  image: null,
};
/** One person per case, so a case's rows are its own whatever order the cases run in. */
const member = (name: string) => ({
  id: `people-${name}-${suite}`,
  email: `people-${name}-${suite}@openbot.test`,
});
const ROLE = member("role");
const GRANT_RACE = member("grant-race");
const REMOVE_RACE = member("remove-race");
const REMOVE_RETRY = member("remove-retry");
const RESTORE = member("restore");
const everybody = [ROLE, GRANT_RACE, REMOVE_RACE, REMOVE_RETRY, RESTORE];

let retirements = 0;
const store = createPeopleStore(database, [], async () => {
  retirements += 1;
  return { retired: 0 };
});

/**
 * Both requests read the person before either writes.
 *
 * The race two administrators can actually hit, held open on purpose: without it the two requests
 * take turns on a fast local database and the second one sees the first one's write, which is a
 * different case (the one below, asking again after the commit).
 */
function readTogether(inner: PeopleStore): PeopleStore {
  let arrived = 0;
  let open = () => {};
  const both = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    ...inner,
    find: async (userId) => {
      arrived += 1;
      if (arrived === 2) open();
      await both;
      return inner.find(userId);
    },
  };
}

function appFor(people: PeopleStore) {
  const app = createApp(
    loadConfig(testEnvironment()),
    {
      handler: () => new Response(null, { status: 204 }),
      api: { getSession: async () => ({ user: ADMIN }) },
    } as never,
    { rolesForUser: async () => ["admin"] },
    // Positions 4-12 are other stores, 13 is the audit store, four more follow, 18 is peopleStore.
    ...(Array.from({ length: 9 }) as never[]),
    createAuditStore(database) as never,
    ...(Array.from({ length: 4 }) as never[]),
    people as never,
  );
  return (path: string, body: unknown) =>
    app.request(`http://openbot.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
}

const request = appFor(store);
const racing = appFor(readTogether(store));

const grant = (who: { id: string }, ask = request) =>
  ask(`/api/admin/people/${who.id}/role`, { role: "admin" });
const remove = (who: { id: string }, ask = request) =>
  ask(`/api/admin/people/${who.id}/access`, { revoked: true });
const restore = (who: { id: string }) =>
  request(`/api/admin/people/${who.id}/access`, { revoked: false });

const rowsFor = async (who: { id: string }, eventType: string) =>
  database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, eventType),
        eq(auditEvents.targetId, who.id),
      ),
    );

beforeAll(async () => {
  await database.insert(users).values([
    { id: ADMIN.id, email: ADMIN.email, name: "An Administrator" },
    ...everybody.map((who) => ({
      id: who.id,
      email: who.email,
      name: "A Member",
    })),
  ]);
  await database.insert(sessions).values(
    everybody.map((who) => ({
      id: `${who.id}-session`,
      userId: who.id,
      token: `${who.id}-token`,
      expiresAt: new Date(Date.now() + 86_400_000),
    })),
  );
});

afterAll(async () => {
  await database.delete(revokedAccess).where(
    inArray(
      revokedAccess.email,
      everybody.map((who) => who.email),
    ),
  );
  await database.delete(sessions).where(
    inArray(
      sessions.userId,
      everybody.map((who) => who.id),
    ),
  );
  await database
    .delete(users)
    .where(inArray(users.id, [ADMIN.id, ...everybody.map((who) => who.id)]));
  await database.$client.end({ timeout: 5 });
});

test("two administrators granting the same role at once leave the role granted", async () => {
  const answers = await Promise.all([
    grant(GRANT_RACE, racing),
    grant(GRANT_RACE, racing),
  ]);

  expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
  expect((await store.find(GRANT_RACE.id))?.role).toBe("admin");
  /*
   * Observed, not yet decided: both requests read the old role, so both write a row and the trail
   * reads as two role changes although the role changed once. The screen's duplicate guard stops one
   * administrator pressing twice; two administrators are two requests. Whether the trail should say
   * one change is an open question for whoever owns the Audit page, and a conditional write would
   * have to keep the half-finished removal's retry working.
   */
  const rows = await rowsFor(GRANT_RACE, "person.role_changed");
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.payload)).toEqual([
    { email: GRANT_RACE.email, from: "user", to: "admin" },
    { email: GRANT_RACE.email, from: "user", to: "admin" },
  ]);
});

test("two administrators removing the same person at once leave one denial and no session", async () => {
  const answers = await Promise.all([
    remove(REMOVE_RACE, racing),
    remove(REMOVE_RACE, racing),
  ]);

  expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
  const denied = await database
    .select({ email: revokedAccess.email })
    .from(revokedAccess)
    .where(eq(revokedAccess.email, REMOVE_RACE.email));
  expect(denied).toHaveLength(1);
  expect(
    await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, REMOVE_RACE.id)),
  ).toEqual([]);
  expect((await store.find(REMOVE_RACE.id))?.revoked).toBe(true);
  // The same open question as the role above: one removal, two rows.
  expect(await rowsFor(REMOVE_RACE, "person.access_revoked")).toHaveLength(2);
});

test("granting a role again after it committed writes no second change", async () => {
  expect((await grant(ROLE)).status).toBe(200);
  const committed = (await rowsFor(ROLE, "person.role_changed")).length;

  expect((await grant(ROLE)).status).toBe(200);

  expect(await rowsFor(ROLE, "person.role_changed")).toHaveLength(committed);
  expect((await store.find(ROLE.id))?.role).toBe("admin");
});

test("removing somebody again after it committed finishes the retirement and writes no second removal", async () => {
  expect((await remove(REMOVE_RETRY)).status).toBe(200);
  const committed = (await rowsFor(REMOVE_RETRY, "person.access_revoked"))
    .length;
  const before = retirements;

  expect((await remove(REMOVE_RETRY)).status).toBe(200);

  expect(await rowsFor(REMOVE_RETRY, "person.access_revoked")).toHaveLength(
    committed,
  );
  // The retirement runs again: it is the half a lost response cannot confirm.
  expect(retirements).toBe(before + 1);
  expect(
    await database
      .select({ email: revokedAccess.email })
      .from(revokedAccess)
      .where(eq(revokedAccess.email, REMOVE_RETRY.email)),
  ).toHaveLength(1);
});

test("giving access back twice writes one restoration", async () => {
  expect((await remove(RESTORE)).status).toBe(200);
  expect((await restore(RESTORE)).status).toBe(200);
  const committed = (await rowsFor(RESTORE, "person.access_restored")).length;
  expect(committed).toBe(1);

  expect((await restore(RESTORE)).status).toBe(200);

  expect(await rowsFor(RESTORE, "person.access_restored")).toHaveLength(1);
  expect((await store.find(RESTORE.id))?.revoked).toBe(false);
});
