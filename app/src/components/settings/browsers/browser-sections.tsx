import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  RECORDER_DISCLOSURE_TITLE,
  recorderDisclosureParagraphsFor,
} from "@openbot/shared/recorder-disclosure";
import { useQuery } from "@tanstack/react-query";
import { type Ref, useState } from "react";
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
export function BrowserSections({
  setupHeading,
}: {
  setupHeading?: Ref<HTMLHeadingElement>;
} = {}) {
  const [thisInstallId, setThisInstallId] = useState<string>();
  const edition = useQuery(deploymentCapabilitiesQueryOptions()).data?.edition;
  return (
    <>
      <ConnectedBrowsers thisInstallId={thisInstallId} />
      <PageSection headingRef={setupHeading} title={RECORDER_DISCLOSURE_TITLE}>
        <VStack gap={2} maxWidth="72ch" paddingBlockStart={1}>
          {recorderDisclosureParagraphsFor(edition).map((paragraph) => (
            <Text as="p" color="secondary" key={paragraph} textWrap="pretty">
              {paragraph}
            </Text>
          ))}
        </VStack>
        <RecorderCollectsRows />
      </PageSection>
      <ThisBrowser onInstallId={setThisInstallId} />
    </>
  );
}
