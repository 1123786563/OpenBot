// MT101 (Issue #144): the desktop's company-and-team choice. The Rust suites
// (cargo test org_context) pin the frozen-context gate itself — this suite pins
// what the person sees and what the screen sends: the choice lists only what
// the eligibility catalog says, a commit carries identifiers only and goes
// through the native validation, a refusal is shown and never re-homed, no
// organization is an empty state rather than a default, and the workbench URL
// carries the frozen pair under the same names the web selection reads.

import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  test,
} from "../../tests/support/e2e-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { within } from "@testing-library/react";

import {
  companyChoiceState,
  CompanySelection,
  type CompanyCatalog,
  type OrgContextStatus,
  selectionOf,
  withWorkbenchSelection,
} from "./CompanySelection";

type Recorded = { command: string; args?: unknown };

let invokeCalls: Recorded[] = [];
let statusAnswer: { __error: string } | OrgContextStatus | null = null;
let establishAnswers: Array<{ __error: string } | OrgContextStatus> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    if (command === "org_context_status") {
      if (statusAnswer && "__error" in statusAnswer)
        throw new Error(statusAnswer.__error);
      return statusAnswer;
    }
    if (command === "establish_org_context") {
      const answer = establishAnswers.shift();
      if (answer && "__error" in answer) throw new Error(answer.__error);
      return answer;
    }
    throw new Error(`unexpected command: ${command}`);
  },
}));

const ROOT = "/fixtures/openbot";

const ACME_STATUS: OrgContextStatus = {
  authority: "https://acme.example",
  user: {
    id: "user-1",
    email: "person@acme.example",
    name: null,
    role: "member",
  },
  company: {
    tenantId: "acme",
    name: "Acme",
    role: "member",
    memberEpoch: 7,
  },
  team: { workspaceId: "acme-finance", name: "Finance" },
  establishedAtMs: 1_000_000_000_000,
  verifiedAtMs: 1_000_000_000_000,
};

const ORG_ONLY_STATUS: OrgContextStatus = {
  ...ACME_STATUS,
  company: null,
  team: null,
};

const CATALOG: CompanyCatalog = {
  companies: [
    {
      tenantId: "acme",
      name: "Acme",
      role: "member",
      memberEpoch: 7,
      teams: [
        { workspaceId: "acme-finance", name: "Finance" },
        { workspaceId: "acme-ops", name: "Ops" },
      ],
    },
    {
      tenantId: "globex",
      name: "Globex",
      role: "member",
      memberEpoch: 2,
      teams: [{ workspaceId: "globex-ops", name: "Ops" }],
    },
  ],
};

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  invokeCalls = [];
  statusAnswer = null;
  establishAnswers = [];
});
afterAll(() => GlobalRegistrator.unregister());

test("no verified organization is an empty state, not a default", async () => {
  statusAnswer = null;
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "answered", catalog: CATALOG }}
      onOpenWorkbench={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      within(document.body!).getByText(/not signed in to an organization/i),
    ).toBeTruthy(),
  );
  // Nothing is listed and nothing is frozen: an empty eligibility world renders as one.
  expect(document.body!.querySelectorAll("option").length).toBe(0);
  expect(
    invokeCalls.filter((call) => call.command === "establish_org_context"),
  ).toHaveLength(0);
});

test("a complete frozen pair is shown, and nothing else is asked", async () => {
  statusAnswer = ACME_STATUS;
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "pending" }}
      onOpenWorkbench={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      within(document.body!).getByTestId("frozen-selection").textContent,
    ).toContain("Acme"),
  );
  expect(
    within(document.body!).getByTestId("frozen-selection").textContent,
  ).toContain("Finance");
  expect(
    invokeCalls.filter((call) => call.command === "establish_org_context"),
  ).toHaveLength(0);
});

