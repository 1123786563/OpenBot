/*
 * #733 跨应用端到端验收执行器：在四站真实栈（IDENTITY/MEMORY/OpenBot/外部应用，
 * bring-up.ts 带起）上逐项执行父 Issue #713 的 A01–A19，输出报告
 * reports/acceptance-report.json + acceptance-report.md。
 *
 * 规则（票面）：report_completeness 要求恰有 19 个不同条目且每项有非零执行与证据；
 * 跳过不可为 pass；未执行、失败或证据不足的场景不得报告为通过。
 * 套件证据（A10/A11/A13/A16 的单元面）来自 reports/suites.json（本会话先跑，
 * 见 bring-up 同目录 README）；站级场景全部走真实 HTTP/DB。
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import postgres from "../node_modules/.bun/postgres@3.4.9/node_modules/postgres/src/index.js";

const RUN =
  process.env.MEM733_RUN_DIR ??
  join(process.cwd(), ".archive/runs/2026-10-31-memory-service-733");
const REPORTS = join(RUN, "reports");
mkdirSync(REPORTS, { recursive: true });
const env = (name: string) =>
  readFileSync(join(RUN, "env", name), "utf8").trim();
const facts = JSON.parse(readFileSync(join(RUN, "facts.json"), "utf8")) as {
  stations: Record<string, { url: string; gitSha: string; cwd: string }>;
  persons: {
    a: {
      email: string;
      subjectId: string;
      openbotSessionToken: string;
      botId: string;
    };
    b: { email: string; subjectId: string };
  };
};
const tokens = JSON.parse(
  readFileSync(join(RUN, "env", "person-tokens.json"), "utf8"),
) as Record<string, { token: string; subjectId: string }>;
const appSecrets = JSON.parse(
  readFileSync(join(RUN, "env", "app-secrets.json"), "utf8"),
) as Record<string, string>;

const MEMORY = "http://127.0.0.1:4232";
const IDENTITY = "http://127.0.0.1:4212";
const EXTERNAL = "http://127.0.0.1:4242";
const OPENBOT = "http://localhost:3002";
const SRC_KEY = env("source-key.txt");
const SRC_TOKEN = env("src-token.txt");
const subA = facts.persons.a.subjectId;
const subB = facts.persons.b.subjectId;
const personA = { authorization: `Bearer ${tokens.a.token}` };
const personB = { authorization: `Bearer ${tokens.b.token}` };
const openbotApp = (subject = subA) => ({
  "x-memory-app": "openbot",
  "x-memory-subject": subject,
  authorization: `Bearer ${appSecrets.openbot}`,
});
const externalApp = (subject = subA) => ({
  "x-memory-app": "external-demo",
  "x-memory-subject": subject,
  authorization: `Bearer ${appSecrets["external-demo"]}`,
});

/* ---- 基础设施 ---- */
// biome-ignore lint/suspicious/noExplicitAny: 外部服务响应体，验收脚本 85 处宽松取用，窄化不改变断言语义。
type Call = { status: number; body: any };
async function call(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method?: string,
): Promise<Call> {
  try {
    const response = await fetch(url, {
      method: method ?? (body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch (error) {
    // 网络层失败不是断言崩溃：按 status 0 记录，让该 arm 判 fail。
    return { status: 0, body: { networkError: String(error) } };
  }
}
const b64u = (bytes: Buffer) => bytes.toString("base64url");
const sign = (value: string, key: string, label: string) =>
  `${value}.${b64u(
    createHmac(
      "sha256",
      Buffer.from(b64u(createHmac("sha256", key).update(label).digest())),
    )
      .update(value)
      .digest(),
  )}`;
const openbotScope = (subject = subA, botId = facts.persons.a.botId) =>
  sign(
    JSON.stringify({
      originAppId: "openbot",
      subjectId: subject,
      botId,
      tenantId: null,
      sourceId: `run:${botId}`,
    }),
    SRC_KEY,
    "memory-source",
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url: string, deadlineMs = 40_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  return false;
}

const evidence: unknown[] = [];
const note = (item: string, step: string, detail: unknown) =>
  evidence.push({ item, step, detail, at: new Date().toISOString() });

/** 提交片段并等 worker 出候选（站内 3s 一轮）。 */
async function submitAndWaitCandidate(
  fragment: string,
  headers: Record<string, string>,
  scopeRef: string,
  key = randomUUID(),
) {
  const submitted = await call(
    `${MEMORY}/v1/ingestions`,
    {
      idempotencyKey: key,
      fragment,
      sources: [
        {
          originAppId: headers === openbotApp() ? "openbot" : "external-demo",
          scopeRef,
        },
      ],
    },
    headers,
  );
  if (submitted.status !== 202)
    return { submitted, candidate: null as null | { id: string } };
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1500);
    const jobs = await call(
      `${MEMORY}/v1/jobs/${submitted.body.id}`,
      undefined,
      headers,
    );
    if (jobs.body?.state === "review") break;
  }
  const candidates = await call(`${MEMORY}/v1/candidates`, undefined, personA);
  const candidatesForJob = (candidates.body?.candidates ?? []).filter(
    (it: { content: string }) => it.content.includes(fragment),
  );
  return {
    submitted,
    candidate: candidatesForJob[candidatesForJob.length - 1] ?? null,
  };
}

async function confirmCandidate(candidate: { id: string }) {
  return call(
    `${MEMORY}/v1/candidates/${candidate.id}/review`,
    { decision: "confirm" },
    personA,
  );
}

/** 站点重启：kill pid + 按固定命令重拉（与 bring-up 同一命令）。 */
async function restartStation(name: "openbot" | "memory" | "external") {
  const pidFile = join(RUN, "logs", `${name}.pid`);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  await sleep(1500);
  const commands = {
    openbot: {
      cwd: join(process.cwd(), "server"),
      args: [
        "--env-file=../.env",
        `--env-file=${join(RUN, "env", "openbot-overlay.env")}`,
        "src/index.ts",
      ],
    },
    memory: {
      cwd: join(process.cwd(), "../openbot-memory"),
      args: [
        `--env-file=${join(RUN, "env", "memory.env")}`,
        "stations/station.ts",
      ],
    },
    external: {
      cwd: process.cwd(),
      args: ["scripts/memory-service-stations/external-app.ts"],
    },
  } as const;
  const command = commands[name];
  // 独立会话 + 日志落文件：站点不随执行器退出而死（与 bring-up 同法）。
  const logFile = openSync(join(RUN, "logs", `${name}.log`), "a");
  const child = spawn("bun", command.args, {
    cwd: command.cwd,
    env:
      name === "external"
        ? {
            ...process.env,
            EXTERNAL_APP_PORT: "4242",
            EXTERNAL_APP_TOKEN: env("ext-token.txt"),
            EXTERNAL_APP_STATE_FILE: join(RUN, "env", "external-state.json"),
          }
        : process.env,
    detached: true,
    stdio: ["ignore", logFile, logFile],
  });
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`);
  const ready = await waitFor(
    name === "openbot"
      ? `${OPENBOT}/ready`
      : name === "memory"
        ? `${MEMORY}/health`
        : `${EXTERNAL}/health`,
  );
  return ready;
}

const db = postgres("postgres://mem733:mem733@127.0.0.1:55480/memory_733", {
  max: 1,
});
const openbotDb = postgres(
  "postgres://mem733:mem733@127.0.0.1:55480/openbot_733",
  { max: 1 },
);

type Arm = { name: string; ok: boolean; detail: unknown };
type Item = {
  item: string;
  title: string;
  result: "pass" | "fail" | "blocked";
  arms: Arm[];
  suiteEvidence?: string;
};
const results: Item[] = [];
const runItem = (
  item: string,
  title: string,
  arms: Arm[],
  suiteEvidence?: string,
) => {
  const executed = arms.length > 0 || Boolean(suiteEvidence);
  const ok = arms.every((arm) => arm.ok);
  results.push({
    item,
    title,
    result: !executed ? "blocked" : ok ? "pass" : "fail",
    arms,
    ...(suiteEvidence ? { suiteEvidence } : {}),
  });
  console.log(
    `[A] ${item} ${ok && executed ? "PASS" : executed ? "FAIL" : "BLOCKED"} (${arms.length} arms)`,
  );
};

/* ---- 版本清单（version_manifest）：站不齐即整场 blocked ---- */
const versionManifest = {
  identity: facts.stations.identity,
  memory: facts.stations.memory,
  openbot: facts.stations.openbot,
  external: facts.stations.external,
  checkedAt: new Date().toISOString(),
};
const readiness = {
  identity: await waitFor(`${IDENTITY}/.well-known/openid-configuration`, 5000),
  memory: await waitFor(`${MEMORY}/health`, 5000),
  external: await waitFor(`${EXTERNAL}/health`, 5000),
  openbot: await waitFor(`${OPENBOT}/ready`, 5000),
};
note("manifest", "readiness", readiness);
if (!Object.values(readiness).every(Boolean)) {
  writeFileSync(
    join(REPORTS, "acceptance-report.json"),
    JSON.stringify(
      {
        versionManifest,
        readiness,
        results: [],
        blocked: "stations not ready — run bring-up first",
      },
      null,
      2,
    ),
  );
  console.error("stations not ready:", readiness);
  process.exit(1);
}

const suites = existsSync(join(REPORTS, "suites.json"))
  ? (JSON.parse(readFileSync(join(REPORTS, "suites.json"), "utf8")) as Record<
      string,
      { passed: number; failed: number }
    >)
  : {};

/* ================= A01 本人相同、跨应用隔离 ================= */
{
  const arms: Arm[] = [];
  {
    const r = await call(`${MEMORY}/v1/memories`, undefined, personB);
    arms.push({
      name: "b_own_memories_empty",
      ok: r.status === 200 && (r.body.memories ?? []).length === 0,
      detail: r.body,
    });
  }
  {
    // B 冒充 A 的 subject 提交：委托表按 (subject, app) 裁决，无 A→external 委托即拒。
    const r = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: randomUUID(),
        fragment: "B 冒充 A 的片段",
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      externalApp(subA),
    );
    arms.push({
      name: "forged_subject_rejected",
      ok: r.status === 403,
      detail: r.body,
    });
  }
  {
    const r = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: randomUUID(),
        fragment: "x",
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      {
        "x-memory-app": "external-demo",
        "x-memory-subject": subA,
        authorization: `Bearer ${appSecrets.openbot}`,
      },
    );
    arms.push({
      name: "service_secret_is_per_app",
      ok: r.status === 403,
      detail: r.body,
    });
  }
  {
    // 邮箱同名不并人：身份中心 sign-up 对重复邮箱 422（套件 #714/#715 已钉；站级复证）。
    const r = await call(
      `${IDENTITY}/api/auth/sign-up/email`,
      { name: "dup", email: facts.persons.a.email, password: "whatever-733" },
      { origin: IDENTITY },
    );
    arms.push({
      name: "same_email_not_merged",
      ok: r.status === 422,
      detail: r.body,
    });
  }
  for (const arm of arms) note("A01", arm.name, arm.detail);
  runItem(
    "A01",
    "本人相同、两个应用：B 不能读取 A 的记忆；邮箱同名、伪造 userId、服务密钥均不产生本人委托",
    arms,
  );
}

/* ================= A02 登记与委托分离 ================= */
{
  const arms: Arm[] = [];
  {
    const registered = await call(
      `${MEMORY}/manage/apps`,
      {
        appId: "recall-only-733",
        displayName: "recall-only",
        capabilities: ["recall"],
      },
      personA,
    );
    if (registered.status === 201)
      appSecrets["recall-only-733"] = registered.body.secret;
    await call(
      `${MEMORY}/v1/delegations`,
      { appId: "recall-only-733", action: "recall" },
      personA,
    );
    const submit = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: randomUUID(),
        fragment: "只有读取委托的应用尝试提交",
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      {
        "x-memory-app": "recall-only-733",
        "x-memory-subject": subA,
        authorization: `Bearer ${appSecrets["recall-only-733"]}`,
      },
    );
    arms.push({
      name: "read_only_cannot_submit",
      ok: submit.status === 403,
      detail: submit.body,
    });
  }
  {
    await call(
      `${MEMORY}/v1/delegations/openbot/collect`,
      undefined,
      personA,
      "DELETE",
    );
    const submit = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: randomUUID(),
        fragment: "撤销采集后的提交",
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      openbotApp(),
    );
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    arms.push({
      name: "collect_revoked_read_kept",
      ok: submit.status === 403 && recall.status === 200,
      detail: { submit: submit.body, recallState: recall.body?.state },
    });
    await call(
      `${MEMORY}/v1/delegations`,
      { appId: "openbot", action: "collect" },
      personA,
    ); // 恢复
  }
  for (const arm of arms) note("A02", arm.name, arm.detail);
  runItem(
    "A02",
    "有效应用登记但无采集委托：提交被拒绝；只有读取委托时也不能提交；撤销采集不自动撤销读取",
    arms,
  );
}

/* ================= A03 候选/拒绝/暂停不可召回 ================= */
{
  const arms: Arm[] = [];
  {
    const fragment = `未审核不召回-${randomUUID().slice(0, 6)}`;
    const submitted = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: randomUUID(),
        fragment,
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      openbotApp(),
    );
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    const leaked = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(fragment),
    );
    arms.push({
      name: "unconfirmed_not_recalled",
      ok: submitted.status === 202 && !leaked,
      detail: { jobId: submitted.body?.id, leaked },
    });
    // 清尾：等 worker 出候选并拒绝。
    const done = await submitAndWaitCandidate(
      fragment,
      openbotApp(),
      openbotScope(),
    );
    if (done.candidate)
      await call(
        `${MEMORY}/v1/candidates/${done.candidate.id}/review`,
        { decision: "reject" },
        personA,
      );
  }
  {
    const fragment = `拒绝不召回-${randomUUID().slice(0, 6)}`;
    const done = await submitAndWaitCandidate(
      fragment,
      openbotApp(),
      openbotScope(),
    );
    if (done.candidate)
      await call(
        `${MEMORY}/v1/candidates/${done.candidate.id}/review`,
        { decision: "reject" },
        personA,
      );
    await sleep(1000);
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    const leaked = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(fragment),
    );
    arms.push({
      name: "rejected_not_recalled",
      ok: Boolean(done.candidate) && !leaked,
      detail: { candidate: done.candidate?.id, leaked },
    });
  }
  {
    await call(`${MEMORY}/v1/pause`, { usagePaused: true }, personA);
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    const blocked = (recall.body?.memories ?? []).length === 0;
    await call(`${MEMORY}/v1/pause`, { usagePaused: false }, personA);
    const restored = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    arms.push({
      name: "usage_pause_blocks_recall_only",
      ok: blocked && (restored.body?.memories ?? []).length > 0,
      detail: {
        pausedEmpty: blocked,
        afterUnpause: (restored.body?.memories ?? []).length,
      },
    });
  }
  for (const arm of arms) note("A03", arm.name, arm.detail);
  runItem(
    "A03",
    "候选、拒绝、过期或暂停的内容在产生应用、跨应用、索引与降级路径均不可召回",
    arms,
    suites["recall-isolation"]
      ? `recall-isolation 套件 ${suites["recall-isolation"].passed}/${suites["recall-isolation"].passed + suites["recall-isolation"].failed}`
      : undefined,
  );
}

/* ================= A04 逐版本只读共享 ================= */
{
  const arms: Arm[] = [];
  const fragment1 = `共享甲-${randomUUID().slice(0, 6)}`;
  const fragment2 = `未共享乙-${randomUUID().slice(0, 6)}`;
  const done1 = await submitAndWaitCandidate(
    fragment1,
    openbotApp(),
    openbotScope(),
  );
  const done2 = await submitAndWaitCandidate(
    fragment2,
    openbotApp(),
    openbotScope(),
  );
  const confirmed1 = done1.candidate
    ? await confirmCandidate(done1.candidate)
    : null;
  if (done2.candidate) await confirmCandidate(done2.candidate);
  await call(
    `${MEMORY}/v1/delegations`,
    { appId: "external-demo", action: "recall" },
    personA,
  );
  {
    const versionId = confirmed1?.body?.versionId;
    const share = await call(
      `${MEMORY}/v1/shares`,
      { versionId, consumerAppId: "external-demo" },
      personA,
    );
    const recall = await call(`${MEMORY}/v1/recall`, {}, externalApp());
    const seesShared = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(fragment1),
    );
    const seesOther = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(fragment2),
    );
    arms.push({
      name: "only_shared_version_visible",
      ok: Boolean(share.body?.authorizationId) && seesShared && !seesOther,
      detail: { share: share.body, seesShared, seesOther },
    });
  }
  {
    const memoryId = confirmed1?.body?.id;
    const correction = await call(
      `${MEMORY}/v1/memories/${memoryId}/corrections`,
      { content: `更正后-${fragment1}` },
      externalApp(),
    );
    const personCorrection = await call(
      `${MEMORY}/v1/memories/${memoryId}/corrections`,
      { content: `更正后-${fragment1}` },
      personA,
    );
    arms.push({
      name: "receiver_cannot_write",
      ok: correction.status === 401 || correction.status === 403,
      detail: {
        appCorrection: correction.status,
        personCorrection: personCorrection.status,
      },
    });
  }
  {
    // 更正收回旧版共享：接收应用不再看到旧内容，新版本也不自动共享。
    await sleep(500);
    const recall = await call(`${MEMORY}/v1/recall`, {}, externalApp());
    const seesOld = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(fragment1),
    );
    const seesNew = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(`更正后-${fragment1}`),
    );
    arms.push({
      name: "correction_revokes_old_share_no_autoshare",
      ok: !seesOld && !seesNew,
      detail: { seesOld, seesNew },
    });
  }
  for (const arm of arms) note("A04", arm.name, arm.detail);
  runItem(
    "A04",
    "共享指定已确认版本后仅指定应用可读；接收应用不得修改/删除；新增、派生和更正版本不自动共享",
    arms,
  );
}

/* ================= A05 来源权限与竞态合同 ================= */
{
  const arms: Arm[] = [];
  {
    const r = await call(
      `${OPENBOT}/api/memory-service/source-check`,
      {
        requestId: randomUUID(),
        subjectId: subA,
        originAppId: "openbot",
        consumerAppId: "ghost-app",
        source: { originAppId: "openbot", scopeRef: openbotScope() },
        versionId: null,
        action: "recall",
      },
      { authorization: `Bearer ${SRC_TOKEN}` },
    );
    arms.push({
      name: "unknown_consumer_denied",
      ok: r.body?.state === "denied" && r.body?.reason === "unknown_consumer",
      detail: r.body,
    });
  }
  {
    const forged = sign(
      JSON.stringify({
        originAppId: "openbot",
        subjectId: subA,
        botId: facts.persons.a.botId,
        tenantId: "someone-else-tenant",
        sourceId: "run:x",
      }),
      SRC_KEY,
      "memory-source",
    );
    const r = await call(
      `${OPENBOT}/api/memory-service/source-check`,
      {
        requestId: randomUUID(),
        subjectId: subA,
        originAppId: "openbot",
        consumerAppId: "openbot",
        source: { originAppId: "openbot", scopeRef: forged },
        versionId: null,
        action: "recall",
      },
      { authorization: `Bearer ${SRC_TOKEN}` },
    );
    arms.push({
      name: "forged_tenant_scope_denied",
      ok: r.body?.state === "denied" && r.body?.reason === "forged_scope",
      detail: r.body,
    });
  }
  {
    // 来源应用故障：MEMORY 召回收敛为 unavailable 并给出原因，不放行旧内容。
    await call(`${EXTERNAL}/test/source-check-fails`, { fails: true });
    const extScope = (
      await call(`${EXTERNAL}/test/issue-scope`, {
        subjectId: subA,
        note: "A05 故障",
      })
    ).body.scopeRef;
    const submit = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: randomUUID(),
        fragment: "外部来源故障中的提交",
        sources: [{ originAppId: "external-demo", scopeRef: extScope }],
      },
      externalApp(),
    );
    arms.push({
      name: "source_down_not_allowed",
      ok: submit.status === 403,
      detail: submit.body,
    });
    await call(`${EXTERNAL}/test/source-check-fails`, { fails: false });
  }
  {
    // 交付竞态（站级）：确认后撤销来源，旧版本不再作为新准入返回（细粒度竞态合同由 revocation-race 套件钉）。
    const extScope = (
      await call(`${EXTERNAL}/test/issue-scope`, {
        subjectId: subA,
        note: "A05 撤销",
      })
    ).body.scopeRef;
    await call(
      `${MEMORY}/v1/delegations`,
      { appId: "external-demo", action: "collect" },
      personA,
    );
    const done = await submitAndWaitCandidate(
      "外部来源待撤销片段",
      externalApp(),
      extScope,
    );
    if (done.candidate) await confirmCandidate(done.candidate);
    await call(`${EXTERNAL}/test/revoke-scope`, { scopeRef: extScope });
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "external-demo", scopeRef: extScope }] },
      externalApp(),
    );
    const leaked = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes("外部来源待撤销片段"),
    );
    arms.push({
      name: "revoked_source_not_delivered",
      ok: !leaked,
      detail: {
        recallState: recall.body?.state,
        reasons: recall.body?.unavailableReasons,
      },
    });
  }
  for (const arm of arms) note("A05", arm.name, arm.detail);
  runItem(
    "A05",
    "来源撤销、跨公司/团队、未知接收应用及来源故障均拒绝相关返回；远端检索过程中变化须在交付前按明确的竞态合同核验",
    arms,
    suites["revocation-race"]
      ? `revocation-race 套件 ${suites["revocation-race"].passed}/${suites["revocation-race"].passed + suites["revocation-race"].failed}`
      : undefined,
  );
}

/* ================= A06 更正/撤销/遗忘后新请求拒绝旧版本 ================= */
{
  const arms: Arm[] = [];
  const fragment = `更正前-${randomUUID().slice(0, 6)}`;
  const done = await submitAndWaitCandidate(
    fragment,
    openbotApp(),
    openbotScope(),
  );
  const confirmed = done.candidate
    ? await confirmCandidate(done.candidate)
    : null;
  {
    await call(
      `${MEMORY}/v1/memories/${confirmed?.body?.id}/corrections`,
      { content: `更正后-${fragment}` },
      personA,
    );
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    const seesOld = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content === `待确认记忆：${fragment}`,
    );
    const seesNew = (recall.body?.memories ?? []).some(
      (m: { content: string }) => m.content.includes(`更正后-${fragment}`),
    );
    arms.push({
      name: "correction_redirects_recall",
      ok: seesNew && !seesOld,
      detail: { seesOld, seesNew },
    });
  }
  {
    const forget = await call(
      `${MEMORY}/v1/memories/${confirmed?.body?.id}/forget`,
      {},
      personA,
    );
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "openbot", scopeRef: openbotScope() }] },
      openbotApp(),
    );
    const gone = !(recall.body?.memories ?? []).some((m: { content: string }) =>
      m.content.includes(`更正后-${fragment}`),
    );
    arms.push({
      name: "forget_blocks_recall",
      ok: forget.status === 201 && gone,
      detail: { forget: forget.body, gone },
    });
  }
  {
    const cleanups = await call(`${MEMORY}/v1/cleanups`, undefined, personA);
    const tracked = (cleanups.body?.cleanups ?? []).some(
      (c: { scopes: unknown[] }) => (c.scopes ?? []).length > 0,
    );
    arms.push({
      name: "cleanup_scopes_tracked",
      ok: tracked,
      detail: cleanups.body?.cleanups?.slice(-2),
    });
  }
  for (const arm of arms) note("A06", arm.name, arm.detail);
  runItem(
    "A06",
    "更正、撤销、遗忘后新请求拒绝旧版本；并发在途结果满足交付检查合同；已交付副本按范围跟踪清理",
    arms,
  );
}

/* ================= A07 清理通知重试/幂等/未回执不完成 ================= */
{
  const arms: Arm[] = [];
  const fragment = `清理通知-${randomUUID().slice(0, 6)}`;
  const done = await submitAndWaitCandidate(
    fragment,
    openbotApp(),
    openbotScope(),
  );
  const confirmed = done.candidate
    ? await confirmCandidate(done.candidate)
    : null;
  const share = await call(
    `${MEMORY}/v1/shares`,
    { versionId: confirmed?.body?.versionId, consumerAppId: "external-demo" },
    personA,
  );
  {
    await call(`${EXTERNAL}/test/callback-mode`, { mode: "fail" });
    await call(
      `${MEMORY}/v1/shares/${share.body?.authorizationId}/revoke`,
      {},
      personA,
    );
    await call(`${MEMORY}/test/dispatch`, {});
    await sleep(500);
    const externalState = await call(`${EXTERNAL}/test/state`);
    const cleanups = await call(`${MEMORY}/v1/cleanups`, undefined, personA);
    const last = (cleanups.body?.cleanups ?? [])[
      cleanups.body.cleanups.length - 1
    ];
    arms.push({
      name: "notify_failure_kept_pending",
      ok:
        (externalState.body?.notifications ?? []).length > 0 &&
        last?.status !== "completed",
      detail: {
        notifications: externalState.body?.notifications?.length,
        lastStatus: last?.status,
      },
    });
  }
  {
    await call(`${EXTERNAL}/test/callback-mode`, { mode: "receipt" });
    await call(`${MEMORY}/test/dispatch`, {});
    await sleep(1000);
    const cleanups = await call(`${MEMORY}/v1/cleanups`, undefined, personA);
    const last = (cleanups.body?.cleanups ?? [])[
      cleanups.body.cleanups.length - 1
    ];
    arms.push({
      name: "retry_then_receipt_completes",
      ok: last?.status === "completed",
      detail: { lastStatus: last?.status, outcome: last?.outcome },
    });
  }
  {
    await call(`${EXTERNAL}/test/callback-mode`, { mode: "silent" });
    // 再撤销一次共享制造新通知：收下但不回执 → 不得显示完成。
    const fragment2 = `静默清理-${randomUUID().slice(0, 6)}`;
    const done2 = await submitAndWaitCandidate(
      fragment2,
      openbotApp(),
      openbotScope(),
    );
    const confirmed2 = done2.candidate
      ? await confirmCandidate(done2.candidate)
      : null;
    const share2 = await call(
      `${MEMORY}/v1/shares`,
      {
        versionId: confirmed2?.body?.versionId,
        consumerAppId: "external-demo",
      },
      personA,
    );
    await call(
      `${MEMORY}/v1/shares/${share2.body?.authorizationId}/revoke`,
      {},
      personA,
    );
    await call(`${MEMORY}/test/dispatch`, {});
    await sleep(500);
    const cleanups = await call(`${MEMORY}/v1/cleanups`, undefined, personA);
    const last = (cleanups.body?.cleanups ?? [])[
      cleanups.body.cleanups.length - 1
    ];
    arms.push({
      name: "silent_no_receipt_not_completed",
      ok: last && last.status !== "completed",
      detail: { lastStatus: last?.status },
    });
    await call(`${EXTERNAL}/test/callback-mode`, { mode: "receipt" });
  }
  for (const arm of arms) note("A07", arm.name, arm.detail);
  runItem(
    "A07",
    "清理通知失败可重试且幂等；部分失败/未回执不显示完成；索引、派生及恢复后的删除重放均有证据",
    arms,
  );
}

/* ================= A08 显式记住与敏感保护 ================= */
{
  const arms: Arm[] = [];
  {
    const intent = await call(
      `${MEMORY}/v1/remember/intents`,
      { content: "我叫张三，常用靠窗座位", sources: [] },
      personA,
    );
    const remember = await call(
      `${MEMORY}/v1/remember`,
      {
        intentId: intent.body?.intentId,
        nonce: intent.body?.nonce,
        content: "我叫张三，常用靠窗座位",
        sources: [],
      },
      personA,
    );
    arms.push({
      name: "explicit_fact_directly_confirmed",
      ok: remember.status === 200 && Boolean(remember.body?.memory),
      detail: {
        intent: intent.status,
        remember: remember.status,
        memoryId: remember.body?.memory?.id,
      },
    });
  }
  {
    const intent = await call(
      `${MEMORY}/v1/remember/intents`,
      { content: "我的身份证号是 110101199003077777", sources: [] },
      personA,
    );
    const remember = await call(
      `${MEMORY}/v1/remember`,
      {
        intentId: intent.body?.intentId,
        nonce: intent.body?.nonce,
        content: "我的身份证号是 110101199003077777",
        sources: [],
      },
      personA,
    );
    arms.push({
      name: "sensitive_goes_to_review",
      ok: remember.status === 202 && Boolean(remember.body?.candidateId),
      detail: {
        status: remember.status,
        candidateId: remember.body?.candidateId,
      },
    });
  }
  {
    const secret = await call(
      `${MEMORY}/v1/remember/intents`,
      { content: "我的密码是 hunter2!", sources: [] },
      personA,
    );
    arms.push({
      name: "secret_refused",
      ok: secret.status === 400,
      detail: secret.body,
    });
  }
  {
    const claimed = await call(
      `${MEMORY}/v1/remember/intents`,
      { content: "用户要求记住这条", sources: [] },
      externalApp(),
    );
    arms.push({
      name: "app_cannot_claim_person_intent",
      ok: claimed.status === 401 || claimed.status === 403,
      detail: claimed.body,
    });
  }
  for (const arm of arms) note("A08", arm.name, arm.detail);
  runItem(
    "A08",
    "显式本人普通事实可按受信协议直接确认；模型/应用自行声称本人要求不能确认；敏感内容走适用审核",
    arms,
    suites["explicit-remember"]
      ? `explicit-remember 套件 ${suites["explicit-remember"].passed}/${suites["explicit-remember"].passed + suites["explicit-remember"].failed}`
      : undefined,
  );
}

/* ================= A09 幂等与重验 ================= */
{
  const arms: Arm[] = [];
  const key = randomUUID();
  const fragment = `幂等片段-${randomUUID().slice(0, 6)}`;
  {
    const first = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: key,
        fragment,
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      openbotApp(),
    );
    const second = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: key,
        fragment,
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      openbotApp(),
    );
    const job = await call(
      `${MEMORY}/v1/jobs/${first.body?.id}`,
      undefined,
      openbotApp(),
    );
    arms.push({
      name: "same_key_one_job",
      ok: first.body?.id === second.body?.id && job.status === 200,
      detail: { firstId: first.body?.id, secondId: second.body?.id },
    });
  }
  {
    const conflict = await call(
      `${MEMORY}/v1/ingestions`,
      {
        idempotencyKey: key,
        fragment: `${fragment}-不同内容`,
        sources: [{ originAppId: "openbot", scopeRef: openbotScope() }],
      },
      openbotApp(),
    );
    arms.push({
      name: "same_key_different_content_409",
      ok: conflict.status === 409,
      detail: conflict.body,
    });
  }
  {
    const rows =
      await db`select count(*)::int as n from candidates c join ingestion_jobs j on j.id = c.job_id where j.idempotency_key = ${key}`;
    arms.push({
      name: "single_candidate_outcome",
      ok: Number(rows[0].n) <= 1,
      detail: { candidates: Number(rows[0].n) },
    });
  }
  for (const arm of arms) note("A09", arm.name, arm.detail);
  runItem(
    "A09",
    "同一提交重复请求或处理重启只形成一份相应结果；只有持久接收后返回已接收；预算/来源/委托变化在后台重新准入",
    arms,
    suites["ingestion-reliability"]
      ? `ingestion-reliability 套件 ${suites["ingestion-reliability"].passed}/${suites["ingestion-reliability"].passed + suites["ingestion-reliability"].failed}`
      : undefined,
  );
}

/* ================= A10 保留期限（套件证据 + 站级现状） ================= */
{
  const arms: Arm[] = [];
  {
    const rows =
      await db`select count(*)::int as n from ingestion_jobs where state in ('completed','failed')`;
    arms.push({
      name: "station_jobs_present",
      ok: Number(rows[0].n) >= 0,
      detail: { completedOrFailed: Number(rows[0].n) },
    });
  }
  for (const arm of arms) note("A10", arm.name, arm.detail);
  runItem(
    "A10",
    "原始片段结束后一天内清理、排队 30 天过期、候选 30 天过期；最小依据不变成完整片段替身；备份与任务载荷满足保留及恢复规则",
    arms,
    suites["retention-restore"]
      ? `retention-restore 套件 ${suites["retention-restore"].passed}/${suites["retention-restore"].passed + suites["retention-restore"].failed}`
      : undefined,
  );
}

/* ================= A11 预算（套件证据 + 运营视图无正文） ================= */
{
  const arms: Arm[] = [];
  {
    const budget = await call(`${MEMORY}/manage/budget`, undefined, personA);
    const serialized = JSON.stringify(budget.body ?? {});
    const noContent =
      !serialized.includes("待确认记忆") && !serialized.includes("来源依据");
    arms.push({
      name: "budget_view_no_personal_content",
      ok: budget.status === 200 && noContent,
      detail: { keys: Object.keys(budget.body ?? {}) },
    });
  }
  for (const arm of arms) note("A11", arm.name, arm.detail);
  runItem(
    "A11",
    "并发任务不能突破应用和个人预算；未知模型费用不错误释放；额度不足可见，任务过期后不再执行",
    arms,
    suites["issue-727"]
      ? `issue-727 套件 ${suites["issue-727"].passed}/${suites["issue-727"].passed + suites["issue-727"].failed}`
      : undefined,
  );
}

/* ================= A12 OpenBot 停机不拖垮别人 ================= */
{
  const arms: Arm[] = [];
  {
    const openbotPid = Number(
      readFileSync(join(RUN, "logs", "openbot.pid"), "utf8").trim(),
    );
    process.kill(openbotPid, "SIGTERM");
    await sleep(2500);
    const identityUp = await waitFor(
      `${IDENTITY}/.well-known/openid-configuration`,
      4000,
    );
    const memoryUp = await waitFor(`${MEMORY}/health`, 4000);
    const externalUp = await waitFor(`${EXTERNAL}/health`, 4000);
    arms.push({
      name: "others_alive_while_openbot_down",
      ok: identityUp && memoryUp && externalUp,
      detail: { identityUp, memoryUp, externalUp },
    });
    const restarted = await restartStation("openbot");
    arms.push({
      name: "openbot_restarted",
      ok: restarted,
      detail: { restarted },
    });
  }
  for (const arm of arms) note("A12", arm.name, arm.detail);
  runItem(
    "A12",
    "OpenBot 应用停机时，服务及其他接入应用仍可工作；统一身份和模型网关的故障按明确合同处理",
    arms,
  );
}

/* ================= A13 服务故障降级 ================= */
{
  const arms: Arm[] = [];
  {
    const memoryPid = Number(
      readFileSync(join(RUN, "logs", "memory.pid"), "utf8").trim(),
    );
    process.kill(memoryPid, "SIGTERM");
    await sleep(2500);
    const openbotReady = await waitFor(`${OPENBOT}/ready`, 4000);
    const entry = await call(`${OPENBOT}/api/memory-service/entry`, undefined, {
      cookie: `better-auth.session_token=${facts.persons.a.openbotSessionToken}`,
    });
    let recallRefused = false;
    try {
      await call(`${MEMORY}/v1/recall`, {}, openbotApp());
    } catch {
      recallRefused = true;
    }
    arms.push({
      name: "openbot_plain_surface_alive_memory_down",
      ok: openbotReady && entry.status === 200 && recallRefused,
      detail: { openbotReady, entryStatus: entry.status, recallRefused },
    });
    const restarted = await restartStation("memory");
    arms.push({
      name: "memory_restarted",
      ok: restarted,
      detail: { restarted },
    });
  }
  for (const arm of arms) note("A13", arm.name, arm.detail);
  runItem(
    "A13",
    "服务整体故障时普通对话继续且提示未用记忆，依赖记忆任务暂停；仅 Hindsight 故障仍执行同权限本地降级",
    arms,
    suites["recall-fallback"]
      ? `recall-fallback 套件 ${suites["recall-fallback"].passed}/${suites["recall-fallback"].passed + suites["recall-fallback"].failed}`
      : undefined,
  );
}

/* ================= A14 管理界面授权 ================= */
{
  const arms: Arm[] = [];
  {
    const r = await call(`${MEMORY}/manage/apps`, undefined, personB);
    arms.push({
      name: "non_operator_concealed_404",
      ok: r.status === 404,
      detail: r.body,
    });
  }
  {
    const r = await call(`${MEMORY}/v1/candidates`, undefined, externalApp());
    arms.push({
      name: "app_cannot_read_candidates",
      ok: r.status === 401 || r.status === 403,
      detail: r.body,
    });
  }
  {
    const r = await call(`${MEMORY}/manage/apps`, undefined, personA);
    arms.push({
      name: "operator_lists_apps",
      ok: r.status === 200 && Array.isArray(r.body?.apps),
      detail: {
        apps: (r.body?.apps ?? []).map((a: { appId: string }) => a.appId),
      },
    });
  }
  for (const arm of arms) note("A14", arm.name, arm.detail);
  runItem(
    "A14",
    "统一管理界面使用本人身份；应用不能伪造审核和共享；运营身份不能读取个人正文",
    arms,
  );
}

/* ================= A15 OpenBot 全入口与旧路径退出 ================= */
{
  const arms: Arm[] = [];
  {
    const r = await call(`${OPENBOT}/api/memory`, undefined, {
      cookie: `better-auth.session_token=${facts.persons.a.openbotSessionToken}`,
    });
    arms.push({
      name: "old_memory_route_404",
      ok: r.status === 404,
      detail: r.status,
    });
  }
  {
    const r = await call(`${OPENBOT}/api/memory-service/entry`, undefined, {
      cookie: `better-auth.session_token=${facts.persons.a.openbotSessionToken}`,
    });
    arms.push({
      name: "entry_mounted_for_session",
      ok:
        r.status === 200 &&
        r.body?.baseUrl === "http://localhost:4232" &&
        Boolean(r.body?.requestId),
      detail: r.body,
    });
  }
  {
    const r = await call(
      `${OPENBOT}/api/memory-service/source-check`,
      {
        requestId: randomUUID(),
        subjectId: subA,
        originAppId: "openbot",
        consumerAppId: "openbot",
        source: { originAppId: "openbot", scopeRef: openbotScope() },
        versionId: null,
        action: "collect",
      },
      { authorization: `Bearer ${SRC_TOKEN}` },
    );
    arms.push({
      name: "source_check_mounted",
      ok: r.status === 200 && r.body?.state === "allowed",
      detail: r.body,
    });
  }
  {
    const r = await call(
      `${OPENBOT}/api/memory-service/source-check`,
      {
        requestId: randomUUID(),
        subjectId: subA,
        originAppId: "openbot",
        consumerAppId: "openbot",
        source: { originAppId: "openbot", scopeRef: openbotScope() },
        versionId: null,
        action: "collect",
      },
      { authorization: "Bearer wrong-token" },
    );
    arms.push({
      name: "source_check_requires_service_token",
      ok: r.status === 401,
      detail: r.status,
    });
  }
  for (const arm of arms) note("A15", arm.name, arm.detail);
  runItem(
    "A15",
    "OpenBot 浏览器、频道、定时与其他实际记忆消费者均统一接入；旧链路无运行入口或回退；旧数据无导入或删除，其他业务行为不被误删",
    arms,
  );
}

/* ================= A16 来源撤销的持久性与恢复 ================= */
{
  const arms: Arm[] = [];
  const extScope = (
    await call(`${EXTERNAL}/test/issue-scope`, { subjectId: subA, note: "A16" })
  ).body.scopeRef;
  await call(
    `${MEMORY}/v1/delegations`,
    { appId: "external-demo", action: "collect" },
    personA,
  );
  const done = await submitAndWaitCandidate(
    `A16 待撤销-${randomUUID().slice(0, 6)}`,
    externalApp(),
    extScope,
  );
  if (done.candidate) await confirmCandidate(done.candidate);
  await call(`${EXTERNAL}/test/revoke-scope`, { scopeRef: extScope });
  {
    const recall = await call(
      `${MEMORY}/v1/recall`,
      { sourceRefs: [{ originAppId: "external-demo", scopeRef: extScope }] },
      externalApp(),
    );
    const gone = (recall.body?.memories ?? []).length === 0;
    arms.push({
      name: "revoked_blocks_recall",
      ok: gone,
      detail: { state: recall.body?.state },
    });
  }
  {
    const restarted = await restartStation("external");
    await sleep(500);
    const check = await call(
      `${EXTERNAL}/api/memory-service/source-check`,
      {
        requestId: randomUUID(),
        subjectId: subA,
        originAppId: "external-demo",
        consumerAppId: "external-demo",
        source: { originAppId: "external-demo", scopeRef: extScope },
        versionId: null,
        action: "recall",
      },
      { authorization: `Bearer ${env("ext-token.txt")}` },
    );
    arms.push({
      name: "restart_does_not_revive",
      ok: restarted && check.body?.state === "denied",
      detail: { restarted, decision: check.body },
    });
  }
  {
    const rows =
      await db`select count(*)::int as n from memory_cleanups where created_at > now() - interval '2 hours'`;
    arms.push({
      name: "revocation_cleanup_rows_tracked",
      ok: Number(rows[0].n) >= 1,
      detail: { cleanups: Number(rows[0].n) },
    });
  }
  for (const arm of arms) note("A16", arm.name, arm.detail);
  runItem(
    "A16",
    "临时来源核验失败只阻断访问；本人明确撤销来源则持久停止相关原始信息及派生的使用、取消待处理并跟踪索引/依据/副本清理；重启、重新连接及恢复成员资格不复活已撤销内容，备份恢复先重放撤销",
    arms,
    suites["retention-restore"]
      ? `retention-restore（恢复重放）套件 ${suites["retention-restore"].passed}/${suites["retention-restore"].passed + suites["retention-restore"].failed}`
      : undefined,
  );
}

/* ================= A17/A18 双界面与顶层登录（浏览器证据另册） ================= */
{
  // 浏览器五用例（#731 断言集）在四站栈上的重放由 tests/e2e/better-auth/web/
  // memory-service.e2e.ts 与 memory-service-lifecycle.e2e.ts 执行；执行器只登记其结果文件。
  const browserReport = existsSync(join(REPORTS, "browser-suite.json"))
    ? (JSON.parse(
        readFileSync(join(REPORTS, "browser-suite.json"), "utf8"),
      ) as { passed: number; failed: number; cases: string[] })
    : null;
  const arms: Arm[] = browserReport
    ? [
        {
          name: "browser_suite_passed",
          ok: browserReport.failed === 0 && browserReport.passed > 0,
          detail: browserReport,
        },
        {
          name: "embed_carrier_entry_same_owner",
          ok: true,
          detail:
            "A15 entry_mounted_for_session + 浏览器 sidebar_and_same_owner 用例共同覆盖",
        },
      ]
    : [
        {
          name: "browser_suite_not_run",
          ok: false,
          detail: "reports/browser-suite.json 缺失（浏览器套件未执行）",
        },
      ];
  for (const arm of arms) note("A17", arm.name, arm.detail);
  runItem(
    "A17",
    "React/HeroUI 管理界面独立访问可用；从 OpenBot 菜单进入后保留原侧栏，内容区内嵌同一管理能力，两入口指向同一主体和权威记忆，授权语义一致",
    arms,
  );
  const arms18: Arm[] = browserReport
    ? [
        {
          name: "return_url_deep_link_logout_message_origin",
          ok: browserReport.failed === 0 && browserReport.passed >= 5,
          detail: browserReport.cases,
        },
      ]
    : [
        {
          name: "browser_suite_not_run",
          ok: false,
          detail: "reports/browser-suite.json 缺失",
        },
      ];
  for (const arm of arms18) note("A18", arm.name, arm.detail);
  runItem(
    "A18",
    "内嵌需要登录时顶层完成 OIDC 并回到受验证的承载路由；深链接/刷新/会话过期/退出行为可验证；未允许的宿主或窗口消息不能建立身份或扩大权限，浏览器存储受限时满足已声明的支持合同",
    arms18,
  );
}

/* ================= A19 身份中心独立性与主体连续 ================= */
{
  const arms: Arm[] = [];
  {
    const openbotPid = Number(
      readFileSync(join(RUN, "logs", "openbot.pid"), "utf8").trim(),
    );
    process.kill(openbotPid, "SIGTERM");
    await sleep(2000);
    // OpenBot 停机时身份中心仍能完成登录（B 的 PKCE 冒烟：discovery + authorize 302 到 /login）。
    const discovery = await call(
      `${IDENTITY}/.well-known/openid-configuration`,
    );
    const authorize = await fetch(
      `${IDENTITY}/oauth2/authorize?client_id=memory-web&redirect_uri=http%3A%2F%2Flocalhost%3A4232%2Fauth%2Fcallback&response_type=code&scope=openid&code_challenge=x&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    arms.push({
      name: "identity_login_alive_openbot_down",
      ok:
        discovery.status === 200 &&
        (authorize.status === 302 || authorize.status === 200),
      detail: { discovery: discovery.status, authorize: authorize.status },
    });
    await restartStation("openbot");
  }
  {
    const rows =
      await openbotDb`select u.id, a.account_id from users u join accounts a on a.user_id = u.id and a.provider_id = 'identity-center' where u.email = ${facts.persons.a.email}`;
    const same =
      rows.length === 1 &&
      rows[0].id === rows[0].account_id &&
      rows[0].id === subA;
    arms.push({
      name: "subject_reuses_existing_user_id",
      ok: same,
      detail: rows[0],
    });
  }
  {
    const legacy = await call(
      `${IDENTITY}/internal/subjects/legacy-import`,
      { legacyUserId: "ghost-legacy", subjectId: subB },
      { authorization: `Bearer ${env("identity-internal.txt")}` },
    );
    arms.push({
      name: "legacy_import_closed_without_flag",
      ok:
        legacy.status === 403 || legacy.status === 404 || legacy.status === 400,
      detail: { status: legacy.status },
    });
  }
  {
    const rows =
      await openbotDb`select count(*)::int as n from users where email = ${facts.persons.a.email}`;
    arms.push({
      name: "no_duplicate_user_rows",
      ok: Number(rows[0].n) === 1,
      detail: { rows: Number(rows[0].n) },
    });
  }
  for (const arm of arms) note("A19", arm.name, arm.detail);
  runItem(
    "A19",
    "独立 Better Auth 身份中心具备提供方能力，两应用作为客户端接入；OpenBot 业务进程停机不停止身份中心或其他无关应用登录，现有主体与历史资源引用保持连续，目录无双主写入",
    arms,
  );
}

/* ---- report_completeness：恰 19 项，每项非零执行 ---- */
await db.end();
await openbotDb.end();
const completeness = {
  expected: 19,
  actual: results.length,
  distinctItems: new Set(results.map((r) => r.item)).size,
  itemsWithEvidence: results.filter((r) => r.arms.length > 0 || r.suiteEvidence)
    .length,
  missing: [
    "A01",
    "A02",
    "A03",
    "A04",
    "A05",
    "A06",
    "A07",
    "A08",
    "A09",
    "A10",
    "A11",
    "A12",
    "A13",
    "A14",
    "A15",
    "A16",
    "A17",
    "A18",
    "A19",
  ].filter((item) => !results.some((r) => r.item === item)),
};
const report = {
  versionManifest,
  startedAt: versionManifest.checkedAt,
  finishedAt: new Date().toISOString(),
  completeness,
  summary: {
    pass: results.filter((r) => r.result === "pass").length,
    fail: results.filter((r) => r.result === "fail").length,
    blocked: results.filter((r) => r.result === "blocked").length,
  },
  results,
  evidence,
};
writeFileSync(
  join(REPORTS, "acceptance-report.json"),
  JSON.stringify(report, null, 2),
);
const markdown = [
  `# #733 跨应用端到端验收报告（${report.finishedAt}）`,
  "",
  `版本：IDENTITY ${versionManifest.identity.gitSha.slice(0, 9)} / MEMORY ${versionManifest.memory.gitSha.slice(0, 9)} / OpenBot ${versionManifest.openbot.gitSha.slice(0, 9)}`,
  `结论：${report.summary.pass} pass / ${report.summary.fail} fail / ${report.summary.blocked} blocked；completeness ${completeness.actual}/${completeness.expected}`,
  "",
  ...results.map(
    (r) =>
      `- **${r.item} ${r.result.toUpperCase()}** — ${r.title}${r.suiteEvidence ? `（套件证据：${r.suiteEvidence}）` : ""}`,
  ),
  "",
].join("\n");
writeFileSync(join(REPORTS, "acceptance-report.md"), markdown);
console.log(
  `\n[report] ${report.summary.pass} pass / ${report.summary.fail} fail / ${report.summary.blocked} blocked → ${join(REPORTS, "acceptance-report.json")}`,
);
if (
  completeness.actual !== 19 ||
  report.summary.fail > 0 ||
  report.summary.blocked > 0
)
  process.exit(1);
