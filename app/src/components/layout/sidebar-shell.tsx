import { type CSSProperties, type ReactNode, useState } from "react";

import { SidebarProvider } from "@/components/ui/sidebar";
import {
  applySidebarOpen,
  parseStoredSidebarOpen,
  SIDEBAR_STORAGE_KEY,
} from "@/lib/sidebar";

/**
 * The frame the three shells — app, admin, settings — hang their sidebar in.
 *
 * It exists for one reason: the open/closed state has to outlive a reload, and the primitive's
 * `SidebarProvider` cannot do that on its own (it writes a cookie nothing reads and hardcodes
 * `defaultOpen` to true). Driving it as controlled state is a dozen lines, and three copies of a
 * dozen lines is three chances for one shell to forget the preference the other two remember.
 *
 * `width` is what actually differs between the shells. The app's roster earns 340px because its
 * rows are two-line message previews; admin and settings hold short nav labels and earn 300px.
 */
export function SidebarShell({
  children,
  className,
  width,
  responsiveCompact = false,
}: {
  children: ReactNode;
  className?: string;
  width: string;
  /** Automatically closes the desktop rail without changing the saved preference. */
  responsiveCompact?: boolean;
}) {
  // Read before the first paint, so a shell somebody left collapsed never flashes open.
  const [open, setOpen] = useState(() =>
    parseStoredSidebarOpen(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)),
  );

  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  const effectiveOpen = manualOverride ?? (open && !responsiveCompact);
  const handleOpenChange = (next: boolean) => {
    setManualOverride(next);
    setOpen(next);
    applySidebarOpen(next, {
      setStoredValue: (key, value) => window.localStorage.setItem(key, value),
    });
  };

  return (
    <SidebarProvider
      className={className}
      onOpenChange={handleOpenChange}
      open={effectiveOpen}
      /* Sidebar's mobile Sheet consumes this variable directly below 768px. */
      style={
        {
          "--sidebar-width": width,
          "--sidebar-width-mobile": "min(280px, calc(100vw - 32px))",
        } as CSSProperties
      }
    >
      {children}
    </SidebarProvider>
  );
}
