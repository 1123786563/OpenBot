import { Button } from "@astryxdesign/core/Button";
import { IconLayoutSidebar } from "@tabler/icons-react";
import { type ReactNode, useId, useRef } from "react";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { UpdateBanner } from "@/components/layout/update-banner";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
import { AstryxBrand, astryxScope } from "./theme";

export function AstryxWebShell({ children }: { children: ReactNode }) {
  return (
    <SidebarShell
      className="astryx-web-shell h-svh overflow-hidden"
      name="astryx-app"
      pageToggle={false}
      width="280px"
    >
      <AstryxWebFrame>{children}</AstryxWebFrame>
    </SidebarShell>
  );
}

function AstryxWebFrame({ children }: { children: ReactNode }) {
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;

  return (
    <>
      <AppSidebar navId={navId} returnFocus={trigger} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <div {...astryxScope} className="astryx-web-bar">
          <Button
            aria-controls={isMobile && !expanded ? undefined : navId}
            aria-expanded={expanded}
            aria-haspopup={isMobile ? "dialog" : undefined}
            icon={<IconLayoutSidebar aria-hidden size={20} />}
            isIconOnly
            label={expanded ? "Close navigation" : "Open navigation"}
            onClick={toggleSidebar}
            ref={trigger}
            variant="ghost"
          />
          {isMobile || !expanded ? <AstryxBrand /> : null}
        </div>
        <UpdateBanner />
        <SelfHostBanner />
        {children}
      </SidebarInset>
    </>
  );
}
