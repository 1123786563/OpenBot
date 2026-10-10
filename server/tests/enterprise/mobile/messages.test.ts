import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";
import {
  EnterpriseApiErrorSchema,
  type PersonalConversation,
  PersonalConversationSchema,
  type Submission,
  SubmissionSchema,
} from "../../../../shared/enterprise/mobile-schemas";
import type {
  CreateRun,
  RunView,
} from "../../../../shared/enterprise/run-contracts";
import { createDatabase } from "../../../src/db/client";
import {
  enterpriseChannels,
  enterpriseIdentityEvents,
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseResourceGrants,
  enterpriseResources,
  enterpriseSecurityEvents,
  enterpriseTenants,
  enterpriseWorkspaces,
  users,
} from "../../../src/db/schema";
import { createEnterpriseApp } from "../../../src/enterprise/app";
import { createResourceReader } from "../../../src/enterprise/authz/repository";
import { createAuthz } from "../../../src/enterprise/authz/service";
import type { Scope, Tx } from "../../../src/enterprise/contracts";
import { PAGE_LIMIT } from "../../../src/enterprise/conversations/service";
import { runRequestDigest, sha256 } from "../../../src/enterprise/runs/digest";
import { createDirectory } from "../../../src/enterprise/tenancy/directory";
import { createPrincipal } from "../../../src/enterprise/tenancy/identity";
import {
  createWorkspace,
  grantRead,
  provisionMember,
  revokeRead,
} from "../../../src/enterprise/tenancy/provision";
import { testDatabaseUrlFrom } from "../../support/database";

/*
 * C07 企业消息提交、历史与幂等核对 —— TDD 测试（plan.md §5.1/§5.2/§C07、
 * docs/superpowers/specs/enterprise-conversations-subsystem.md §3.2/§3.3、
 * enterprise-mobile-subsystem-specs-draft.md §74-§79）。
 *
 * 覆盖计划 §C07 第 1 步清单的九组断言：
 *  1) 同一 clientMessageId 两次提交 → 同一 Submission（同 message/run），仅一条用户
 *     消息、一个业务 Run、一个启动意图；
 *  2) 同键不同内容 → 409 SUBMISSION_CONFLICT；
 *  3) 断网后按 clientMessageId 核对（GET submissions）不创建新业务 Run；
 *  4) 并发同键 → 唯一约束保证只落一次；
 *  5) 提交后权限撤销 → 拒绝（read 撤权走真实 revokeRead；run 撤权为 fixture 级删行，
 *     如实标注）；
 *  6) 跨租户/未授权 channel → 403/404，无存在性泄漏；
 *  7) history 按 cursor 分页、顺序稳定、message/run 归属明确；
 *  8) 202 返回 Submission：accepted 字面 true，受理 ≠ 完成；
 *  9) 不信任客户端身份：伪造 principalId/tenantId 等字段被 strict schema 以 400 拒绝。
 *
 * 每个用例自足：凡需要既有 Submission 的用例先自行提交并以 202 建立前置——首跑红灯
 * 必须全部落在「消息路由缺失」类失败（404/状态不匹配），不得是守护错误或环境错误。
 *
 * ── fixture 级集成声明（必读）──────────────────────────────────────────────
 * Run/预算接缝按审计结论：runs/contracts.ts:44 的冻结签名 `RunService.create(scope,
 * key, request)` 是 scope 级、实现内部自管事务，冻结面没有接收外部 Tx 的创建变体，
 * 因此「消息事务内创建业务 Run」无法按现有冻结签名直接达成。本文件通过
 * createEnterpriseApp 的新增依赖 `messagesDatabase`（消息域自己的单写连接池）与
 * `messageSeams` 注入窄端口 fixture：
 *
 *   - messageSeams.createRunInTx(tx, { scope, key, request }) → RunView：
 *     RunService.create 的事务内变体替身。它按 0060 §2（0060:60-72）的
 *     「run↔reservation 同事务对」写入真实 enterprise_budget_reservations 行与
 *     enterprise_runs 行（两表互为 DEFERRABLE INITIALLY DEFERRED 外键，提交时结算），
 *     使消息域在同一 withTenant 事务内真实写入 enterprise_run_outbox 时通过外键与
 *     RLS（run_owner_write / run_reservation_write / run_owner_children，0060:96-130）。
 *     待 03 册提供 inTx 接缝后换真。
 *
 *   fixture 的两点刻意模拟，均如实标注、不冒充真实执行：
 *   a) run 行落为终态 'succeeded'：0060:76-78 的偏索引
 *      enterprise_thread_single_active_run（一个 thread 至多一个非终态 run）会挡住
 *      同一 Channel 的后续提交；终态模拟让同一 Channel 可累积多条消息以验证 history
 *      分页。因此「一个业务 Run」只断言行数与 id 绑定，不断言运行态；
 *   b) 编排启动（WorkflowStarter/dispatcher）并未发生：本文件不断言任何投递事实，
 *      启动意图仅断言 enterprise_run_outbox 的行存在、status 走默认 'pending'、
 *      payload_digest 等于冻结的 runRequestDigest（digest.ts:30-42）。
 *   「202 ≠ 完成」只钉在响应契约上（202 + accepted:true + 恰好三个字段）。
 *   本文件不宣称与 03 册实现集成通过；生产集成需与 03 册对齐补充 inTx 接缝。
 *
 * ── 契约口径 ──────────────────────────────────────────────────────────────
 * 消息 schema 目标形状由 conversations-subsystem §3.2 冻结给 C07：
 * SubmitMessage {clientMessageId≤128, text 1..16000, attachmentIds≤8} 与
 * Submission {messageId, runId, accepted: literal true}（.strict()）。shared/
 * enterprise/mobile-schemas.ts 中两者的现形状（{threadId,content}/{id,threadId,
 * status}）按该规格 §3.4 标注为「待修订」，由实现步修订；本文件以行为断言驱动该
 * 修订，响应经 SubmissionSchema 校验。
 * 「仅一条用户消息」的物理存储由实现选择（当前迁移无 Channel 级消息表），本文件以
 * 历史投影（该 messageId 在 history 全量游标走查中恰好出现一次）+ 同一
 * Submission.messageId 断言，不钉未冻结表名；「一个业务 Run」「一个启动意图」钉在
 * 冻结表 enterprise_runs（唯一索引 enterprise_run_request_key，0059:428）与
 * enterprise_run_outbox（0059:219-236）上。
 *
 * ── fixture 纪律 ──────────────────────────────────────────────────────────
 * 全部连接指向 TEST_DATABASE_URL 的隔离测试库（5434，禁碰应用库），t7m- 前缀幂等
 * 清理；行级断言一律排在路由断言之后（先 assert 状态码），缺路由时红灯保持「路由/
 * 服务缺失」类，绝不混成环境错误。语句文本模块常量、值只走 $n 参数。
 * 现状口径：C07 的消息路由/服务与 app 装配的 messageSeams/messagesDatabase 注入均
 * 未实现（首跑红灯应全部落在消息路由的 404/状态不匹配上）；createEnterpriseApp 收到
 * 的两个额外依赖键在实现步扩展 EnterpriseDependencies 前被运行时忽略（bun 不做类型
 * 检查，typecheck:enterprise 待实现步接线后恢复）。
 */

