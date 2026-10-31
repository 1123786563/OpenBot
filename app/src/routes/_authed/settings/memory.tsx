import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old local-memory settings page (#732). The memory service owns the whole view now, so
 * this address keeps working as a controlled entry to it — nothing here reads or writes the
 * old tables.
 */
export const Route = createFileRoute("/_authed/settings/memory")({
  beforeLoad: () => {
    throw redirect({ to: "/memory", replace: true });
  },
});
