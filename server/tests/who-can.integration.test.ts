import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { LLMock } from "@copilotkit/aimock";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { CapabilityChange } from "../src/admin/capability-changes";
import {
  type EnterpriseControls,
  installEnterpriseControls,
} from "../src/admin/controls";
import { createApp } from "../src/app";
import { createAuditReader, createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  capabilitySettings,
  revokedAccess,
  userRoles,
  users,
} from "../src/db/schema";
import { createModelCompleter } from "../src/routing/model";
import recorded from "./fixtures/who-can-recorded.json";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Who can do what, described in English: "Contractors can't use their own computer" written as switch
 * changes, read back by a call that never sees the sentence, previewed for every real member with
 * `resolveCapability` itself, and saved as one change through the store the switches always use.
 *
 * Through the real routes in `createApp`, against a real PostgreSQL with the enterprise controls
 * installed, the trail written and read by the real audit store and reader, and the model answered by
 * aimock serving answers recorded from the real API to these exact prompts
 * (`fixtures/who-can-recorded.json`), over the same people and groups seeded here.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const person = (key: string, name: string, groups: string[]) => ({
  id: `who-can-${key}-${suite}`,
  email: `who-can-${key}-${suite}@acme.test`,
  name,
  groups,
});
/** The admin asking, in no group. */
const ada = person("ada", "Ada Admin", []);
const cam = person("cam", "Cam Contractor", ["Contractors"]);
/** A contractor who is also an engineer. */
const cy = person("cy", "Cy Contractor", ["Contractors", "Engineering"]);
const eve = person("eve", "Eve Engineer", ["Engineering"]);
const sam = person("sam", "Sam Sales", ["Sales"]);
const nora = person("nora", "Nora Nogroup", []);
const lee = person("lee", "Lee Field", ["Field Sales (EMEA)"]);
const everyone = [ada, cam, cy, eve, sam, nora, lee];
const bot = `who-can-bot-${suite}`;

const mock = new LLMock();
let controls: EnterpriseControls;
const originalBaseUrl = process.env.OPENAI_BASE_URL;

beforeAll(async () => {
  process.env.OPENAI_BASE_URL = await mock.start();
  await database.delete(capabilitySettings);
  await database.insert(users).values(everyone);
  await database.insert(userRoles).values({ userId: ada.id, role: "admin" });
  controls = await installEnterpriseControls({
    database,
    databaseUrl: testDatabaseUrl(),
    auditStore,
    env: {},
  });

  // Cam's own computer, used twice this month: the activity the preview should find.
  const hostAction = (action: string, extra: Record<string, unknown>) =>
    auditStore.insert({
      eventType: "computer.action_allowed",
      targetType: "host_access",
      targetId: `grant-${suite}`,
      actorUserId: cam.id,
      payload: { action, bot, actor: cam.id, folder: "Projects", ...extra },
    });
  await hostAction("host/read_file", { file: "plan.md" });
  await hostAction("host/run_command", { command: "ls -la" });
  // A cloud computer's page is not their own computer, and is not counted for it.
  await auditStore.insert({
    eventType: "computer.action_allowed",
    targetType: "computer",
    targetId: bot,
    actorUserId: cam.id,
    payload: {
      action: "computer_navigate",
      bot,
      actor: cam.id,
      page: "https://example.com/",
    },
  });
  // Older than the window.
  await database.insert(auditEvents).values({
    actorUserId: cam.id,
    eventType: "computer.action_allowed",
    targetType: "host_access",
    targetId: `grant-${suite}`,
    payload: { action: "host/write_file", bot, actor: cam.id, file: "old.md" },
    createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
  });
});

afterEach(() => {
  mock.clearFixtures();
  mock.clearRequests();
});

afterAll(async () => {
  await controls?.stop();
  await mock.stop();
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
  await database.delete(capabilitySettings);
  // Audit rows are append-only by design and stay; they name only this run's throwaway ids.
  await database.delete(users).where(like(users.id, `who-can-%-${suite}`));
  await database.$client.end({ timeout: 5 });
});

