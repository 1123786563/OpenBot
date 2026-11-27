import { DEFAULT_CAPABILITIES } from "../../server/src/admin/capabilities.ts";
import { CONVERSATIONS } from "./conversations.mjs";

const emptyLearningTarget = { containerId: null };
const emptyConnections = { connections: [], defaultConnectionId: null };

const reads = {
  "/api/bots/attention": { bots: [], lastPingId: null },
  "/api/bots/routing": {
    routing: {
      progress: "all",
      decision: "all",
      question: "all",
      attention: "all",
    },
  },
  "/api/browser": {
    available: false,
    computerId: "person-e05bab5fabaa1b9ab0c2c289601eca3f13",
    open: false,
    tabs: [],
  },
  "/api/agents/capabilities": {
    capabilities: { builtInAvailable: true, isolationAvailable: false },
  },
  "/api/tasks": { tasks: [] },
  "/api/responsibilities": { responsibilities: [] },
  "/api/responsibilities/sources/github": { bindings: [] },
  "/api/routines": {
    routines: [],
    sweep: { lastSweptAt: null, working: false },
  },
  "/api/proactive/settings": { settings: [], allowed: true },
  "/api/proactive/suggestions": { suggestions: [] },
  "/api/identity/providers": { providers: { slack: false, github: false } },
  "/api/identity/links": { links: [] },
  "/api/plugins/connections": { connections: [], redirectUri: null },
  "/api/plugins/giveable": { apps: [] },
  "/api/plugins/access-requests": {
    requests: [],
    counts: { total: 0, byApp: {} },
  },
  "/api/plugins/composio/apps": { apps: [] },
  "/api/corsair/github/connections": emptyConnections,
  "/api/corsair/github/connections/revocations": { connections: [] },
  "/api/corsair/slack/connections": emptyConnections,
  "/api/corsair/integrations": {
    catalogVersion: "fixture",
    corsairVersion: "fixture",
    total: 0,
    integrations: [],
  },
  "/api/recorder/connections": { connections: [], extensionIds: [] },
  "/api/recorder/recordings": { recordings: [], nextCursor: null },
  "/api/delivery": {
    bindings: [],
    devices: [],
    deliveries: [],
    available: { slack: false, teams: false, sms: false, push: false },
  },
  "/api/computers/fleet": { computers: [], isolation: "per-person" },
  "/api/host-access": {
    grants: [],
    pending: [],
    connected: false,
    desktop: false,
  },
  "/api/team-bots": { teamBots: [], publishable: [] },
  "/api/approvals/team/guidance/backtest": { calls: 0, skippedSafety: 0 },
  "/api/sandboxed": { components: [] },
  "/api/settings/learning": {
    mode: "closed",
    sharingAllowed: false,
    skills: [],
  },
  "/api/admin/audit-events/openobserve": { url: null },
  "/api/admin/enterprise/me": {
    capabilities: DEFAULT_CAPABILITIES,
    enforced: false,
  },
  "/api/admin/learning/settings": {
    settings: { enabled: false, defaultTarget: null, agents: {} },
  },
  "/api/admin/learning/overview": {
    overview: {
      configuration: "not_configured",
      pendingThreadCount: null,
      pendingCandidateCount: 0,
      publishedSkillCount: null,
      insightCount: null,
      hasActiveRun: false,
      latestRunStatus: null,
      links: { learning: null, candidates: null, runs: null },
    },
  },
  "/api/admin/learning/people/proposals": { people: [] },
  "/api/admin/learning/proposals": { ...emptyLearningTarget, proposals: [] },
  "/api/admin/learning/runs": { ...emptyLearningTarget, runs: [] },
  "/api/admin/learning/skills": { ...emptyLearningTarget, skills: [] },
  "/api/admin/learning/sharing-requests": { requests: [] },
};

