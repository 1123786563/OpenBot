import { createFileRoute } from "@tanstack/react-router";
import { DevicePage } from "@/components/astryx-pilot/device-page";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";
import { editionOf } from "@/lib/edition-guard";

export const Route = createFileRoute("/_authed/settings/browsers")({
  // The edition decides where the disclosure says a recording goes, so it is read before the page draws.
  beforeLoad: async ({ context }) => {
    await editionOf(context.queryClient);
  },
  component: BrowsersPage,
});

/** Connect the OpenBot Recorder in this browser, and see or disconnect every browser connected as you. */
function BrowsersPage() {
  return (
    <DevicePage
      title="Browsers"
      description="Connect the OpenBot Recorder in this browser to teach your Bots by doing a task yourself. What you record goes into your own Learning space."
    >
      <BrowserSections />
    </DevicePage>
  );
}
