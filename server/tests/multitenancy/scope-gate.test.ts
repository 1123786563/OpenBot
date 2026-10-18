// server/tests/multitenancy/scope-gate.test.ts
// MT005（Issue #48）：集中授权入口（scope gate）——公司成员资格 + 团队成员资格。
//
// 验收事实源（Issue #48 五条，逐条对应 describe）：
//   (1) 只有签发入口能产生 Scope；伪造或反序列化的 Scope 被拒绝
//       （WeakSet 信任边界 + Object.freeze + assertTrustedScope；业务事务
//        入口同样先验信任再触库）。
//   (2) 缺少公司或团队上下文时明确拒绝（TENANT_REQUIRED / WORKSPACE_REQUIRED
//        / WORKSPACE_FORBIDDEN），绝不回退默认公司或第一个团队。
//   (3) 团队成员被移除或停用后，同一事务后续步骤与下一次请求都被拒绝
//        （WORKSPACE_REVOKED / WORKSPACE_FORBIDDEN；advisory 锁串行化）。
//   (4) 公司成员被暂停后，其在该公司全部团队资格立即失效，但其他公司的
//        资格不受影响（跨公司隔离正反两测）。
//   (5) 授权判定只依赖服务端事实；请求头里的公司/团队值只做选择，篡改
//        头不改变判定结果。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_DATABASE_URL）
// 加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在用例名里，
// skipped 不计为通过），绝不回退开发库。裁决 #1：请求头
// x-openbot-tenant / x-openbot-workspace 仅作选择。裁决 #2：本栈不存在
// conversations-v1 策略，本文件不引入任何新策略版本。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import type { PlatformScope } from "../../src/enterprise/contracts";
import { createWorkspaceGate } from "../../src/enterprise/tenancy/scope-gate";
import { assertTrustedScope } from "../../src/enterprise/tenancy/store";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";
import {
  createScopeGateFixture,
  type ScopeGateFixture,
} from "./support/scope-gate";

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
      reason: `MT005 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 共享夹具：MT002 隔离矩阵 + MT004 团队成员关系行 + 真实 resolver/gate
// ---------------------------------------------------------------------------

let fixture: ScopeGateFixture;

/** Resolves to the rejected error code (empty string when it did not throw). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    // Drizzle wraps driver faults ("Failed query: …") with the original
    // postgres.js error on `cause`; the SQLSTATE (e.g. 55P03
    // lock_not_available) is what the lock tests pin. Collect every code
    // along the cause chain so either layer's error shape works.
    const codes: string[] = [];
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
    }
    const text = messages.join(" | ");
    return codes.length > 0 ? `${text} [${codes.join(",")}]` : text;
  }
}

describeDb("MT005 scope gate (Issue #48)", () => {
  beforeAll(async () => {
    fixture = await createScopeGateFixture();
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  // -------------------------------------------------------------------------
  // 验收 (1)：只有签发入口能产生 Scope；伪造/反序列化被拒
  // -------------------------------------------------------------------------

  describe("issue #48 criterion 1: only the issuance entry produces a trusted Scope", () => {
    itDb(
      "a resolver-issued scope is frozen and passes assertTrustedScope",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        const scope = await fixture.resolver.resolve(request);
        expect(Object.isFrozen(scope)).toBe(true);
        expect(() => assertTrustedScope(scope)).not.toThrow();
      },
    );

    itDb("a hand-forged scope with correct-shaped fields is rejected", () => {
      const forged = {
        tenantId: fixture.isolation.ids["company-a"],
        workspaceId: fixture.isolation.ids["team-a1"],
        principalId: "forged-principal",
        actorId: "forged-actor",
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      } satisfies PlatformScope;
      expect(() => assertTrustedScope(forged)).toThrow("UNVERIFIED_SCOPE");
    });

    itDb(
      "a scope deserialized from a stolen JSON payload loses the process trust mark and is rejected",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        const issued = await fixture.resolver.resolve(request);
        const smuggled = JSON.parse(JSON.stringify(issued)) as PlatformScope;
        expect(JSON.stringify(smuggled)).toBe(JSON.stringify(issued));
        expect(() => assertTrustedScope(smuggled)).toThrow("UNVERIFIED_SCOPE");
      },
    );

    itDb("a structuredClone of an issued scope is rejected too", async () => {
      const request = fixture.requestFor("a1-member", {
        tenantId: fixture.isolation.ids["company-a"],
        workspaceId: fixture.isolation.ids["team-a1"],
      });
      const issued = await fixture.resolver.resolve(request);
      const cloned = structuredClone(issued);
      expect(cloned).toEqual(issued);
      expect(cloned).not.toBe(issued);
      expect(() => assertTrustedScope(cloned)).toThrow("UNVERIFIED_SCOPE");
    });

    itDb(
      "the business-transaction gate rejects forged scopes before touching the database",
      async () => {
        const gate = createWorkspaceGate(fixture.data);
        const forged = {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
          principalId: "forged-principal",
          actorId: "forged-actor",
          memberEpoch: 1,
          aclEpoch: 1,
          entrypoint: "web",
        } satisfies PlatformScope;
        let operationRan = false;
        const code = await codeOf(
          gate.transaction(forged, async () => {
            operationRan = true;
          }),
        );
        expect(code).toBe("UNVERIFIED_SCOPE");
        expect(operationRan).toBe(false);
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 (2)：缺少公司/团队上下文时明确拒绝，不回退默认
  // -------------------------------------------------------------------------

  describe("issue #48 criterion 2: missing company or team context is rejected explicitly, never defaulted", () => {
    itDb("no tenant header at all is TENANT_REQUIRED", async () => {
      const request = fixture.requestFor("a1-member", {});
      expect(await codeOf(fixture.resolver.resolve(request))).toBe(
        "TENANT_REQUIRED",
      );
    });

    itDb(
      "tenant without a workspace header is WORKSPACE_REQUIRED, even for a member of exactly one team (no first-team fallback)",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
        });
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "WORKSPACE_REQUIRED",
        );
      },
    );

    itDb(
      "a blank workspace header is WORKSPACE_REQUIRED, not guessed",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: "   ",
        });
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "WORKSPACE_REQUIRED",
        );
      },
    );

    itDb("a blank tenant header is TENANT_REQUIRED", async () => {
      const request = fixture.requestFor("a1-member", {
        tenantId: "",
        workspaceId: fixture.isolation.ids["team-a1"],
      });
      expect(await codeOf(fixture.resolver.resolve(request))).toBe(
        "TENANT_REQUIRED",
      );
    });

    itDb(
      "a company member with no team membership row is refused even for an existing team (company-admin is not auto-admitted to team-a1)",
      async () => {
        const request = fixture.requestFor("company-admin", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "WORKSPACE_FORBIDDEN",
        );
      },
    );

    itDb(
      "an unknown workspace id and a real non-member workspace are indistinguishable (no existence leak)",
      async () => {
        const realButForeign = await codeOf(
          fixture.resolver.resolve(
            fixture.requestFor("a1-member", {
              tenantId: fixture.isolation.ids["company-a"],
              workspaceId: fixture.isolation.ids["team-a2"],
            }),
          ),
        );
        const unknown = await codeOf(
          fixture.resolver.resolve(
            fixture.requestFor("a1-member", {
              tenantId: fixture.isolation.ids["company-a"],
              workspaceId: `${fixture.isolation.idPrefix}-never-existed`,
            }),
          ),
        );
        expect(realButForeign).toBe("WORKSPACE_FORBIDDEN");
        expect(unknown).toBe("WORKSPACE_FORBIDDEN");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 (3)：团队移除/停用 → 同事务与下一次请求都被拒
  // -------------------------------------------------------------------------

  describe("issue #48 criterion 3: team removal or suspension rejects the same transaction and the next request", () => {
    itDb(
      "suspension revokes the already-issued scope inside the business transaction (operation never runs)",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        const scope = await fixture.resolver.resolve(request);
        const gate = createWorkspaceGate(fixture.data);

        await fixture.suspendTeamMembership("a1-member", "team-a1");

        let operationRan = false;
        const code = await codeOf(
          gate.transaction(scope, async () => {
            operationRan = true;
          }),
        );
        expect(code).toBe("WORKSPACE_REVOKED");
        expect(operationRan).toBe(false);

        // 下一次请求同样被拒（签发入口即拒绝）。
        const nextRequest = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        expect(await codeOf(fixture.resolver.resolve(nextRequest))).toBe(
          "WORKSPACE_FORBIDDEN",
        );
      },
    );

    itDb(
      "removal (row deleted) rejects the same transaction and the next request",
      async () => {
        const request = fixture.requestFor("a2-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a2"],
        });
        const scope = await fixture.resolver.resolve(request);
        const gate = createWorkspaceGate(fixture.data);

        await fixture.removeTeamMembership("a2-member", "team-a2");

        const code = await codeOf(
          gate.transaction(scope, async () => {
            throw new Error("MUST_NOT_RUN");
          }),
        );
        expect(code).toBe("WORKSPACE_REVOKED");
        const nextRequest = fixture.requestFor("a2-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a2"],
        });
        expect(await codeOf(fixture.resolver.resolve(nextRequest))).toBe(
          "WORKSPACE_FORBIDDEN",
        );
      },
    );

    itDb(
      "a gate transaction that begins after revocation rejects before the operation, and re-granting restores eligibility with a strictly larger epoch",
      async () => {
        const gate = createWorkspaceGate(fixture.data);
        const request = fixture.requestFor("b1-member", {
          tenantId: fixture.isolation.ids["company-b"],
          workspaceId: fixture.isolation.ids["team-b1"],
        });
        const scope = await fixture.resolver.resolve(request);
        const suspended = await fixture.suspendTeamMembership(
          "b1-member",
          "team-b1",
        );

        // 同一事务（业务事务重验）在操作执行前即拒绝。
        let operationRan = false;
        expect(
          await codeOf(
            gate.transaction(scope, async () => {
              operationRan = true;
            }),
          ),
        ).toBe("WORKSPACE_REVOKED");
        expect(operationRan).toBe(false);
        // 下一次请求同样在签发入口被拒。
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "WORKSPACE_FORBIDDEN",
        );

        const granted = await fixture.grantTeamMembership(
          "b1-member",
          "team-b1",
        );
        expect(granted.epoch).toBeGreaterThan(suspended.epoch);
        const restored = await fixture.resolver.resolve(request);
        expect(restored.workspaceId).toBe(fixture.isolation.ids["team-b1"]);
      },
    );

    itDb(
      "an in-flight gate transaction serializes team revocation: the admin write blocks (lock timeout), then applies after commit",
      async () => {
        const request = fixture.requestFor("a1-other", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        const scope = await fixture.resolver.resolve(request);
        const gate = createWorkspaceGate(fixture.data);

        let releaseOperation!: () => void;
        let operationStarted!: () => void;
        const operationBlocked = new Promise<void>((resolve) => {
          releaseOperation = resolve;
        });
        // Synchronize on the operation body: once it runs, the gate has passed
        // revalidation and holds the shared workspace-membership lock.
        const operationRunning = new Promise<void>((resolve) => {
          operationStarted = resolve;
        });
        const gatePromise = gate.transaction(scope, async () => {
          operationStarted();
          await operationBlocked;
        });
        await operationRunning;

        // Gate 事务持有共享锁期间，撤权写必须被串行化（超时而非交错提交）。
        // finally 保证即使断言失败也释放闸门事务，绝不把共享锁与池连接泄漏给
        // 后续用例（data 连接 max:1）。
        let blocked = "";
        try {
          blocked = await codeOf(
            fixture.suspendTeamMembership("a1-other", "team-a1", {
              lockTimeoutMs: 300,
            }),
          );
          // PostgreSQL's own lock-timeout cancellation text; the driver maps
          // the SQLSTATE to a generic code, so pin the server's message.
          expect(blocked).toContain("canceling statement due to lock timeout");
        } finally {
          releaseOperation();
        }
        expect(await codeOf(gatePromise)).toBe(""); // 撤权尚未提交：本事务正常完成。

        // Gate 事务提交后，撤权立即生效：同 key 下一次重试成功，随后拒绝。
        const suspended = await fixture.suspendTeamMembership(
          "a1-other",
          "team-a1",
        );
        expect(suspended.epoch).toBeGreaterThanOrEqual(1);
        const nextGateCode = await codeOf(
          gate.transaction(scope, async () => {}),
        );
        expect(nextGateCode).toBe("WORKSPACE_REVOKED");
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 (4)：公司暂停 → 该公司全部团队资格立即失效，其他公司不受影响
  // -------------------------------------------------------------------------

  describe("issue #48 criterion 4: company suspension kills that company's team eligibility only", () => {
    itDb(
      "suspending company-a revokes the member's team-a1 scope (resolve + business transaction) while company-b team-b1 keeps working",
      async () => {
        const requestA = fixture.requestFor("multi-company", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        const requestB = fixture.requestFor("multi-company", {
          tenantId: fixture.isolation.ids["company-b"],
          workspaceId: fixture.isolation.ids["team-b1"],
        });
        const scopeA = await fixture.resolver.resolve(requestA);
        // 正向对照：撤权前两个公司都可解析。
        await fixture.resolver.resolve(requestB);

        await fixture.isolation.suspendCompanyMembership(
          "multi-company",
          fixture.isolation.ids["company-a"],
        );

        // 公司 A：下一次请求在签发入口被拒；已签发 scope 在业务事务内被拒。
        expect(await codeOf(fixture.resolver.resolve(requestA))).toBe(
          "TENANT_FORBIDDEN",
        );
        const gate = createWorkspaceGate(fixture.data);
        expect(await codeOf(gate.transaction(scopeA, async () => {}))).toBe(
          "SCOPE_REVOKED",
        );

        // 公司 B：同一身份的另一家公司团队资格不受影响（正向）。
        const scopeB = await fixture.resolver.resolve(requestB);
        expect(scopeB.tenantId).toBe(fixture.isolation.ids["company-b"]);
        // 业务事务放行（显式断言而非裸 await，失败时留下可读证据）。
        expect(await codeOf(gate.transaction(scopeB, async () => {}))).toBe("");
      },
    );

    itDb(
      "revocation is per company: suspending a company-a principal never touches company-b facts, and already-revoked company-a stays revoked",
      async () => {
        // 反向：撤掉 company-admin（纯公司成员，无团队）的公司 A 成员资格，
        // 只属 company-b 的 b1-member 完全不受影响（跨公司隔离负向）。
        await fixture.isolation.suspendCompanyMembership(
          "company-admin",
          fixture.isolation.ids["company-a"],
        );
        const requestB = fixture.requestFor("b1-member", {
          tenantId: fixture.isolation.ids["company-b"],
          workspaceId: fixture.isolation.ids["team-b1"],
        });
        const scopeB = await fixture.resolver.resolve(requestB);
        expect(scopeB.tenantId).toBe(fixture.isolation.ids["company-b"]);

        // multi-company 的 company-a 已在上一个用例中暂停：确认服务端事实
        // 逐公司独立判定，未因 company-b 侧活动而恢复。
        const requestA = fixture.requestFor("multi-company", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        });
        expect(await codeOf(fixture.resolver.resolve(requestA))).toBe(
          "TENANT_FORBIDDEN",
        );
      },
    );

    itDb(
      "a scope issued before a company epoch bump is stale: the gate rejects it even though the membership stays active",
      async () => {
        const requestB = fixture.requestFor("multi-company", {
          tenantId: fixture.isolation.ids["company-b"],
          workspaceId: fixture.isolation.ids["team-b1"],
        });
        const staleScope = await fixture.resolver.resolve(requestB);
        const gate = createWorkspaceGate(fixture.data);
        expect(await codeOf(gate.transaction(staleScope, async () => {}))).toBe(
          "",
        );

        // 续约/重开通周期：epoch 单调递增但 status 保持 active。旧 scope 的
        // memberEpoch 已过时，判定路径必须以 epoch 一致性拒绝（read-then-
        // increase 并发竞态的串行化责任归本入口）。
        const bumped = await fixture.bumpCompanyMembershipEpoch(
          "multi-company",
          "company-b",
        );
        expect(bumped.epoch).toBeGreaterThan(1);

        expect(await codeOf(gate.transaction(staleScope, async () => {}))).toBe(
          "SCOPE_REVOKED",
        );
        // 新解析的 scope 携带新 epoch，照常放行。
        const freshScope = await fixture.resolver.resolve(requestB);
        expect(freshScope.memberEpoch).toBe(bumped.epoch);
        expect(await codeOf(gate.transaction(freshScope, async () => {}))).toBe(
          "",
        );
      },
    );
  });

  // -------------------------------------------------------------------------
  // 验收 (5)：头只做选择，判定只依赖服务端事实
  // -------------------------------------------------------------------------

  describe("issue #48 criterion 5: headers select, server facts decide", () => {
    itDb(
      "truthful headers select: a1a2-member resolves into either of their two teams",
      async () => {
        const first = await fixture.resolver.resolve(
          fixture.requestFor("a1a2-member", {
            tenantId: fixture.isolation.ids["company-a"],
            workspaceId: fixture.isolation.ids["team-a1"],
          }),
        );
        const second = await fixture.resolver.resolve(
          fixture.requestFor("a1a2-member", {
            tenantId: fixture.isolation.ids["company-a"],
            workspaceId: fixture.isolation.ids["team-a2"],
          }),
        );
        expect(first.workspaceId).toBe(fixture.isolation.ids["team-a1"]);
        expect(second.workspaceId).toBe(fixture.isolation.ids["team-a2"]);
      },
    );

    itDb(
      "tampering the workspace header to a same-company team the user is not in changes nothing (WORKSPACE_FORBIDDEN)",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a2"],
        });
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "WORKSPACE_FORBIDDEN",
        );
      },
    );

    itDb(
      "tampering the workspace header to another company's team changes nothing",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-b1"],
        });
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "WORKSPACE_FORBIDDEN",
        );
      },
    );

    itDb(
      "tampering the tenant header to a company the user never joined changes nothing (TENANT_FORBIDDEN)",
      async () => {
        const request = fixture.requestFor("a1-member", {
          tenantId: fixture.isolation.ids["company-b"],
          workspaceId: fixture.isolation.ids["team-b1"],
        });
        expect(await codeOf(fixture.resolver.resolve(request))).toBe(
          "TENANT_FORBIDDEN",
        );
      },
    );

    itDb(
      "the same headers flip from allow to deny only when server state flips: suspension, not the header, decides",
      async () => {
        const headers = {
          tenantId: fixture.isolation.ids["company-a"],
          workspaceId: fixture.isolation.ids["team-a1"],
        };
        const before = await fixture.resolver.resolve(
          fixture.requestFor("a1a2-member", headers),
        );
        expect(before.workspaceId).toBe(fixture.isolation.ids["team-a1"]);

        await fixture.suspendTeamMembership("a1a2-member", "team-a1");

        const after = await codeOf(
          fixture.resolver.resolve(fixture.requestFor("a1a2-member", headers)),
        );
        expect(after).toBe("WORKSPACE_FORBIDDEN");

        // 清理：恢复成员资格，避免影响其他用例（epoch 单调递增）。
        await fixture.grantTeamMembership("a1a2-member", "team-a1");
      },
    );
  });
});

// ENV 关闭时保留一条可见的非通过记录：跳过原因写进用例名。
if (!ENV.ok) {
  test(`MT005 scope-gate suite not run: ${ENV.reason}`, () => {
    expect(ENV.ok).toBe(false);
  });
}
