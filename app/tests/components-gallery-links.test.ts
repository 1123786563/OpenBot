import "./preload";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../tests/support/e2e-compat";

/*
 * The settings gallery route tree (MT094 / Issue #137) is a full copy of the admin components
 * routes under a new path, and its links came along for the ride: the gallery tiles and the
 * back-out links still pointed at `/admin/components*`, so a user who arrived through settings
 * navigated into the admin area instead of staying in the gallery. The admin copies keep their
 * own links — this pins only the settings-gallery copies.
 */

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);
const galleryDir = join(
  hereDir,
  "..",
  "src",
  "routes",
  "_authed",
  "settings",
  "components-gallery",
);

function readRoute(name: string): string {
  return readFileSync(join(galleryDir, name), "utf8");
}

test("the gallery index links tiles into the gallery, not the admin area", () => {
  const index = readRoute("index.tsx");
  expect(index).toContain(`to="/settings/components-gallery/$name"`);
  expect(index).not.toContain('"/admin/components');
});

test("the gallery detail page backs out into the gallery, not the admin area", () => {
  const detail = readRoute("$name.tsx");
  expect(detail).toContain(`{ to: "/settings/components-gallery" }`);
  expect(detail).toContain(`<Link to="/settings/components-gallery" />`);
  expect(detail).not.toContain('"/admin/components');
});