export function sweepRead(
  request,
  path,
  json,
  { edition, role, salesBot, userId },
) {
  if (request.method !== "GET") return undefined;
  if (Object.hasOwn(reads, path)) return json(reads[path]);

  const url = new URL(request.url);
  const threadLearning = /^\/api\/copilotkit\/threads\/([^/]+)\/learn$/.exec(
    path,
  );
  if (threadLearning) {
    const [, threadId] = threadLearning;
    const seed = CONVERSATIONS.find(
      ({ id, bot }) =>
        id === threadId && bot === url.searchParams.get("agentId"),
    );
    if (seed) {
      return json({
        enabled: false,
        available: false,
        scope: { personId: userId, threadId, botId: seed.bot },
        autoApprove: false,
        latest: null,
        lastResult: null,
        schedule: {
          enabled: false,
          intervalHours: 24,
          nextAt: null,
          lastResult: null,
        },
        proposals: [],
      });
    }
  }
  const evidence =
    /^\/api\/copilotkit\/conversations\/([^/]+)\/learning-evidence$/.exec(path);
  if (evidence && CONVERSATIONS.some(({ id }) => id === evidence[1])) {
    return json({ allowed: false });
  }
  const lifecycle = /^\/api\/bots\/([^/]+)\/lifecycle$/.exec(path);
  if (lifecycle && knownBot(lifecycle[1], salesBot.id)) {
    return json({
      lifecycle: {
        agentId: lifecycle[1],
        paused: false,
        pausedAt: null,
        notify: "all",
      },
    });
  }
  const control = /^\/api\/computers\/([^/]+)\/control$/.exec(path);
  if (control && knownBot(control[1], salesBot.id)) {
    return json({
      holder: "bot",
      since: new Date(0).toISOString(),
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: false,
      recoveryRequired: false,
    });
  }

  switch (path) {
    case "/api/settings/learning/review":
      return json({
        mode: "openbot",
        conversations: [],
        autoApprove: edition === "personal" ? true : null,
      });
    case "/api/admin/enterprise/models/usage": {
      const days = Number(url.searchParams.get("days") || 30);
      return json({ days, summary: [], recent: [] });
    }
    case "/api/admin/proactive": {
      const days = Number(url.searchParams.get("days") || 7);
      return json({
        days,
        dailyRuns: 24,
        bots: [],
        pings: { sent: 0, itemsPerPing: null },
      });
    }
    case `/api/agents/${salesBot.id}/handoff`:
      return json({
        handoff: {
          enabled: false,
          canGrant: role === "admin",
          reachable: [],
          grantable: false,
        },
      });
    case `/api/bots/${salesBot.id}/activity`:
      return json({
        activity: {
          inProgress: [],
          scheduled: [],
          onDemand: [],
          completed: [],
        },
      });
    case "/api/voice/sessions":
      return CONVERSATIONS.some(
        ({ id }) => id === url.searchParams.get("channelId"),
      )
        ? json({ sessions: [], nextCursor: null })
        : json({ error: "A valid channel is required." }, 400);
    case "/api/components/for-agent/general":
      return json({ components: [] });
    case "/api/plugins/for/general":
      return json({ catalogue: [], servers: [], skills: [] });
    case `/api/memory/sources/available/${salesBot.id}`:
      return json({ tools: [] });
    case `/api/plugins/for/${salesBot.id}/apps`:
      return json({ apps: [] });
    case "/api/sign-in-requests/fixture-sign-in":
      return json({
        id: "fixture-sign-in",
        botId: salesBot.id,
        origin: "https://example.test",
        reason: null,
        status: "pending",
        method: null,
        outcome: null,
        threadId: null,
        toolCallId: null,
        controlRequestId: null,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        resolvedAt: null,
        passwordManager: true,
        savedLogins: [],
      });
    default:
      return undefined;
  }
}

function knownBot(id, salesBotId) {
  return id === salesBotId || CONVERSATIONS.some(({ bot }) => bot === id);
}
