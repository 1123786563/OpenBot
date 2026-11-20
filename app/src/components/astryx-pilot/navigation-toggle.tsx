import { Button } from "@astryxdesign/core/Button";
import { IconLayoutSidebar } from "@tabler/icons-react";
import type { RefObject } from "react";
import { useSidebar } from "@/components/ui/sidebar";

export function AstryxNavigationToggle({
  navId,
  drawerId = navId,
  trigger,
  label = "navigation",
}: {
  navId: string;
  drawerId?: string;
  trigger: RefObject<HTMLButtonElement | null>;
  label?: string;
}) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;

  return (
    <Button
      aria-controls={isMobile ? (expanded ? drawerId : undefined) : navId}
      aria-expanded={expanded}
      aria-haspopup={isMobile ? "dialog" : undefined}
      icon={<IconLayoutSidebar aria-hidden size={20} />}
      isIconOnly
      label={`${expanded ? "Close" : "Open"} ${label}`}
      onClick={toggleSidebar}
      ref={trigger}
      variant="ghost"
    />
  );
}
