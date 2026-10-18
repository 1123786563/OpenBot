// MT034（Issue #77）：共享账号审批——绑定对象、参数摘要与归属。
//
// 票面四条验收（全部门在最靠近事实的一层）：
//   AC1 批准只对其锁定的对象与参数摘要有效；参数变化后需要重新审批。
//   AC2 切换到另一团队后旧批准不被复用（有专门测试）。
//   AC3 跨公司审批请求与批准永远拒绝。
//   AC4 撤权后待处理申请不可被该用户继续操作，已批准动作按 MT029 重新校验。
//
// 实现面（与 MT029 credential-lease 同族纪律）：
//   - enterprise_shared_use_requests：申请行锁定 (tenant, workspace, bot,
//     install)，复合外键全部内嵌 tenant——跨公司申请行结构性不可能；
//     proposed_params_digest 是服务端对提议参数的 sha256 摘要。
//   - enterprise_shared_use_approvals：批准行是只追加的不可变授予——
//     锁定同一四元组 + 摘要 + 批准人；authorizeUse 现读实时事实
//     （成员资格 active + epoch 匹配 + 团队成员 active + bot/install
//     归属行 active + 批准行四元组/摘要逐字匹配），任何漂移 =
//     canonical RESOURCE_NOT_FOUND（不泄露存在性）。
//   - 已批准动作可携带 MT029 lease：authorizeUse 经注入的真实
//     createCredentialLeaseService.validate 在校验点重验 lease（消费
//     MT029 seam，不复制其六道校验）——撤权后两层同时失效。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。MT034 迁移（两张新表 + FORCE RLS +
// 最小授权）经 MT003 工具（migrate-test.ts）三步配方真实执行：套件内
// dry-run → manifest → --apply，本文件不自己 DDL。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  buildPlan,
  manifestFor,
  resolveTestDatabaseTarget,
  runMigrateTest,
} from "../../scripts/multitenancy/migrate-test";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createSharedApprovalsFixture,
  type SharedApprovalsFixture,
} from "./support/shared-approvals";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT034 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseTestDatabaseUrlFrom(process.env);
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 判定断言助手：deny 只有一种对外形状（不泄露存在性）
// ---------------------------------------------------------------------------

const CANONICAL_DENY = Object.freeze({
  outcome: "deny",
  code: "RESOURCE_NOT_FOUND",
});

function expectCanonicalDeny(verdict: unknown): void {
  expect(verdict).toEqual(CANONICAL_DENY);
}

// ---------------------------------------------------------------------------
// 套件状态
// ---------------------------------------------------------------------------

let fixture: SharedApprovalsFixture;
let dryRunOutcome: Awaited<ReturnType<typeof runMigrateTest>>;
let applyOutcome: Awaited<ReturnType<typeof runMigrateTest>>;

// 对象平面：公司 A 团队 A1（bot-a1 + install-a1 + team 凭据）、团队 A2
//（bot-a2 + install-a2）、公司 B 团队 B1（bot-b1 + install-b1，与 A1 同一条
// 目录条目——共享目录、各自归属的对照面）。
let companyA: string;
let companyB: string;
let teamA1: string;
let teamA2: string;
let teamB1: string;
let botA1: string;
let botA2: string;
let botB1: string;
let installA1: { installId: string; tenantId: string; workspaceId: string };
let installA2: { installId: string; tenantId: string; workspaceId: string };
let installB1: { installId: string; tenantId: string; workspaceId: string };
let teamCredentialA1: string;

const TEAM_PARAMS = Object.freeze({
  audience: "team" as const,
  outsideInput: false,
  members: [] as const,
});
const PEOPLE_PARAMS = Object.freeze({
  audience: "people" as const,
  outsideInput: false,
  members: [{ kind: "user" as const, value: "u-people" }],
});

async function approvedPairFor(
  who: "a1-member" | "a2-member" | "b1-member" | "a1a2-member",
  teamKey: "team-a1" | "team-a2" | "team-b1",
  agentId: string,
  installId: string,
  params: typeof TEAM_PARAMS | typeof PEOPLE_PARAMS = TEAM_PARAMS,
): Promise<void> {
  const tenant = teamKey === "team-b1" ? companyB : companyA;
  const workspace =
    teamKey === "team-a1" ? teamA1 : teamKey === "team-a2" ? teamA2 : teamB1;
  const scope = await fixture.scopeAs(who, tenant, workspace);
  const requested = await fixture.approvals.request(scope, {
    agentId,
    installId,
    proposed: params,
    reason: "publish",
  });
  if (requested.outcome !== "requested") {
    throw new Error(`fixture request failed: ${JSON.stringify(requested)}`);
  }
  const decided = await fixture.approvalAdmin.decide(
    await fixture.adminContextFor(tenant),
    { requestId: requested.requestId, decision: "approve" },
  );
  if (decided.outcome !== "approved") {
    throw new Error(`fixture approve failed: ${JSON.stringify(decided)}`);
  }
}

