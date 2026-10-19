import { mock } from "../../tests/support/bun-test-compat";

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggle: () => <button type="button">Toggle sidebar</button>,
}));
