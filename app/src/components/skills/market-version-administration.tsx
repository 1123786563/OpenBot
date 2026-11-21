import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
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
      {versions.isPending && (
        <p role="status">Loading installed and disabled versions…</p>
      )}
      {versions.isError && (
        <p role="alert">
          Couldn't load installed and disabled versions.{" "}
          <Button
            variant="ghost"
            size="sm"
            label="Try again"
            onClick={() => void versions.refetch()}
          />
        </p>
      )}
      {versions.data?.length === 0 && (
        <p>No installed or disabled market versions.</p>
      )}
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
  const reasonId = useId();
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
              <VStack as="label" gap={1} htmlFor={reasonId}>
                <Text type="label">Disable reason</Text>
                <Input id={reasonId} maxLength={500} name="reason" required />
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
