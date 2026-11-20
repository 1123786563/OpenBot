import type { ReactNode } from "react";
import { AstryxSurface, astryxPilot } from "@/components/astryx-pilot/theme";

export function ConversationSurface({
  children,
  fill = false,
}: {
  children: ReactNode;
  fill?: boolean;
}) {
  if (!astryxPilot) {
    return fill ? (
      <div className="flex h-full min-h-0 flex-col">{children}</div>
    ) : (
      children
    );
  }
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col [&_[data-slot=composer]]:rounded-(--radius-container) [&_[data-slot=composer]]:bg-(--color-background-surface) [&_[data-slot=conversation-header]]:bg-(--color-background-surface) [&_[data-conversation-recipients]:has(:focus-visible)]:outline-2 [&_[data-conversation-recipients]:has(:focus-visible)]:outline-ring">
      {children}
    </AstryxSurface>
  );
}
