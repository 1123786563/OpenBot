import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, getTableName, getTableColumns, inArray, like, or, sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseBudgetAccounts,
  enterpriseBudgetBindings,
  enterpriseBudgetReservations,
  enterpriseCapabilities,
  enterpriseMemberships,
  enterpriseModelAttempts,
  enterpriseModelCalls,
  enterpriseModelGrants,
  enterpriseModelRoutes,
  enterprisePrincipals,
  enterpriseResources,
  enterpriseRunAttempts,
  enterpriseRunCheckpoints,
  enterpriseRunCommands,
  enterpriseRunDelegations,
  enterpriseRunEvents,
  enterpriseRunGrants,
  enterpriseRunMessages,
  enterpriseRunOutbox,
  enterpriseRunReleases,
  enterpriseRunSnapshots,
  enterpriseRunSteps,
  enterpriseRuns,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseThreads,
  enterpriseUsageEntries,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * E1-B 数据模型、角色与迁移（03 分册 §4.1/§4.2）。
 *
 * 静态半场钉住 Drizzle 表合同：22 张新表全部走复合主键、逐一补复合 FK（引用列以
 * tenant_id 开头——不存在"只按 id 的跨租户外键"）、唯一组合、bigint 以 64 位 bigint
 * 列存储（API 层再转十进制字符串，DB 层不降级成 number）、jsonb 一律用本地 ./json.ts
 * 的自定义类型。补充细则（sealed_at/effects_revision/model_calls_count/last_source_ordinal、
 * input_revision/event_low_watermark、is_default_for_alias、response_ref/usage_status、
 * overage_micros/closed_at、logical_call_id 约束）作为列合同一并钉住。
 *
 * 迁移半场钉住 journal 纪律：编号由 drizzle-kit 生成、条目与磁盘文件一一对应、
 * 新迁移不 DROP 既有表；custom migration（enterprise_runs_rls）是 ENABLE/FORCE RLS、
 * Run↔reservation 延迟复合 FK、两个部分唯一索引与 budget_reservation_nonnegative
 * CHECK 的唯一来源；roles.sql 声明五个 NOLOGIN/非 owner/无 BYPASSRLS 能力角色。
 *
 * 动态半场在真实测试库以受限登录复现计划 306-312 行的反例：公开角色读 token_hash
 * 与 truncate 拒绝、跨租户 thread/release/route/reservation 引用失败、无 context 无行、
 * 旧 API 角色不能写账本、dispatcher 不能读输入正文。所有拒绝都在受限登录上取证，
 * 迁移 owner 连接只负责种受控 fixture（与 02 册 rls.test.ts 同一纪律）。
 *
 * 本文件没有任何动态 SQL：所有语句都是编译期字面量（fixture id 硬编码），外部值
 * 一律经查询构建器的绑定参数传递。
 */

/* ------------------------------------------------------------------ */
/* 静态半场：Drizzle 表合同                                             */
/* ------------------------------------------------------------------ */

const ALL_TABLES: readonly PgTable[] = [
  enterpriseThreads,
  enterpriseRunReleases,
  enterpriseRunGrants,
  enterpriseRuns,
  enterpriseRunAttempts,
  enterpriseRunCommands,
  enterpriseRunMessages,
  enterpriseRunSteps,
  enterpriseRunCheckpoints,
  enterpriseRunEvents,
  enterpriseRunSnapshots,
  enterpriseRunOutbox,
  enterpriseCapabilities,
  enterpriseRunDelegations,
  enterpriseModelRoutes,
  enterpriseModelGrants,
  enterpriseBudgetAccounts,
  enterpriseBudgetReservations,
  enterpriseBudgetBindings,
  enterpriseModelAttempts,
  enterpriseUsageEntries,
  enterpriseModelCalls,
];

const EXPECTED_TABLE_NAMES: readonly string[] = [
  "enterprise_threads",
  "enterprise_run_releases",
  "enterprise_run_grants",
  "enterprise_runs",
  "enterprise_run_attempts",
  "enterprise_run_commands",
  "enterprise_run_messages",
  "enterprise_run_steps",
  "enterprise_run_checkpoints",
  "enterprise_run_events",
  "enterprise_run_snapshots",
  "enterprise_run_outbox",
  "enterprise_capabilities",
  "enterprise_run_delegations",
  "enterprise_model_routes",
  "enterprise_model_grants",
  "enterprise_budget_accounts",
  "enterprise_budget_reservations",
  "enterprise_budget_bindings",
  "enterprise_model_attempts",
  "enterprise_usage_entries",
  "enterprise_model_calls",
];

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function primaryKeyOf(table: PgTable): string[] {
  return getTableConfig(table).primaryKeys.flatMap((key) =>
    key.columns.map((column) => column.name),
  );
}

function foreignKeysOf(table: PgTable): Array<{
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
}> {
  return getTableConfig(table).foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      sourceColumns: reference.columns.map((column) => column.name),
      targetTable: getTableName(reference.foreignTable),
      targetColumns: reference.foreignColumns.map((column) => column.name),
    };
  });
}

function uniqueIndexOf(table: PgTable): Array<{
  name: string;
  columns: string[];
  unique: boolean;
}> {
  return getTableConfig(table).indexes.map((index) => ({
    name: index.config.name,
    columns: index.config.columns.map((column) =>
      "name" in column ? column.name : undefined,
    ) as string[],
    unique: index.config.unique,
  }));
}

describe("the runs ledger schema registers every table", () => {
  test("all 22 tables export under their contract names", () => {
    expect(ALL_TABLES.map(getTableName)).toEqual(EXPECTED_TABLE_NAMES);
  });

  test("the schema barrel and the drizzle config both register the three files", () => {
    const barrel = readFileSync(
      new URL("../../../src/db/schema/index.ts", import.meta.url),
      "utf8",
    );
    for (const file of [
      "enterprise-runs",
      "enterprise-run-events",
      "enterprise-models",
    ]) {
      expect(barrel).toContain(`./${file}`);
    }
    const drizzleConfig = readFileSync(
      new URL("../../../drizzle.config.ts", import.meta.url),
      "utf8",
    );
    for (const file of [
      "enterprise-runs.ts",
      "enterprise-run-events.ts",
      "enterprise-models.ts",
    ]) {
      expect(drizzleConfig).toContain(file);
    }
  });
});

