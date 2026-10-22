/**
 * MT141 (Issue #184): the aggregated gap registry — the machine-checkable form
 * of the 缺口清单 document (reports/gap-closure-mt141.md).
 *
 * What a "gap" is here: every surface the coverage-evidence wave (MT133–MT140)
 * did NOT bind to a matrix entrance, plus every explicitly unverified item and
 * every disclosed limit those tickets recorded. Each entry carries exactly one
 * disposition:
 *
 *   fixed                — a defect found by the wave was repaired; a regression
 *                          pin rides the real product code and is re-run by
 *                          gap-closure.test.ts (never merely asserted absent).
 *   blocked-open         — real coverage work that needs its own ticket-sized
 *                          scenario authoring; NOT claimable as covered. Where
 *                          domain-level (store/fixture) evidence exists today,
 *                          basisRefs name it — partial evidence, honestly labeled.
 *   environment-blocked  — cannot be evidenced in this environment at all
 *                          (native device runs, external providers, live
 *                          sandbox/stream runtimes).
 *   unverified           — a probe-able claim recorded as NOT verified; never
 *                          counted as a pass (MT140's device runs, MT111's
 *                          enabled-unverified integrations).
 *   global-exception     — the spec itself carves these out of per-tenant
 *                          evidence (§8: 全局静态组件、平台模板目录、健康接口
 *                          可共享) — classification with a citation, not an
 *                          exemption by silence.
 *
 * The entrance census is DERIVED, never hand-copied: gap-closure.test.ts builds
 * the real inventory, subtracts the entrances the coverage suites actually
 * planned (read from their sources), and requires every remainder to resolve to
 * exactly one bucket below. A new route that misses classification fails the
 * suite; a bucket that matches nothing fails it too.
 */

/** One entrance bucket: a disposition shared by a family of inventory entrances. */
export interface EntranceBucket {
  readonly id: string;
  /** Path prefixes (after the method, no trailing slash) this bucket claims, segment-wise. */
  readonly prefixes: readonly string[];
  /**
   * Platform roots that must match EXACTLY (a bare "/api" or "/api/*" group
   * node must not swallow every concrete route beneath it).
   */
  readonly exactPrefixes?: readonly string[];
  readonly disposition:
    | "blocked-open"
    | "environment-blocked"
    | "global-exception";
  readonly source: string;
  readonly reason: string;
  /** Domain-level evidence that exists today (partial, never entrance-mapped). */
  readonly domainEvidence?: readonly string[];
}

/** A defect the wave found and repaired, with its regression pin. */
export interface FixedGap {
  readonly id: string;
  readonly source: string;
  readonly scope: string;
  readonly what: string;
  readonly fix: string;
  /** The suite file that pins the behavior; must exist and be green. */
  readonly regressionPin: string;
  readonly rerun: string;
}

/** An item recorded as explicitly NOT verified (probe-backed where possible). */
export interface UnverifiedItem {
  readonly id: string;
  readonly source: string;
  readonly scope: string;
  readonly reason: string;
  /** How the claim is probed (command or contract reference). */
  readonly probe: string;
}

/** A disclosed limit that is not an inventory entrance. */
export interface DisclosedLimit {
  readonly id: string;
  readonly source: string;
  readonly scope: string;
  readonly disposition: "blocked-open" | "environment-blocked";
  readonly reason: string;
  readonly domainEvidence?: readonly string[];
}

export const FIXED_GAPS: readonly FixedGap[] = [
  {
    id: "G-FIX-1",
    source: "MT139 (#182) gapFixes[0], re-pinned by MT141 (#184)",
    scope: "orders page / company payment records — invoice.anomalies",
    what: "orders page crashed on invoices whose anomalies field the server omits (statements.ts contract: absent = no anomalies recorded, never an error)",
    fix: "app/src/lib/billing/fulfillment.ts anomalyLines treats the absent field as empty (anomalies ?? [])",
    regressionPin:
      "app/tests/multitenancy/web-billing.test.tsx (MT141 pin: absent field renders, present codes list)",
    rerun:
      "bun --no-env-file test app/tests/multitenancy/web-billing.test.tsx → 7/7 green; re-driven by gap-closure.test.ts as a subprocess",
  },
];

