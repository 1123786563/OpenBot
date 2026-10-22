import "./preload";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { CraftTaskEditorPresenter } from "@/components/craft/scheduled-task-editor";
import { DetailPanel } from "@/components/layout/detail-panel";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Sidebar, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { afterAll, afterEach, beforeAll, expect, test } from "../../tests/support/e2e-compat";
let originalObserver: typeof ResizeObserver;
beforeAll(() => {
  GlobalRegistrator.register();
  originalObserver = globalThis.ResizeObserver;
});
afterAll(() => {
  globalThis.ResizeObserver = originalObserver;
  GlobalRegistrator.unregister();
});
afterEach(() => { cleanup(); });
test("lifecycle probe c (imports only)", () => { expect(true).toBe(true); });