const PREFIX = "t7m-";
const TENANT_A = "t7m-tenant-a";
const TENANT_B = "t7m-tenant-b";
const TENANT_NAME_A = "T7M App Tenant A";
const TENANT_NAME_B = "T7M App Tenant B";
const USER_OWNER = "t7m-user-owner";
const USER_OTHER = "t7m-user-other";
const P_OWNER = "t7m-principal-owner"; // member of A and B
const P_OTHER = "t7m-principal-other"; // member of A only
const WS_A = "t7m-ws-a";
const WS_B = "t7m-ws-b";
const BOT_RW = "t7m-bot-rw"; // read + run for P_OWNER in A（主 Channel 用）
const BOT_OTHER = "t7m-bot-other"; // read granted to P_OTHER（无 run）
const BOT_RR = "t7m-bot-rr"; // read + run for P_OWNER in A（run 撤权专用）
const BOT_HP = "t7m-bot-hp"; // read + run for P_OWNER in A（history 专用）
const BOT_B = "t7m-bot-b"; // read + run for P_OWNER in tenant B
const OPERATOR = "t7m-operator";
const IDENTITY_OPERATOR = "t7m-idop";
const ORIGIN = "https://t7m.example";

const KEY_1 = "t7m-msg-1";
const TEXT_1 = "第一版正文：幂等提交基线";
const KEY_REPLAY = "t7m-msg-replay";
const TEXT_REPLAY = "重放用正文：同键同内容";
const KEY_CONFLICT = "t7m-msg-conflict";
const TEXT_CONFLICT = "冲突用正文：同键不同内容";
const KEY_CONC = "t7m-msg-conc";
const TEXT_CONC = "并发同键提交正文";
const KEY_FIND = "t7m-msg-find";
const TEXT_FIND = "断网核对正文";
const KEY_ISO = "t7m-msg-iso";
const TEXT_ISO = "越权探测前的基线正文";
const KEY_REVOKE = "t7m-msg-revoke";
const TEXT_REVOKE = "撤权重放正文";

function restrictedLoginUrl(variable: string): string {
  return testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env[variable] });
}

const ownerDatabase = createDatabase(
  testDatabaseUrlFrom({ TEST_DATABASE_URL: process.env.TEST_DATABASE_URL }),
  { max: 1 },
);
const identityOperatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_IDENTITY_OPERATOR_DATABASE_URL"),
  { max: 1 },
);
const operatorDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_OPERATOR_DATABASE_URL"),
  { max: 2 },
);
const directoryLoginDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DIRECTORY_DATABASE_URL"),
  { max: 2 },
);
/* C05 conversations 域的 data 连接池（已实现路径，保持 C05 原状）。 */
const dataDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_DATA_DATABASE_URL"),
  { max: 2 },
);
/*
 * 消息域自己的单写连接池：C07 的消息事务（用户消息 + 业务 Run + 预算预留 + 启动
 * Outbox 在同一事务）必须以 run_writer 身份运行——enterprise_runs/outbox/预算表的
 * GRANT 与 RLS 策略（0060 §5a）只授予 ob_ent_run_writer，且 0060:76-78 的单活动
 * run 约束与 run↔reservation 同事务对都要求写在 run 写者的连接上完成。
 */
const messagesDatabase = createDatabase(
  restrictedLoginUrl("ENTERPRISE_TEST_RUN_WRITER_DATABASE_URL"),
  { max: 2 },
);

/*
 * ── Run/预算接缝 fixture（fixture 级集成，见文件头声明）─────────────────────
 * 窄端口形状：createRunInTx(tx, { scope, key, request }) → RunView。
 * 记录每次调用以断言「业务 Run 创建只发生一次」（fixture 级断言，语义与 plan §C07
 * 验收一致：同键重放不重新执行）。
 */
type RunCreationSeamInput = {
  scope: Scope;
  /** 路由已按 IdempotencyKeySchema 校验的幂等键（此处即 clientMessageId）。 */
  key: string;
  /** 严格解析后的 CreateRun（shared/enterprise/run-contracts.ts:65-73）。 */
  request: CreateRun;
};
type RunCreationSeam = {
  createRunInTx(tx: Tx, input: RunCreationSeamInput): Promise<RunView>;
};

const runCreations: Array<RunCreationSeamInput & { runId: string }> = [];
let seamSequence = 0;

/* fixture 语句常量：值只走 $n 参数（store.ts 既定纪律）。 */
const FIXTURE_INSERT_RESERVATION = `
  insert into enterprise_budget_reservations
    (tenant_id, id, run_id, cap_micros, currency, period_id)
  values ($1, $2, $3, $4, $5, $6)`;
const FIXTURE_INSERT_RUN = `
  insert into enterprise_runs
    (tenant_id, id, owner_principal_id, actor_user_id, workspace_id, thread_id,
     release_id, initiator_kind, request_key, request_digest, input_text,
     model_route_ref, model_grant_revision, release_digest, policy_revision,
     budget_reservation_id, status, revision, latest_seq, current_fence)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20)`;

