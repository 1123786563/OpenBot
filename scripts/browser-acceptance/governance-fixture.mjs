import answers from "../../app/tests/what-if.fixture.json";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  DEFAULT_CAPABILITIES,
} from "../../server/src/admin/capabilities.ts";
import {
  applyCapabilityChanges,
  previewCapabilityChanges,
} from "../../server/src/admin/capability-changes.ts";

export const boundary = 'page.host == "blocked.example.test"';
export const boundaryName = "Blocked fixture host";
const member = {
  id: "fixture-member",
  email: "member@example.test",
  name: "Fixture Member",
  image: null,
  role: "user",
  providers: ["google"],
  lastSignedInAt: null,
  revoked: false,
  configuredAdmin: false,
  groups: [],
};
const approval = {
  toolRef: "whatif-gmail/send_email",
  scope: "whatif-gmail",
  effect: "write",
  botId: "whatif-sales",
  behaviour: "ask",
};

let scenario;
let policy;
let rows;
let teamRules;
const requests = [];
export const governance = {
  get edition() {
    return scenario?.edition ?? "team";
  },
  get role() {
    return scenario?.role ?? "admin";
  },
  async respond(request, path, json) {
    if (path === "/__fixture/governance" && request.method === "PUT") {
      scenario = await request.json();
      policy = {
        mode: "enforce",
        deny: [boundary],
        allow: ["true"],
        labels: { [boundary]: { name: boundaryName, description: "" } },
      };
      rows = [];
      teamRules = [];
      requests.length = 0;
      return json({ ready: true });
    }
    if (!scenario) return undefined;
    if (path === "/__fixture/governance" && request.method === "PATCH") {
      Object.assign(scenario, await request.json());
      return json({ ready: true });
    }
    if (path === "/__fixture/governance") return json({ requests, policy });
    if (
      request.method === "GET" ||
      request.method === "PUT" ||
      request.method === "POST"
    ) {
      requests.push({ method: request.method, path });
    }
    switch (path) {
      case "/api/agents":
        return json({ agents: [{ id: "whatif-sales", name: "Sales" }] });
      case "/api/computers/policy":
        if (request.method === "GET") {
          return scenario.policyReadFailure
            ? json({ error: "Fixture policy read failed." }, 503)
            : json({ policy });
        }
        if (request.method === "PUT") {
          const { expected, ...updated } = await request.json();
          if (scenario.policyConflict) {
            policy = { ...policy, deny: [...policy.deny, "false"] };
            scenario.policyConflict = false;
          }
          if (expected && JSON.stringify(expected) !== JSON.stringify(policy)) {
            return json({ error: "The policy has changed." }, 409);
          }
          policy = updated;
          return json({ policy });
        }
        return undefined;
      case "/api/computers/policy-dry-run":
        return json({
          report: {
            scanned: 0,
            wouldRefuse: 0,
            wouldAllow: 0,
            unchanged: 0,
            changes: [],
          },
        });
      case "/api/admin/people":
        if (scenario.people === "loading") {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (scenario.people === "failed")
          return json({ error: "Fixture read failed." }, 503);
        if (scenario.people === "denied")
          return json({ error: "Fixture access denied." }, 403);
        return json({
          people: scenario.people === "empty" ? [] : [member],
          nextCursor: null,
        });
      case "/api/admin/audit-events":
        return json({ events: [answers.event], nextCursor: null });
      case `/api/admin/what-if/explain/${answers.event.id}`:
        return json(answers.explained);
      case "/api/admin/what-if/vocabulary":
        return json(answers.vocabulary);
      case "/api/admin/what-if/ask":
        return scenario.whatIfDenied
          ? json({ error: "Fixture access denied." }, 403)
          : json({
              understood: "yes",
              action: answers.checked.action,
              labels: answers.checked.labels,
              missing: null,
            });
      case "/api/admin/what-if/check":
        return json(answers.checked);
      case "/api/approvals":
        return json({
          enabled: true,
          requests: [],
          rules: [],
          teamRules,
          questions: [],
          preferences: {
            enabled: true,
            autoReview: false,
            hostCommands: "ask",
          },
          hostCommands: "ask",
          ...(scenario.edition !== "personal" && {
            team: {
              enforceAutoReview: false,
              customRulesEnabled: true,
              hostCommandsCap: "ask",
            },
          }),
        });
      case "/api/approvals/team/guidance":
        return json({ guidance: null });
      case "/api/approvals/shared-use":
        return json({ requests: [] });
      case "/api/approvals/team/rules/translate":
        return json({
          rules: [
            {
              ...approval,
              behaviour: (await request.json()).text.includes("allow")
                ? "allow"
                : "ask",
            },
          ],
          summary: "Sales uses Gmail.",
          explanation: "This is a simulated rule.",
          check: { ok: true },
          warning: null,
        });
      case "/api/approvals/team/rules/backtest":
        return json({
          check: { ok: true },
          report: {
            scanned: 0,
            matched: 0,
            changed: 0,
            removedAsks: 0,
            removedDenied: 0,
            addedAsks: 0,
            fixed: 0,
            changes: [],
          },
        });
      case "/api/approvals/team/rules/batch": {
        const { rules } = await request.json();
        teamRules = rules.map((rule, index) => ({
          ...rule,
          id: `fixture-rule-${index}`,
          createdAt: new Date().toISOString(),
        }));
        return json({ rules: teamRules }, 201);
      }
      case "/api/admin/enterprise":
        return json({
          capabilities: CAPABILITIES.map((capability) => ({
            capability,
            ...CAPABILITY_LABELS[capability],
            default: DEFAULT_CAPABILITIES[capability],
            organization:
              rows.find((row) => row.capability === capability)?.allowed ??
              null,
            roles: {},
            groups: {},
          })),
          groups: [],
        });
      case "/api/admin/enterprise/capabilities/translate":
        return json({
          changes: [
            {
              scopeKind: "organization",
              scopeId: "",
              capability: "localComputer",
              allowed: (await request.json()).text.includes("allow"),
            },
          ],
          summary: "Change local computer access.",
          explanation: "This is a simulated permission change.",
          check: { ok: true },
          warning: null,
        });
      case "/api/admin/enterprise/capabilities/preview":
        return json({
          ...(await previewCapabilityChanges({
            changes: (await request.json()).changes,
            rows,
            members: [member],
            groups: [],
            now: new Date(),
          })),
          basedOn: rows,
        });
      case "/api/admin/enterprise/capabilities/batch": {
        const { changes } = await request.json();
        rows = applyCapabilityChanges(rows, changes);
        return json({ saved: changes });
      }
      default:
        return undefined;
    }
  },
};
