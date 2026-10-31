import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { randomUUID } from "node:crypto";
import {
  startIdentityCenter,
  type IdentityCenterProcess,
} from "./support/identity-center";
import {
  SUBJECT_PROJECTION_DISABLED,
  SUBJECT_PROJECTION_GENERATION_CHANGED,
  SUBJECT_PROJECTION_UNKNOWN_SUBJECT,
  SubjectProjectionRefusal,
  createCenterStatusClient,
  createSubjectProjection,
  type CenterStatusReader,
  type SubjectProjectionStore,
  type SubjectRef,
} from "../src/auth/subject-projection";
import type { AuthService, RoleRepository } from "../src/auth/guards";
import type { OpenBotRole } from "../src/auth/roles";

/*
 * #715 OpenBot side. The center keeps the identity write authority; OpenBot
 * keeps a compatibility projection (its own userId + principalId) and creates
 * nothing from stale state.
 *
 * The center is real here (its own Bun process, #714 bootstrap). The
 * projection runs against a contract-fixture store: the OpenBot enterprise
 * test database is not running in this environment, and that store is the one
 * seam the projection has — the four named scenarios below are about the
 * projection's decisions, not about PostgreSQL.
 */

const INTERNAL_TOKEN = "itc-" + randomUUID().replaceAll("-", "") + "715";

let center: IdentityCenterProcess;

beforeAll(async () => {
  center = await startIdentityCenter({
    port: 4210,
    env: { IDENTITY_INTERNAL_TOKEN: INTERNAL_TOKEN },
  });
});

afterAll(async () => {
  await center.stop();
});

