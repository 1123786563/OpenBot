import { z } from "zod";

export const weknoraResourceId = z
  .string()
  .regex(/^weknora:tenant:[0-9]+:kb:[a-zA-Z0-9_-]{1,128}$/);

export type WeKnoraWork = "chat" | "rerank" | "maintenance";

export function weknoraWorkResource(resource: string, work: WeKnoraWork) {
  return `${resource}:${work}`;
}

export function validWeKnoraGrant({
  kind,
  resourcePrefix,
}: {
  kind: "online" | "background";
  resourcePrefix?: string;
}) {
  const split = /^(.*):(chat|rerank|maintenance)$/.exec(resourcePrefix ?? "");
  if (!split)
    return (
      kind === "background" &&
      weknoraResourceId.safeParse(resourcePrefix).success
    );
  return (
    weknoraResourceId.safeParse(split[1]).success &&
    (split[2] === "maintenance" ? kind === "background" : kind === "online")
  );
}
