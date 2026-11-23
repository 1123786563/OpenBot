import {
  RECORDER_DISCLOSURE_TITLE,
  recorderDisclosureFor,
} from "@openbot/shared/recorder-disclosure";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { RecorderCollectsRows } from "@/components/recorder/recorder-collects";
import { ConnectedBrowsers } from "@/components/settings/browsers/connected-browsers";
import { ThisBrowser } from "@/components/settings/browsers/this-browser";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * Current connections come first. The Recorder disclosure precedes the control for connecting
 * this browser, and the list marks this browser's own copy when it is connected.
 *
 * Where a recording goes is said for the edition: an organization's OpenBot in the team edition, the person's own
 * Learning space in the personal one, which has no organization.
 */
export function BrowserSections() {
  const [thisInstallId, setThisInstallId] = useState<string>();
  const edition = useQuery(deploymentCapabilitiesQueryOptions()).data?.edition;
  return (
    <>
      <ConnectedBrowsers thisInstallId={thisInstallId} />
      <PageSection
        title={RECORDER_DISCLOSURE_TITLE}
        description={recorderDisclosureFor(edition)}
      >
        <RecorderCollectsRows />
      </PageSection>
      <ThisBrowser onInstallId={setThisInstallId} />
    </>
  );
}
