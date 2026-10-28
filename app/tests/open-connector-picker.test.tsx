import "./preload";
import { expect, test } from "../../tests/support/e2e-compat";
import type { ComposioApp } from "@/lib/plugins/queries";
import { matchingApps } from "@/routes/_authed/admin/plugins/open-connector";

/**
 * What the OpenConnector picker lists, decided without drawing anything.
 *
 * The twin of `composio-picker.test.tsx` over the second broker's directory page, which is why it
 * is the same three facts in the same words: the order the list is read in, and that the two fields
 * a decision rests on — whether the app is already here, and how much it brings — arrive at the row
 * intact. The wire shape is the broker directory shape both brokers answer, so `ComposioApp` is
 * still the type name; see `openConnectorAppsQueryOptions`.
 *
 * "Unsupported apps are not offered" is NOT one of these cases, because it is not this module's
 * doing to pin: an `oauth2` provider arrives from the adapter as `unsupported` and the directory
 * route filters it before the wire, exactly as the Composio route filters its consent-only apps —
 * so a picker that received one would already be a server-side defect. The page asserts nothing
 * about the apps it should never have been handed.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `composio-picker.test.tsx`. Nothing here renders, though — `matchingApps` is exported as a
 * function rather than left inline in the map for exactly that reason, so the ordering and the
 * already-added marker can be asserted without a DOM, a router or a query client.
 */

/** A minimal but complete directory app, overridable per case. */
function app(overrides: Partial<ComposioApp> & { slug: string }): ComposioApp {
  return {
    name: "App",
    description: "Does something.",
    logo: null,
    categories: [],
    actionCount: 1,
    enabled: false,
    ...overrides,
  };
}

const GITHUB = app({
  slug: "github",
  name: "GitHub",
  description: "Repos, issues and pull requests.",
  actionCount: 96,
  enabled: true,
});

const HACKERNEWS = app({
  slug: "hackernews",
  name: "Hacker News",
  description: "Stories, comments and users.",
  actionCount: 7,
});

test("an app this deployment already has is offered as added, not as one more thing to add", () => {
  const listed = matchingApps([GITHUB, HACKERNEWS]);

  // Once, and carrying the flag the row branches on. An app that came back enabled and lost it
  // would draw a second Add button for something already here, and pressing it would ask the
  // server to add a duplicate.
  const github = listed.filter((entry) => entry.slug === "github");
  expect(github).toHaveLength(1);
  expect(github[0]?.enabled).toBe(true);

  // The other side of the same claim: an app that is genuinely not here stays addable.
  expect(listed.find((entry) => entry.slug === "hackernews")?.enabled).toBe(
    false,
  );
});

test("the size of the decision survives, however large the app", () => {
  const listed = matchingApps([GITHUB, HACKERNEWS]);

  // The count is the whole reason the row states one: an app is not a small thing to switch on,
  // and the number is what says so before anybody presses Add.
  expect(listed.find((entry) => entry.slug === "github")?.actionCount).toBe(96);
  expect(listed.find((entry) => entry.slug === "hackernews")?.actionCount).toBe(
    7,
  );
});

test("the directory is listed by name, and the container's own order is left alone", () => {
  const apps = [GITHUB, HACKERNEWS];
  const listed = matchingApps(apps);

  expect(listed.map((entry) => entry.name)).toEqual(["GitHub", "Hacker News"]);
  // A copy: the query's cached array is the same object every render, and sorting it in place
  // would rewrite what TanStack Query holds.
  expect(apps.map((entry) => entry.name)).toEqual(["GitHub", "Hacker News"]);
  expect(listed).not.toBe(apps);
});
