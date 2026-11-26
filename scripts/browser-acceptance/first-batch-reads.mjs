export function firstBatchRead(request, path, json) {
  if (request.method !== "GET") return undefined;
  const skill = {
    id: "fixture-skill",
    slug: "fixture-skill",
    ownerUserId: null,
    title: "Sort the inbox",
    summary: "Groups mail by when it needs a reply",
    instructions: "Group unread mail by urgency.",
    origin: "admin",
    installedBy: null,
    grantedTo: ["whatif-sales"],
    tools: [],
  };
  const reads = {
    "/api/admin/credentials": {
      credentials: [
        {
          id: "fixture-key",
          kind: "connector",
          provider: "notion",
          keyId: "workspace",
          metadata: {},
          revokedAt: null,
        },
      ],
    },
    "/api/admin/credentials/fixture-key/usage": {
      usage: {
        features: ["Notion app"],
        bots: [{ id: "whatif-sales", name: "Sales" }],
      },
    },
    "/api/admin/identity-providers": {
      providers: [
        {
          providerId: "fixture-sso",
          domain: "example.test",
          issuer: "https://sso.example.test",
          protocol: "saml",
          registeredBy: "fixture",
        },
      ],
    },
    "/api/admin/identity-providers/fixture-sso/impact": {
      impact: {
        losing: { total: 1, emails: ["member@example.test"] },
        keeping: { total: 0, accounts: [] },
        includesYou: false,
      },
    },
    "/api/passwords": { passwordManager: true, logins: [] },
    "/api/plugins": { catalogue: [], servers: [], skills: [skill] },
    "/api/plugins/for/whatif-sales": {
      catalogue: [],
      servers: [],
      skills: [skill],
    },
    "/api/memory": { memories: [] },
    "/api/memory/sources": { sources: [] },
    "/api/agents/whatif-sales": {
      agent: { id: "whatif-sales", name: "Sales" },
    },
    "/api/components/for-agent/whatif-sales": { components: [] },
    "/api/components/functions": { functions: [] },
    "/api/components": {
      components: [
        {
          name: "chat",
          title: "Fixture chat card",
          kind: "builtin",
          draftDescription: "Shows the result of a conversation.",
          publishedDescription: null,
          published: false,
          updatedAt: "2026-11-26T00:00:00Z",
          hasUnpublishedChanges: true,
          withheldFrom: [],
          functions: [],
        },
      ],
    },
  };
  return Object.hasOwn(reads, path) ? json(reads[path]) : undefined;
}
