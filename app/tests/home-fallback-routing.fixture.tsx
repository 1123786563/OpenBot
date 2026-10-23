import type { ReactNode } from "react";
import { afterAll, mock } from "../../tests/support/bun-test-compat";

/*
 * Each handle is kept so the registry entries can be given back when this suite ends. Bun's
 * mock.module is process-wide and, as of Bun 1.4.2, returns no restore handle (probed:
 * undefined) — the afterAll below is inert on this runtime and starts unregistering the day
 * Bun ships the handle; until then these mocks stay behind for the later files of the host
 * group's single `bun test` process, all of which run (and pass) under them.
 */
const uninstallMocks: unknown[] = [
  mock.module("@/components/layout/sidebar-toggle", () => ({
    SidebarToggleBar: () => <div data-testid="sidebar-toggle-bar" />,
  })),

  mock.module("@/components/ui/carousel", () => ({
    Carousel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    CarouselContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    CarouselItem: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    CarouselNext: () => <button type="button">Next agents</button>,
    CarouselPrevious: () => <button type="button">Previous agents</button>,
  })),
];

afterAll(() => {
  for (const uninstall of uninstallMocks) {
    if (typeof uninstall === "function") (uninstall as () => void)();
  }
});
