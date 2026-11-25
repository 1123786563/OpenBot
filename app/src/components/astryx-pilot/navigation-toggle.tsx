import { Button } from "@astryxdesign/core/Button";
import { IconLayoutSidebar } from "@tabler/icons-react";
import type { RefObject } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useTranslation } from "@/i18n";

export function AstryxNavigationToggle({
  navId,
  drawerId = navId,
  trigger,
}: {
  navId: string;
  drawerId?: string;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const { t } = useTranslation();
  const expanded = isMobile ? openMobile : open;

  return (
    <Button
      aria-controls={isMobile ? (expanded ? drawerId : undefined) : navId}
      aria-expanded={expanded}
      aria-haspopup={isMobile ? "dialog" : undefined}
      icon={<IconLayoutSidebar aria-hidden size={20} />}
      isIconOnly
      label={
        expanded
          ? t("nav.closeNavigation", "Close navigation")
          : t("nav.openNavigation", "Open navigation")
      }
      onClick={toggleSidebar}
      ref={trigger}
      variant="ghost"
    />
  );
}
