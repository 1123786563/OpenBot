import type { ComponentProps, ReactNode } from "react";
import { BotFormAction } from "@/components/astryx-pilot/bot-actions";
import {
  AstryxSurface,
  astryxPilot,
  astryxScope,
} from "@/components/astryx-pilot/theme";
import { Button } from "@/components/ui/button";
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
    <DialogContent
      {...astryxScope}
      className={astryxPilot ? "astryx-bot-dialog" : undefined}
    >
      {children}
    </DialogContent>
  );
}

export function BotDetailFormAction(
  props: ComponentProps<typeof BotFormAction>,
) {
  return astryxPilot ? (
    <BotFormAction {...props} />
  ) : (
    <Button {...props} size="sm" />
  );
}