export const UNVERIFIED_ITEMS: readonly UnverifiedItem[] = [
  {
    id: "G-UNV-1",
    source: "MT140 (#183) unverified[0]",
    scope: "iOS native run (Expo/React Native on simulator)",
    reason:
      "simulator runtime exists on this machine but the openmuse submodule toolchain (pnpm install, expo prebuild, Xcode build) is not installed in this worktree; the tenancy/transport/aggregation logic is verified CI-level with no runtime beneath it (the suites' own disclosure)",
    probe:
      "xcrun simctl list devices available (11 devices present) + reports/coverage-mt140.json unverified[0]",
  },
  {
    id: "G-UNV-2",
    source: "MT140 (#183) unverified[1]",
    scope: "Android native run (device or emulator)",
    reason:
      "no Android SDK/emulator toolchain in this environment (emulator/adb not found, ANDROID_HOME unset); same CI-level verification as iOS",
    probe:
      "which emulator / which adb / echo $ANDROID_HOME + reports/coverage-mt140.json unverified[1]",
  },
];

export const DISCLOSED_LIMITS: readonly DisclosedLimit[] = [
  {
    id: "G-BLK-1",
    source: "MT136 (#179) honest boundary 1",
    scope: "craft/workshop HTTP assembly (sandbox gateway, turn executor)",
    disposition: "environment-blocked",
    reason:
      "the full runtime assembly is not mounted in the test environment; evidence rides the authorization seams the routes actually compose (store-level owner gates + canUseBot), disclosed per scenario in coverage-craft-openmuse.test.ts",
    domainEvidence: [
      "server/tests/multitenancy/coverage-craft-openmuse.test.ts",
    ],
  },
  {
    id: "G-BLK-2",
    source: "MT136 (#179) honest boundary 2",
    scope: "connector §9 deletion owner fence — default rows face is a no-op",
    disposition: "blocked-open",
    reason:
      "the fence is wired at deployment assembly; the default rows-side no-op is disclosed and not asserted as a fence by the suite",
    domainEvidence: [
      "server/tests/multitenancy/coverage-craft-openmuse.test.ts",
    ],
  },
  {
    id: "G-BLK-3",
    source: "MT101 (#144) honest boundary 1 (mt18 report)",
    scope: "desktop native listing command for the qualification catalog",
    disposition: "blocked-open",
    reason:
      "the native surface has selection verification (establish_org_context) but no enumeration command; the catalog prop is declared against the workbench listing seam (desktop-native follow-up)",
    domainEvidence: ["desktop/src/CompanySelection.tsx"],
  },
  {
    id: "G-BLK-4",
    source: "MT101 (#144) honest boundary 2 (mt18 report)",
    scope: "withWorkbenchSelection → show_openbot navigation composition",
    disposition: "blocked-open",
    reason:
      "the URL-carrying helper is delivered and pinned (same-origin gate, Web's own query names, preserved query); wiring it into the actual Rust-built handoff destination is a desktop-native composition step outside the zero-Rust scope of #144",
    domainEvidence: ["desktop/src/CompanySelection.test.tsx"],
  },
];

