import type { ComponentProps, ReactNode } from "react";
import { BotFormAction } from "@/components/astryx-pilot/bot-actions";
import { AstryxSurface, astryxScope } from "@/components/astryx-pilot/theme";
import { DialogContent } from "@/components/ui/dialog";
import "./detail-surface.css";

export function BotDetailSurface({ children }: { children: ReactNode }) {
  return (
    <AstryxSurface className="astryx-bot-detail flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
    </AstryxSurface>
  );
}

export function BotDetailDialog({ children }: { children: ReactNode }) {
  return (
    <DialogContent {...astryxScope} className={"astryx-bot-dialog"}>
      {children}
    </DialogContent>
  );
}

export function BotDetailFormAction(
  props: ComponentProps<typeof BotFormAction>,
) {
  return <BotFormAction {...props} />;
}