const runCreationSeam: RunCreationSeam = {
  async createRunInTx(tx, input) {
    seamSequence += 1;
    const ordinal = String(seamSequence).padStart(4, "0");
    const runId = `${PREFIX}fxrun-${ordinal}`;
    const reservationId = `${PREFIX}fxresv-${ordinal}`;
    /* RunView.thread_id 为必填（run-contracts.ts:80），与真实 createRun 同语义：请求未带
     * thread_id 时 mint 确定性 id（runs/service.ts:288-291）。现有用例的请求均带
     * thread_id（路由自频道推导，messages.test.ts:736 的断言），此分支不触发。 */
    const threadId = input.request.thread_id ?? `${PREFIX}fxthread-${ordinal}`;
    const requestDigest = runRequestDigest(input.request);
    /* 先 runs 后 reservations：run_owner_write 只看事务 GUC，而
     * run_reservation_write 的 WITH CHECK 实时 EXISTS 本事务的 runs 行
     * （0060:131-139）；runs→reservations 的 FK 是 DEFERRED，提交时结算
     * （0060:60-72 的同事务对）。 */
    await tx.unsafe(FIXTURE_INSERT_RUN, [
      input.scope.tenantId,
      runId,
      input.scope.principalId,
      input.scope.userId,
      input.request.workspace_id,
      threadId,
      input.request.expert_release_id,
      "user",
      input.key,
      requestDigest,
      input.request.input.text,
      `${PREFIX}fixture-route`,
      1,
      sha256(`${PREFIX}fixture-release`),
      "conversations-v1",
      reservationId,
      "succeeded" /* fixture 终态模拟，见文件头 a) */,
      1,
      0,
      1,
    ]);
    await tx.unsafe(FIXTURE_INSERT_RESERVATION, [
      input.scope.tenantId,
      reservationId,
      runId,
      "1000000000",
      "USD",
      `${PREFIX}period`,
    ]);
    runCreations.push({ ...input, runId });
    return {
      run_id: runId,
      thread_id: threadId,
      status: "succeeded",
      revision: "1",
      latest_seq: "0",
      reconciliation_required: false,
      reason_code: null,
    };
  },
};

let currentSession: { user: { id: string; email: string } } | null = null;
const sessionAuth = {
  handler: async () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => currentSession,
  },
};

const liveApp = createEnterpriseApp({
  auth: sessionAuth,
  directory: createDirectory(directoryLoginDatabase),
  resources: createResourceReader(dataDatabase, createAuthz()),
  authz: createAuthz(),
  conversationsDatabase: dataDatabase,
  /* C07 注入（实现步扩展 EnterpriseDependencies 前被运行时忽略，见文件头口径）： */
  messagesDatabase,
  messageSeams: runCreationSeam,
  allowedOrigins: new Set([ORIGIN]),
  authRoutes: new Set<string>(),
  logRedactedSecurityError: () => {},
  isDraining: () => false,
  ready: async () => true,
});

function asUser(userId: string | null): void {
  currentSession =
    userId === null
      ? null
      : { user: { id: userId, email: `${userId}@t7m.invalid` } };
}

let mainChannel: PersonalConversation | undefined;
let histChannel: PersonalConversation | undefined;
const histSubmissions = new Map<string, { messageId: string; runId: string }>();

function mainChannelOf(): PersonalConversation {
  if (mainChannel === undefined) {
    throw new Error("主 Channel 尚未创建");
  }
  return mainChannel;
}

const tenantHeader = (tenantId: string) => ({
  "x-openbot-tenant": tenantId,
});

async function get(path: string, tenantId: string): Promise<Response> {
  return await liveApp.request(path, { headers: tenantHeader(tenantId) });
}

