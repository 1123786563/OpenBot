import { afterAll, spyOn } from "bun:test";
import * as SidebarToggle from "@/components/layout/sidebar-toggle";

/*
 * A restorable stand-in for the sidebar toggle bar, installed as a NAMESPACE SPY rather than
 * `mock.module`, because bun cannot take a module mock back off: a registry-level mock would stay
 * installed for every test file walked into the same process afterwards (see
 * composer-queue-attachments.test.tsx). A spy is restorable, and the `afterAll` below genuinely
 * puts the real component back.
 */
const sidebarToggleBarSpy = spyOn(
  SidebarToggle,
  "SidebarToggleBar",
).mockImplementation(() => <div data-testid="sidebar-toggle-bar" />);

afterAll(() => sidebarToggleBarSpy.mockRestore());
