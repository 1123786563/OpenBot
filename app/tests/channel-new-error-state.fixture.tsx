import { afterAll, mock } from "../../tests/support/bun-test-compat";

/*
 * The handle is kept so the registry entry can be given back when this suite ends. Bun's
 * mock.module is process-wide and, as of Bun 1.4.2, returns no restore handle (probed:
 * undefined) — the afterAll below is inert on this runtime and starts unregistering the day
 * Bun ships the handle; until then the mock stays behind for the later files of the host
 * group's single `bun test` process, all of which run (and pass) under it.
 */
const uninstallMocks: unknown[] = [
  mock.module("@/components/layout/sidebar-toggle", () => ({
    SidebarToggle: () => <button type="button">Toggle sidebar</button>,
  })),
];

afterAll(() => {
  for (const uninstall of uninstallMocks) {
    if (typeof uninstall === "function") (uninstall as () => void)();
  }
});
