import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { CapabilitiesShell } from "@/components/capabilities/capabilities-shell";
import { MemoryList } from "@/components/memory/memories";
import { deploymentOffersMemory } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/_app/capabilities/memory")({
  // The personal edition has no memory (see `offersMemory`), so its Bots page is where this goes.
  // `/memory` and `/settings/memory` forward here and land there too.
  beforeLoad: async ({ context }) => {
    if (!(await deploymentOffersMemory(context.queryClient))) {
      throw redirect({ to: "/bots", replace: true });
    }
  },
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <CapabilitiesShell>
        <MemoryList description="Facts you add are shared with all your Bots. A fact learned by a Bot stays with that Bot. Turn off Use memory to pause a fact. Forget removes it permanently." />
        <Link
          className="mt-6 inline-block text-sm underline underline-offset-4"
          to="/ideas"
        >
          Open Ideas
        </Link>
      </CapabilitiesShell>
    </AstryxSurface>
  );
}