async function post(
  path: string,
  body: unknown,
  tenantId: string,
  userId: string = USER_OWNER,
): Promise<Response> {
  asUser(userId);
  return await liveApp.request(path, {
    method: "POST",
    headers: {
      ...tenantHeader(tenantId),
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function postMessage(
  clientMessageId: string,
  text: string,
  options: {
    attachmentIds?: string[];
    channelId?: string;
    tenantId?: string;
    userId?: string;
  } = {},
): Promise<Response> {
  return await post(
    `/api/enterprise/v1/channels/${
      options.channelId ?? mainChannelOf().channelId
    }/messages`,
    {
      clientMessageId,
      text,
      attachmentIds: options.attachmentIds ?? [],
    },
    options.tenantId ?? TENANT_A,
    options.userId ?? USER_OWNER,
  );
}

async function getSubmission(
  clientMessageId: string,
  options: {
    channelId?: string;
    tenantId?: string;
    userId?: string;
  } = {},
): Promise<Response> {
  asUser(options.userId ?? USER_OWNER);
  return await get(
    `/api/enterprise/v1/channels/${
      options.channelId ?? mainChannelOf().channelId
    }/submissions/${clientMessageId}`,
    options.tenantId ?? TENANT_A,
  );
}

async function getHistory(
  options: {
    channelId?: string;
    tenantId?: string;
    userId?: string;
    cursor?: string | null;
  } = {},
): Promise<Response> {
  asUser(options.userId ?? USER_OWNER);
  const cursor = options.cursor ?? null;
  const suffix = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return await get(
    `/api/enterprise/v1/channels/${
      options.channelId ?? mainChannelOf().channelId
    }/history${suffix}`,
    options.tenantId ?? TENANT_A,
  );
}

/** 先断言状态码再解析：缺路由的红灯必须是状态不匹配，绝不是 JSON 解析错误。 */
async function jsonOf(
  response: Response,
  status: number,
  label: string,
): Promise<unknown> {
  expect(response.status, label).toBe(status);
  return await response.json();
}

/** 响应必须是冻结的 Submission 形状（messageId/runId/accepted:true，恰好三键）。 */
function expectSubmission(raw: unknown, label: string): Submission {
  const parsed = SubmissionSchema.safeParse(raw);
  expect(parsed.success, `${label}: ${JSON.stringify(raw)}`).toBe(true);
  if (!parsed.success) {
    throw new Error("unreachable: Submission 必须能按冻结 schema 解析");
  }
  const submission = parsed.data;
  expect(
    Object.keys(submission as object).sort(),
    `${label}: Submission 键集`,
  ).toEqual(["accepted", "messageId", "runId"]);
  expect(submission.accepted, `${label}: accepted 必须是字面 true`).toBe(true);
  return submission;
}

/** §3.3 错误信封：状态码先断言（红灯保持路由缺失类），再校验信封形状与 code。 */
async function expectError(
  response: Response,
  status: number,
  code: string,
): Promise<{ error: { code: string; request_id: string; summary: string } }> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as unknown;
  expect(Object.keys(body as object).sort()).toEqual(["error"]);
  const error = (body as { error: unknown }).error;
  expect(EnterpriseApiErrorSchema.safeParse(error).success).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  return body as {
    error: { code: string; request_id: string; summary: string };
  };
}

/* ── 冻结表行级事实（owner 超管连接，RLS 不适用；只在路由断言之后调用）──────── */

async function runRowsFor(
  tenantId: string,
  requestKey: string,
): Promise<Array<{ id: string; status: string }>> {
  return await ownerDatabase.$client.unsafe<{ id: string; status: string }[]>(
    `select id, status from enterprise_runs
      where tenant_id = $1 and owner_principal_id = $2 and request_key = $3
      order by id`,
    [tenantId, P_OWNER, requestKey],
  );
}

async function outboxRowsFor(
  tenantId: string,
  runId: string,
): Promise<
  Array<{ id: string; kind: string; payload_digest: string; status: string }>
> {
  return await ownerDatabase.$client.unsafe<
    Array<{ id: string; kind: string; payload_digest: string; status: string }>
  >(
    `select id, kind, payload_digest, status from enterprise_run_outbox
      where tenant_id = $1 and run_id = $2
      order by id`,
    [tenantId, runId],
  );
}

function creationCountFor(key: string): number {
  return runCreations.filter((creation) => creation.key === key).length;
}

function historyItemOf(item: unknown): { messageId: string; runId: string } {
  expect(
    item,
    `history item 必须是对象: ${JSON.stringify(item)}`,
  ).toBeInstanceOf(Object);
  const record = item as Record<string, unknown>;
  expect(
    typeof record.messageId,
    `history item 必须带 messageId 归属: ${JSON.stringify(item)}`,
  ).toBe("string");
  expect(
    typeof record.runId,
    `history item 必须带 runId 归属: ${JSON.stringify(item)}`,
  ).toBe("string");
  return {
    messageId: record.messageId as string,
    runId: record.runId as string,
  };
}

/* run↔reservation 互为 DEFERRABLE FK（0060:60-72）：清理必须在一个事务里同时删光，
 * 否则 autocommit 单语句在提交时违反对面外键。消息表（0063）引用 runs 与 channels，
 * 必须最先删。 */
async function cleanupRunLedger(): Promise<void> {
  await ownerDatabase.$client.begin(async (tx) => {
    await tx.unsafe(
      `delete from enterprise_channel_messages where tenant_id like $1`,
      [`${PREFIX}%`],
    );
    await tx.unsafe(
      `delete from enterprise_run_outbox where tenant_id like $1`,
      [`${PREFIX}%`],
    );
    await tx.unsafe(
      `delete from enterprise_run_messages where tenant_id like $1`,
      [`${PREFIX}%`],
    );
    await tx.unsafe(
      `delete from enterprise_budget_reservations where tenant_id like $1`,
      [`${PREFIX}%`],
    );
    await tx.unsafe(`delete from enterprise_runs where tenant_id like $1`, [
      `${PREFIX}%`,
    ]);
    /* 消息事务登记的 run 台账线程行（FK→workspaces，必须在 workspaces 清理前删）。 */
    await tx.unsafe(`delete from enterprise_threads where tenant_id like $1`, [
      `${PREFIX}%`,
    ]);
  });
}

beforeAll(async () => {
  await cleanupRunLedger();
  /* 幂等清理（外键顺序），与 conversations.test.ts 同纪律。 */
  await ownerDatabase
    .delete(enterpriseChannels)
    .where(like(enterpriseChannels.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseResourceGrants)
    .where(like(enterpriseResourceGrants.tenantId, `${PREFIX}%`));
  await ownerDatabase.$client.unsafe(
    `delete from enterprise_run_releases where tenant_id like $1`,
    [`${PREFIX}%`],
  );
  await ownerDatabase
    .delete(enterpriseResources)
    .where(like(enterpriseResources.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseWorkspaces)
    .where(like(enterpriseWorkspaces.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseSecurityEvents)
    .where(like(enterpriseSecurityEvents.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseMemberships)
    .where(like(enterpriseMemberships.tenantId, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseIdentityEvents)
    .where(like(enterpriseIdentityEvents.id, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterprisePrincipals)
    .where(like(enterprisePrincipals.id, `${PREFIX}%`));
  await ownerDatabase
    .delete(enterpriseTenants)
    .where(like(enterpriseTenants.id, `${PREFIX}%`));
  await ownerDatabase.delete(users).where(like(users.id, `${PREFIX}%`));

  await ownerDatabase
    .insert(users)
    .values([
      { id: USER_OWNER, email: `${USER_OWNER}@t7m.invalid` },
      { id: USER_OTHER, email: `${USER_OTHER}@t7m.invalid` },
    ])
    .onConflictDoNothing();

  await createPrincipal(identityOperatorDatabase, {
    principalId: P_OWNER,
    userId: USER_OWNER,
    operator: IDENTITY_OPERATOR,
    operationId: `${PREFIX}op-idp-owner`,
  });
  await createPrincipal(identityOperatorDatabase, {
    principalId: P_OTHER,
    userId: USER_OTHER,
    operator: IDENTITY_OPERATOR,
    operationId: `${PREFIX}op-idp-other`,
  });

  for (const [tenantId, tenantName, workspaceId] of [
    [TENANT_A, TENANT_NAME_A, WS_A],
    [TENANT_B, TENANT_NAME_B, WS_B],
  ] as const) {
    await provisionMember(operatorDatabase, {
      tenantId,
      tenantName,
      principalId: P_OWNER,
      userId: USER_OWNER,
      role: "member",
      operator: OPERATOR,
      operationId: `${PREFIX}op-open-owner-${tenantId}`,
    });
    await createWorkspace(operatorDatabase, {
      tenantId,
      workspaceId,
      name: `T7M Workspace ${tenantId}`,
      operator: OPERATOR,
      operationId: `${PREFIX}op-ws-${tenantId}`,
    });
  }
  await provisionMember(operatorDatabase, {
    tenantId: TENANT_A,
    tenantName: TENANT_NAME_A,
    principalId: P_OTHER,
    userId: USER_OTHER,
    role: "member",
    operator: OPERATOR,
    operationId: `${PREFIX}op-open-other-a`,
  });

  /* run 判定由租户策略修订裁决（conversations.test.ts 同款前置事实）。 */
  await ownerDatabase
    .update(enterpriseTenants)
    .set({ policyRevision: "conversations-v1" })
    .where(like(enterpriseTenants.id, `${PREFIX}%`));

  /* Bot 行：kind='bot' 的生产入口不在 C07（conversations-subsystem §11.6），
   * fixture 以 owner 直插资源行（与 C05 同款，如实标注）。 */
  await ownerDatabase.insert(enterpriseResources).values(
    (
      [
        [TENANT_A, BOT_RW, WS_A],
        [TENANT_A, BOT_OTHER, WS_A],
        [TENANT_A, BOT_RR, WS_A],
        [TENANT_A, BOT_HP, WS_A],
        [TENANT_B, BOT_B, WS_B],
      ] as const
    ).map(([tenantId, botId, workspaceId]) => ({
      tenantId,
      id: botId,
      workspaceId,
      kind: "bot",
    })),
  );

  /* 专家发布行：enterprise_runs.release_id 的复合 FK 目标（0059:83-102），
   * 按 03 的角色契约由 run_operator 离线供给；run_operator 的生产供给入口
   * 不在 C07，fixture 以 owner 直插（一 Bot 一发布，id=botId，如实标注）。 */
  await ownerDatabase.$client.unsafe(
    `insert into enterprise_run_releases
       (tenant_id, id, resource_id, version_digest, runtime_compatibility,
        expert_version, model_route_ref, input_limit_bytes, max_model_calls,
        max_run_micros, currency, tool_manifest_digest, tool_count)
     select r.tenant_id, r.id, r.id, 't7m-release-digest', 't7m-runtime',
            't7m-expert-v1', 't7m-fixture-route', 32768, 8, 1000000000, 'USD',
            't7m-tools-digest', 0
       from enterprise_resources r
      where r.tenant_id like $1 and r.kind = 'bot'
      order by r.tenant_id, r.id`,
    [`${PREFIX}%`],
  );

  for (const [tenantId, botId, principalId] of [
    [TENANT_A, BOT_RW, P_OWNER],
    [TENANT_A, BOT_OTHER, P_OTHER],
    [TENANT_A, BOT_RR, P_OWNER],
    [TENANT_A, BOT_HP, P_OWNER],
    [TENANT_B, BOT_B, P_OWNER],
  ] as const) {
    await grantRead(operatorDatabase, {
      tenantId,
      resourceId: botId,
      principalId,
      operator: OPERATOR,
      operationId: `${PREFIX}op-grant-${botId}`,
    });
  }
  /* run 授权行：0061:46/60 已将 enterprise_grant_action 放宽为 ('read','run')，
   * 直插即为生产同款行（C05 时代 CHECK 未放宽时的 23514 顾虑已解除）。 */
  for (const [tenantId, botId] of [
    [TENANT_A, BOT_RW],
    [TENANT_A, BOT_RR],
    [TENANT_A, BOT_HP],
    [TENANT_B, BOT_B],
  ] as const) {
    await ownerDatabase.$client.unsafe(
      `insert into enterprise_resource_grants (tenant_id, resource_id, principal_id, action)
       values ($1, $2, $3, 'run')`,
      [tenantId, botId, P_OWNER],
    );
  }

  /* 主 Channel（C05 已实现路径；若失败即为环境/C05 回归，按环境错误如实上报）。 */
  asUser(USER_OWNER);
  const created = await post(
    "/api/enterprise/v1/channels",
    { botId: BOT_RW, clientRequestId: `${PREFIX}chan-main` },
    TENANT_A,
  );
  expect(created.status).toBe(200);
  mainChannel = PersonalConversationSchema.parse(await created.json());

  /* history 专用 Channel。 */
  const histCreated = await post(
    "/api/enterprise/v1/channels",
    { botId: BOT_HP, clientRequestId: `${PREFIX}chan-hist` },
    TENANT_A,
  );
  expect(histCreated.status).toBe(200);
  histChannel = PersonalConversationSchema.parse(await histCreated.json());
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([
    ownerDatabase.$client.close(),
    identityOperatorDatabase.$client.close(),
    operatorDatabase.$client.close(),
    directoryLoginDatabase.$client.close(),
    dataDatabase.$client.close(),
    messagesDatabase.$client.close(),
  ]);
});

describe("C07 消息提交：202 受理、同键幂等与并发（案例 8/1/2/4）", () => {
  test("首次提交返回 202 与 Submission：accepted 字面 true；恰好一个业务 Run、一个启动意图、一条用户消息", async () => {
    asUser(USER_OWNER);
    const response = await postMessage(KEY_1, TEXT_1);
    expect(
      response.status,
      "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
    ).toBe(202);
    const submission = expectSubmission(await response.json(), "首次提交");
    expect(submission.messageId.length).toBeGreaterThan(0);
    expect(submission.runId.length).toBeGreaterThan(0);

    /* 业务 Run 创建意图恰好一次（fixture 级断言），且身份来自服务端 Scope。 */
    expect(creationCountFor(KEY_1)).toBe(1);
    const creation = runCreations.find((entry) => entry.key === KEY_1)!;
    expect(creation.scope.tenantId).toBe(TENANT_A);
    expect(creation.scope.principalId).toBe(P_OWNER);
    expect(creation.scope.userId).toBe(USER_OWNER);
    expect(creation.request.input.text).toBe(TEXT_1);
    expect(creation.request.thread_id).toBe(mainChannelOf().threadId);
    expect(creation.request.workspace_id).toBe(WS_A);

    /* 一个业务 Run：enterprise_runs 恰好一行，且 Submission.runId 绑定该行。 */
    const runs = await runRowsFor(TENANT_A, KEY_1);
    expect(runs).toHaveLength(1);
    expect(submission.runId).toBe(runs[0].id);

    /* 一个启动意图：outbox 恰好一行（启动 kind），status 走默认 pending，
     * payload_digest 与 Run 侧冻结 digest（runRequestDigest）一致。 */
    const outbox = await outboxRowsFor(TENANT_A, submission.runId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe("pending");
    expect(outbox[0].kind.length).toBeGreaterThan(0);
    expect(outbox[0].payload_digest).toBe(runRequestDigest(creation.request));

    /* 一条用户消息：history 投影中该 messageId 恰好出现一次，run 归属明确。 */
    const history = await getHistory();
    expect(
      history.status,
      "C07 history 路由未实现（GET /api/enterprise/v1/channels/:id/history）",
    ).toBe(200);
    const page = (await history.json()) as {
      items: unknown[];
      nextCursor: unknown;
    };
    expect(Object.keys(page).sort()).toEqual(["items", "nextCursor"]);
    const items = page.items.map(historyItemOf);
    expect(items).toHaveLength(1);
    expect(items[0].messageId).toBe(submission.messageId);
    expect(items[0].runId).toBe(submission.runId);
  });

  test("同一 clientMessageId 重放返回同一 Submission，不新增消息/业务 Run/启动意图", async () => {
    asUser(USER_OWNER);
    const first = expectSubmission(
      await jsonOf(
        await postMessage(KEY_REPLAY, TEXT_REPLAY),
        202,
        "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
      ),
      "重放基线首次提交",
    );
    const creationsAfterFirst = runCreations.length;
    const outboxBefore = await outboxRowsFor(TENANT_A, first.runId);

    const response = await postMessage(KEY_REPLAY, TEXT_REPLAY);
    expect(
      response.status,
      "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
    ).toBe(202);
    const replayed = expectSubmission(await response.json(), "同键重放");
    expect(replayed).toEqual(first);

    expect(creationCountFor(KEY_REPLAY)).toBe(1);
    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, KEY_REPLAY)).toHaveLength(1);
    expect(await outboxRowsFor(TENANT_A, first.runId)).toEqual(outboxBefore);
  });

  test("同键不同内容（text 或 attachmentIds 变化）是 409 SUBMISSION_CONFLICT，不产生新副作用", async () => {
    asUser(USER_OWNER);
    const first = expectSubmission(
      await jsonOf(
        await postMessage(KEY_CONFLICT, TEXT_CONFLICT),
        202,
        "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
      ),
      "冲突基线首次提交",
    );
    const creationsAfterFirst = runCreations.length;

    await expectError(
      await postMessage(KEY_CONFLICT, "完全不同的正文"),
      409,
      "SUBMISSION_CONFLICT",
    );
    await expectError(
      await postMessage(KEY_CONFLICT, TEXT_CONFLICT, {
        attachmentIds: ["t7m-attach-1"],
      }),
      409,
      "SUBMISSION_CONFLICT",
    );

    expect(creationCountFor(KEY_CONFLICT)).toBe(1);
    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, KEY_CONFLICT)).toHaveLength(1);
    expect(await outboxRowsFor(TENANT_A, first.runId)).toHaveLength(1);
  });

  test("并发同键提交只落一次：全部 202 且读回同一 Submission，Run/启动意图各恰一", async () => {
    asUser(USER_OWNER);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => postMessage(KEY_CONC, TEXT_CONC)),
    );
    for (const response of responses) {
      expect(
        response.status,
        "并发同键提交必须全部 202（约束保证只落一次）",
      ).toBe(202);
    }
    const bodies = await Promise.all(
      responses.map((response) => response.json()),
    );
    const submissions = bodies.map((body) =>
      expectSubmission(body, "并发同键"),
    );
    expect(new Set(submissions.map((s) => JSON.stringify(s))).size).toBe(1);

    const concurrent = submissions[0];
    expect(creationCountFor(KEY_CONC)).toBe(1);
    const runs = await runRowsFor(TENANT_A, KEY_CONC);
    expect(runs).toHaveLength(1);
    expect(concurrent.runId).toBe(runs[0].id);
    expect(await outboxRowsFor(TENANT_A, concurrent.runId)).toHaveLength(1);
  });
});

describe("C07 消息核对、边界与撤权（案例 3/6/9/5）", () => {
  test("断网核对 GET submissions/:clientMessageId 读回原 Submission，不创建新业务 Run；未知键是封闭 404", async () => {
    asUser(USER_OWNER);
    const first = expectSubmission(
      await jsonOf(
        await postMessage(KEY_FIND, TEXT_FIND),
        202,
        "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
      ),
      "核对基线首次提交",
    );
    const creationsAfterFirst = runCreations.length;

    const found = await getSubmission(KEY_FIND);
    expect(
      found.status,
      "C07 提交核对路由未实现（GET /channels/:id/submissions/:clientMessageId）",
    ).toBe(200);
    expect(expectSubmission(await found.json(), "断网核对")).toEqual(first);

    expect(creationCountFor(KEY_FIND)).toBe(1);
    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, KEY_FIND)).toHaveLength(1);
    expect(await outboxRowsFor(TENANT_A, first.runId)).toHaveLength(1);

    const missing = await getSubmission("t7m-msg-unknown");
    const body = await expectError(missing, 404, "RESOURCE_NOT_FOUND");
    const text = JSON.stringify(body);
    expect(text).not.toContain(first.messageId);
    expect(text).not.toContain(first.runId);
    expect(text).not.toContain(mainChannelOf().channelId);
    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, "t7m-msg-unknown")).toHaveLength(0);
  });

  test("非 owner 与跨租户的提交/核对/历史一律 404/403 且无存在性泄漏", async () => {
    /* 先以 owner 建立一条真实提交作为不可泄漏的既有事实。 */
    asUser(USER_OWNER);
    const isolated = expectSubmission(
      await jsonOf(
        await postMessage(KEY_ISO, TEXT_ISO),
        202,
        "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
      ),
      "越权探测基线提交",
    );
    const creationsAfterFirst = runCreations.length;
    const channelId = mainChannelOf().channelId;
    const secrets = [
      channelId,
      mainChannelOf().threadId,
      isolated.messageId,
      isolated.runId,
      BOT_RW,
      P_OWNER,
    ];

    /* 同租户非 owner：closed 404，三个端点一致。 */
    asUser(USER_OTHER);
    for (const [label, response] of [
      [
        "非 owner 提交",
        await postMessage("t7m-msg-other", "越权正文", {
          channelId,
          userId: USER_OTHER,
        }),
      ],
      [
        "非 owner 核对",
        await getSubmission(KEY_ISO, { channelId, userId: USER_OTHER }),
      ],
      ["非 owner 历史", await getHistory({ channelId, userId: USER_OTHER })],
    ] as const) {
      const body = await expectError(response, 404, "RESOURCE_NOT_FOUND");
      const text = JSON.stringify(body);
      for (const secret of secrets) {
        expect(text, `${label} 泄漏检查`).not.toContain(secret);
      }
    }

    /* owner 选了另一租户：Channel 不在所选租户，同一 closed 404。 */
    asUser(USER_OWNER);
    for (const [label, response] of [
      [
        "跨租户提交",
        await postMessage("t7m-msg-xt", "跨租户正文", {
          channelId,
          tenantId: TENANT_B,
        }),
      ],
      [
        "跨租户核对",
        await getSubmission(KEY_ISO, { channelId, tenantId: TENANT_B }),
      ],
      ["跨租户历史", await getHistory({ channelId, tenantId: TENANT_B })],
    ] as const) {
      const body = await expectError(response, 404, "RESOURCE_NOT_FOUND");
      const text = JSON.stringify(body);
      for (const secret of secrets) {
        expect(text, `${label} 泄漏检查`).not.toContain(secret);
      }
    }

    /* 非成员租户：scope 中间件 403，无资源应答。 */
    await expectError(
      await postMessage("t7m-msg-zz", "非成员租户", {
        channelId,
        tenantId: "t7m-tenant-zz",
      }),
      403,
      "TENANT_FORBIDDEN",
    );

    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, "t7m-msg-other")).toHaveLength(0);
    expect(await runRowsFor(TENANT_A, "t7m-msg-xt")).toHaveLength(0);
  });

  test("客户端伪造 principalId/tenantId 等身份与服务端字段被 strict schema 以 400 拒绝，不产生任何行", async () => {
    asUser(USER_OWNER);
    const creationsBefore = runCreations.length;
    for (const extra of [
      "principalId",
      "tenantId",
      "userId",
      "scope",
      "token",
      "status",
      "runId",
      "messageId",
    ]) {
      const body: Record<string, unknown> = {
        clientMessageId: `${PREFIX}forge-${extra}`,
        text: "伪造身份探测",
        attachmentIds: [],
      };
      body[extra] = "t7m-forged-value";
      const response = await post(
        `/api/enterprise/v1/channels/${mainChannelOf().channelId}/messages`,
        body,
        TENANT_A,
      );
      expect(response.status, `伪造字段 ${extra} 必须 400`).toBe(400);
      const parsed = (await response.json()) as unknown;
      expect(
        EnterpriseApiErrorSchema.safeParse((parsed as { error: unknown }).error)
          .success,
        `伪造字段 ${extra} 的错误信封`,
      ).toBe(true);
      expect(
        await runRowsFor(TENANT_A, body.clientMessageId as string),
      ).toHaveLength(0);
    }
    expect(runCreations.length).toBe(creationsBefore);

    /* 冻结边界（conversations-subsystem §3.2）：text 1..16000、clientMessageId ≤128。 */
    for (const body of [
      {
        clientMessageId: "t7m-blank-text",
        text: "",
        attachmentIds: [] as string[],
      },
      {
        clientMessageId: "t7m-long-text",
        text: "字".repeat(16001),
        attachmentIds: [] as string[],
      },
      {
        clientMessageId: "k".repeat(129),
        text: "超长幂等键",
        attachmentIds: [] as string[],
      },
      { clientMessageId: "", text: "空幂等键", attachmentIds: [] as string[] },
    ]) {
      const response = await post(
        `/api/enterprise/v1/channels/${mainChannelOf().channelId}/messages`,
        body,
        TENANT_A,
      );
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(runCreations.length).toBe(creationsBefore);
  });

  test("提交后撤销 read 授权：重放/核对/历史即刻关闭（404），不产生新副作用", async () => {
    asUser(USER_OWNER);
    const first = expectSubmission(
      await jsonOf(
        await postMessage(KEY_REVOKE, TEXT_REVOKE),
        202,
        "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
      ),
      "撤权基线首次提交",
    );
    const creationsAfterFirst = runCreations.length;
    const outboxBefore = await outboxRowsFor(TENANT_A, first.runId);

    /* 真实撤权路径（审计 + ACL epoch bump）：冻结语义要求重放在事务内重跑授权，
     * 缓存命中永不绕过撤权（runs/contracts.ts:38-43）。 */
    await revokeRead(operatorDatabase, {
      tenantId: TENANT_A,
      resourceId: BOT_RW,
      principalId: P_OWNER,
      operator: OPERATOR,
      operationId: `${PREFIX}op-revoke-rw`,
    });

    await expectError(
      await postMessage(KEY_REVOKE, TEXT_REVOKE),
      404,
      "RESOURCE_NOT_FOUND",
    );
    await expectError(
      await getSubmission(KEY_REVOKE),
      404,
      "RESOURCE_NOT_FOUND",
    );
    await expectError(await getHistory(), 404, "RESOURCE_NOT_FOUND");

    expect(creationCountFor(KEY_REVOKE)).toBe(1);
    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, KEY_REVOKE)).toHaveLength(1);
    expect(await outboxRowsFor(TENANT_A, first.runId)).toEqual(outboxBefore);
  });

  test("撤销 run 授权（fixture 级删除 run grant 行）后，新提交被 403 拒绝且不产生任何行", async () => {
    asUser(USER_OWNER);
    /* 专用 Bot/Channel，撤权不污染其他用例。run grant 行本身是 fixture 直插的
     * （生产无 run 授予函数，C05 同款标注），撤权以同级别直删模拟，如实标注。 */
    const rrCreated = await post(
      "/api/enterprise/v1/channels",
      { botId: BOT_RR, clientRequestId: `${PREFIX}chan-rr` },
      TENANT_A,
    );
    expect(rrCreated.status).toBe(200);
    const rrChannel = PersonalConversationSchema.parse(await rrCreated.json());

    const ok = await postMessage("t7m-msg-rr-1", "撤权前的正常提交", {
      channelId: rrChannel.channelId,
    });
    expect(
      ok.status,
      "C07 消息提交路由未实现（POST /api/enterprise/v1/channels/:id/messages）",
    ).toBe(202);
    const rrSubmission = expectSubmission(await ok.json(), "run 撤权前提交");
    const creationsAfterFirst = runCreations.length;

    await ownerDatabase.$client.unsafe(
      `delete from enterprise_resource_grants
        where tenant_id = $1 and resource_id = $2 and principal_id = $3 and action = 'run'`,
      [TENANT_A, BOT_RR, P_OWNER],
    );

    await expectError(
      await postMessage("t7m-msg-rr-2", "撤权后的新提交", {
        channelId: rrChannel.channelId,
      }),
      403,
      "TENANT_FORBIDDEN",
    );
    expect(runCreations.length).toBe(creationsAfterFirst);
    expect(await runRowsFor(TENANT_A, "t7m-msg-rr-2")).toHaveLength(0);
    expect(await runRowsFor(TENANT_A, "t7m-msg-rr-1")).toHaveLength(1);
    expect(rrSubmission.accepted).toBe(true);
  });
});

