import "./preload";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import { ObservabilityPlaceholder } from "../src/components/ai-observability/placeholder";
import { routeTree } from "../src/routeTree.gen";

/*
 * T02 claims the four observation URLs so the chain tickets (#18 run list/detail, #27 datasets,
 * #36 experiments, #42 admin) each land on an address that already exists. Asserting against the
 * generated tree — not the source files — is what proves the URLs the router will actually serve,
 * and the id chain — which URL paths do not carry — is what proves a route typed straight into the
 * address bar still walks the guards its layouts impose: `/_authed` checks the session, and
 * `/_authed/admin` additionally checks the admin role, so hiding the nav link is not the control.
 */
const OBSERVABILITY_ROUTES = [
  { url: "/bots/$agentId/runs", id: "/_authed/_app/bots/$agentId/runs" },
  {
    url: "/bots/$agentId/runs/$bindingId",
    id: "/_authed/_app/bots/$agentId/runs/$bindingId",
  },
  {
    url: "/bots/$agentId/evaluations",
    id: "/_authed/_app/bots/$agentId/evaluations",
  },
  {
    url: "/bots/$agentId/evaluations/$datasetId",
    id: "/_authed/_app/bots/$agentId/evaluations/$datasetId",
  },
  {
    url: "/bots/$agentId/exports",
    id: "/_authed/_app/bots/$agentId/exports",
  },
  {
    url: "/bots/$agentId/evaluations/experiments/$experimentId/$executionId",
    id: "/_authed/_app/bots/$agentId/evaluations/experiments/$experimentId/$executionId",
  },
  {
    url: "/bots/$agentId/evaluations/experiment-comparisons",
    id: "/_authed/_app/bots/$agentId/evaluations/experiment-comparisons",
  },
  { url: "/admin/ai-observability", id: "/_authed/admin/ai-observability" },
];

/**
 * The runtime shape of a route inside the generated tree: children hang off the instance, while
 * `path` and `id` live on `options`. Neither carries its ancestors, so the walk threads both
 * through — pathless layouts (`_authed`, `_app`) contribute their id to the id chain and nothing
 * to the URL.
 */
interface TreeNode {
  children?: TreeNode[];
  options?: { path?: string; id?: string };
}

function flatten(
  node: TreeNode,
  urlPrefix = "",
  idPrefix = "",
): { url: string; id: string }[] {
  const segment = node.options?.path;
  const url = joinUrl(urlPrefix, segment);
  const id = joinUrl(idPrefix, node.options?.id ?? segment);
  const self = url === "" ? [] : [{ url, id }];
  return [
    ...self,
    ...(node.children ?? []).flatMap((c) => flatten(c, url, id)),
  ];
}

function joinUrl(prefix: string, segment?: string): string {
  if (segment === undefined || segment === "") return prefix;
  if (prefix === "") return segment;
  return `${prefix.replace(/\/$/, "")}/${segment.replace(/^\//, "")}`;
}

beforeAll(async () => {
  await GlobalRegistrator.register();
});
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("observability placeholder routes", () => {
  test("the four observation routes exist at the agreed URLs, under the authed layouts", () => {
    const routes = flatten(routeTree as unknown as TreeNode);
    for (const expected of OBSERVABILITY_ROUTES) {
      const found = routes.find(
        ({ url, id }) => url === expected.url && id === expected.id,
      );
      expect(
        found,
        `${expected.url} must sit at ${expected.id}, so a directly typed URL still hits the layout guards`,
      ).toBeDefined();
    }
  });

  test("a placeholder says what it is, announced as a status", () => {
    // Only the experiment chains (#36 #37) still ship a placeholder; the runs chain, the
    // datasets chain and #42's two pages render real pages now, and their placeholder copy
    // was deleted with the placeholder routes.
    for (const namespace of ["ai-observability-evaluations"] as const) {
      /*
       * Queries come off the `render` result rather than the global `screen`: module imports
       * evaluate before `beforeAll` can install happy-dom, and `screen` bakes in its no-document
       * fallback at import time, so every query on it throws no matter what `beforeAll` did.
       */
      const { getByRole, unmount } = render(
        <ObservabilityPlaceholder namespace={namespace} />,
      );
      const status = getByRole("status");
      expect(status.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      unmount();
    }
  });
});