describeDb(
  "MT034 shared-account approvals: locked object, params digest, owning scope (Issue #77)",
  () => {
    beforeAll(async () => {
      const resolved = resolveTestDatabaseTarget(process.env);
      if (!resolved.ok) {
        throw new Error(`MT034 shared tests refuse to run: ${resolved.reason}`);
      }
      // 三步配方之一：dry-run（默认 migrate 即计划展示，无副作用）。
      // 拒绝即响亮失败（绝不静默继续）；已应用过的库返回 0 待应用步骤，
      // 是合法的重复运行状态。
      dryRunOutcome = await runMigrateTest(["migrate", "MT034"], {
        environment: { TEST_DATABASE_URL: resolved.target.url },
        out: () => {},
      });
      if (dryRunOutcome.kind === "refused") {
        throw new Error(`MT034 dry-run refused: ${dryRunOutcome.reason}`);
      }
      // 三步配方之二：manifest 由当前计划物化。
      const manifestPath = `/tmp/mt034-manifest-${randomUUID()}.json`;
      await Bun.write(
        manifestPath,
        `${JSON.stringify(manifestFor(buildPlan("MT034")), null, 2)}\n`,
      );
      // 三步配方之三：--apply 与 manifest 逐步骤核对后执行。
      try {
        applyOutcome = await runMigrateTest(
          ["migrate", "MT034", "--apply", "--manifest", manifestPath],
          {
            environment: { TEST_DATABASE_URL: resolved.target.url },
            out: () => {},
          },
        );
      } finally {
        await rm(manifestPath, { force: true });
      }
      if (
        applyOutcome.kind !== "applied" &&
        applyOutcome.kind !== "up-to-date"
      ) {
        throw new Error(
          `MT034 apply did not land: ${JSON.stringify(applyOutcome).slice(0, 200)}`,
        );
      }
      fixture = await createSharedApprovalsFixture();
      companyA = fixture.base.base.isolation.ids["company-a"];
      companyB = fixture.base.base.isolation.ids["company-b"];
      teamA1 = fixture.base.base.isolation.ids["team-a1"];
      teamA2 = fixture.base.base.isolation.ids["team-a2"];
      teamB1 = fixture.base.base.isolation.ids["team-b1"];

      // 共享目录条目 + 三家各自安装（与 MT031 同一对照面：共享目录、
      // 各自安装、互不影响）。
      const cat = await fixture.base.seedCatalogEntry({
        catalogId: "cat-mcp-shared",
        kind: "mcp",
        vendor: "github",
        source: "first-party",
        title: "GitHub MCP (shared account)",
        summary: "The shared-account app the approvals lock to.",
      });
      installA1 = await fixture.base.provisionInstall({
        identity: "a1-member",
        teamKey: "team-a1",
        catalogId: cat.catalogId,
        config: { region: "us" },
      });
      installA2 = await fixture.base.provisionInstall({
        identity: "a2-member",
        teamKey: "team-a2",
        catalogId: cat.catalogId,
        config: { region: "ca" },
      });
      installB1 = await fixture.base.provisionInstall({
        identity: "b1-member",
        teamKey: "team-b1",
        catalogId: cat.catalogId,
        config: { region: "eu" },
      });

      // 真实 Bot 归属行（真实 MT016 服务、真实 scope 签发）。
      for (const [who, teamKey, tenant, workspace] of [
        ["a1-member", "team-a1", companyA, teamA1],
        ["a2-member", "team-a2", companyA, teamA2],
        ["b1-member", "team-b1", companyB, teamB1],
      ] as const) {
        const scope = await fixture.scopeAs(who, tenant, workspace);
        const agentId = `bot-${randomUUID()}`;
        const created = await fixture.bots.createBot(scope, {
          agentId,
          displayName: `MT034 bot ${teamKey}`,
          defaultConfig: {},
        });
        if (created.outcome !== "allow") {
          throw new Error(
            `fixture createBot failed: ${JSON.stringify(created)}`,
          );
        }
        if (teamKey === "team-a1") botA1 = agentId;
        if (teamKey === "team-a2") botA2 = agentId;
        if (teamKey === "team-b1") botB1 = agentId;
      }

      // 真实团队凭据 + use 授权（MT027 admin）：MT029 lease 的对象面。
      teamCredentialA1 = await fixture.provisionTeamCredential({
        teamKey: "team-a1",
        target: "https://shared.example.invalid",
        label: "MT034 shared account credential",
        plaintext: "mt034-canary-shared-account",
      });
      await fixture.grantUse({
        credentialId: teamCredentialA1,
        identity: "a1-member",
        teamKey: "team-a1",
      });
    });

    afterAll(async () => {
      if (fixture) {
        await fixture.dispose();
      }
    });

    // -----------------------------------------------------------------
    // AC1：批准只对锁定的对象与参数摘要有效；参数变化后需要重新审批
    // -----------------------------------------------------------------

    describe("AC1: an approval holds only for its locked object and params digest", () => {
      test("request → approve → use allow: the whole flow admits the exact locked object and params", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const requested = await fixture.approvals.request(scope, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        expect(requested.paramsDigest).toHaveLength(64);

        // 摘要是服务端对提议参数的规范序列化摘要（纯函数可独立复算）。
        const decided = await fixture.approvalAdmin.decide(
          await fixture.adminContextFor(companyA),
          { requestId: requested.requestId, decision: "approve" },
        );
        expect(decided.outcome).toBe("approved");
        if (decided.outcome !== "approved") return;
        expect(decided.paramsDigest).toBe(requested.paramsDigest);

        const rows = await fixture.approvalRows({ tenantId: companyA });
        const approval = rows.find((row) => row.id === decided.approvalId);
        expect(approval).toBeDefined();
        expect(approval?.agentId).toBe(botA1);
        expect(approval?.installId).toBe(installA1.installId);
        expect(approval?.workspaceId).toBe(teamA1);
        expect(approval?.paramsDigest).toBe(requested.paramsDigest);
        expect(approval?.audience).toBe("team");

        const used = await fixture.approvals.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
        });
        expect(used).toEqual({
          outcome: "allow",
          approvalId: decided.approvalId,
          paramsDigest: requested.paramsDigest,
        });
      });

      test("changed params are refused on the old approval; re-approval with the new params reopens the door", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        // 先批准 team 形态。
        await approvedPairFor(
          "a1-member",
          "team-a1",
          botA1,
          installA1.installId,
        );
        // 参数变化（audience team → people + members）：旧批准不复用。
        const changed = await fixture.approvals.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: PEOPLE_PARAMS,
        });
        expectCanonicalDeny(changed);
        // 重新审批（新 request → approve）：新摘要独立放行，旧批准行仍在
        // 但只对旧摘要有效。
        const requested = await fixture.approvals.request(scope, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: PEOPLE_PARAMS,
          reason: "trigger",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        expect(requested.paramsDigest).not.toBe(
          (await fixture.approvalRows({ tenantId: companyA })).find(
            (row) => row.audience === "team",
          )?.paramsDigest,
        );
        const decided = await fixture.approvalAdmin.decide(
          await fixture.adminContextFor(companyA),
          { requestId: requested.requestId, decision: "approve" },
        );
        expect(decided.outcome).toBe("approved");
        const reopened = await fixture.approvals.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: PEOPLE_PARAMS,
        });
        expect(reopened).toEqual({
          outcome: "allow",
          approvalId: (decided as { approvalId: string }).approvalId,
          paramsDigest: requested.paramsDigest,
        });
      });

      test("the claimed digest is never client-supplied: extra fields are invalid input", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        await expect(
          fixture.approvals.authorizeUse(scope, {
            agentId: botA1,
            installId: installA1.installId,
            params: TEAM_PARAMS,
            // @ts-expect-error — 客户端伪造的摘要字段必须被拒绝
            digest: "f".repeat(64),
          } as never),
        ).rejects.toThrow(/unexpected field digest/);
      });

      test("digest pins every parameter dimension: audience, outsideInput and members each flip it", async () => {
        const { sharedApprovalParamsDigest } = await import(
          "../../src/enterprise/tenancy/shared-approvals"
        );
        const base = sharedApprovalParamsDigest(TEAM_PARAMS);
        expect(sharedApprovalParamsDigest(PEOPLE_PARAMS)).not.toBe(base);
        expect(
          sharedApprovalParamsDigest({ ...TEAM_PARAMS, outsideInput: true }),
        ).not.toBe(base);
        expect(
          sharedApprovalParamsDigest({
            ...TEAM_PARAMS,
            members: [{ kind: "user", value: "u-people" }],
          }),
        ).not.toBe(base);
        // 成员顺序不影响同一参数事实的摘要（规范序列化）。
        expect(
          sharedApprovalParamsDigest({
            audience: "people",
            outsideInput: false,
            members: [
              { kind: "user", value: "b" },
              { kind: "user", value: "a" },
            ],
          }),
        ).toBe(
          sharedApprovalParamsDigest({
            audience: "people",
            outsideInput: false,
            members: [
              { kind: "user", value: "a" },
              { kind: "user", value: "b" },
            ],
          }),
        );
      });
    });

    // -----------------------------------------------------------------
    // AC2：切换到另一团队后旧批准不被复用（专门测试）
    // -----------------------------------------------------------------

    describe("AC2: switching teams never reuses the old approval (dedicated)", () => {
      test("the same member, same object pair, same params — from the other team the approval does not answer", async () => {
        // a1a2-member 在 team-a1 完成整条批准链。
        const scopeA1 = await fixture.scopeAs("a1a2-member", companyA, teamA1);
        const requested = await fixture.approvals.request(scopeA1, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        const decided = await fixture.approvalAdmin.decide(
          await fixture.adminContextFor(companyA),
          { requestId: requested.requestId, decision: "approve" },
        );
        expect(decided.outcome).toBe("approved");
        // 原 scope 放行。
        const allowed = await fixture.approvals.authorizeUse(scopeA1, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
        });
        expect(allowed.outcome).toBe("allow");
        // 切换到 team-a2（同一公司另一团队、同一用户、同一对象对、同一
        // 参数）：批准行锁定 team-a1，不回答 team-a2 的调用。
        const scopeA2 = await fixture.scopeAs("a1a2-member", companyA, teamA2);
        const switched = await fixture.approvals.authorizeUse(scopeA2, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
        });
        expectCanonicalDeny(switched);
      });
    });

    // -----------------------------------------------------------------
    // AC3：跨公司审批请求与批准永远拒绝
    // -----------------------------------------------------------------

    describe("AC3: cross-company requests and approvals are always refused", () => {
      test("a member of company B cannot request company A's object pair — and no request row appears in company A", async () => {
        const before = (await fixture.requestRows({ tenantId: companyA }))
          .length;
        const scopeB = await fixture.scopeAs("multi-company", companyB, teamB1);
        const attempted = await fixture.approvals.request(scopeB, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expectCanonicalDeny(attempted);
        const after = (await fixture.requestRows({ tenantId: companyA }))
          .length;
        expect(after).toBe(before);
      });

      test("a company-A admin cannot approve (or decline) a company-B request — the request stays pending and untouched", async () => {
        // 公司 B 内合法请求。
        const scopeB = await fixture.scopeAs("b1-member", companyB, teamB1);
        const requested = await fixture.approvals.request(scopeB, {
          agentId: botB1,
          installId: installB1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        // 公司 A 管理上下文对 B 的请求决定：canonical 拒（租户 pin 下不可见；
        // 本夹具宇宙唯一的 tenant_admin 是公司 A 的——跨公司管理上下文本身
        // 就被真实 authorizer 拒绝 mint，AC3 因此双向无解：可见性 + 信任面）。
        const adminA = await fixture.adminContextFor(companyA);
        const approveAttempt = await fixture.approvalAdmin.decide(adminA, {
          requestId: requested.requestId,
          decision: "approve",
        });
        expectCanonicalDeny(approveAttempt);
        const declineAttempt = await fixture.approvalAdmin.decide(adminA, {
          requestId: requested.requestId,
          decision: "decline",
        });
        expectCanonicalDeny(declineAttempt);
        // 行未被触碰。
        const rows = await fixture.requestRows({ tenantId: companyB });
        const row = rows.find((entry) => entry.id === requested.requestId);
        expect(row?.status).toBe("pending");
        expect(row?.decidedBy).toBeNull();
        // 正向对照：同一 admin 服务对本公司的 pending 申请决定放行
        // （判定代码公司无关，正向面在 AC1 已对本公司链路验证）。
        const scopeA = await fixture.scopeAs("a1-member", companyA, teamA1);
        const requestedA = await fixture.approvals.request(scopeA, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: TEAM_PARAMS,
          reason: "grant",
        });
        expect(requestedA.outcome).toBe("requested");
        if (requestedA.outcome !== "requested") return;
        const decidedA = await fixture.approvalAdmin.decide(adminA, {
          requestId: requestedA.requestId,
          decision: "approve",
        });
        expect(decidedA.outcome).toBe("approved");
      });

      test("cross-company rows are structurally impossible: the composite FKs embed the tenant (23503)", async () => {
        // 超户探针（披露过的结构断言面）：把公司 A 的 bot/install 对塞进
        // 公司 B 的申请行——复合外键拒绝（23503）。
        const b1Principal = fixture.base.base.teamOf(
          "b1-member",
          "team-b1",
        ).principalId;
        const state = await fixture.rawRequestInsert({
          tenantId: companyB,
          workspaceId: teamB1,
          agentId: botA1,
          installId: installA1.installId,
          requestedBy: b1Principal,
          paramsDigest: "a".repeat(64),
        });
        expect(state).toBe("23503");
      });

      test("the request/approval FK set embeds the tenant on every referenced object", async () => {
        const requestFks = await fixture.foreignKeys(
          "enterprise_shared_use_requests",
        );
        const refs = requestFks.map((fk) => fk.refTable).sort();
        expect(refs).toEqual([
          "enterprise_bot_ownership",
          "enterprise_memberships",
          "enterprise_memberships",
          "enterprise_plugin_installs",
          "enterprise_tenants",
          "enterprise_workspaces",
        ]);
        for (const fk of requestFks) expect(fk.onDelete).toBe("cascade");
        const approvalFks = await fixture.foreignKeys(
          "enterprise_shared_use_approvals",
        );
        expect(approvalFks.map((fk) => fk.refTable).sort()).toEqual([
          "enterprise_bot_ownership",
          "enterprise_memberships",
          "enterprise_plugin_installs",
          "enterprise_shared_use_requests",
          "enterprise_tenants",
          "enterprise_workspaces",
        ]);
      });
    });

    // -----------------------------------------------------------------
    // AC4：撤权后待处理申请不可被该用户继续操作；已批准动作按 MT029 重新校验
    // -----------------------------------------------------------------

    describe("AC4: after revocation pending requests are frozen for that user; approved actions re-validate per MT029", () => {
      test("a suspended requester cannot withdraw (or further operate) their own pending request", async () => {
        const scope = await fixture.scopeAs("a2-member", companyA, teamA2);
        const requested = await fixture.approvals.request(scope, {
          agentId: botA2,
          installId: installA2.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        // 真实撤权（MT006 原语：status 翻转 + epoch 递增 + 审计事件）。
        await fixture.base.setCompanyMembershipStatus(
          "a2-member",
          "company-a",
          "suspended",
        );
        try {
          // 已签发 scope 立即失效（epoch 漂移），待处理申请不可再操作。
          const withdrawn = await fixture.approvals.withdraw(scope, {
            requestId: requested.requestId,
          });
          expectCanonicalDeny(withdrawn);
          // 行仍是 pending：未被该用户或任何人触碰。
          const rows = await fixture.requestRows({ tenantId: companyA });
          const row = rows.find((entry) => entry.id === requested.requestId);
          expect(row?.status).toBe("pending");
          // 新申请同样被拒（liveness fail-closed）。
          const fresh = await fixture.approvals.request(scope, {
            agentId: botA2,
            installId: installA2.installId,
            proposed: TEAM_PARAMS,
            reason: "grant",
          });
          expectCanonicalDeny(fresh);
        } finally {
          // 恢复成员资格（MT007 restore 语义走真实 company-admin 面；
          // epoch 再次递增，旧 scope 依然失效——用新 scope 完成收尾）。
          await fixture.base.setCompanyMembershipStatus(
            "a2-member",
            "company-a",
            "active",
          );
        }
      });

      test("a no-epoch-bump suspension still freezes the pending request: status is enforced independently of epoch", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const requested = await fixture.approvals.request(scope, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        // 只翻状态不递增 epoch（披露过的安排 stand-in）：epoch 校验无从
        // 生效，status 校验必须独立拦住（AC4 的第二道独立防线）。
        await approvedPairFor(
          "a1-member",
          "team-a1",
          botA1,
          installA1.installId,
        );
        await fixture.base.setCompanyMembershipStatusWithoutEpochBump(
          "a1-member",
          "company-a",
          "suspended",
        );
        try {
          const withdrawn = await fixture.approvals.withdraw(scope, {
            requestId: requested.requestId,
          });
          expectCanonicalDeny(withdrawn);
          const rows = await fixture.requestRows({ tenantId: companyA });
          const row = rows.find((entry) => entry.id === requested.requestId);
          expect(row?.status).toBe("pending");
          // 使用门同样只认状态事实（不依赖 epoch 漂移）：已批准动作的
          // liveness 在无 epoch bump 撤权下同样立即失效。
          const useAfterStatusOnly = await fixture.approvals.authorizeUse(
            scope,
            {
              agentId: botA1,
              installId: installA1.installId,
              params: TEAM_PARAMS,
            },
          );
          expectCanonicalDeny(useAfterStatusOnly);
        } finally {
          await fixture.base.setCompanyMembershipStatusWithoutEpochBump(
            "a1-member",
            "company-a",
            "active",
          );
        }
      });

      test("a suspended company admin cannot decide: the in-transaction revalidation refuses the stale context", async () => {
        const scope = await fixture.scopeAs("b1-member", companyB, teamB1);
        const requested = await fixture.approvals.request(scope, {
          agentId: botB1,
          installId: installB1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        const admin = await fixture.adminContextFor(companyA);
        await fixture.base.setCompanyMembershipStatus(
          "company-admin",
          "company-a",
          "suspended",
        );
        try {
          await expect(
            fixture.approvalAdmin.decide(admin, {
              requestId: requested.requestId,
              decision: "approve",
            }),
          ).rejects.toThrow(/SCOPE_REVOKED/);
          const rows = await fixture.requestRows({ tenantId: companyB });
          const row = rows.find((entry) => entry.id === requested.requestId);
          expect(row?.status).toBe("pending");
        } finally {
          await fixture.base.setCompanyMembershipStatus(
            "company-admin",
            "company-a",
            "active",
          );
        }
      });

      test("an approved action re-validates per MT029: after suspension the use gate and the lease checkpoint both refuse", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        await approvedPairFor(
          "a1-member",
          "team-a1",
          botA1,
          installA1.installId,
        );
        // 真实 MT029 lease（真实服务、真实凭据与 use 授权）。
        const issued = await fixture.leases.issue(scope, {
          credentialId: teamCredentialA1,
          purpose: "connector-call",
        });
        expect(issued.outcome).toBe("allow");
        if (issued.outcome !== "allow") return;
        // 携带 lease 的已批准动作：两道检查点都过。
        const before = await fixture.approvals.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
          lease: { leaseId: issued.leaseId, purpose: "connector-call" },
        });
        expect(before.outcome).toBe("allow");

        // 撤权（真实 MT006 原语）。
        await fixture.base.setCompanyMembershipStatus(
          "a1-member",
          "company-a",
          "suspended",
        );
        try {
          const after = await fixture.approvals.authorizeUse(scope, {
            agentId: botA1,
            installId: installA1.installId,
            params: TEAM_PARAMS,
            lease: { leaseId: issued.leaseId, purpose: "connector-call" },
          });
          expectCanonicalDeny(after);
          // MT029 自己的校验点同样拒绝（同一 seam，两层一致）。
          const leaseOnly = await fixture.leases.validate(scope, {
            leaseId: issued.leaseId,
            purpose: "connector-call",
          });
          expectCanonicalDeny(leaseOnly);
          // 无 lease 的使用面同样被批准域自己的 liveness 拒绝。
          const approvalOnly = await fixture.approvals.authorizeUse(scope, {
            agentId: botA1,
            installId: installA1.installId,
            params: TEAM_PARAMS,
          });
          expectCanonicalDeny(approvalOnly);
        } finally {
          await fixture.base.setCompanyMembershipStatus(
            "a1-member",
            "company-a",
            "active",
          );
        }
      });

      test("a pre-suspension scope stays rejected after reinstatement: the epoch policy outlives the status flip", async () => {
        // 真实撤权再恢复（MT006 + MT007 语义）：status 回到 active，但
        // epoch 两次递增。撤权前签发的 scope 不能因恢复而复活——epoch
        // 独立于 status 拦住它（AC4 的 epoch 臂）。
        const staleScope = await fixture.scopeAs("a1-member", companyA, teamA1);
        await approvedPairFor(
          "a1-member",
          "team-a1",
          botA1,
          installA1.installId,
        );
        await fixture.base.setCompanyMembershipStatus(
          "a1-member",
          "company-a",
          "suspended",
        );
        await fixture.base.setCompanyMembershipStatus(
          "a1-member",
          "company-a",
          "active",
        );
        // 旧 scope：status 已 active，epoch 已漂移。
        const staleUse = await fixture.approvals.authorizeUse(staleScope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
        });
        expectCanonicalDeny(staleUse);
        // 新签发的 scope 正常放行（恢复成员资格不留下永久伤疤）。
        const freshScope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const freshUse = await fixture.approvals.authorizeUse(freshScope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
        });
        expect(freshUse.outcome).toBe("allow");
      });

      test("the MT029 checkpoint is consumed verbatim: a lease issued for another purpose does not open the gate", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        await approvedPairFor(
          "a1-member",
          "team-a1",
          botA1,
          installA1.installId,
        );
        const issued = await fixture.leases.issue(scope, {
          credentialId: teamCredentialA1,
          purpose: "bot-run",
        });
        expect(issued.outcome).toBe("allow");
        if (issued.outcome !== "allow") return;
        // 用途漂移的 lease：MT029 六道校验的用途臂拒绝，批准域 fail-closed
        // 同步拒绝（消费其判定，绝不复制第二套）。
        const wrongPurpose = await fixture.approvals.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
          lease: { leaseId: issued.leaseId, purpose: "connector-call" },
        });
        expectCanonicalDeny(wrongPurpose);
        const rightPurpose = await fixture.approvals.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
          lease: { leaseId: issued.leaseId, purpose: "bot-run" },
        });
        expect(rightPurpose.outcome).toBe("allow");
      });

      test("without a wired lease validator the gate is fail-closed: a lease-carrying use is refused, never permissive", async () => {
        const { createSharedApprovalService } = await import(
          "../../src/enterprise/tenancy/shared-approvals"
        );
        const bare = createSharedApprovalService(fixture.base.base.data);
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const issued = await fixture.leases.issue(scope, {
          credentialId: teamCredentialA1,
          purpose: "connector-call",
        });
        expect(issued.outcome).toBe("allow");
        if (issued.outcome !== "allow") return;
        const verdict = await bare.authorizeUse(scope, {
          agentId: botA1,
          installId: installA1.installId,
          params: TEAM_PARAMS,
          lease: { leaseId: issued.leaseId, purpose: "connector-call" },
        });
        expectCanonicalDeny(verdict);
      });
    });

    // -----------------------------------------------------------------
    // 存储契约：最小授权、RLS、信任边界与输入校验
    // -----------------------------------------------------------------

    describe("storage fence: least grants, trusted seams, input validation", () => {
      test("requests: data reads/inserts/updates its own pending rows; operator reads/updates; directory nothing; nobody deletes", async () => {
        const grants = await fixture.grants("enterprise_shared_use_requests");
        expect(grants).toEqual([
          "ob_ent_data:INSERT",
          "ob_ent_data:SELECT",
          "ob_ent_data:UPDATE",
          "ob_ent_operator:SELECT",
          "ob_ent_operator:UPDATE",
        ]);
        const approvalGrants = await fixture.grants(
          "enterprise_shared_use_approvals",
        );
        expect(approvalGrants).toEqual([
          "ob_ent_data:SELECT",
          "ob_ent_operator:INSERT",
          "ob_ent_operator:SELECT",
        ]);
      });

      test("RLS: the data role pinned to company B reads none of company A's request or approval rows", async () => {
        const seen = await fixture.base.base.data.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${companyB}, true), set_config('app.principal_id', ${fixture.base.base.teamOf("b1-member", "team-b1").principalId}, true)`,
          );
          const requests = (await tx.execute(
            sql`select count(*)::int as n from enterprise_shared_use_requests where tenant_id = ${companyA}`,
          )) as unknown as { n: number }[];
          const approvals = (await tx.execute(
            sql`select count(*)::int as n from enterprise_shared_use_approvals where tenant_id = ${companyA}`,
          )) as unknown as { n: number }[];
          return {
            requests: requests[0]?.n ?? 0,
            approvals: approvals[0]?.n ?? 0,
          };
        });
        expect(seen.requests).toBe(0);
        expect(seen.approvals).toBe(0);
      });

      test("unverified scopes and forged admin contexts are refused at the seam", async () => {
        const forged = {
          tenantId: companyA,
          workspaceId: teamA1,
          principalId: "p-forged",
          actorId: "u-forged",
          memberEpoch: 1,
          aclEpoch: 1,
          entrypoint: "web" as const,
        };
        await expect(
          fixture.approvals.request(forged, {
            agentId: botA1,
            installId: installA1.installId,
            proposed: TEAM_PARAMS,
            reason: "publish",
          }),
        ).rejects.toThrow(/UNVERIFIED_SCOPE/);
        await expect(
          fixture.approvals.authorizeUse(forged, {
            agentId: botA1,
            installId: installA1.installId,
            params: TEAM_PARAMS,
          }),
        ).rejects.toThrow(/UNVERIFIED_SCOPE/);
        await expect(
          fixture.approvalAdmin.decide(
            {
              tenantId: companyA,
              principalId: "p-forged",
              actorId: "u-forged",
              memberEpoch: 1,
            } as never,
            { requestId: "req-x", decision: "approve" },
          ),
        ).rejects.toThrow(/UNVERIFIED/);
      });

      test("a same-company cross-team object pair is refused at request time (the owning scope locks the request)", async () => {
        // a1-member 对本公司 team-a2 的 (bot, install) 对发起申请：模块层
        // 对象归属检查拒绝（同公司跨团队与跨公司同形 canonical deny；
        // 复合外键只拦跨公司，同公司跨团队靠这道防线）。
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const attempted = await fixture.approvals.request(scope, {
          agentId: botA2,
          installId: installA2.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expectCanonicalDeny(attempted);
        // 混搭对（本团队 Bot + 另一团队安装）：Bot 臂放行、安装臂必须
        // 独立拦住——对象对必须同属一个团队才可申请。
        const mixedPair = await fixture.approvals.request(scope, {
          agentId: botA1,
          installId: installA2.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expectCanonicalDeny(mixedPair);
      });

      test("a decided request can no longer be withdrawn by its requester", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        const requested = await fixture.approvals.request(scope, {
          agentId: botA1,
          installId: installA1.installId,
          proposed: TEAM_PARAMS,
          reason: "publish",
        });
        expect(requested.outcome).toBe("requested");
        if (requested.outcome !== "requested") return;
        const decided = await fixture.approvalAdmin.decide(
          await fixture.adminContextFor(companyA),
          { requestId: requested.requestId, decision: "approve" },
        );
        expect(decided.outcome).toBe("approved");
        const lateWithdraw = await fixture.approvals.withdraw(scope, {
          requestId: requested.requestId,
        });
        expectCanonicalDeny(lateWithdraw);
        const rows = await fixture.requestRows({ tenantId: companyA });
        const row = rows.find((entry) => entry.id === requested.requestId);
        expect(row?.status).toBe("approved");
      });

      test("the RLS policy arms carry the second defense line: withdraw pending pin, data self-insert pin, immutability", async () => {
        // 模块 WHERE 臂与 RLS 策略臂互为纵深防御（MT031 D6 同款：任一
        // 单点变异被另一臂掩蔽）。本断言独立钉死策略臂的存在与形状。
        const rows = (await fixture.base.base.isolation.queryRestricted(
          "data",
          undefined,
          "select policyname, cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename in ($1, $2) order by tablename, policyname",
          ["enterprise_shared_use_requests", "enterprise_shared_use_approvals"],
        )) as unknown as readonly Record<string, unknown>[];
        const byName = new Map(
          rows.map((row) => [String(row.policyname), row]),
        );
        const withdraw = byName.get(
          "enterprise_shared_use_request_data_withdraw",
        );
        expect(withdraw).toBeDefined();
        expect(String(withdraw?.qual)).toContain("status = 'pending'");
        expect(String(withdraw?.qual)).toContain("requested_by");
        const insert = byName.get("enterprise_shared_use_request_data_insert");
        expect(String(insert?.with_check)).toContain("requested_by");
        // 批准行：data 只有读策略（不可变授予的存储形状证据），operator
        // 无 UPDATE/DELETE 策略。
        expect(byName.has("enterprise_shared_use_approval_data_read")).toBe(
          true,
        );
        for (const [name, row] of byName) {
          if (name.startsWith("enterprise_shared_use_approval_")) {
            expect(String(row.cmd)).not.toBe("UPDATE");
            expect(String(row.cmd)).not.toBe("DELETE");
          }
        }
      });

      test("malformed proposals are invalid input, never silent rows: audience, reason, members shape, extra keys", async () => {
        const scope = await fixture.scopeAs("a1-member", companyA, teamA1);
        await expect(
          fixture.approvals.request(scope, {
            agentId: botA1,
            installId: installA1.installId,
            proposed: { ...TEAM_PARAMS, audience: "everyone" } as never,
            reason: "publish",
          }),
        ).rejects.toThrow(/SHARED_APPROVAL_INVALID: params.audience/);
        await expect(
          fixture.approvals.request(scope, {
            agentId: botA1,
            installId: installA1.installId,
            proposed: TEAM_PARAMS,
            reason: "because" as never,
          }),
        ).rejects.toThrow(/SHARED_APPROVAL_INVALID: reason/);
        await expect(
          fixture.approvals.request(scope, {
            agentId: botA1,
            installId: installA1.installId,
            proposed: {
              ...TEAM_PARAMS,
              members: [{ kind: "role", value: "x" }],
            } as never,
            reason: "publish",
          }),
        ).rejects.toThrow(/SHARED_APPROVAL_INVALID: params.members/);
        await expect(
          fixture.approvals.request(scope, {
            agentId: botA1,
            installId: installA1.installId,
            proposed: TEAM_PARAMS,
            reason: "publish",
            // @ts-expect-error — 多余字段拒绝
            hijacked: true,
          } as never),
        ).rejects.toThrow(/unexpected field hijacked/);
      });

      test("an unknown or already-decided request reads as the same canonical deny (no existence leak)", async () => {
        const admin = await fixture.adminContextFor(companyA);
        const unknown = await fixture.approvalAdmin.decide(admin, {
          requestId: `req-${randomUUID()}`,
          decision: "approve",
        });
        expectCanonicalDeny(unknown);
      });
    });
  },
);
