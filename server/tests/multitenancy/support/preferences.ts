/**
 * Preferences fixture (MT079 / Issue #122).
 *
 * Wraps the MT014 runtime-config fixture (zero changes to it) for the real
 * per-company/per-team business-config side, and adds the global personal
 * preference side on the setup channel: two real `users` rows — one clean,
 * one whose stored `preferences` document is deliberately poisoned with
 * business-shaped keys and a canary secret — plus the real
 * `createUserPreferencesStore` over that channel. Nothing here mocks the
 * read path: the preference row is a real row, read and patched through the
 * real store; the runtime-config resolves run as `ob_ent_data` under
 * transaction-local `app.tenant_id` with RLS enforced (recorded by the
 * wrapped fixture).
 */

import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { createDatabase, type Database } from "../../../src/db/client";
import { users } from "../../../src/db/schema/core";
import { createUserPreferencesStore } from "../../../src/user-preferences";
import { enterpriseTestDatabaseUrlFrom } from "../../support/enterprise-database";
import {
  createRuntimeConfigFixture,
  type RuntimeConfigFixture,
} from "./runtime-config";

/**
 * A stored preferences document poisoned exactly the way the acceptance
 * criteria fear: business model selection, prompts, policies, credential
 * references and a canary secret, sitting next to the two legal global
 * items. The classification-gated read must return the legal items and
 * nothing else.
 */
export const POISONED_PREFERENCES = Object.freeze({
  messageListEmphasis: "agent",
  selfHostBannerDismissed: true,
  // —— 分类外的范围业务形键（验收 4 的投毒面）——
  defaultModel: "gpt-4o",
  apiKey: "sk-mt079-leak-canary-deadbeef01",
  systemPrompt: "You are the finance bot of company A",
  networkPolicy: { mode: "off", rules: [{ host: "internal.example" }] },
  theme: "dark",
  language: "zh-CN",
  "runtime.model.credentialRef": "secret-ref://company-a/model-key",
  credentialRef: "secret-ref://company-b/model-key",
  billingExternalCustomerId: "openbot-company-a-customer",
  legacyJunk: { nested: { deep: "stale value" } },
});

export interface PreferencesFixture {
  readonly idPrefix: string;
  readonly ids: Readonly<Record<string, string>>;
  /** The wrapped MT014 fixture: real companies/teams + real runtime-config service. */
  readonly runtime: RuntimeConfigFixture;
  /** The real personal preference store over the setup channel. */
  readonly store: ReturnType<typeof createUserPreferencesStore>;
  /** The raw stored preferences jsonb (no defaults merged, no gate applied). */
  readStoredPreferences(userId: string): Promise<unknown>;
  /** Column names of the `users` table, from information_schema. */
  usersTableColumns(): Promise<readonly string[]>;
  dispose(): Promise<void>;
}

export async function createPreferencesFixture(): Promise<PreferencesFixture> {
  const setupUrl = enterpriseTestDatabaseUrlFrom(process.env);
  // Companies A (teams A1/A2), B (team B1) + the real restricted-role
  // runtime-config service — the scoped business-config half of the ticket.
  const runtime = await createRuntimeConfigFixture();

  const prefix = `mt079-${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {
    "user-clean": `${prefix}-user-clean`,
    "user-poisoned": `${prefix}-user-poisoned`,
  };

  const setupDatabase: Database = createDatabase(setupUrl, { max: 2 });
  const closeables: Array<{ close(): void | Promise<void> }> = [
    setupDatabase.$client,
  ];
  try {
    await setupDatabase.insert(users).values([
      {
        id: ids["user-clean"],
        email: `${ids["user-clean"]}@example.invalid`,
        name: "MT079 clean user",
      },
      {
        id: ids["user-poisoned"],
        email: `${ids["user-poisoned"]}@example.invalid`,
        name: "MT079 poisoned user",
        preferences: POISONED_PREFERENCES,
      },
    ]);

    const fixture: PreferencesFixture = {
      idPrefix: prefix,
      ids: Object.freeze({ ...ids }),
      runtime,

      store: createUserPreferencesStore(setupDatabase),

      async readStoredPreferences(userId) {
        const [row] = await setupDatabase
          .select({ preferences: users.preferences })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);
        return row?.preferences ?? null;
      },

      async usersTableColumns() {
        const result = (await setupDatabase.execute(
          sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'users' order by column_name`,
        )) as unknown;
        const rows = Array.isArray(result)
          ? result
          : ((result as { rows?: unknown[] })?.rows ?? []);
        return rows
          .map((row) => (row as { column_name?: unknown }).column_name)
          .filter((name): name is string => typeof name === "string");
      },

      async dispose() {
        const failures: unknown[] = [];
        try {
          await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
        } catch (error) {
          failures.push(error);
        }
        for (const closeable of closeables.reverse()) {
          try {
            await closeable.close();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await runtime.dispose();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Preferences fixture disposal failed.",
          );
        }
      },
    };
    return fixture;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await setupDatabase.delete(users).where(like(users.id, `${prefix}%`));
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    for (const closeable of closeables.reverse()) {
      try {
        await closeable.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    try {
      await runtime.dispose();
    } catch (disposeError) {
      failures.push(disposeError);
    }
    throw new AggregateError(failures, "Preferences fixture creation failed.");
  }
}