function appFor(options: { model?: string; role?: "admin" | "user" } = {}) {
  const args: never[] = Array.from({ length: 35 }) as never[];
  args[0] = loadConfig(testEnvironment()) as never;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: ada.id, email: ada.email, name: ada.name, image: null },
      }),
    },
  } as never;
  args[2] = { rolesForUser: async () => [options.role ?? "admin"] } as never;
  args[3] = createAuditReader(database) as never;
  args[12] = auditStore as never;
  args[34] = {
    boundaryWriter: createModelCompleter({
      model: {
        provider: "openai",
        defaultModel: options.model ?? "gpt-5.6-terra",
      },
      resolveApiKey: async () => "test-key",
    }),
  } as never;
  // Positional, built by index, so an appended parameter cannot shift what lands where.
  const build = createApp as (
    ...positional: never[]
  ) => ReturnType<typeof createApp>;
  return build(...args);
}

function post(
  path: "translate" | "preview" | "batch",
  body: unknown,
  options: Parameters<typeof appFor>[0] = {},
) {
  return appFor(options).request(
    `http://localhost:3001/api/admin/enterprise/capabilities/${path}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify(body),
    },
  );
}

type Recording = {
  model: string;
  text: string;
  writer: string[];
  reader?: string;
};

function serve(recording: Recording) {
  const [first] = recording.writer;
  if (first) mock.on({ userMessage: /<description>/ }, { content: first });
  if (recording.reader)
    mock.on(
      { userMessage: /You explain permission changes/ },
      { content: recording.reader },
    );
}

/** The prompt each model request carried, in order. */
function prompts(): string[] {
  return mock.getRequests().map((entry) => {
    const messages = (entry.body as { messages?: { content?: unknown }[] })
      ?.messages;
    return String(messages?.at(-1)?.content ?? "");
  });
}

async function lastTranslation() {
  const [row] = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, ada.id),
        eq(auditEvents.eventType, "capability.changes_translated"),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);
  return row;
}

type PreviewBody = {
  check: { ok: boolean };
  /** The switches this preview read, which a save says it is based on. */
  basedOn: {
    scopeKind: string;
    scopeId: string;
    capability: string;
    allowed: boolean;
  }[];
  people: {
    id: string;
    role: string;
    capabilities: {
      capability: string;
      before: { allowed: boolean; decidedBy: string; scopeId: string };
      after: { allowed: boolean; decidedBy: string; scopeId: string };
      activity?: {
        what: string;
        count: number;
        more: boolean;
        recent: { eventType: string; payload: Record<string, unknown> }[];
      };
    }[];
  }[];
  counts: Record<string, number>;
  activity: { days: number; unmapped: { capability: string; title: string }[] };
  warning: string | null;
};

const LOCAL = "localComputer";
const defaultOn = { allowed: true, decidedBy: "default", scopeId: "" };
const offForEverybody = {
  allowed: false,
  decidedBy: "organization",
  scopeId: "",
};
const throughGroup = (scopeId: string) => ({
  allowed: true,
  decidedBy: "group",
  scopeId,
});

/** The changes the default model wrote for "Contractors can't use their own computer". */
const TRAP: CapabilityChange[] = [
  { scopeKind: "organization", scopeId: "", capability: LOCAL, allowed: false },
  {
    scopeKind: "group",
    scopeId: "Engineering",
    capability: LOCAL,
    allowed: true,
  },
  {
    scopeKind: "group",
    scopeId: "Field Sales (EMEA)",
    capability: LOCAL,
    allowed: true,
  },
  { scopeKind: "group", scopeId: "Sales", capability: LOCAL, allowed: true },
];

describe("POST /api/admin/enterprise/capabilities/translate", () => {
  test("one group losing a permission becomes off for everybody and on for every other group, and the reading says so", async () => {
    const recording = recorded.trap as Recording;
    serve(recording);

    const response = await post("translate", { text: recording.text });

    expect(response.status).toBe(200);
    const body = await response.json();
    const reading = JSON.parse(recording.reader as string);
    // A group can only widen, so the restriction is a narrower default plus every other group widened.
    expect(body).toEqual({
      changes: TRAP,
      summary: reading.summary,
      explanation: reading.explanation,
      check: { ok: true },
      warning: null,
    });
    expect(
      body.changes.some(
        (change: CapabilityChange) =>
          change.scopeKind === "group" && change.scopeId === "Contractors",
      ),
    ).toBeFalse();
    expect(reading.explanation).toContain(
      '"Local computer access" is turned off for everybody, then turned back on for "Engineering", "Field Sales (EMEA)", and "Sales".',
    );

    // One writing, then one reading of it. The reading was asked with the changes, never the request.
    const asked = prompts();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain(recording.text);
    // The writer is told this OpenBot's real groups and the rule a group can only widen.
    expect(asked[0]).toContain('- "Contractors": 2 people');
    expect(asked[0]).toContain('- "Field Sales (EMEA)": 1 person');
    expect(asked[0]).toContain("There is no off for a group.");
    expect(asked[1]).not.toContain(recording.text);
    expect(asked[1]).not.toContain("their own computer");
    // The reader is told what the changes come to under the rule, worked out by the resolver.
    expect(asked[1]).toContain(
      "- Groups that give it to their members whatever the organization or role says: none before; Engineering, Field Sales (EMEA), Sales after.",
    );
    expect(asked[1]).toContain(
      "- Admins in no group that gives it: on before, off after.",
    );

    // Structured output, held to the changes' own schema.
    const firstBody = mock.getRequests()[0]?.body as {
      response_format?: unknown;
    };
    expect(firstBody.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "permission_changes", strict: true },
    });

    // On the trail with the admin's words, though nothing is saved yet.
    expect((await lastTranslation())?.payload).toMatchObject({
      actor: ada.email,
      text: recording.text,
      outcome: "written",
      changes: TRAP,
      checked: true,
      attempts: 1,
    });
  });

  test("a request for a group's off switch comes back with no changes and the model's reason, and is never read", async () => {
    const recording = recorded.groupOffRefused as Recording;
    serve(recording);

    const response = await post("translate", { text: recording.text });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.changes).toEqual([]);
    expect(body.check.ok).toBeFalse();
    expect(body.check.error).toStartWith("No changes were written. ");
    expect(body.check.error).toContain("only grant permissions");
    expect(body.explanation).toBeNull();
    expect(prompts()).toHaveLength(1);
    expect((await lastTranslation())?.payload).toMatchObject({
      text: recording.text,
      outcome: "did_not_check",
      checked: false,
    });
  });

  test("changes that check but invert the request are read for what they do, and the preview shows who that takes it from", async () => {
    const recording = recorded.readingCatchesInversion as Recording;
    serve(recording);

    const response = await post(
      "translate",
      { text: recording.text },
      { model: recording.model },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // Every switch is one the rule honours, so the check passes...
    expect(body.check).toEqual({ ok: true });
    expect(body.changes).toContainEqual({
      scopeKind: "group",
      scopeId: "Contractors",
      capability: LOCAL,
      allowed: true,
    });
    // ...and the reading, which never saw "off for Contractors", says what the changes really do.
    expect(body.summary).toBe(
      "Contractors gain Local computer access; everyone else loses it.",
    );

    const preview = (await (
      await post("preview", { changes: body.changes })
    ).json()) as PreviewBody;
    const losing = preview.people
      .filter((entry) =>
        entry.capabilities.some(
          (capability) =>
            capability.before.allowed && !capability.after.allowed,
        ),
      )
      .map((entry) => entry.id);
    for (const who of [ada, eve, sam, nora, lee])
      expect(losing).toContain(who.id);
    for (const who of [cam, cy]) expect(losing).not.toContain(who.id);
  });

  test("only an admin may describe, preview or save a change", async () => {
    for (const path of ["translate", "preview", "batch"] as const) {
      const response = await post(
        path,
        { text: "Contractors can't use their own computer", changes: TRAP },
        { role: "user" },
      );
      expect(response.status).toBe(403);
    }
    expect(prompts()).toHaveLength(0);
  });
});

describe("POST /api/admin/enterprise/capabilities/preview", () => {
  test("each real member's permission before and after, and the recent use of what they lose", async () => {
    const response = await post("preview", { changes: TRAP });

    expect(response.status).toBe(200);
    const preview = (await response.json()) as PreviewBody;
    expect(preview.check).toEqual({ ok: true });
    expect(preview.warning).toBeNull();
    expect(preview.activity).toEqual({ days: 30, unmapped: [] });
    const of = (who: { id: string }) => {
      const entry = preview.people.find((candidate) => candidate.id === who.id);
      expect(entry?.capabilities).toHaveLength(1);
      return entry?.capabilities[0];
    };

    // The contractor in no other group, the admin and the member in no group lose it.
    expect(of(cam)).toMatchObject({
      capability: LOCAL,
      before: defaultOn,
      after: offForEverybody,
    });
    expect(of(ada)).toMatchObject({
      before: defaultOn,
      after: offForEverybody,
    });
    expect(of(nora)).toMatchObject({
      before: defaultOn,
      after: offForEverybody,
    });
    // The contractor who is also an engineer keeps it, through Engineering.
    expect(of(cy)).toMatchObject({
      before: defaultOn,
      after: throughGroup("Engineering"),
    });
    expect(of(eve)?.after).toEqual(throughGroup("Engineering"));
    expect(of(sam)?.after).toEqual(throughGroup("Sales"));
    expect(of(lee)?.after).toEqual(throughGroup("Field Sales (EMEA)"));
    expect(preview.people.find((entry) => entry.id === ada.id)?.role).toBe(
      "admin",
    );

    // Cam used their own computer twice this month. Not the cloud page, not the row from 40 days ago.
    const activity = of(cam)?.activity;
    expect(activity).toMatchObject({
      what: "actions on their own computer",
      count: 2,
      more: false,
    });
    expect(
      activity?.recent.map((event) => event.payload.action).sort(),
    ).toEqual(["host/read_file", "host/run_command"]);
    expect(of(nora)?.activity).toMatchObject({ count: 0, recent: [] });
    // Nothing is looked up for somebody who keeps it.
    const kept = of(cy);
    expect(kept).toMatchObject({ capability: "localComputer" });
    expect(kept).not.toHaveProperty("activity");

    // Those losing it come before those keeping it.
    const order = preview.people.map((entry) => entry.id);
    expect(order.indexOf(cam.id)).toBeLessThan(order.indexOf(cy.id));
    expect(preview.counts.losing).toBeGreaterThanOrEqual(3);
    expect(preview.counts.keeping).toBeGreaterThanOrEqual(4);
  });

  test("a permission whose use the trail doesn't record is named, and nothing is counted for it", async () => {
    const response = await post("preview", {
      changes: [
        {
          scopeKind: "organization",
          scopeId: "",
          capability: "proactive",
          allowed: false,
        },
      ],
    });

    const preview = (await response.json()) as PreviewBody;
    expect(preview.activity.unmapped).toEqual([
      { capability: "proactive", title: "Check-ins" },
    ]);
    const cams = preview.people.find((entry) => entry.id === cam.id);
    expect(cams?.capabilities[0]).toMatchObject({
      capability: "proactive",
      before: defaultOn,
      after: offForEverybody,
    });
    expect(cams?.capabilities[0]).not.toHaveProperty("activity");
    expect(preview.warning).toBe('After this, nobody has "Check-ins".');
  });
});

describe("POST /api/admin/enterprise/capabilities/batch", () => {
  test("a group's off switch is refused with how to say it, and nothing is saved", async () => {
    const response = await post("batch", {
      changes: [
        {
          scopeKind: "group",
          scopeId: "Contractors",
          capability: LOCAL,
          allowed: false,
        },
      ],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.problems).toEqual([
      {
        change: 1,
        field: "allowed",
        message:
          'A group can only turn a permission on, so off for the group "Contractors" changes nothing. To take it from a group, turn it off for everybody or for a role, then turn it on for every other group.',
      },
    ]);
    expect(await controls.store.capabilityRows()).toEqual([]);
  });

  test("the changes save together, are enforced as the preview said, and each switch is on the trail with the sentence", async () => {
    const text = (recorded.trap as Recording).text;
    const preview = (await (
      await post("preview", { changes: TRAP })
    ).json()) as PreviewBody;

    const response = await post("batch", {
      changes: TRAP,
      authoring: { source: "english", text },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: TRAP });

    // What the switches now decide for each person is what the preview said they would.
    for (const who of everyone) {
      const after = preview.people
        .find((entry) => entry.id === who.id)
        ?.capabilities.find((capability) => capability.capability === LOCAL)
        ?.after.allowed;
      expect(await controls.capabilityFor(who.id, LOCAL)).toBe(
        after as boolean,
      );
    }
    expect(await controls.capabilityFor(cam.id, LOCAL)).toBeFalse();
    expect(await controls.capabilityFor(cy.id, LOCAL)).toBeTrue();
    // The synchronous snapshot the computer boundary reads was refreshed too.
    expect(controls.snapshot()?.rows).toHaveLength(TRAP.length);

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, ada.id),
          eq(auditEvents.eventType, "capability.changed"),
          sql`${auditEvents.payload} -> 'authoring' ->> 'text' = ${text}`,
        ),
      );
    expect(rows).toHaveLength(TRAP.length);
    const batches = new Set(rows.map((row) => row.payload.batch));
    expect(batches.size).toBe(1);
    expect(rows.map((row) => row.payload)).toContainEqual({
      scopeKind: "organization",
      scopeId: "",
      capability: LOCAL,
      title: "Local computer access",
      allowed: false,
      by: ada.email,
      before: null,
      batch: [...batches][0],
      authoring: { source: "english", text },
    });

    // Previewed again, the same changes change nothing for these people.
    const again = (await (
      await post("preview", { changes: TRAP })
    ).json()) as PreviewBody;
    for (const who of everyone)
      expect(again.people.map((entry) => entry.id)).not.toContain(who.id);
  });

  test("the one-switch save that shares the prefix still answers", async () => {
    const response = await appFor().request(
      "http://localhost:3001/api/admin/enterprise/capabilities",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3001",
        },
        body: JSON.stringify({
          scopeKind: "group",
          scopeId: "Sales",
          capability: LOCAL,
          allowed: null,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await controls.capabilityFor(sam.id, LOCAL)).toBeFalse();
  });
});

/**
 * Two admins reading one preview and saving different drafts, and a save the trail refuses. Both ask
 * the same question: what is in force afterwards, and what does the admin read?
 */
describe("a permission batch from a stale reading, and one the trail refused", () => {
  /** Off for everybody: one switch, so what landed is unambiguous. */
  /** What a stored switch is, as the preview and the rows read it: `allowed` is never null. */
  type StoredSwitch = Omit<CapabilityChange, "allowed"> & { allowed: boolean };
  const OFF: StoredSwitch[] = [
    {
      scopeKind: "organization",
      scopeId: "",
      capability: LOCAL,
      allowed: false,
    },
  ];
  /** A different draft from the same reading, touching another permission. */
  const NO_CHECK_INS: StoredSwitch[] = [
    {
      scopeKind: "organization",
      scopeId: "",
      capability: "proactive",
      allowed: false,
    },
  ];

  const rowsNow = () =>
    controls.store.capabilityRows().then((rows) =>
      rows.map(({ scopeKind, scopeId, capability, allowed }) => ({
        scopeKind,
        scopeId,
        capability,
        allowed,
      })),
    );

  beforeAll(async () => {
    await database.delete(capabilitySettings);
    await controls.refresh();
  });

  test("the first save lands and the second is refused with the switches now in force", async () => {
    // One reading, taken once, that both saves say they are based on.
    const preview = (await (
      await post("preview", { changes: OFF })
    ).json()) as PreviewBody;
    expect(preview.basedOn).toEqual([]);

    const first = await post("batch", {
      changes: OFF,
      basedOn: preview.basedOn,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ saved: OFF });

    const second = await post("batch", {
      changes: NO_CHECK_INS,
      basedOn: preview.basedOn,
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe(
      "Permissions changed while you were reviewing them. Review the new impact and save again.",
    );
    // The loser wrote nothing: only the winner's switch is in force, and only it is on the trail.
    expect(await rowsNow()).toEqual(OFF);
    expect(await controls.capabilityFor(cam.id, "proactive")).toBeTrue();

    // Reading again shows what is there now, and saving against that is accepted.
    const latest = (await (
      await post("preview", { changes: NO_CHECK_INS })
    ).json()) as PreviewBody;
    expect(latest.basedOn).toEqual(OFF);
    const retry = await post("batch", {
      changes: NO_CHECK_INS,
      basedOn: latest.basedOn,
    });
    expect(retry.status).toBe(200);
    expect(await rowsNow()).toEqual(
      expect.arrayContaining([...OFF, ...NO_CHECK_INS]),
    );
  });

  test("a save with no reading named still saves, as every caller before this sent it", async () => {
    const response = await post("batch", { changes: OFF });
    expect(response.status).toBe(200);
    expect(await rowsNow()).toEqual(expect.arrayContaining(OFF));
  });

  test("a reading that is not switches is refused, and nothing is saved", async () => {
    const before = await rowsNow();
    const response = await post("batch", {
      changes: NO_CHECK_INS,
      // A stored switch is on or off. Inherited is what a change may say, not what a reading holds.
      basedOn: [{ ...OFF[0], allowed: null }],
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      "basedOn must be the switches the preview read.",
    );
    expect(await rowsNow()).toEqual(before);
  });

  test("a save the trail refuses leaves every switch as it was, and saving again records the change once", async () => {
    await database.delete(capabilitySettings);
    await controls.refresh();
    const preview = (await (
      await post("preview", { changes: OFF })
    ).json()) as PreviewBody;
    const trail = controls.deps.auditStore;
    const recorded = () =>
      database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, ada.id),
            eq(auditEvents.eventType, "capability.changed"),
            eq(auditEvents.targetId, LOCAL),
          ),
        )
        .orderBy(desc(auditEvents.createdAt));
    const before = (await recorded()).length;
    controls.deps.auditStore = {
      ...trail,
      insert: async (event, correlation) => {
        if (event.eventType === "capability.changed")
          throw new Error("the trail is unavailable");
        return trail.insert(event, correlation);
      },
    };
    let response: Response;
    try {
      response = await post("batch", {
        changes: OFF,
        basedOn: preview.basedOn,
      });
    } finally {
      controls.deps.auditStore = trail;
    }

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Couldn't save the changes. Nothing changed. Try again.",
    });
    // Nothing is in force: no switch moved, the snapshot still says so, and the trail has no row.
    expect(await rowsNow()).toEqual([]);
    expect(await controls.capabilityFor(cam.id, LOCAL)).toBeTrue();
    expect(controls.snapshot()?.rows).toHaveLength(0);
    expect(await recorded()).toHaveLength(before);

    // Saving again is the same save against the same reading. It lands once, and the row says what
    // the switch was before it: nothing, which the first attempt would have had no way left to know.
    const retry = await post("batch", {
      changes: OFF,
      basedOn: preview.basedOn,
    });
    expect(retry.status).toBe(200);
    expect(await rowsNow()).toEqual(OFF);
    const rows = await recorded();
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]?.payload).toMatchObject({
      allowed: false,
      by: ada.email,
      before: null,
    });
  });
});

test("only admins can read a member's current permissions and their sources", async () => {
  const uri = (id: string) =>
    `http://localhost:3001/api/admin/enterprise/capabilities/members/${encodeURIComponent(id)}/effective`;
  const regular = appFor({ role: "user" });
  expect((await regular.request(uri(cam.id))).status).toBe(403);
  expect((await regular.request(uri("me"))).status).toBe(403);
  expect(
    (await regular.request("http://localhost:3001/api/admin/enterprise/me"))
      .status,
  ).toBe(200);

  await controls.store.setCapabilities(
    [
      {
        scopeKind: "organization",
        scopeId: "",
        capability: LOCAL,
        allowed: false,
      },
      {
        scopeKind: "group",
        scopeId: "Contractors",
        capability: LOCAL,
        allowed: true,
      },
    ],
    ada.email,
  );
  const admin = appFor();
  const granted = await admin.request(uri(cam.id));
  expect(granted.status).toBe(200);
  expect(granted.headers.get("Cache-Control")).toBe("no-store");
  expect(await granted.json()).toMatchObject({
    status: "active",
    person: { name: cam.name, email: cam.email, role: "user" },
    capabilities: expect.arrayContaining([
      expect.objectContaining({
        capability: LOCAL,
        allowed: true,
        decidedBy: "group",
        scopeId: "Contractors",
      }),
    ]),
  });
  expect((await admin.request(uri("missing-member"))).status).toBe(404);
  await database
    .insert(revokedAccess)
    .values({ email: cam.email, revokedBy: ada.email });
  try {
    expect(await (await admin.request(uri(cam.id))).json()).toEqual({
      status: "access-removed",
      person: { name: cam.name, email: cam.email, role: "user" },
    });
  } finally {
    await database
      .delete(revokedAccess)
      .where(eq(revokedAccess.email, cam.email));
  }
});
