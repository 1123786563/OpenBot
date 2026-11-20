import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { Button } from "@/components/ui/button";
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
    <section
      className="mt-3 grid gap-2 rounded-lg border p-3 text-sm"
      aria-label="Market version administration"
    >
      <h3 className="font-medium">Emergency version controls</h3>
      {versions.isPending && (
        <p role="status">Loading installed and disabled versions…</p>
      )}
      {versions.isError && (
        <p role="alert">
          Couldn't load installed and disabled versions.{" "}
          <Button variant="link" onClick={() => void versions.refetch()}>
            Try again
          </Button>
        </p>
      )}
      {versions.data?.length === 0 && (
        <p>No installed or disabled market versions.</p>
      )}
      {versions.data && versions.data.length > 0 && (
        <ul className="grid gap-2 divide-y divide-border">
          {versions.data.map((version) => (
            <li
              key={JSON.stringify([
                version.source,
                version.registrySkillId,
                version.versionId,
              ])}
              className="grid gap-2 pt-2"
            >
              <p className="break-words font-medium">
                {version.namespace}/{version.slug} {version.version}
              </p>
              <p className="break-words text-muted-foreground">
                {version.source}
              </p>
              <MarketVersionControl
                version={version}
                disableReason={version.reason}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
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
    <div className="grid gap-2 text-sm">
      {disableReason !== null ? (
        <>
          <p className="font-medium">Disabled by an OpenBot administrator</p>
          <p className="break-words">{disableReason}</p>
          <Button
            className="justify-self-start"
            type="button"
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate(null)}
          >
            Re-enable version
          </Button>
        </>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const reason = new FormData(event.currentTarget).get("reason");
            if (typeof reason === "string" && !update.isPending)
              update.mutate(reason.trim());
          }}
        >
          <label className="grid min-w-0 grow gap-1" htmlFor={reasonId}>
            Disable reason
            <Input id={reasonId} maxLength={500} name="reason" required />
          </label>
          <Button
            type="submit"
            size="sm"
            variant="destructive"
            disabled={update.isPending}
          >
            Disable version
          </Button>
        </form>
      )}
      {update.isError && <p role="alert">{update.error.message}</p>}
      {update.isPending && <p role="status">Updating version availability…</p>}
    </div>
  );
}
