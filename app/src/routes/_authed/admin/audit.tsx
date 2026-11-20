import { IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { z } from "zod";
import { RecordingSection } from "@/components/admin/controls/recording-section";
import { GovernanceSurface } from "@/components/astryx-pilot/governance";
import { AuditPage } from "@/components/manage/audit-page";
import { buttonVariants } from "@/components/ui/button";
import { client } from "@/lib/client";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events. `bot` narrows it
 * to one Bot, which is how a Bot's own Activity page links here.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  validateSearch: z.object({ bot: z.string().optional() }),
  component: AdminAuditPage,
});

/**
 * The log, then what else is recorded and where it is exported.
 *
 * Search is read without `strict`, so the page also renders where it is mounted on a route of
 * another name, as the audit tests do. The route's own `validateSearch` has already checked it.
 */
function AdminAuditPage() {
  const { bot } = useSearch({ strict: false }) as { bot?: string };
  const navigate = useNavigate();
  const openObserve = useQuery({
    queryKey: ["admin", "audit", "openobserve"],
    queryFn: ({ signal }) =>
      client<string | null>("/api/admin/audit-events/openobserve", "url", {
        signal,
      }),
    gcTime: 0,
    retry: false,
  });
  return (
    <GovernanceSurface>
      <AuditPage
        action={
          openObserve.isSuccess && openObserve.data ? (
            <a
              className={buttonVariants({ variant: "outline" })}
              href={openObserve.data}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open in OpenObserve
              <IconExternalLink aria-hidden="true" />
            </a>
          ) : null
        }
        ask
        bot={bot}
        onClearBot={() => navigate({ to: "/admin/audit" })}
      >
        <RecordingSection />
      </AuditPage>
    </GovernanceSurface>
  );
}
