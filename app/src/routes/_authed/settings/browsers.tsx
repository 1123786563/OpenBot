import { createFileRoute } from "@tanstack/react-router";
import { useRef } from "react";
import { DevicePage } from "@/components/astryx-pilot/device-page";
import { BrowserSections } from "@/components/settings/browsers/browser-sections";
import { Button } from "@/components/ui/button";
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
  const setupHeading = useRef<HTMLHeadingElement>(null);
  return (
    <DevicePage
      action={
        <Button
          className="min-h-11"
          onClick={() => {
            setupHeading.current?.focus({ preventScroll: true });
            setupHeading.current?.scrollIntoView({ block: "start" });
          }}
          variant="outline"
        >
          Set up Recorder
        </Button>
      }
      title="Browsers"
      description="Connect the OpenBot Recorder in this browser to teach your Bots by doing a task yourself."
    >
      <BrowserSections setupHeading={setupHeading} />
    </DevicePage>
  );
}
