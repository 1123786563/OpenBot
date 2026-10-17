import { mock } from "../../tests/support/e2e-compat";

mock.module("@/components/layout/sidebar-toggle", () => ({
  SidebarToggle: () => <button type="button">Toggle sidebar</button>,
}));
