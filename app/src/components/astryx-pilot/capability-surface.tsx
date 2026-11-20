import type { ComponentProps, ReactNode } from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { PageShell } from "@/components/layout/page-shell";
import "./capability-surface.css";

export function CapabilitySurface({ children }: { children: ReactNode }) {
  return (
    <AstryxSurface className="astryx-capability-surface flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
    </AstryxSurface>
  );
}

export function CapabilityPage(props: ComponentProps<typeof PageShell>) {
  return (
    <CapabilitySurface>
      <PageShell {...props} />
    </CapabilitySurface>
  );
}