test("the chooser lists exactly the catalog's companies and teams, and commits identifiers only", async () => {
  statusAnswer = ORG_ONLY_STATUS;
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "answered", catalog: CATALOG }}
      onOpenWorkbench={() => {}}
    />,
  );
  const company = await waitFor(() =>
    within(document.body!).getByLabelText("Company"),
  );
  const options = Array.from(company.querySelectorAll("option"));
  // The placeholder plus exactly the catalog's companies — no invented, no default-selected.
  expect(options.map((option) => option.textContent)).toEqual([
    "Choose a company…",
    "Acme",
    "Globex",
  ]);

  // The commit button is disabled until BOTH halves are chosen — a company without a team is
  // not a scope, the same refusal the web side applies to half a pair.
  const commit = within(document.body!).getByRole("button", {
    name: "Work in this company and team",
  });
  expect(commit.hasAttribute("disabled")).toBe(true);

  await act(async () => {
    fireEvent.change(company, { target: { value: "acme" } });
  });
  const team = within(document.body!).getByLabelText("Team");
  expect(
    Array.from(team.querySelectorAll("option")).map(
      (option) => option.textContent,
    ),
  ).toEqual(["Choose a team…", "Finance", "Ops"]);
  expect(commit.hasAttribute("disabled")).toBe(true);

  establishAnswers = [ACME_STATUS];
  await act(async () => {
    fireEvent.change(team, { target: { value: "acme-finance" } });
  });
  await act(async () => {
    fireEvent.click(commit);
  });
  await waitFor(() =>
    expect(
      within(document.body!).getByTestId("frozen-selection").textContent,
    ).toContain("Finance"),
  );

  // The establish payload is identifiers only: no provider, no key, no credential field exists.
  const establishCalls = invokeCalls.filter(
    (call) => call.command === "establish_org_context",
  );
  expect(establishCalls).toHaveLength(1);
  expect(establishCalls[0]!.args).toEqual({
    root: ROOT,
    tenantId: "acme",
    workspaceId: "acme-finance",
  });
});

test("a refused choice is shown with its code and the frozen selection is not re-homed", async () => {
  statusAnswer = { ...ACME_STATUS, company: ACME_STATUS.company, team: null };
  establishAnswers = [
    {
      __error:
        "OpenBot could not freeze that organization context. (ORG_CONTEXT_SELECTION_UNKNOWN)",
    },
    ACME_STATUS,
  ];
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "answered", catalog: CATALOG }}
      onOpenWorkbench={() => {}}
    />,
  );
  // The incomplete frozen company stays on screen while the choice is attempted.
  await waitFor(() =>
    expect(
      within(document.body!).getByTestId("frozen-selection").textContent,
    ).toContain("Acme"),
  );

  const company = await within(document.body!).getByLabelText("Company");
  await act(async () => {
    fireEvent.change(company, { target: { value: "globex" } });
  });
  const team = within(document.body!).getByLabelText("Team");
  await act(async () => {
    fireEvent.change(team, { target: { value: "globex-ops" } });
  });
  await act(async () => {
    fireEvent.click(
      within(document.body!).getByRole("button", {
        name: "Work in this company and team",
      }),
    );
  });
  await waitFor(() =>
    expect(within(document.body!).getByRole("alert").textContent).toContain(
      "ORG_CONTEXT_SELECTION_UNKNOWN",
    ),
  );
  // The refused choice did not become anything: the frozen selection is still what it was.
  expect(
    within(document.body!).getByTestId("frozen-selection").textContent,
  ).toContain("Acme");

  // A retry with an answerable choice still works — the failure never wedges the screen.
  await act(async () => {
    fireEvent.click(
      within(document.body!).getByRole("button", {
        name: "Work in this company and team",
      }),
    );
  });
  await waitFor(() =>
    expect(
      within(document.body!).getByTestId("frozen-selection").textContent,
    ).toContain("Finance"),
  );
});

test("an empty catalog is the empty state: no company is invented to choose", async () => {
  statusAnswer = ORG_ONLY_STATUS;
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "answered", catalog: { companies: [] } }}
      onOpenWorkbench={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      within(document.body!).getByText(/do not belong to any company/i),
    ).toBeTruthy(),
  );
  expect(document.body!.querySelectorAll("option").length).toBe(0);
});

