import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, screen } from "@testing-library/react";
import { ObservabilityPlaceholder } from "../src/components/ai-observability/placeholder";
import type { Route } from "../src/routeTree.gen";
import { routeTree } from "../src/routeTree.gen";

/*
 * T02 claims the four observation URLs so the chain tickets (#18 run list/detail, #27 datasets,
 * #36 experiments, #42 admin) each land on an address that already exists. Asserting against the
 * generated tree — not the source files — is what proves the URLs the router will actually serve.
 */
const OBSERVABILITY_PATHS = [
  "/bots/$agentId/runs",
  "/bots/$agentId/runs/$bindingId",
  "/bots/$agentId/evaluations",
  "/admin/ai-observability",
];

function pathsOf(routes: Route[], into: string[] = []): string[] {
  for (const route of routes) {
    into.push(route.fullPath);
    if (route.children.length > 0) pathsOf(route.children, into);
  }
  return into;
}

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

describe("observability placeholder routes", () => {
  test("the four observation routes exist at the agreed URLs", () => {
    const paths = pathsOf(routeTree.routes);
    for (const path of OBSERVABILITY_PATHS) {
      expect(paths, `route tree must contain ${path}`).toContain(path);
    }
  });

  test("a placeholder says what it is, announced as a status", () => {
    for (const namespace of [
      "ai-observability-runs",
      "ai-observability-evaluations",
      "ai-observability-admin",
    ] as const) {
      const { unmount } = render(
        <ObservabilityPlaceholder namespace={namespace} />,
      );
      const status = screen.getByRole("status");
      expect(status.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      unmount();
    }
  });
});