describe("C07 历史：cursor 分页、稳定顺序、message/run 归属（案例 7）", () => {
  const HIST_TOTAL = PAGE_LIMIT + 1;

  test(`准备 ${PAGE_LIMIT}+1 条消息全部 202 受理（fixture 终态模拟释放单活动 run 名额）`, async () => {
    asUser(USER_OWNER);
    expect(histChannel).toBeDefined();
    for (let index = 0; index < HIST_TOTAL; index += 1) {
      const clientMessageId = `${PREFIX}hist-${String(index).padStart(3, "0")}`;
      const response = await postMessage(
        clientMessageId,
        `history 分页正文 ${index}`,
        {
          channelId: histChannel!.channelId,
        },
      );
      expect(response.status, `第 ${index} 条提交`).toBe(202);
      const submission = expectSubmission(
        await response.json(),
        `第 ${index} 条`,
      );
      histSubmissions.set(clientMessageId, {
        messageId: submission.messageId,
        runId: submission.runId,
      });
    }
    expect(histSubmissions.size).toBe(HIST_TOTAL);
    expect(creationCountFor(`${PREFIX}hist-000`)).toBe(1);
  }, 120_000);

  test("history 按 cursor 分页走全：跨页覆盖不重不漏、message/run 归属逐一对应、重复读取字节稳定", async () => {
    asUser(USER_OWNER);
    expect(
      histSubmissions.size,
      "前置用例未完成 51 条消息准备（上一用例红灯的级联）",
    ).toBe(HIST_TOTAL);

    /* 游标走查必须终止（封顶迭代防御死循环）。 */
    const pages: Array<Array<{ messageId: string; runId: string }>> = [];
    const rawPages: Array<unknown> = [];
    let cursor: string | null = null;
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const response = await getHistory({
        channelId: histChannel!.channelId,
        cursor,
      });
      expect(response.status, `第 ${iteration} 页`).toBe(200);
      const body = (await response.json()) as unknown;
      expect(Object.keys(body as object).sort()).toEqual([
        "items",
        "nextCursor",
      ]);
      const page = body as { items: unknown[]; nextCursor: string | null };
      pages.push(page.items.map(historyItemOf));
      rawPages.push(body);
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }
    expect(cursor, "游标走查必须以 nextCursor=null 结束").toBeNull();

    /* PAGE_LIMIT+1 条 → 恰好两页：首页 PAGE_LIMIT 条且还有下一页。 */
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(PAGE_LIMIT);
    expect(pages[1].length).toBeGreaterThan(0);

    /* 不重不漏 + message/run 归属逐一对应提交事实。 */
    const flat = pages.flat();
    expect(flat).toHaveLength(HIST_TOTAL);
    const byMessageId = new Map(
      flat.map((item) => [item.messageId, item.runId]),
    );
    expect(byMessageId.size).toBe(HIST_TOTAL);
    for (const [clientMessageId, expected] of histSubmissions) {
      expect(
        byMessageId.get(expected.messageId),
        `归属 ${clientMessageId}`,
      ).toBe(expected.runId);
    }

    /* 稳定顺序：两次独立读取字节一致（信封与条目序均稳定）。 */
    const firstPage = await getHistory({ channelId: histChannel!.channelId });
    expect(firstPage.status).toBe(200);
    expect(JSON.stringify(await firstPage.json())).toBe(
      JSON.stringify(rawPages[0]),
    );
    const secondPage = await getHistory({
      channelId: histChannel!.channelId,
      cursor: (rawPages[0] as { nextCursor: string }).nextCursor,
    });
    expect(secondPage.status).toBe(200);
    expect(JSON.stringify(await secondPage.json())).toBe(
      JSON.stringify(rawPages[1]),
    );
  });
});
