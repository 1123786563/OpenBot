import type { ComponentProps } from "react";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { PageShell } from "@/components/layout/page-shell";

export function AstryxAdminPage(props: ComponentProps<typeof PageShell>) {
  return (
    <AstryxSurface className="astryx-admin-page flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell {...props} />
    </AstryxSurface>
  );
}