describe("identity_center_internal_api", () => {
  test("未知主体返回 null；令牌错误按不可用拒绝（不猜测 active/generation）", async () => {
    const client = createCenterStatusClient({
      issuer: center.issuer,
      internalToken: INTERNAL_TOKEN,
    });
    expect(await client.status(randomUUID())).toBeNull();

    const unauthorized = createCenterStatusClient({
      issuer: center.issuer,
      internalToken: "itc-wrong-token-0000000000000000000000",
    });
    let threw = false;
    try {
      await unauthorized.status(randomUUID());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

type FixtureOptions = {
  status?: (
    subjectId: string,
  ) => Promise<{ active: boolean; generation: number } | null>;
  accounts?: Record<string, string>;
  principals?: Record<string, string>;
  session?: {
    userId: string;
    email: string;
    name?: string | null;
    image?: string | null;
  } | null;
  roles?: OpenBotRole[];
};

function projectionFixture(options: FixtureOptions = {}) {
  const accounts = options.accounts ?? { "subject-alice": "user-alice" };
  const principals = options.principals ?? { "user-alice": "principal-alice" };
  const calls = { status: [] as string[], ensured: [] as string[] };

  const store: SubjectProjectionStore = {
    accountForSubject: async (subjectId) =>
      accounts[subjectId] ? { userId: accounts[subjectId] } : undefined,
    subjectForUser: async (userId) => {
      const found = Object.entries(accounts).find(
        ([, value]) => value === userId,
      );
      return found ? { subjectId: found[0] } : undefined;
    },
    ensurePrincipal: async (userId) => {
      calls.ensured.push(userId);
      const principalId = principals[userId];
      if (!principalId)
        throw new Error(`fixture has no principal for ${userId}`);
      return { principalId };
    },
  };
  const status =
    options.status ?? (async () => ({ active: true, generation: 1 }));
  const centerStatus: CenterStatusReader = {
    status: async (subjectId) => {
      calls.status.push(subjectId);
      return status(subjectId);
    },
  };
  const session = options.session === undefined ? null : options.session;
  const auth = {
    handler: () => new Response(null, { status: 404 }),
    api: {
      getSession: async () =>
        session
          ? {
              user: {
                id: session.userId,
                email: session.email,
                name: session.name,
                image: session.image,
              },
            }
          : null,
    },
  } as unknown as AuthService;
  const roles: RoleRepository = {
    rolesForUser: async () => options.roles ?? [],
  };
  const projection = createSubjectProjection({
    center: centerStatus,
    store,
    auth,
    roles,
  });
  return { projection, calls, store, accounts, principals };
}

const ALICE: SubjectRef = {
  subjectId: "subject-alice",
  issuer: "https://identity.test",
  subject: "ext-alice",
  generation: 1,
};

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SubjectProjectionRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a SubjectProjectionRefusal");
}

describe("legacy_ids_and_resources", () => {
  test("投影沿用既有 userId 与 principalId，历史资源外键不变", async () => {
    const { projection } = projectionFixture({
      accounts: { "subject-legacy": "user-legacy" },
      principals: { "user-legacy": "principal-legacy" },
    });
    // 两个历史资源以 (userId, principalId) 为外键；投影后仍按同一 id 可读。
    const resources = [
      { id: "res-1", userId: "user-legacy", principalId: "principal-legacy" },
      { id: "res-2", userId: "user-legacy", principalId: "principal-legacy" },
    ];
    const projected = await projection.projectVerifiedSubject({
      ...ALICE,
      subjectId: "subject-legacy",
    });
    expect(projected).toEqual({
      userId: "user-legacy",
      principalId: "principal-legacy",
    });
    const visible = resources.filter(
      (resource) =>
        resource.userId === projected.userId &&
        resource.principalId === projected.principalId,
    );
    expect(visible.map((resource) => resource.id)).toEqual(["res-1", "res-2"]);
  });
});

describe("same_email_no_link", () => {
  test("同名/同邮箱的两个主体各自独立；缺控制权证明不能互相认领", async () => {
    const { projection } = projectionFixture({
      accounts: {
        "subject-alice": "user-alice",
        "subject-alice-2": "user-alice-2",
      },
      principals: {
        "user-alice": "principal-alice",
        "user-alice-2": "principal-alice-2",
      },
    });
    // 两个 OpenBot 用户同名同邮箱域，但中心给的是两个主体：不合并。
    const first = await projection.projectVerifiedSubject(ALICE);
    const second = await projection.projectVerifiedSubject({
      ...ALICE,
      subjectId: "subject-alice-2",
      subject: "ext-alice-2",
    });
    expect(first).toEqual({
      userId: "user-alice",
      principalId: "principal-alice",
    });
    expect(second).toEqual({
      userId: "user-alice-2",
      principalId: "principal-alice-2",
    });
    expect(first.userId).not.toBe(second.userId);
    expect(first.principalId).not.toBe(second.principalId);

    // 中心不提供按邮箱查询的角色：投影只认 (subjectId)。拿别人的 subject 但
    // generation 不符同样拒绝，证明认领需要中心侧的当前事实。
    const changed = await refusalOf(() =>
      projection.projectVerifiedSubject({
        ...ALICE,
        subjectId: "subject-alice-2",
        generation: 9,
      }),
    );
    expect(changed).toBe(SUBJECT_PROJECTION_GENERATION_CHANGED);
  });
});

describe("disabled_and_scope", () => {
  test("停用主体不产生 actor，也不创建投影；另一主体照常，但资源仍按主体隔离", async () => {
    const { projection, calls } = projectionFixture({
      accounts: { "subject-alice": "user-alice", "subject-bob": "user-bob" },
      principals: {
        "user-alice": "principal-alice",
        "user-bob": "principal-bob",
      },
      session: {
        userId: "user-alice",
        email: "alice@test.example",
        name: "alice",
      },
      roles: ["user"],
      status: async (subjectId) =>
        subjectId === "subject-alice"
          ? { active: false, generation: 2 }
          : { active: true, generation: 1 },
    });

    expect(
      await projection.resolveCenterActor(
        new Request("https://openbot.test/api/x"),
      ),
    ).toBeNull();
    expect(calls.ensured).toEqual([]);

    const disabled = await refusalOf(() =>
      projection.projectVerifiedSubject({ ...ALICE, generation: 2 }),
    );
    expect(disabled).toBe(SUBJECT_PROJECTION_DISABLED);
    expect(calls.ensured).toEqual([]);

    // 另一公司/团队/资源属于 bob 的 principal：alice 停用不会把它交出去。
    const bob = await projection.projectVerifiedSubject({
      ...ALICE,
      subjectId: "subject-bob",
      subject: "ext-bob",
    });
    expect(bob.principalId).toBe("principal-bob");
    expect(calls.ensured).toEqual(["user-bob"]);
  });
});

describe("mapping_conflict_and_outage", () => {
  test("中心不可用或状态缺失时不凭过期状态创建主体", async () => {
    const outage = projectionFixture({
      status: async () => {
        throw new Error("center unreachable");
      },
    });
    let outageThrew = false;
    try {
      await outage.projection.projectVerifiedSubject(ALICE);
    } catch (error) {
      outageThrew = !(error instanceof SubjectProjectionRefusal);
    }
    expect(outageThrew).toBe(true);
    expect(outage.calls.ensured).toEqual([]);

    const unknown = projectionFixture({ status: async () => null });
    expect(
      await refusalOf(() => unknown.projection.projectVerifiedSubject(ALICE)),
    ).toBe(SUBJECT_PROJECTION_UNKNOWN_SUBJECT);
    expect(unknown.calls.ensured).toEqual([]);

    // 冲突映射：本地没有该主体的账号（例如中心与本地投影不一致）→ 拒绝，不新建。
    const conflict = projectionFixture({ accounts: {} });
    expect(
      await refusalOf(() => conflict.projection.projectVerifiedSubject(ALICE)),
    ).toBe("SUBJECT_PROJECTION_UNKNOWN_ACCOUNT");
    expect(conflict.calls.ensured).toEqual([]);
    expect(conflict.calls.status).toEqual([]);
  });
});

describe("resolve_center_actor", () => {
  test("身份中心会话 → 受控 actor；无会话或未绑定中心主体返回 null", async () => {
    const bound = projectionFixture({
      session: {
        userId: "user-alice",
        email: "alice@test.example",
        name: "alice",
      },
      roles: ["admin"],
    });
    const actor = await bound.projection.resolveCenterActor(
      new Request("https://openbot.test/api/me"),
    );
    expect(actor).toEqual({
      id: "user-alice",
      email: "alice@test.example",
      name: "alice",
      image: undefined,
      role: "admin",
    });

    const anonymous = projectionFixture({ session: null });
    expect(
      await anonymous.projection.resolveCenterActor(
        new Request("https://openbot.test/api/me"),
      ),
    ).toBeNull();

    const notCenter = projectionFixture({
      session: { userId: "user-elsewhere", email: "e@test.example" },
    });
    expect(
      await notCenter.projection.resolveCenterActor(
        new Request("https://openbot.test/api/me"),
      ),
    ).toBeNull();
  });
});