test("a status read failure is a connection problem with a retry, never an eligibility answer", async () => {
  statusAnswer = {
    __error: "OpenBot could not read its organization context.",
  };
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "answered", catalog: CATALOG }}
      onOpenWorkbench={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      within(document.body!).getByText(/connection problem/i),
    ).toBeTruthy(),
  );
  statusAnswer = ACME_STATUS;
  await act(async () => {
    fireEvent.click(
      within(document.body!).getByRole("button", { name: "Try again" }),
    );
  });
  await waitFor(() =>
    expect(
      within(document.body!).getByTestId("frozen-selection").textContent,
    ).toContain("Acme"),
  );
});

test("the screen never offers a credential field, and the personal-models note stays", async () => {
  statusAnswer = ORG_ONLY_STATUS;
  render(
    <CompanySelection
      root={ROOT}
      catalog={{ status: "answered", catalog: CATALOG }}
      onOpenWorkbench={() => {}}
    />,
  );
  await waitFor(() =>
    expect(within(document.body!).getByLabelText("Company")).toBeTruthy(),
  );
  expect(document.body!.querySelectorAll("input[type=password]").length).toBe(
    0,
  );
  expect(
    within(document.body!).getByText(
      /personal model connections stay personal/i,
    ),
  ).toBeTruthy();
});

test("withWorkbenchSelection carries the pair under the web's own names, and nothing else", () => {
  // The same two names the web selection reads from a URL (`company`, `team`), so the
  // workbench starts under the frozen scope the way a deep link would.
  expect(
    withWorkbenchSelection("/?ticket=one-use", {
      tenantId: "acme",
      workspaceId: "acme finance",
    }),
  ).toBe("/?ticket=one-use&company=acme&team=acme%20finance");
  expect(
    withWorkbenchSelection("/app", {
      tenantId: "acme",
      workspaceId: "acme-finance",
    }),
  ).toBe("/app?company=acme&team=acme-finance");
  // Absence is carried as absence, never defaulted — and an unowned URL shape is left alone.
  expect(withWorkbenchSelection("/?ticket=one-use", null)).toBe(
    "/?ticket=one-use",
  );
  expect(
    withWorkbenchSelection("https://elsewhere.example/app", {
      tenantId: "acme",
      workspaceId: "acme-finance",
    }),
  ).toBe("https://elsewhere.example/app");
  expect(
    withWorkbenchSelection("//protocol.relative/app", {
      tenantId: "acme",
      workspaceId: "acme-finance",
    }),
  ).toBe("//protocol.relative/app");
});

test("the state machine maps the frozen world onto the same refusal kinds as the web", () => {
  expect(companyChoiceState({ status: "pending" })).toEqual({
    kind: "loading",
  });
  expect(
    companyChoiceState({
      status: "error",
      problem: { said: "unreachable" },
    }),
  ).toEqual({ kind: "error", problem: { said: "unreachable" } });
  expect(companyChoiceState({ status: "answered", frozen: null })).toEqual({
    kind: "no-organization",
  });
  expect(
    companyChoiceState({ status: "answered", frozen: ORG_ONLY_STATUS }),
  ).toEqual({
    kind: "choosing",
    frozen: ORG_ONLY_STATUS,
  });
  const incomplete = {
    ...ACME_STATUS,
    team: null,
  };
  expect(
    companyChoiceState({ status: "answered", frozen: incomplete }),
  ).toEqual({ kind: "incomplete", frozen: incomplete });
  expect(
    companyChoiceState({ status: "answered", frozen: ACME_STATUS }),
  ).toEqual({
    kind: "chosen",
    frozen: ACME_STATUS,
  });

  expect(selectionOf(ORG_ONLY_STATUS)).toBeNull();
  expect(selectionOf(incomplete)).toBeNull();
  expect(selectionOf(ACME_STATUS)).toEqual({
    tenantId: "acme",
    workspaceId: "acme-finance",
  });
});
