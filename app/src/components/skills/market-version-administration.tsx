import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";

export type MarketVersionIdentity = {
  source: string;
  namespace: string;
  slug: string;
  version: string;
  registrySkillId: number;
  versionId: number;
};

export function marketSkillPath({
  namespace,
  slug,
}: Pick<MarketVersionIdentity, "namespace" | "slug">) {
  return `/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
}

export function marketVersionQueryKey(path: string, version?: string) {
  const prefix = ["skill-market", path, "version"];
  return version === undefined ? prefix : [...prefix, version];
}

const disablementsPath = "/version-disablements";

export function MarketVersionAdministration() {
  const versions = useQuery({
    queryKey: ["skill-market", "version-disablements"],
    queryFn: ({ signal }) =>
      client<(MarketVersionIdentity & { reason: string | null })[]>(
        `/api/skill-market${disablementsPath}`,
        "versions",
        { signal },
      ),
    retry: false,
  });
  return (
    <VStack as="section" gap={2} aria-label="Market version administration">
      <Heading level={4} accessibilityLevel={3}>
        Emergency version controls
      </Heading>
      {versions.isPending && <p role="status">Loading market versions…</p>}
      {versions.isError && (
        <p role="alert">
          Couldn't load market versions.{" "}
          <Button
            variant="ghost"
            size="sm"
            label="Try again"
            onClick={() => void versions.refetch()}
          />
        </p>
      )}
      {versions.data?.length === 0 && <p>No market versions to manage.</p>}
      {versions.data && versions.data.length > 0 && (
        <List hasDividers edge="flush">
          {versions.data.map((version) => (
            <ListItem
              key={JSON.stringify([
                version.source,
                version.registrySkillId,
                version.versionId,
              ])}
              label={
                <VStack gap={1}>
                  <Text type="label" wordBreak="break-word">
                    {version.namespace}/{version.slug} {version.version}
                  </Text>
                  <Text type="supporting" wordBreak="break-word">
                    {version.source}
                  </Text>
                  <MarketVersionControl
                    version={version}
                    disableReason={version.reason}
                  />
                </VStack>
              }
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

export function MarketVersionControl({
  version: { source, namespace, slug, version, registrySkillId, versionId },
  disableReason,
}: {
  version: MarketVersionIdentity;
  disableReason: string | null;
}) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: async (reason: string | null) => {
      const identity = {
        source,
        namespace,
        slug,
        version,
        registrySkillId,
        versionId,
      };
      await client(`/api/skill-market${disablementsPath}`, {
        method: reason === null ? "DELETE" : "PUT",
        body: reason === null ? identity : { ...identity, reason },
        fallback: "Couldn't update this version's availability.",
      });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["skill-market", "version-disablements"],
        }),
        queryClient.invalidateQueries({
          queryKey: marketVersionQueryKey(
            marketSkillPath({ namespace, slug }),
            version,
          ),
        }),
      ]),
  });
  return (
    <VStack gap={2} align="start">
      {disableReason !== null ? (
        <>
          <Text as="p" type="label">
            Disabled by an OpenBot administrator
          </Text>
          <Text as="p" wordBreak="break-word">
            {disableReason}
          </Text>
          <Button
            size="sm"
            label="Re-enable version"
            isLoading={update.isPending}
            onClick={() => update.mutate(null)}
          />
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const reason = new FormData(event.currentTarget).get("reason");
            if (typeof reason === "string" && !update.isPending)
              update.mutate(reason.trim());
          }}
        >
          <HStack align="end" gap={2} wrap="wrap">
            <StackItem size="fill">
              <VStack as="label" gap={1}>
                <Text type="label">Disable reason</Text>
                <Input maxLength={500} name="reason" required />
              </VStack>
            </StackItem>
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              label="Disable version"
              isLoading={update.isPending}
            />
          </HStack>
        </form>
      )}
      {update.isError && <p role="alert">{update.error.message}</p>}
      {update.isPending && <p role="status">Updating version availability…</p>}
    </VStack>
  );
}

export type BifrostReviewPreview = {
  registry: "bifrost";
  source: string;
  version: string;
  packageIdentity: {
    namespace: "bifrost";
    slug: string;
    version: string;
    skillId: string;
    versionId: string;
    fingerprint: string;
  };
  registrySkillId?: number;
  versionId?: number;
  reviewStatus: "unreviewed" | "approved" | "withdrawn" | "mismatched";
  reviewedFingerprint?: string;
  reviewable: boolean;
};

export function BifrostReviewControl({
  value,
  versionPath,
}: {
  value: BifrostReviewPreview;
  versionPath: string;
}) {
  const queryClient = useQueryClient();
  const [confirmWithdrawal, setConfirmWithdrawal] = useState(false);
  const { packageIdentity, reviewStatus, reviewedFingerprint, reviewable } =
    value;
  const update = useMutation({
    mutationFn: (method: "PUT" | "DELETE") =>
      client(`/api/skill-market${versionPath}/review`, {
        method,
        body: {
          ...packageIdentity,
          fingerprint:
            method === "DELETE"
              ? reviewedFingerprint
              : packageIdentity.fingerprint,
        },
        fallback: "Couldn't update this version's review.",
      }),
    onSuccess: async () => {
      setConfirmWithdrawal(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: marketVersionQueryKey(
            marketSkillPath(packageIdentity),
            value.version,
          ),
        }),
        queryClient.invalidateQueries({
          queryKey: ["skill-market", "version-disablements"],
        }),
      ]);
    },
  });
  return (
    <VStack gap={2} align="start">
      <Text type="label">Package fingerprint</Text>
      <Text as="p" wordBreak="break-word">
        {packageIdentity.fingerprint}
      </Text>
      {reviewable && reviewStatus === "unreviewed" && (
        <>
          <Text as="p">
            Approve only after verifying that these instructions can run without
            scripts, supporting files, or a dedicated runtime.
          </Text>
          <Button
            size="sm"
            label="Approve exact package"
            isLoading={update.isPending}
            onClick={() => update.mutate("PUT")}
          />
        </>
      )}
      {reviewedFingerprint &&
        (reviewStatus === "approved" || reviewStatus === "mismatched") && (
          <Button
            size="sm"
            label="Withdraw approval"
            isDisabled={update.isPending}
            onClick={() => {
              update.reset();
              setConfirmWithdrawal(true);
            }}
          />
        )}
      <AlertDialog
        isOpen={confirmWithdrawal}
        onOpenChange={(open) => {
          if (!update.isPending) setConfirmWithdrawal(open);
        }}
        title={`Withdraw version ${value.version}?`}
        description={
          update.error?.message ??
          "This version will become unavailable for new installations and switches. Existing installations will continue to run."
        }
        actionLabel="Withdraw version"
        isActionLoading={update.isPending}
        onAction={() => update.mutate("DELETE")}
      />
      {!confirmWithdrawal && update.isError && (
        <p role="alert">{update.error.message}</p>
      )}
    </VStack>
  );
}
