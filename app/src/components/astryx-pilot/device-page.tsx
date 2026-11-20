import type { ComponentProps } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { AstryxSurface } from "./theme";

export function DevicePage(props: ComponentProps<typeof PageShell>) {
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell {...props} />
    </AstryxSurface>
  );
}