export const ENTRANCE_BUCKETS: readonly EntranceBucket[] = [
  {
    id: "EB-GLOBAL-HEALTH-STATIC",
    prefixes: ["/.well-known"],
    exactPrefixes: [
      "/health",
      "/ready",
      "/*",
      "/api",
      "/api/*",
      "/api/capabilities",
    ],
    disposition: "global-exception",
    source: "spec §8 closing note",
    reason:
      "全局静态组件代码、平台模板目录、健康接口可共享（spec §8）；分类引用规范，不是静默豁免",
  },
  {
    id: "EB-AUTH-IDENTITY-ONBOARDING",
    prefixes: [
      "/api/auth",
      "/api/sign-in-requests",
      "/api/identity",
      "/api/me",
      "/api/desktop/connection-failure",
    ],
    disposition: "blocked-open",
    source: "§8 row 1 (身份、入职、成员、组织登录、SSO/SCIM)",
    reason:
      "identity surfaces have store/fixture-level evidence but no per-entrance matrix scenarios; entrance-mapped coverage is open work",
    domainEvidence: [
      "server/tests/multitenancy/support/people-lifecycle.ts",
      "server/tests/multitenancy/support/sso-scim.ts",
      "server/tests/multitenancy/support/oauth-state.ts",
    ],
  },
  {
    id: "EB-BOTS-AGENTS-LIFECYCLE",
    prefixes: [
      "/api/agents",
      "/api/bots",
      "/api/team-bots",
      "/api/bot-service",
      "/api/admin/bot-services",
    ],
    disposition: "blocked-open",
    source: "§8 row 2 (Bot、团队发布、生命周期)",
    reason:
      "MT133 mapped create/duplicate/hide/pin/patch/delete + reset + publication; the catalog/detail/handoff/capabilities and activity/routing/pause-resume remainders are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-bots-conversations.test.ts",
      "server/tests/multitenancy/support/bot-lifecycle.ts",
    ],
  },
  {
    id: "EB-CHANNELS-GROUPS-THREADS-STREAMS",
    prefixes: [
      "/api/channels",
      "/api/groups",
      "/api/threads",
      "/api/enterprise/streams",
      "/api/enterprise/conversations",
      "WS /^",
    ],
    disposition: "blocked-open",
    source: "§8 row 3 (私人/多人会话与消息)",
    reason:
      "MT133 mapped enterprise conversations core + channel attachments + SSE transport seams; channel/group CRUD remainders, subscription lifecycle and events entrances are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-bots-conversations.test.ts",
      "server/tests/multitenancy/support/streams.ts",
      "server/tests/multitenancy/support/conversation-actions.ts",
      "server/tests/multitenancy/support/group-membership.ts",
    ],
  },
  {
    id: "EB-CRAFT-LONGTAIL",
    prefixes: [
      "/api/craft",
      "/api/craft/sessions",
      "/api/craft/approvals",
      "/api/craft/apps",
      "/api/craft/scheduled-tasks",
    ],
    disposition: "blocked-open",
    source: "§8 row 10 (Craft 创作与任务) + MT136 disclosed limits",
    reason:
      "MT136 mapped the five session actions + artifacts + upload/snapshot entrances; the long tail (messages, turns, files read, webapp family, exports, previews, scheduled tasks, approvals) is open — parts additionally need the sandbox runtime assembly (G-BLK-1)",
    domainEvidence: [
      "server/tests/multitenancy/coverage-craft-openmuse.test.ts",
    ],
  },
  {
    id: "EB-WORKSHOP-LONGTAIL",
    prefixes: ["/api/workshop", "/api/public/workshop"],
    disposition: "blocked-open",
    source: "§8 row 11 (Workshop 与分享) + MT136 disclosed limits",
    reason:
      "MT136 mapped session read + share issue/revoke + public artifacts + turns; schedules, file upload, reset, events and the public preview family are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-craft-openmuse.test.ts",
    ],
  },
  {
    id: "EB-PLUGINS-COMPONENTS-LONGTAIL",
    prefixes: ["/api/plugins", "/api/components"],
    disposition: "blocked-open",
    source: "§8 row 4 (插件、技能、组件与连接账号)",
    reason:
      "MT134 mapped plugin call + skills install + components call + shared-use approvals; server CRUD/OAuth/connect entrances and grants/catalogue remainders are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-plugins-knowledge.test.ts",
      "server/tests/multitenancy/support/plugin-install.ts",
      "server/tests/multitenancy/support/skills-components.ts",
    ],
  },
  {
    id: "EB-KNOWLEDGE-MEMORY-AUTOMATION",
    prefixes: [
      "/api/memory",
      "/api/routines",
      "/api/responsibilities",
      "/api/proactive",
    ],
    disposition: "blocked-open",
    source: "§8 rows 6–7 (知识与文档处理；职责、定时任务、主动建议)",
    reason:
      "MT136 mapped personal memory list/create/read/delete + sources-available; the automation family (routines, responsibilities, triggers, proactive) has fixture-level evidence only — entrance mapping is open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-craft-openmuse.test.ts",
      "server/tests/multitenancy/support/personal-memory.ts",
      "server/tests/multitenancy/support/proactive-tx.ts",
      "server/tests/multitenancy/support/job-ownership.ts",
    ],
  },
  {
    id: "EB-DEMONSTRATIONS-LEARNING",
    prefixes: ["/api/demonstrations", "/api/admin/learning"],
    disposition: "blocked-open",
    source: "§8 row 6 (记忆、研究、学习与演示)",
    reason: "fixture-level evidence exists; entrance mapping is open",
    domainEvidence: [
      "server/tests/multitenancy/support/learning-demonstrations.ts",
    ],
  },
  {
    id: "EB-COMPUTERS-RUNTIME",
    prefixes: [
      "/api/computers/:botId/control/secret",
      "/api/computers/:botId/control/request",
      "/api/computers/:botId/control/revoke",
      "/api/computers/:botId/click",
      "/api/computers/:botId/key",
      "/api/computers/:botId/navigate",
      "/api/computers/:botId/scroll",
      "/api/computers/:botId/type",
      "/api/computers/:botId/read",
      "/api/computers/:botId/status",
      "/api/computers/:botId/page-frame",
      "/api/computers/:botId/human",
      "/api/computers/:botId/files/list",
      "/api/computers/:botId/files/read",
      "/api/computers/:botId/files/download",
      "/api/computers/:botId/computers",
      "WS /api/computers",
    ],
    disposition: "environment-blocked",
    source: "§8 row 9 (电脑、浏览器、代码与沙箱) + MT135 disclosed limits",
    reason:
      "remote-control/stream entrances need a live sandbox and screen runtime; MT135 mapped the allocation/reset/snapshot/exec seams that are provable without the runtime (see coverage-jobs-execution honest boundary)",
    domainEvidence: [
      "server/tests/multitenancy/coverage-jobs-execution.test.ts",
      "server/tests/multitenancy/support/computer-allocation.ts",
    ],
  },
  {
    id: "EB-COMPUTERS-FLEET-POLICY",
    prefixes: [
      "/api/computers/fleet",
      "/api/computers/policy",
      "/api/computers",
    ],
    disposition: "blocked-open",
    source: "§8 row 9",
    reason:
      "fleet/policy surfaces are authorizable without the runtime but have no entrance scenarios yet (policy fixtures exist)",
    domainEvidence: [
      "server/tests/multitenancy/support/computer-allocation.ts",
    ],
  },
  {
    id: "EB-SANDBOX-CODESANDBOX",
    prefixes: ["/api/sandboxed", "/api/codesandbox"],
    disposition: "blocked-open",
    source: "§8 row 9",
    reason:
      "codesandbox runs entrance is mapped (MT135); publish/reset/list remainders are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-jobs-execution.test.ts",
    ],
  },
  {
    id: "EB-DELIVERY-VOICE-EXTERNAL",
    prefixes: ["/api/delivery", "/api/events", "/api/voice", "/api/audio"],
    disposition: "environment-blocked",
    source: "§8 row 13 (通知、消息渠道、语音与听写)",
    reason:
      "external channel integrations (slack/teams/sms/opentag/email-sns webhooks) and voice/dictation need external providers; store-level evidence exists (inbound attribution, voice mobile BFF)",
    domainEvidence: [
      "server/tests/multitenancy/support/inbound-attribution.ts",
      "server/tests/multitenancy/support/voice-mobile-bff.ts",
    ],
  },
  {
    id: "EB-BILLING-PERSONAL-ADMIN-LONGTAIL",
    prefixes: [
      "/api/billing",
      "/api/admin/billing",
      "/api/admin/openmuse-deletion",
    ],
    disposition: "blocked-open",
    source: "§8 row 14 (计费、积分、订单、对账) + §7.1",
    reason:
      "MT137 mapped the company core (catalog/summary/consumption/plan-usage/invoices/purchases create/lago webhook/payments callbacks/admin grants) and MT136 mapped purge/restore; personal purchase lifecycle, entitlements, admin reconcile/sync/recovery and cleanup-execution remainders are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-billing.test.ts",
      "server/tests/multitenancy/support/payer-accounts.ts",
      "server/tests/multitenancy/support/purge-restore.ts",
    ],
  },
  {
    id: "EB-ADMIN-GOVERNANCE-LONGTAIL",
    prefixes: [
      "/api/admin/gateway",
      "/api/admin/identity-providers",
      "/api/admin/credentials",
      "/api/admin/openmuse-ops",
      "/api/admin/openmuse-template",
      "/api/admin/package",
      "/api/admin/people",
      "/api/admin/enterprise",
      "/api/admin/audit-events",
      "/api/admin/status",
      "/api/enterprise/workspace-scope",
    ],
    disposition: "blocked-open",
    source: "§8 row 15 (设置、治理与审计)",
    reason:
      "MT138 mapped audit-events/status/enterprise/settings capabilities/people role + workspace-scope admin team creation; gateway, identity-provider, credential rotation, openmuse ops/template, package, network and member-removal admin remainders are open",
    domainEvidence: [
      "server/tests/multitenancy/coverage-governance.test.ts",
      "server/tests/multitenancy/support/admin-separation.ts",
      "server/tests/multitenancy/support/routing-policy.ts",
      "server/tests/multitenancy/support/credentials-ownership.ts",
    ],
  },
  {
    id: "EB-MOBILE-OPENMUSE-LONGTAIL",
    prefixes: ["/api/mobile", "/api/public/openmuse-google"],
    disposition: "blocked-open",
    source: "§8 row 16 (Web、移动端、桌面及内部接入) + MT136/MT140",
    reason:
      "MT136 mapped the mobile aggregate + goals/ideas/memories/mail list/notifications list + google connect; MT140 delivered the three-client selection/cache/stream/media evidence at CI level; the per-domain file/task/mail-thread/calendar/reviewed-action entrances remain open (client-side rules already pinned in the submodule suites)",
    domainEvidence: [
      "server/tests/multitenancy/coverage-craft-openmuse.test.ts",
      "apps/openmuse/apps/mobile/src/openbot/tenancy.test.ts",
      "apps/openmuse/apps/mobile/src/openbot/transport.test.ts",
      "apps/openmuse/apps/mobile/src/openbot/aggregation.test.ts",
    ],
  },
  {
    id: "EB-MARKETPLACE",
    prefixes: ["/api/marketplace"],
    disposition: "blocked-open",
    source: "§8 row 2 (专家安装)",
    reason:
      "skills install entrances are mapped (MT134); marketplace listing + expert install remainders are open (fixture exists)",
    domainEvidence: [
      "server/tests/multitenancy/support/marketplace-install.ts",
    ],
  },
  {
    id: "EB-APPROVALS-HOSTACCESS-PASSWORDS",
    prefixes: ["/api/approvals", "/api/host-access", "/api/passwords"],
    disposition: "blocked-open",
    source: "§8 row 8 (审批、保存的登录与 Host Access)",
    reason:
      "shared-use approvals entrances are mapped (MT134); rules/team rules/preferences/decision flows, host-access grants and saved-passwords remainders are open (fixtures exist)",
    domainEvidence: [
      "server/tests/multitenancy/coverage-plugins-knowledge.test.ts",
      "server/tests/multitenancy/support/shared-approvals.ts",
      "server/tests/multitenancy/support/host-access.ts",
    ],
  },
  {
    id: "EB-MODEL-PROVIDER-RUNTIME",
    prefixes: [
      "/api/model-provider",
      "/api/model-access",
      "/api/model-discovery",
      "/api/copilotkit",
      "/api/threads/mint",
      "WS <preview-host>",
    ],
    disposition: "blocked-open",
    source: "§8 row 12 (Enterprise Run 与执行协议) + ADR 0003",
    reason:
      "personal Bifrost admission and Copilot runtime entrances need the runtime protocol execution; payer-account routing evidence exists store-level (ADR 0003 seam)",
    domainEvidence: [
      "server/tests/multitenancy/support/payer-accounts.ts",
      "server/tests/multitenancy/support/personal-bot.ts",
    ],
  },
  {
    id: "EB-SETTINGS-PREFERENCES",
    prefixes: ["/api/settings", "/api/model-selection"],
    disposition: "blocked-open",
    source: "§8 row 15",
    reason: "preferences fixtures exist; entrance mapping is open",
    domainEvidence: ["server/tests/multitenancy/support/preferences.ts"],
  },
];

/** All non-global dispositions require open work or an environment; the release gate stays closed. */
export function releaseReadiness(): {
  ready: boolean;
  blockers: readonly string[];
} {
  const blockers: string[] = [];
  for (const bucket of ENTRANCE_BUCKETS) {
    if (bucket.disposition !== "global-exception") blockers.push(bucket.id);
  }
  for (const item of UNVERIFIED_ITEMS) blockers.push(item.id);
  for (const limit of DISCLOSED_LIMITS) blockers.push(limit.id);
  return { ready: blockers.length === 0, blockers };
}