describe("every ledger table keys by tenant first", () => {
  test("all 22 primary keys are composite and start with tenant_id", () => {
    for (const table of ALL_TABLES) {
      const key = primaryKeyOf(table);
      expect(key.length, getTableName(table)).toBeGreaterThanOrEqual(2);
      expect(key[0], getTableName(table)).toBe("tenant_id");
    }
  });

  test("every foreign key is composite, tenant-first on both sides", () => {
    for (const table of ALL_TABLES) {
      for (const reference of foreignKeysOf(table)) {
        expect(
          reference.sourceColumns.length,
          getTableName(table),
        ).toBeGreaterThan(1);
        expect(
          reference.sourceColumns.length,
          `${getTableName(table)} -> ${reference.targetTable}`,
        ).toBe(reference.targetColumns.length);
        expect(reference.sourceColumns[0], getTableName(table)).toBe(
          "tenant_id",
        );
        expect(reference.targetColumns[0], reference.targetTable).toBe(
          "tenant_id",
        );
      }
    }
  });

  test("child ledgers reference runs by the composite (tenant, run) pair", () => {
    for (const table of [
      enterpriseRunAttempts,
      enterpriseRunCommands,
      enterpriseRunMessages,
      enterpriseRunSteps,
      enterpriseRunCheckpoints,
      enterpriseRunEvents,
      enterpriseRunSnapshots,
      enterpriseRunOutbox,
      enterpriseCapabilities,
      enterpriseModelAttempts,
      enterpriseModelCalls,
    ]) {
      expect(
        foreignKeysOf(table).some(
          (reference) =>
            reference.targetTable === "enterprise_runs" &&
            reference.targetColumns.join() === "tenant_id,id",
        ),
        getTableName(table),
      ).toBe(true);
    }
  });

  test("attempt-scoped ledgers reference attempts by the composite (tenant, run, attempt)", () => {
    for (const table of [
      enterpriseRunMessages,
      enterpriseRunSteps,
      enterpriseRunCheckpoints,
      enterpriseCapabilities,
      enterpriseModelAttempts,
      enterpriseModelCalls,
    ]) {
      expect(
        foreignKeysOf(table).some(
          (reference) =>
            reference.targetTable === "enterprise_run_attempts" &&
            reference.sourceColumns.join() === "tenant_id,run_id,attempt_id" &&
            reference.targetColumns.join() === "tenant_id,run_id,id",
        ),
        getTableName(table),
      ).toBe(true);
    }
  });

  test("threads pin the owner membership and same-tenant workspace", () => {
    expect(foreignKeysOf(enterpriseThreads)).toEqual([
      {
        sourceColumns: ["tenant_id", "owner_principal_id"],
        targetTable: "enterprise_memberships",
        targetColumns: ["tenant_id", "principal_id"],
      },
      {
        sourceColumns: ["tenant_id", "workspace_id"],
        targetTable: "enterprise_workspaces",
        targetColumns: ["tenant_id", "id"],
      },
    ]);
  });

  test("runs pin owner, workspace, thread and the frozen release", () => {
    expect(
      foreignKeysOf(enterpriseRuns).map((reference) => reference.targetTable),
    ).toEqual([
      "enterprise_memberships",
      "enterprise_workspaces",
      "enterprise_threads",
      "enterprise_run_releases",
    ]);
    /*
     * Run↔reservation 互相引用是创建循环：这对延迟复合 FK 由 custom migration 以
     * DEFERRABLE INITIALLY DEFERRED 建立，不能以 nullable 长期规避，也不进普通迁移。
     */
    expect(
      foreignKeysOf(enterpriseRuns).some(
        (reference) =>
          reference.targetTable === "enterprise_budget_reservations",
      ),
    ).toBe(false);
    expect(
      foreignKeysOf(enterpriseBudgetReservations).some(
        (reference) => reference.targetTable === "enterprise_runs",
      ),
    ).toBe(false);
  });

  test("model attempts bind reservation, route, run attempt and the one logical call", () => {
    expect(foreignKeysOf(enterpriseModelAttempts)).toEqual([
      {
        sourceColumns: ["tenant_id", "run_id"],
        targetTable: "enterprise_runs",
        targetColumns: ["tenant_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "run_id", "attempt_id"],
        targetTable: "enterprise_run_attempts",
        targetColumns: ["tenant_id", "run_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "reservation_id"],
        targetTable: "enterprise_budget_reservations",
        targetColumns: ["tenant_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "route_id"],
        targetTable: "enterprise_model_routes",
        targetColumns: ["tenant_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "run_id", "logical_call_id"],
        targetTable: "enterprise_model_calls",
        targetColumns: ["tenant_id", "run_id", "logical_call_id"],
      },
    ]);
  });

  test("model calls stay inside their run's steps and routes", () => {
    expect(foreignKeysOf(enterpriseModelCalls)).toEqual([
      {
        sourceColumns: ["tenant_id", "run_id"],
        targetTable: "enterprise_runs",
        targetColumns: ["tenant_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "run_id", "attempt_id"],
        targetTable: "enterprise_run_attempts",
        targetColumns: ["tenant_id", "run_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "run_id", "step_id"],
        targetTable: "enterprise_run_steps",
        targetColumns: ["tenant_id", "run_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "route_id"],
        targetTable: "enterprise_model_routes",
        targetColumns: ["tenant_id", "id"],
      },
    ]);
  });

  test("budget bindings point at a same-tenant reservation and account", () => {
    expect(foreignKeysOf(enterpriseBudgetBindings)).toEqual([
      {
        sourceColumns: ["tenant_id", "reservation_id"],
        targetTable: "enterprise_budget_reservations",
        targetColumns: ["tenant_id", "id"],
      },
      {
        sourceColumns: ["tenant_id", "account_id"],
        targetTable: "enterprise_budget_accounts",
        targetColumns: ["tenant_id", "id"],
      },
    ]);
  });

  test("run releases, grants, delegations, routes and usage resolve same-tenant parents", () => {
    expect(
      foreignKeysOf(enterpriseRunReleases).map((r) => r.targetTable),
    ).toEqual(["enterprise_resources"]);
    expect(
      foreignKeysOf(enterpriseRunGrants).map((r) => r.targetTable),
    ).toEqual(["enterprise_run_releases", "enterprise_memberships"]);
    expect(
      foreignKeysOf(enterpriseRunDelegations).map((r) => r.targetTable),
    ).toEqual([
      "enterprise_memberships",
      "enterprise_run_releases",
      "enterprise_model_routes",
    ]);
    expect(
      foreignKeysOf(enterpriseModelRoutes).map((r) => r.targetTable),
    ).toEqual(["enterprise_resources"]);
    expect(
      foreignKeysOf(enterpriseModelGrants).map((r) => r.targetTable),
    ).toEqual(["enterprise_model_routes", "enterprise_memberships"]);
    expect(
      foreignKeysOf(enterpriseUsageEntries).map((r) => r.targetTable),
    ).toEqual(["enterprise_model_attempts"]);
  });
});

describe("uniqueness contracts", () => {
  test("idempotent create keys and per-turn attempts are unique", () => {
    expect(uniqueIndexOf(enterpriseRuns)).toEqual([
      {
        name: "enterprise_run_request_key",
        columns: ["tenant_id", "owner_principal_id", "request_key"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseRunAttempts)).toEqual([
      {
        name: "enterprise_attempt_turn",
        columns: ["tenant_id", "run_id", "turn_id"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseRunSteps)).toEqual([
      {
        name: "enterprise_step_no",
        columns: ["tenant_id", "run_id", "attempt_id", "step_no"],
        unique: true,
      },
    ]);
  });

  test("events dedupe by event id and by (attempt, source) pair", () => {
    expect(uniqueIndexOf(enterpriseRunEvents)).toEqual([
      {
        name: "enterprise_run_event_id",
        columns: ["tenant_id", "run_id", "event_id"],
        unique: true,
      },
      {
        name: "enterprise_run_event_source",
        columns: ["tenant_id", "run_id", "attempt_id", "source_event_id"],
        unique: true,
      },
    ]);
  });

  test("outbox dedupe, route revisions and budget period accounts are unique", () => {
    expect(uniqueIndexOf(enterpriseRunOutbox)).toEqual([
      {
        name: "enterprise_outbox_dedup",
        columns: ["tenant_id", "run_id", "kind", "payload_digest"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseModelRoutes)).toEqual([
      {
        name: "enterprise_route_revision",
        columns: ["tenant_id", "alias", "revision"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseBudgetAccounts)).toEqual([
      {
        name: "enterprise_budget_account_period",
        columns: [
          "tenant_id",
          "scope_kind",
          "scope_ref",
          "period_id",
          "currency",
        ],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseBudgetReservations)).toEqual([
      {
        name: "enterprise_reservation_run",
        columns: ["tenant_id", "run_id"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseUsageEntries)).toEqual([
      {
        name: "enterprise_usage_revision",
        columns: ["tenant_id", "model_attempt_id", "revision"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseModelAttempts)).toEqual([
      {
        name: "enterprise_model_attempt_call",
        columns: ["tenant_id", "run_id", "logical_call_id"],
        unique: true,
      },
    ]);
    expect(uniqueIndexOf(enterpriseModelCalls)).toEqual([
      {
        name: "enterprise_call_ordinal",
        columns: ["tenant_id", "run_id", "step_id", "call_ordinal"],
        unique: true,
      },
    ]);
  });

  test("primary keys match the contract tuples exactly", () => {
    const expected: ReadonlyArray<[PgTable, string[]]> = [
      [enterpriseThreads, ["tenant_id", "id"]],
      [enterpriseRunReleases, ["tenant_id", "id"]],
      [
        enterpriseRunGrants,
        ["tenant_id", "release_id", "principal_id", "action"],
      ],
      [enterpriseRuns, ["tenant_id", "id"]],
      [enterpriseRunAttempts, ["tenant_id", "run_id", "id"]],
      [enterpriseRunCommands, ["tenant_id", "run_id", "command_id"]],
      [enterpriseRunMessages, ["tenant_id", "run_id", "id"]],
      [enterpriseRunSteps, ["tenant_id", "run_id", "id"]],
      [enterpriseRunCheckpoints, ["tenant_id", "run_id", "id"]],
      [enterpriseRunEvents, ["tenant_id", "run_id", "seq"]],
      [enterpriseRunSnapshots, ["tenant_id", "run_id", "seq"]],
      [enterpriseRunOutbox, ["tenant_id", "id"]],
      [enterpriseModelRoutes, ["tenant_id", "id"]],
      [enterpriseModelGrants, ["tenant_id", "route_id", "principal_id"]],
      [enterpriseBudgetAccounts, ["tenant_id", "id"]],
      [enterpriseBudgetReservations, ["tenant_id", "id"]],
      [enterpriseBudgetBindings, ["tenant_id", "reservation_id", "account_id"]],
      [enterpriseModelAttempts, ["tenant_id", "id"]],
      [enterpriseUsageEntries, ["tenant_id", "id"]],
      [enterpriseCapabilities, ["tenant_id", "id"]],
      [enterpriseModelCalls, ["tenant_id", "run_id", "logical_call_id"]],
      [enterpriseRunDelegations, ["tenant_id", "id"]],
    ];
    for (const [table, key] of expected) {
      expect(primaryKeyOf(table), getTableName(table)).toEqual(key);
    }
  });
});

describe("bigint counters stay 64-bit bigint columns", () => {
  test("revision/seq/fence/money/count columns are bigint, never number", () => {
    const expectations: ReadonlyArray<[PgTable, readonly string[]]> = [
      [
        enterpriseRuns,
        [
          "model_grant_revision",
          "revision",
          "latest_seq",
          "current_fence",
          "input_revision",
          "event_low_watermark",
        ],
      ],
      [
        enterpriseRunAttempts,
        [
          "attempt_no",
          "fencing_token",
          "effects_revision",
          "model_calls_count",
          "last_source_ordinal",
        ],
      ],
      [
        enterpriseRunReleases,
        [
          "input_limit_bytes",
          "max_model_calls",
          "max_run_micros",
          "tool_count",
        ],
      ],
      [enterpriseRunCommands, ["result_revision"]],
      [enterpriseRunSteps, ["step_no", "next_call_ordinal", "revision"]],
      [enterpriseRunEvents, ["seq"]],
      [enterpriseRunSnapshots, ["seq"]],
      [enterpriseRunOutbox, ["attempts"]],
      [enterpriseRunGrants, ["revision"]],
      [
        enterpriseRunDelegations,
        ["max_run_micros", "max_runs", "used_runs", "revision"],
      ],
      [
        enterpriseModelRoutes,
        [
          "revision",
          "price_revision",
          "input_unit_micros",
          "output_unit_micros",
          "per_request_micros",
          "max_input_tokens",
          "max_output_tokens",
          "max_request_bytes",
        ],
      ],
      [enterpriseModelGrants, ["revision"]],
      [
        enterpriseBudgetAccounts,
        [
          "limit_micros",
          "spent_micros",
          "held_micros",
          "overage_micros",
          "revision",
        ],
      ],
      [
        enterpriseBudgetReservations,
        [
          "cap_micros",
          "spent_micros",
          "held_micros",
          "allocated_micros",
          "overage_micros",
        ],
      ],
      [
        enterpriseModelAttempts,
        [
          "price_revision",
          "cap_micros",
          "charged_micros",
          "receipt_revision",
          "fencing_token",
        ],
      ],
      [
        enterpriseUsageEntries,
        ["revision", "input_tokens", "output_tokens", "cost_micros"],
      ],
      [enterpriseCapabilities, ["fencing_token"]],
      [enterpriseModelCalls, ["call_ordinal"]],
    ];
    for (const [table, names] of expectations) {
      const columns = getTableConfig(table).columns;
      for (const name of names) {
        const column = columns.find((candidate) => candidate.name === name);
        expect(column, `${getTableName(table)}.${name}`).toBeDefined();
        expect(column?.columnType, `${getTableName(table)}.${name}`).toBe(
          "PgBigInt64",
        );
        expect(column?.dataType, `${getTableName(table)}.${name}`).toBe(
          "bigint",
        );
      }
    }
  });

  test("json payloads use the single-serialisation jsonb", () => {
    for (const pair of [
      [enterpriseRunCheckpoints, "payload"],
      [enterpriseRunEvents, "payload"],
      [enterpriseRunEvents, "public_payload"],
      [enterpriseRunSnapshots, "payload"],
      [enterpriseRunOutbox, "payload"],
    ] as const) {
      const column = getTableConfig(pair[0]).columns.find(
        (c) => c.name === pair[1],
      );
      expect(column, `${getTableName(pair[0])}.${pair[1]}`).toBeDefined();
      expect(column?.columnType).toBe("PgCustomColumn");
      expect(column?.getSQLType()).toBe("jsonb");
    }
  });

  test("timestamps are timestamptz", () => {
    for (const pair of [
      [enterpriseRuns, "created_at"],
      [enterpriseRuns, "updated_at"],
      [enterpriseRunAttempts, "lease_until"],
      [enterpriseRunEvents, "occurred_at"],
      [enterpriseCapabilities, "expires_at"],
    ] as const) {
      const column = getTableConfig(pair[0]).columns.find(
        (c) => c.name === pair[1],
      );
      expect(column?.getSQLType(), `${getTableName(pair[0])}.${pair[1]}`).toBe(
        "timestamp with time zone",
      );
    }
  });
});

describe("the plan's schema supplement columns exist", () => {
  test("attempts carry the seal/counter columns", () => {
    expect(columnNames(enterpriseRunAttempts)).toEqual([
      "tenant_id",
      "run_id",
      "id",
      "turn_id",
      "attempt_no",
      "lease_id",
      "lease_until",
      "service_id",
      "fencing_token",
      "status",
      "context_digest",
      "started_at",
      "exited_at",
      "exit_receipt_ref",
      "sealed_at",
      "effects_revision",
      "model_calls_count",
      "last_source_ordinal",
    ]);
    const columns = getTableConfig(enterpriseRunAttempts).columns;
    expect(columns.find((c) => c.name === "sealed_at")?.notNull).toBe(false);
    for (const name of [
      "effects_revision",
      "model_calls_count",
      "last_source_ordinal",
    ]) {
      const column = columns.find((c) => c.name === name);
      expect(column?.notNull, name).toBe(true);
      expect(column?.hasDefault, name).toBe(true);
    }
  });

  test("runs carry input_revision, event_low_watermark and the non-null reservation", () => {
    const columns = getTableConfig(enterpriseRuns).columns;
    const reservation = columns.find((c) => c.name === "budget_reservation_id");
    expect(reservation?.notNull).toBe(true);
    for (const name of ["input_revision", "event_low_watermark"]) {
      const column = columns.find((c) => c.name === name);
      expect(column?.notNull, name).toBe(true);
      expect(column?.hasDefault, name).toBe(true);
    }
  });

  test("routes carry is_default_for_alias; model attempts response_ref and usage_status", () => {
    expect(columnNames(enterpriseModelRoutes)).toContain(
      "is_default_for_alias",
    );
    expect(columnNames(enterpriseModelAttempts)).toContain("response_ref");
    const usageStatus = getTableConfig(enterpriseModelAttempts).columns.find(
      (c) => c.name === "usage_status",
    );
    expect(usageStatus?.notNull).toBe(true);
    expect(usageStatus?.hasDefault).toBe(true);
  });

  test("budget rows carry overage_micros, reservations a closed_at", () => {
    const accounts = getTableConfig(enterpriseBudgetAccounts).columns;
    const reservations = getTableConfig(enterpriseBudgetReservations).columns;
    expect(accounts.find((c) => c.name === "overage_micros")?.notNull).toBe(
      true,
    );
    expect(reservations.find((c) => c.name === "overage_micros")?.notNull).toBe(
      true,
    );
    expect(reservations.find((c) => c.name === "closed_at")?.notNull).toBe(
      false,
    );
  });

  test("a model-audience capability must bind a logical call (check constraint)", () => {
    const checks = getTableConfig(enterpriseCapabilities).checks;
    expect(
      checks.some(
        (constraint) => constraint.name === "enterprise_capability_model_call",
      ),
    ).toBe(true);
    expect(columnNames(enterpriseCapabilities)).toContain("logical_call_id");
  });

  test("the run state set, initiator kinds and attempt lifecycle are check-pinned", () => {
    expect(getTableConfig(enterpriseRuns).checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "enterprise_run_status",
        "enterprise_run_initiator",
      ]),
    );
    expect(
      getTableConfig(enterpriseRunAttempts).checks.map((c) => c.name),
    ).toContain("enterprise_attempt_status");
  });
});

/* ------------------------------------------------------------------ */
/* 迁移与角色文件合同                                                   */
/* ------------------------------------------------------------------ */

type JournalEntry = { idx: number; tag: string };

function readJournal(): JournalEntry[] {
  return JSON.parse(
    readFileSync(
      new URL("../../../drizzle/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as JournalEntry[];
}

function migrationSql(tag: string): string {
  return readFileSync(
    new URL(`../../../drizzle/${tag}.sql`, import.meta.url),
    "utf8",
  );
}

describe("the migration journal stays generated and drop-free", () => {
  test("every journal entry has its sql file on disk", () => {
    const entries = readJournal();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      let exists = true;
      try {
        migrationSql(entry.tag);
      } catch {
        exists = false;
      }
      expect(exists, entry.tag).toBe(true);
    }
  });

  test("the two new runs migrations drop no table and no column", () => {
    const entries = readJournal();
    expect(entries.length).toBeGreaterThanOrEqual(58);
    const tail = entries.slice(-2);
    expect(tail.map((entry) => entry.tag).some((tag) => tag.endsWith("_enterprise_runs_rls"))).toBe(
      true,
    );
    for (const entry of tail) {
      const migration = migrationSql(entry.tag);
      expect(migration, entry.tag).not.toMatch(/drop\s+table/i);
      expect(migration, entry.tag).not.toMatch(/drop\s+column/i);
    }
  });

  test("the custom runs RLS migration is the journal's last entry", () => {
    const entries = readJournal();
    const custom = entries.find((entry) => entry.tag.endsWith("_enterprise_runs_rls"));
    expect(custom).toBeDefined();
    expect(custom?.idx).toBe(Math.max(...entries.map((entry) => entry.idx)));
  });
});

describe("the custom RLS migration is the single executable policy source", () => {
  function rlsMigrationSql(): string {
    const entry = readJournal().find((candidate) =>
      candidate.tag.endsWith("_enterprise_runs_rls"),
    );
    if (!entry) {
      throw new Error("enterprise_runs_rls migration has not been generated yet");
    }
    return migrationSql(entry.tag).toLowerCase();
  }

  test("every new table gets ENABLE and FORCE row level security", () => {
    const migration = rlsMigrationSql();
    for (const tableName of EXPECTED_TABLE_NAMES) {
      expect(migration, tableName).toContain(
        `alter table ${tableName} enable row level security`,
      );
      expect(migration, tableName).toContain(
        `alter table ${tableName} force row level security`,
      );
    }
  });

  test("run and reservation reference each other through deferred composite foreign keys", () => {
    const migration = rlsMigrationSql();
    expect(migration).toContain("deferrable initially deferred");
    expect(migration).toContain(
      "foreign key (tenant_id, budget_reservation_id)",
    );
    expect(migration).toContain(
      "references enterprise_budget_reservations (tenant_id, id)",
    );
    expect(migration).toContain("references enterprise_runs (tenant_id, id)");
  });

  test("the two partial unique indexes exist with their where clauses", () => {
    const migration = rlsMigrationSql();
    expect(migration).toContain("enterprise_thread_single_active_run");
    expect(migration).toMatch(
      /create unique index enterprise_thread_single_active_run[\s\S]*?where status not in \('succeeded', ?'failed', ?'cancelled', ?'expired'\)/,
    );
    expect(migration).toContain("enterprise_platform_event_source");
    expect(migration).toMatch(
      /create unique index enterprise_platform_event_source[\s\S]*?where attempt_id is null/,
    );
  });

  test("the reservation non-negativity check exists", () => {
    const migration = rlsMigrationSql();
    expect(migration).toContain("budget_reservation_nonnegative");
    expect(migration).toContain("allocated_micros <= held_micros");
  });

  test("the dispatcher's statements touch nothing but the outbox", () => {
    const dispatcherLines = rlsMigrationSql()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"))
      .filter((line) => line.includes("ob_ent_dispatcher"));
    expect(dispatcherLines.length).toBeGreaterThan(0);
    for (const line of dispatcherLines) {
      expect(line, line).toContain("enterprise_run_outbox");
      for (const forbidden of [
        "enterprise_run_messages",
        "enterprise_run_events",
        "enterprise_runs ",
        "enterprise_capabilities",
        "input_text",
      ]) {
        expect(line, line).not.toContain(forbidden);
      }
    }
  });

  test("the maintenance role never selects the input body column", () => {
    const maintenanceLines = rlsMigrationSql()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("--"))
      .filter((line) => line.includes("ob_ent_run_maintenance"));
    expect(maintenanceLines.length).toBeGreaterThan(0);
    for (const line of maintenanceLines) {
      expect(line, line).not.toContain("input_text");
    }
    /* enterprise_runs 的 SELECT 必须是列级清单（清单里没有 input_text）。 */
    const runsColumnGrant = maintenanceLines.find((line) =>
      line.includes("on enterprise_runs"),
    );
    expect(runsColumnGrant).toBeDefined();
    expect(runsColumnGrant).toMatch(/grant select \(/);
  });
});

describe("roles.sql declares the five capability roles", () => {
  test("each new role is nologin, nonsuperuser and non-bypassrls", () => {
    const roles = readFileSync(
      new URL("../../../ops/enterprise/roles.sql", import.meta.url),
      "utf8",
    ).toLowerCase();
    for (const role of [
      "ob_ent_run_writer",
      "ob_ent_runtime_writer",
      "ob_ent_dispatcher",
      "ob_ent_run_operator",
      "ob_ent_run_maintenance",
    ]) {
      expect(roles, role).toMatch(
        new RegExp(
          `create role ${role} nologin nosuperuser nobypassrls nocreatedb nocreaterole`,
        ),
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 动态半场：真实测试库上的受限登录反例                                   */
/* ------------------------------------------------------------------ */

type Probe = { ready: boolean; reason: string };

async function probeRunsDatabase(): Promise<Probe> {
  let client:
    | {
        unsafe: (query: string) => Promise<unknown[]>;
        close: () => Promise<void>;
      }
    | undefined;
  try {
    const { SQL } = await import("bun");
    const url = testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    });
    const opened = new SQL(url, { max: 1, timeout: 5 });
    client = opened;
    const tables = await opened.unsafe(
      "select 1 from pg_tables where schemaname = 'public' and tablename = 'enterprise_runs'",
    );
    if (tables.length === 0) {
      return {
        ready: false,
        reason: "migrations not applied to the test database",
      };
    }
    const roles = await opened.unsafe(
      "select rolname from pg_roles where rolname in ('ob_ent_run_writer','ob_ent_runtime_writer','ob_ent_dispatcher','ob_ent_run_operator','ob_ent_run_maintenance')",
    );
    if (roles.length < 5) {
      return {
        ready: false,
        reason: `only ${roles.length}/5 runs capability roles exist; run enterprise-test-db.ts roles`,
      };
    }
    const missing = [
      "ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL",
      "ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL",
      "ENTERPRISE_TEST_DISPATCHER_DATABASE_URL",
      "ENTERPRISE_TEST_RUN_OPERATOR_DATABASE_URL",
      "ENTERPRISE_TEST_RUN_MAINTENANCE_DATABASE_URL",
      "ENTERPRISE_TEST_DATA_DATABASE_URL",
    ].filter((variable) => !process.env[variable]);
    if (missing.length > 0) {
      return {
        ready: false,
        reason: `restricted login env vars missing: ${missing.join(", ")}`,
      };
    }
    return { ready: true, reason: "" };
  } catch (error) {
    return { ready: false, reason: String((error as Error)?.message ?? error) };
  } finally {
    await client?.close();
  }
}

const dbProbe: Probe = await probeRunsDatabase();
if (!dbProbe.ready) {
  console.warn(
    `[schema.test.ts] real-database assertions skipped: ${dbProbe.reason}`,
  );
}
const describeDb = dbProbe.ready ? describe : describe.skip;

if (dbProbe.ready) {
  const restrictedUrl = (variable: string) =>
    testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });

  const ownerDatabase = createDatabase(
    testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
    { max: 1 },
  );
  /* 计划 309 行：db 为经 testDatabaseUrlFrom 校验的专用受限池——公开 run-writer 连接。 */
  const db = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL"),
    {
      max: 1,
    },
  );
  const runtimeDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_RUNTIME_WRITER_DATABASE_URL"),
    { max: 1 },
  );
  const dispatcherDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_DISPATCHER_DATABASE_URL"),
    { max: 1 },
  );
  const operatorDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_RUN_OPERATOR_DATABASE_URL"),
    { max: 1 },
  );
  const maintenanceDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_RUN_MAINTENANCE_DATABASE_URL"),
    { max: 1 },
  );
  const dataDatabase = createDatabase(
    restrictedUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
    {
      max: 1,
    },
  );

  const TENANT_A = "r1b-tenant-a";
  const TENANT_B = "r1b-tenant-b";
  const USER_A = "r1b-user-a";
  const USER_B = "r1b-user-b";
  const PRINCIPAL_A = "r1b-principal-a";
  const PRINCIPAL_B = "r1b-principal-b";
  const WORKSPACE_A = "r1b-workspace-a";
  const WORKSPACE_B = "r1b-workspace-b";
  const RESOURCE_A = "r1b-resource-a";
  const RESOURCE_B = "r1b-resource-b";
  const THREAD_A = "r1b-thread-a";
  const THREAD_A2 = "r1b-thread-a2";
  const THREAD_B = "r1b-thread-b";
  const RELEASE_A = "r1b-release-a";
  const RELEASE_B = "r1b-release-b";
  const ROUTE_A = "r1b-route-a";
  const ACCOUNT_A = "r1b-account-a";
  const RUN_A = "r1b-run-a";
  const RUN_B = "r1b-run-b";
  const RESERVATION_A = "r1b-res-a";
  const RESERVATION_B = "r1b-res-b";
  const ATTEMPT_A = "r1b-attempt-a";
  const STEP_A = "r1b-step-a";
  const CALL_A = "r1b-call-a";
  const MODEL_ATTEMPT_A = "r1b-mattempt-a";

  /*
   * 事务本地上下文，全部为固定字面量：fixture id 在本文件内硬编码，这些语句是
   * 测试定义的一部分，不是外部输入通道。
   */
  const writerContextA = sql`select
    set_config('app.tenant_id', 'r1b-tenant-a', true),
    set_config('app.principal_id', 'r1b-principal-a', true)`;
  const writerContextB = sql`select
    set_config('app.tenant_id', 'r1b-tenant-b', true),
    set_config('app.principal_id', 'r1b-principal-a', true)`;
  const runtimeContextRunA = sql`select
    set_config('app.tenant_id', 'r1b-tenant-a', true),
    set_config('app.run_id', 'r1b-run-a', true)`;
  const runtimeContextUnbound = sql`select
    set_config('app.tenant_id', 'r1b-tenant-a', true),
    set_config('app.run_id', 'r1b-run-unbound', true)`;
  const runtimeContextTenantB = sql`select
    set_config('app.tenant_id', 'r1b-tenant-b', true),
    set_config('app.run_id', 'r1b-run-a', true)`;
  const operatorContextA = sql`select set_config('app.tenant_id', 'r1b-tenant-a', true)`;
  const maintenanceContextA = sql`select set_config('app.tenant_id', 'r1b-tenant-a', true)`;

  type PgError = { code: string; message: string };

  async function rejectionOf(run: () => Promise<unknown>): Promise<PgError> {
    try {
      await run();
    } catch (error) {
      let candidate = error as Record<string, unknown> | undefined;
      for (let depth = 0; candidate !== undefined && depth < 5; depth += 1) {
        const sqlstate = [candidate.errno, candidate.code].find(
          (value) =>
            typeof value === "string" && /^[0-9A-Z]{5}$/.test(value as string),
        );
        if (
          typeof sqlstate === "string" &&
          typeof candidate.message === "string"
        ) {
          return { code: sqlstate, message: candidate.message as string };
        }
        candidate = candidate.cause as Record<string, unknown> | undefined;
      }
      throw new Error(
        `expected a PostgreSQL error with a SQLSTATE and message, got: ${String(error)}`,
      );
    }
    throw new Error("expected the statement to be rejected, but it succeeded");
  }

  const routeRow = (overrides: {
    tenantId: string;
    id: string;
    alias: string;
    revision: bigint;
    resourceId: string;
    isDefaultForAlias: boolean;
  }) => ({
    tenantId: overrides.tenantId,
    id: overrides.id,
    alias: overrides.alias,
    revision: overrides.revision,
    resourceId: overrides.resourceId,
    targetRef: "openai/gpt-test",
    priceRevision: BigInt(1),
    currency: "USD",
    inputUnitMicros: BigInt(10),
    outputUnitMicros: BigInt(30),
    perRequestMicros: BigInt(0),
    maxInputTokens: BigInt(8192),
    maxOutputTokens: BigInt(2048),
    maxRequestBytes: BigInt(262144),
    protocolProfile: "openai-chat",
    usageProfile: "tokens",
    isDefaultForAlias: overrides.isDefaultForAlias,
    status: "active",
  });

  const releaseRow = (overrides: {
    tenantId: string;
    id: string;
    resourceId: string;
    versionDigest: string;
  }) => ({
    tenantId: overrides.tenantId,
    id: overrides.id,
    resourceId: overrides.resourceId,
    versionDigest: overrides.versionDigest,
    runtimeCompatibility: "go-v1",
    expertVersion: "1.0.0",
    modelRouteRef: null,
    inputLimitBytes: BigInt(32768),
    maxModelCalls: BigInt(8),
    maxRunMicros: BigInt(1000000),
    currency: "USD",
    toolManifestDigest: null,
    toolCount: BigInt(0),
    status: "published",
  });

  const runRow = (overrides: {
    tenantId: string;
    id: string;
    ownerPrincipalId: string;
    workspaceId: string;
    threadId: string;
    releaseId: string;
    requestKey: string;
    budgetReservationId: string;
  }) => ({
    tenantId: overrides.tenantId,
    id: overrides.id,
    ownerPrincipalId: overrides.ownerPrincipalId,
    actorUserId: overrides.tenantId === TENANT_A ? USER_A : USER_B,
    workspaceId: overrides.workspaceId,
    threadId: overrides.threadId,
    releaseId: overrides.releaseId,
    initiatorKind: "user",
    requestKey: overrides.requestKey,
    requestDigest: "d".repeat(64),
    inputText: "hello ledger",
    modelRouteRef: ROUTE_A,
    modelGrantRevision: BigInt(1),
    releaseDigest: "e".repeat(64),
    policyRevision: "tenancy-v1",
    budgetReservationId: overrides.budgetReservationId,
    status: "running",
    revision: BigInt(1),
    latestSeq: BigInt(1),
    currentFence: BigInt(1),
    reconciliationRequired: false,
    inputRevision: BigInt(0),
    eventLowWatermark: BigInt(0),
  });

  const reservationRow = (overrides: {
    tenantId: string;
    id: string;
    runId: string;
  }) => ({
    tenantId: overrides.tenantId,
    id: overrides.id,
    runId: overrides.runId,
    capMicros: BigInt(1000000),
    spentMicros: BigInt(0),
    heldMicros: BigInt(1000),
    allocatedMicros: BigInt(0),
    overageMicros: BigInt(0),
    currency: "USD",
    periodId: "2026-10",
    status: "open",
  });

  beforeAll(async () => {
    /* 迁移 owner（专用测试库）按 FK 拓扑（子表在前）清理本 suite 的 fixture。runs 与
     * reservations 互为延迟 FK，必须同一事务删除，让两个方向在提交时一起结算。 */
    const cleanupOrder: readonly PgTable[] = [
      enterpriseUsageEntries,
      enterpriseModelAttempts,
      enterpriseCapabilities,
      enterpriseRunMessages,
      enterpriseRunCheckpoints,
      enterpriseRunEvents,
      enterpriseRunSnapshots,
      enterpriseRunOutbox,
      enterpriseRunCommands,
      enterpriseModelCalls,
      enterpriseRunSteps,
      enterpriseRunAttempts,
      enterpriseRunGrants,
      enterpriseRunDelegations,
      enterpriseModelGrants,
      enterpriseBudgetBindings,
      enterpriseModelRoutes,
      enterpriseBudgetAccounts,
    ];
    for (const table of cleanupOrder) {
      await ownerDatabase
        .delete(table)
        .where(inArray(getTableColumns(table).tenantId, [TENANT_A, TENANT_B]));
    }
    await ownerDatabase.transaction(async (tx) => {
      await tx
        .delete(enterpriseRuns)
        .where(inArray(enterpriseRuns.tenantId, [TENANT_A, TENANT_B]));
      await tx
        .delete(enterpriseBudgetReservations)
        .where(inArray(enterpriseBudgetReservations.tenantId, [TENANT_A, TENANT_B]));
    });
    /* runs/reservations 落库之后才能删它们的父表：releases、threads 与 tenancy 链。 */
    for (const table of [
      enterpriseRunReleases,
      enterpriseThreads,
      enterpriseResources,
      enterpriseWorkspaces,
      enterpriseMemberships,
    ] as const) {
      await ownerDatabase
        .delete(table)
        .where(inArray(getTableColumns(table).tenantId, [TENANT_A, TENANT_B]));
    }
    await ownerDatabase
      .delete(enterpriseSecurityEvents)
      .where(like(enterpriseSecurityEvents.id, "r1b-%"));
    await ownerDatabase
      .delete(enterprisePrincipals)
      .where(inArray(enterprisePrincipals.id, [PRINCIPAL_A, PRINCIPAL_B]));
    await ownerDatabase
      .delete(enterpriseTenants)
      .where(inArray(enterpriseTenants.id, [TENANT_A, TENANT_B]));
    await ownerDatabase
      .delete(users)
      .where(inArray(users.id, [USER_A, USER_B]));

    await ownerDatabase
      .insert(users)
      .values([
        { id: USER_A, email: "r1b-a@enterprise-test.invalid" },
        { id: USER_B, email: "r1b-b@enterprise-test.invalid" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseTenants)
      .values([
        { id: TENANT_A, name: "R1B Tenant A" },
        { id: TENANT_B, name: "R1B Tenant B" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterprisePrincipals)
      .values([
        { id: PRINCIPAL_A, userId: USER_A },
        { id: PRINCIPAL_B, userId: USER_B },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseMemberships)
      .values([
        { tenantId: TENANT_A, principalId: PRINCIPAL_A, role: "member" },
        { tenantId: TENANT_B, principalId: PRINCIPAL_B, role: "member" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseWorkspaces)
      .values([
        { tenantId: TENANT_A, id: WORKSPACE_A, name: "A" },
        { tenantId: TENANT_B, id: WORKSPACE_B, name: "B" },
      ])
      .onConflictDoNothing();
    await ownerDatabase
      .insert(enterpriseResources)
      .values([
        {
          tenantId: TENANT_A,
          id: RESOURCE_A,
          workspaceId: WORKSPACE_A,
          kind: "expert",
        },
        {
          tenantId: TENANT_B,
          id: RESOURCE_B,
          workspaceId: WORKSPACE_B,
          kind: "expert",
        },
      ])
      .onConflictDoNothing();
    await ownerDatabase.insert(enterpriseThreads).values([
      {
        tenantId: TENANT_A,
        id: THREAD_A,
        ownerPrincipalId: PRINCIPAL_A,
        workspaceId: WORKSPACE_A,
      },
      {
        tenantId: TENANT_A,
        id: THREAD_A2,
        ownerPrincipalId: PRINCIPAL_A,
        workspaceId: WORKSPACE_A,
      },
      {
        tenantId: TENANT_B,
        id: THREAD_B,
        ownerPrincipalId: PRINCIPAL_B,
        workspaceId: WORKSPACE_B,
      },
    ]);
    await ownerDatabase.insert(enterpriseModelRoutes).values(
      routeRow({
        tenantId: TENANT_A,
        id: ROUTE_A,
        alias: "chat",
        revision: BigInt(1),
        resourceId: RESOURCE_A,
        isDefaultForAlias: true,
      }),
    );
    await ownerDatabase.insert(enterpriseRunReleases).values([
      releaseRow({
        tenantId: TENANT_A,
        id: RELEASE_A,
        resourceId: RESOURCE_A,
        versionDigest: "f".repeat(64),
      }),
      releaseRow({
        tenantId: TENANT_B,
        id: RELEASE_B,
        resourceId: RESOURCE_B,
        versionDigest: "a".repeat(64),
      }),
    ]);
    await ownerDatabase.insert(enterpriseBudgetAccounts).values({
      tenantId: TENANT_A,
      id: ACCOUNT_A,
      scopeKind: "workspace",
      scopeRef: WORKSPACE_A,
      periodId: "2026-10",
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: new Date("2026-11-01T00:00:00Z"),
      currency: "USD",
      limitMicros: BigInt(10000000),
      spentMicros: BigInt(0),
      heldMicros: BigInt(0),
      overageMicros: BigInt(0),
      status: "active",
      revision: BigInt(1),
    });
    /* Run↔reservation 的创建循环在同事务内互相引用：延迟 FK 在提交时结算。 */
    await ownerDatabase.transaction(async (tx) => {
      await tx.insert(enterpriseRuns).values(
        runRow({
          tenantId: TENANT_A,
          id: RUN_A,
          ownerPrincipalId: PRINCIPAL_A,
          workspaceId: WORKSPACE_A,
          threadId: THREAD_A,
          releaseId: RELEASE_A,
          requestKey: "req-a",
          budgetReservationId: RESERVATION_A,
        }),
      );
      await tx.insert(enterpriseBudgetReservations).values(
        reservationRow({
          tenantId: TENANT_A,
          id: RESERVATION_A,
          runId: RUN_A,
        }),
      );
    });
    await ownerDatabase.transaction(async (tx) => {
      await tx.insert(enterpriseRuns).values(
        runRow({
          tenantId: TENANT_B,
          id: RUN_B,
          ownerPrincipalId: PRINCIPAL_B,
          workspaceId: WORKSPACE_B,
          threadId: THREAD_B,
          releaseId: RELEASE_B,
          requestKey: "req-b",
          budgetReservationId: RESERVATION_B,
        }),
      );
      await tx.insert(enterpriseBudgetReservations).values(
        reservationRow({
          tenantId: TENANT_B,
          id: RESERVATION_B,
          runId: RUN_B,
        }),
      );
    });
    await ownerDatabase.insert(enterpriseRunAttempts).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      id: ATTEMPT_A,
      turnId: "r1b-turn-1",
      attemptNo: BigInt(1),
      leaseId: "r1b-lease-1",
      leaseUntil: new Date(Date.now() + 60_000),
      serviceId: "r1b-service",
      fencingToken: BigInt(1),
      status: "active",
      contextDigest: "c".repeat(64),
      effectsRevision: BigInt(0),
      modelCallsCount: BigInt(0),
      lastSourceOrdinal: BigInt(0),
    });
    await ownerDatabase.insert(enterpriseRunSteps).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      id: STEP_A,
      attemptId: ATTEMPT_A,
      stepNo: BigInt(1),
      kind: "model",
      status: "allocated",
      nextCallOrdinal: BigInt(0),
      revision: BigInt(1),
    });
    await ownerDatabase.insert(enterpriseModelCalls).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      logicalCallId: CALL_A,
      attemptId: ATTEMPT_A,
      stepId: STEP_A,
      callOrdinal: BigInt(1),
      routeId: ROUTE_A,
      status: "allocated",
    });
    await ownerDatabase.insert(enterpriseModelAttempts).values({
      tenantId: TENANT_A,
      id: MODEL_ATTEMPT_A,
      runId: RUN_A,
      attemptId: ATTEMPT_A,
      logicalCallId: CALL_A,
      requestDigest: "b".repeat(64),
      routeId: ROUTE_A,
      priceRevision: BigInt(1),
      reservationId: RESERVATION_A,
      capMicros: BigInt(1000),
      status: "reserved",
      usageStatus: "pending",
      leaseId: "r1b-lease-1",
      fencingToken: BigInt(1),
      receiptRevision: BigInt(0),
    });
    await ownerDatabase.insert(enterpriseUsageEntries).values({
      tenantId: TENANT_A,
      id: "r1b-usage-a",
      modelAttemptId: MODEL_ATTEMPT_A,
      revision: BigInt(1),
      inputTokens: BigInt(10),
      outputTokens: BigInt(5),
      costMicros: BigInt(12),
      kind: "charge",
      evidenceDigest: "9".repeat(64),
    });
    await ownerDatabase.insert(enterpriseBudgetBindings).values({
      tenantId: TENANT_A,
      reservationId: RESERVATION_A,
      accountId: ACCOUNT_A,
    });
    await ownerDatabase.insert(enterpriseRunGrants).values({
      tenantId: TENANT_A,
      releaseId: RELEASE_A,
      principalId: PRINCIPAL_A,
      action: "start",
      revision: BigInt(1),
    });
    await ownerDatabase.insert(enterpriseModelGrants).values({
      tenantId: TENANT_A,
      routeId: ROUTE_A,
      principalId: PRINCIPAL_A,
      revision: BigInt(1),
      status: "active",
    });
    await ownerDatabase.insert(enterpriseRunDelegations).values({
      tenantId: TENANT_A,
      id: "r1b-delegation-a",
      principalId: PRINCIPAL_A,
      releaseId: RELEASE_A,
      routeId: ROUTE_A,
      maxRunMicros: BigInt(500000),
      maxRuns: BigInt(10),
      usedRuns: BigInt(0),
      expiresAt: new Date(Date.now() + 3_600_000),
      revision: BigInt(1),
    });
    await ownerDatabase.insert(enterpriseRunMessages).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      id: "r1b-message-a",
      attemptId: ATTEMPT_A,
      turnId: "r1b-turn-1",
      role: "user",
      contentRef: "content-store://r1b-message-a",
      contentDigest: "d1".repeat(32),
      status: "committed",
    });
    await ownerDatabase.insert(enterpriseRunCommands).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      commandId: "r1b-command-a",
      payloadDigest: "c1".repeat(32),
      kind: "input",
      resultRevision: BigInt(1),
      resultStatus: "applied",
    });
    await ownerDatabase.insert(enterpriseRunEvents).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      eventId: "r1b-event-a",
      seq: BigInt(1),
      attemptId: ATTEMPT_A,
      turnId: "r1b-turn-1",
      sourceEventId: "r1b-src-1",
      sourceDigest: "e1".repeat(32),
      eventType: "RUN_STATE_CHANGED",
      schemaVersion: "1",
      payload: { status: "running" },
      occurredAt: new Date(),
    });
    await ownerDatabase.insert(enterpriseRunSnapshots).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      seq: BigInt(1),
      payload: { status: "running" },
      contentDigest: "s1".repeat(32),
    });
    await ownerDatabase.insert(enterpriseRunCheckpoints).values({
      tenantId: TENANT_A,
      runId: RUN_A,
      id: "r1b-checkpoint-a",
      attemptId: ATTEMPT_A,
      stepId: STEP_A,
      contentDigest: "k1".repeat(32),
      runtimeCompatibility: "go-v1",
      expertVersion: "1.0.0",
      payload: { messages: [] },
    });
    await ownerDatabase.insert(enterpriseRunOutbox).values({
      tenantId: TENANT_A,
      id: "r1b-outbox-a",
      runId: RUN_A,
      kind: "workflow-start",
      payloadDigest: "o1".repeat(32),
      payload: { runId: RUN_A },
      status: "pending",
      availableAt: new Date(),
      attempts: BigInt(0),
    });
    await ownerDatabase.insert(enterpriseCapabilities).values({
      tenantId: TENANT_A,
      id: "r1b-cap-a",
      tokenHash: "h1".repeat(32),
      serviceId: "r1b-service",
      audience: "runtime",
      envelopeDigest: "n1".repeat(32),
      runId: RUN_A,
      attemptId: ATTEMPT_A,
      leaseId: "r1b-lease-1",
      fencingToken: BigInt(1),
      expiresAt: new Date(Date.now() + 60_000),
    });
  });

  afterAll(async () => {
    await Promise.allSettled([
      ownerDatabase.$client.close(),
      db.$client.close(),
      runtimeDatabase.$client.close(),
      dispatcherDatabase.$client.close(),
      operatorDatabase.$client.close(),
      maintenanceDatabase.$client.close(),
      dataDatabase.$client.close(),
    ]);
  });

  describeDb("capability roles stay nologin and mutually unreachable", () => {
    test("the five new roles are nologin, non-superuser, non-bypassrls", async () => {
      const roles =
        await ownerDatabase.execute(sql`select rolname, rolcanlogin, rolsuper,
          rolbypassrls, rolcreaterole, rolcreatedb
        from pg_roles where rolname in
          ('ob_ent_run_writer','ob_ent_runtime_writer','ob_ent_dispatcher',
           'ob_ent_run_operator','ob_ent_run_maintenance')`);
      expect(roles).toHaveLength(5);
      for (const role of roles) {
        expect(role.rolcanlogin).toBe(false);
        expect(role.rolsuper).toBe(false);
        expect(role.rolbypassrls).toBe(false);
        expect(role.rolcreaterole).toBe(false);
        expect(role.rolcreatedb).toBe(false);
      }
    });

    test("the run-writer login cannot assume the owner or another capability role", async () => {
      for (const setRole of [
        sql`set role openbot`,
        sql`set role ob_ent_dispatcher`,
        sql`set role ob_ent_run_maintenance`,
      ]) {
        const error = await rejectionOf(() => db.execute(setRole));
        expect(error.code).toBe("42501");
        expect(error.message).toContain("role");
      }
    });
  });

  describeDb("the run-writer scope", () => {
    test("without a context the restricted pool sees no rows", async () => {
      expect(
        await db.select({ id: enterpriseRuns.id }).from(enterpriseRuns),
      ).toHaveLength(0);
    });

    test("with the tenant and principal context only the caller's own runs appear", async () => {
      const own = await db.transaction(async (tx) => {
        await tx.execute(writerContextA);
        return tx.select({ id: enterpriseRuns.id }).from(enterpriseRuns);
      });
      expect(own.map((row) => row.id)).toEqual([RUN_A]);

      const crossTenant = await db.transaction(async (tx) => {
        await tx.execute(writerContextB);
        return tx.select({ id: enterpriseRuns.id }).from(enterpriseRuns);
      });
      /* principal A 在租户 B 不是成员；策略的两个谓词必须同时成立。 */
      expect(crossTenant).toHaveLength(0);
    });

    test("the public pool cannot read capability hashes (plan §E1-B)", async () => {
      await expect(
        db.$client.unsafe("select token_hash from enterprise_capabilities"),
      ).rejects.toThrow();
    });

    test("the public pool cannot truncate the ledger (plan §E1-B)", async () => {
      await expect(
        db.$client.unsafe("truncate enterprise_runs"),
      ).rejects.toThrow();
    });

    test("a thread pointing at another tenant's workspace is refused by the composite FK", async () => {
      const error = await db.transaction(async (tx) => {
        await tx.execute(writerContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseThreads).values({
            tenantId: TENANT_A,
            id: "r1b-thread-cross",
            ownerPrincipalId: PRINCIPAL_A,
            workspaceId: WORKSPACE_B,
          }),
        );
      });
      expect(error.code).toBe("23503");
      expect(error.message).toContain("enterprise_threads");
    });

    test("a reservation referencing another tenant's run is refused at commit", async () => {
      /* 延迟复合 FK：语句期通过，提交时 (tenant A, run B) 不存在才暴露 23503。 */
      const error = await rejectionOf(() =>
        db.transaction(async (tx) => {
          await tx.execute(writerContextA);
          await tx.insert(enterpriseBudgetReservations).values(
            reservationRow({
              tenantId: TENANT_A,
              id: "r1b-res-cross",
              runId: RUN_B,
            }),
          );
        }),
      );
      expect(error.code).toBe("23503");
      expect(error.message).toContain("enterprise_budget_reservations");
    });

    test("a run and its reservation can commit together in one transaction", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(writerContextA);
        await tx.insert(enterpriseRuns).values(
          runRow({
            tenantId: TENANT_A,
            id: "r1b-run-atomic",
            ownerPrincipalId: PRINCIPAL_A,
            workspaceId: WORKSPACE_A,
            threadId: THREAD_A2,
            releaseId: RELEASE_A,
            requestKey: "req-atomic",
            budgetReservationId: "r1b-res-atomic",
          }),
        );
        await tx.insert(enterpriseBudgetReservations).values(
          reservationRow({
            tenantId: TENANT_A,
            id: "r1b-res-atomic",
            runId: "r1b-run-atomic",
          }),
        );
      });
      const rows = await ownerDatabase
        .select({ id: enterpriseRuns.id })
        .from(enterpriseRuns)
        .where(eq(enterpriseRuns.id, "r1b-run-atomic"));
      expect(rows).toHaveLength(1);
    });

    test("a second non-terminal run on the same thread is refused by the partial unique index", async () => {
      const error = await db.transaction(async (tx) => {
        await tx.execute(writerContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseRuns).values(
            runRow({
              tenantId: TENANT_A,
              id: "r1b-run-second",
              ownerPrincipalId: PRINCIPAL_A,
              workspaceId: WORKSPACE_A,
              threadId: THREAD_A2,
              releaseId: RELEASE_A,
              requestKey: "req-second",
              budgetReservationId: "r1b-res-second",
            }),
          ),
        );
      });
      expect(error.code).toBe("23505");
      expect(error.message).toContain("enterprise_thread_single_active_run");
    });

    test("negative or over-allocated reservations violate the non-negativity check", async () => {
      const negative = await db.transaction(async (tx) => {
        await tx.execute(writerContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseBudgetReservations).values({
            ...reservationRow({
              tenantId: TENANT_A,
              id: "r1b-res-neg",
              runId: RUN_A,
            }),
            capMicros: BigInt(-1),
          }),
        );
      });
      expect(negative.code).toBe("23514");

      const overAllocated = await db.transaction(async (tx) => {
        await tx.execute(writerContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseBudgetReservations).values({
            ...reservationRow({
              tenantId: TENANT_A,
              id: "r1b-res-over",
              runId: RUN_A,
            }),
            allocatedMicros: BigInt(2000),
          }),
        );
      });
      expect(overAllocated.code).toBe("23514");
      expect(overAllocated.message).toContain("budget_reservation_nonnegative");
    });
  });

  describeDb("the offline operator scope", () => {
    test("a route referencing another tenant's resource is refused by the composite FK", async () => {
      const error = await operatorDatabase.transaction(async (tx) => {
        await tx.execute(operatorContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseModelRoutes).values(
            routeRow({
              tenantId: TENANT_A,
              id: "r1b-route-cross",
              alias: "chat",
              revision: BigInt(2),
              resourceId: RESOURCE_B,
              isDefaultForAlias: false,
            }),
          ),
        );
      });
      expect(error.code).toBe("23503");
      expect(error.message).toContain("enterprise_model_routes");
    });

    test("a release referencing another tenant's resource is refused", async () => {
      const error = await operatorDatabase.transaction(async (tx) => {
        await tx.execute(operatorContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseRunReleases).values(
            releaseRow({
              tenantId: TENANT_A,
              id: "r1b-release-cross",
              resourceId: RESOURCE_B,
              versionDigest: "c2".repeat(32),
            }),
          ),
        );
      });
      expect(error.code).toBe("23503");
      expect(error.message).toContain("enterprise_run_releases");
    });

    test("the operator cannot start model calls: no grant on the model ledger", async () => {
      const error = await operatorDatabase.transaction(async (tx) => {
        await tx.execute(operatorContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseModelAttempts).values({
            tenantId: TENANT_A,
            id: "r1b-mattempt-op",
            runId: RUN_A,
            attemptId: ATTEMPT_A,
            logicalCallId: "r1b-call-op",
            requestDigest: "f2".repeat(32),
            routeId: ROUTE_A,
            priceRevision: BigInt(1),
            reservationId: RESERVATION_A,
            capMicros: BigInt(1),
            status: "reserved",
            usageStatus: "pending",
            leaseId: "r1b-lease-1",
            fencingToken: BigInt(1),
            receiptRevision: BigInt(0),
          }),
        );
      });
      expect(error.code).toBe("42501");
      expect(error.message).toContain("permission denied for table");
      expect(error.message).toContain("enterprise_model_attempts");
    });

    test("only one default active route per tenant alias (partial unique index)", async () => {
      await operatorDatabase.transaction(async (tx) => {
        await tx.execute(operatorContextA);
        await tx.insert(enterpriseModelRoutes).values(
          routeRow({
            tenantId: TENANT_A,
            id: "r1b-route-second",
            alias: "chat",
            revision: BigInt(2),
            resourceId: RESOURCE_A,
            isDefaultForAlias: false,
          }),
        );
      });
      const error = await operatorDatabase.transaction(async (tx) => {
        await tx.execute(operatorContextA);
        return rejectionOf(() =>
          tx.insert(enterpriseModelRoutes).values(
            routeRow({
              tenantId: TENANT_A,
              id: "r1b-route-default2",
              alias: "chat",
              revision: BigInt(3),
              resourceId: RESOURCE_A,
              isDefaultForAlias: true,
            }),
          ),
        );
      });
      expect(error.code).toBe("23505");
      /* 已有 run 继续用原 route：历史请求不由默认切换改写（route_id 固定在 runs 上）。 */
      const routeA = await ownerDatabase
        .select({ id: enterpriseModelRoutes.id })
        .from(enterpriseModelRoutes)
        .where(eq(enterpriseModelRoutes.id, ROUTE_A));
      expect(routeA).toHaveLength(1);
    });
  });

  describeDb("the runtime-writer, dispatcher and maintenance scopes", () => {
    test("the runtime writer is pinned to the bound run", async () => {
      const bound = await runtimeDatabase.transaction(async (tx) => {
        await tx.execute(runtimeContextRunA);
        return tx
          .select({ seq: enterpriseRunEvents.seq })
          .from(enterpriseRunEvents);
      });
      expect(bound).toHaveLength(1);

      const unbound = await runtimeDatabase.transaction(async (tx) => {
        await tx.execute(runtimeContextUnbound);
        return tx
          .select({ seq: enterpriseRunEvents.seq })
          .from(enterpriseRunEvents);
      });
      expect(unbound).toHaveLength(0);

      const wrongTenant = await runtimeDatabase.transaction(async (tx) => {
        await tx.execute(runtimeContextTenantB);
        return tx
          .select({ seq: enterpriseRunEvents.seq })
          .from(enterpriseRunEvents);
      });
      expect(wrongTenant).toHaveLength(0);
    });

    test("platform events dedupe by source id only when the attempt is null", async () => {
      await ownerDatabase.insert(enterpriseRunEvents).values({
        tenantId: TENANT_A,
        runId: RUN_A,
        eventId: "r1b-event-platform-1",
        seq: BigInt(2),
        attemptId: null,
        turnId: null,
        sourceEventId: "r1b-src-platform",
        sourceDigest: "p1".repeat(32),
        eventType: "WORKFLOW_STARTED",
        schemaVersion: "1",
        payload: {},
        occurredAt: new Date(),
      });
      const error = await rejectionOf(() =>
        ownerDatabase.insert(enterpriseRunEvents).values({
          tenantId: TENANT_A,
          runId: RUN_A,
          eventId: "r1b-event-platform-2",
          seq: BigInt(3),
          attemptId: null,
          turnId: null,
          sourceEventId: "r1b-src-platform",
          sourceDigest: "p1".repeat(32),
          eventType: "WORKFLOW_STARTED",
          schemaVersion: "1",
          payload: {},
          occurredAt: new Date(),
        }),
      );
      expect(error.code).toBe("23505");
      expect(error.message).toContain("enterprise_platform_event_source");
    });

    test("a model-audience capability without a logical call is refused", async () => {
      const error = await rejectionOf(() =>
        ownerDatabase.insert(enterpriseCapabilities).values({
          tenantId: TENANT_A,
          id: "r1b-cap-model-nocall",
          tokenHash: "h2".repeat(32),
          serviceId: "r1b-service",
          audience: "model",
          envelopeDigest: "n2".repeat(32),
          runId: RUN_A,
          attemptId: ATTEMPT_A,
          leaseId: "r1b-lease-1",
          fencingToken: BigInt(1),
          logicalCallId: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
      expect(error.code).toBe("23514");
      expect(error.message).toContain("enterprise_capability_model_call");
    });

    test("the dispatcher reads only the redacted outbox, never inputs, events or hashes", async () => {
      const outbox = await dispatcherDatabase
        .select({ id: enterpriseRunOutbox.id })
        .from(enterpriseRunOutbox);
      expect(outbox.map((row) => row.id)).toEqual(["r1b-outbox-a"]);

      /* 固定字面量探针（计划 306 行：dispatcher 不能读输入），每个都是独立常量。 */
      const runInput = await rejectionOf(() =>
        dispatcherDatabase.$client.unsafe(
          "select input_text from enterprise_runs",
        ),
      );
      expect(runInput.code).toBe("42501");
      const messageBody = await rejectionOf(() =>
        dispatcherDatabase.$client.unsafe(
          "select content_ref from enterprise_run_messages",
        ),
      );
      expect(messageBody.code).toBe("42501");
      const eventPayload = await rejectionOf(() =>
        dispatcherDatabase.$client.unsafe(
          "select payload from enterprise_run_events",
        ),
      );
      expect(eventPayload.code).toBe("42501");
      const capabilityHash = await rejectionOf(() =>
        dispatcherDatabase.$client.unsafe(
          "select token_hash from enterprise_capabilities",
        ),
      );
      expect(capabilityHash.code).toBe("42501");

      await dispatcherDatabase
        .update(enterpriseRunOutbox)
        .set({ status: "claimed", claimToken: "r1b-claim-1" })
        .where(eq(enterpriseRunOutbox.id, "r1b-outbox-a"));
    });

    test("the legacy data role cannot write the ledger", async () => {
      const error = await rejectionOf(() =>
        dataDatabase.insert(enterpriseRuns).values(
          runRow({
            tenantId: TENANT_A,
            id: "r1b-run-data",
            ownerPrincipalId: PRINCIPAL_A,
            workspaceId: WORKSPACE_A,
            threadId: THREAD_A,
            releaseId: RELEASE_A,
            requestKey: "req-data",
            budgetReservationId: "r1b-res-data",
          }),
        ),
      );
      expect(error.code).toBe("42501");
      expect(error.message).toContain("permission denied for table");
      expect(error.message).toContain("enterprise_runs");
    });

    test("the maintenance role cannot read the input column but can converge state", async () => {
      /* 列级 SELECT 清单里没有 input_text：整行与单列两种读法都拒绝。 */
      const starError = await rejectionOf(() =>
        maintenanceDatabase.$client.unsafe("select * from enterprise_runs"),
      );
      expect(starError.code).toBe("42501");
      expect(starError.message).toContain("input_text");

      const inputError = await rejectionOf(() =>
        maintenanceDatabase.$client.unsafe(
          "select input_text from enterprise_runs",
        ),
      );
      expect(inputError.code).toBe("42501");
      expect(inputError.message).toContain("input_text");

      const ids = await maintenanceDatabase.transaction(async (tx) => {
        await tx.execute(maintenanceContextA);
        return tx.select({ id: enterpriseRuns.id }).from(enterpriseRuns);
      });
      expect(ids.map((row) => row.id)).toContain(RUN_A);
    });

    test("audit goes to the security log, not to message bodies", async () => {
      await maintenanceDatabase.transaction(async (tx) => {
        await tx.execute(maintenanceContextA);
        await tx.insert(enterpriseSecurityEvents).values({
          tenantId: TENANT_A,
          id: "r1b-maintenance-audit",
          operationId: "r1b-maintenance-audit",
          actor: "ob_ent_run_maintenance",
          kind: "run.lost_detected",
          details: { runId: RUN_A },
        });
      });
    });

    test("bigint counters round-trip as bigint, never as number", async () => {
      const rows = await ownerDatabase
        .select({
          revision: enterpriseRuns.revision,
          seq: enterpriseRunEvents.seq,
        })
        .from(enterpriseRuns)
        .innerJoin(
          enterpriseRunEvents,
          and(
            eq(enterpriseRunEvents.tenantId, enterpriseRuns.tenantId),
            eq(enterpriseRunEvents.runId, enterpriseRuns.id),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]?.revision).toBe("bigint");
      expect(typeof rows[0]?.seq).toBe("bigint");
      expect(rows[0]?.revision.toString()).toBe("1");
    });
  });

  void or;
}
