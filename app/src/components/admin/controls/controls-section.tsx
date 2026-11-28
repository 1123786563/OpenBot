import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { setEnterpriseSettingMutationOptions } from "@/lib/enterprise/mutations";
import {
  type EnterpriseOverview,
  type EnterpriseSettings,
  enterpriseOverviewQueryOptions,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

/** What a section of the admin's controls reads and changes. */
export type Controls = {
  data: EnterpriseOverview;
  setSetting: <K extends keyof EnterpriseSettings>(
    key: K,
    value: EnterpriseSettings[K],
  ) => void;
  /** The same write, awaited: a dialog that must outlive its own Save presses this. */
  setSettingAsync: <K extends keyof EnterpriseSettings>(
    key: K,
    value: EnterpriseSettings[K],
  ) => Promise<void>;
  saving: boolean;
};

/**
 * One section of the controls that apply to everybody, drawn on the admin page it is about.
 *
 * WHY EACH SECTION LOADS ITS OWN. These used to be one page, Enterprise controls, which held eight
 * unrelated decisions under a name that said nothing about any of them. Each now sits beside the
 * page it governs: the network policy on Computers, the MCP allowlist on Plugins, Action Recording
 * on Audit. They all read the one overview query, so a page with two of them still asks once, and
 * each keeps its own save state so a refused change is reported where it was made.
 */
export function ControlsSection({
  title,
  description,
  headingId,
  children,
  readErrorMessage = "Couldn't load these settings.",
  showWriteError = true,
}: {
  /** Absent on a page whose only section this is: the page title already names it. */
  title?: string;
  description?: ReactNode | ((data: EnterpriseOverview) => ReactNode);
  headingId?: string;
  children: (controls: Controls) => ReactNode;
  /** Pass false when another section on the page shows the shared read status. */
  readErrorMessage?: string | false;
  /** A confirmation dialog can display its own save failure. */
  showWriteError?: boolean;
}) {
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const data =
    overview.isSuccess && overview.data.settings ? overview.data : undefined;
  const failure = setSetting.error;
  return (
    <PageSection
      description={
        typeof description === "function"
          ? data && description(data)
          : description
      }
      headingId={headingId}
      title={title}
    >
      {data ? (
        <>
          {showWriteError && failure ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {failure.message}
            </p>
          ) : null}
          {children({
            data,
            setSetting: (key, value) => setSetting.mutate({ key, value }),
            setSettingAsync: async (key, value) => {
              await setSetting.mutateAsync({ key, value });
            },
            saving: setSetting.isPending,
          })}
        </>
      ) : readErrorMessage !== false ? (
        overview.isPending && overview.errorUpdateCount === 0 ? (
          <ReadStatus kind="loading" message="Loading settings…" />
        ) : (
          <ReadError
            message={readErrorMessage}
            retry={overview.refetch}
            retryBelow
            retrying={overview.isFetching}
          />
        )
      ) : null}
    </PageSection>
  );
}
