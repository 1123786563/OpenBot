import { z } from "zod";
import type {
  CheckGithubEventRepository,
  GithubReadAccess,
} from "./event-triggers";
import { githubId } from "./github";

const matchId = z.object({ id: githubId });
const installation = matchId.extend({
  app_id: githubId,
  suspended_at: z.string().nullable(),
  permissions: z.object({ issues: z.string().optional() }),
});
const repository = matchId.extend({
  node_id: z.string(),
  has_issues: z.boolean(),
});
const itemCount = z.number().int().nonnegative();

export function createGithubEventReader(
  appId: string,
  transport: typeof fetch = fetch,
): CheckGithubEventRepository {
  return async ({ token, userId, installationId, repositoryId, nodeId }) => {
    const signal = AbortSignal.timeout(10_000);
    async function get<T extends z.ZodType>(path: string, schema: T) {
      try {
        const response = await transport(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "OpenBot",
          },
          redirect: "error",
          signal,
        });
        if (response.status === 401 || response.status === 404)
          return { kind: "denied" } as const;
        if (!response.ok) return { kind: "retry" } as const;
        return {
          kind: "ok",
          value: schema.parse(await response.json()),
        } as const;
      } catch {
        return { kind: "retry" } as const;
      }
    }
    const user = await get("/user", matchId);
    if (user.kind !== "ok") return user.kind;
    if (String(user.value.id) !== userId) return "denied";

    async function find(
      path: string,
      field: "installations" | "repositories",
      id: string,
      validate: (row: unknown) => GithubReadAccess,
    ): Promise<GithubReadAccess> {
      const schema = z.object({
        total_count: itemCount,
        installations: z.array(matchId.passthrough()).optional(),
        repositories: z.array(matchId.passthrough()).optional(),
      });
      for (let page = 1; page <= 10; page++) {
        const response = await get(`${path}?per_page=100&page=${page}`, schema);
        if (response.kind !== "ok") return response.kind;
        const rows = response.value[field];
        if (!rows) return "retry";
        const match = rows.find((row) => String(row.id) === id);
        if (match) return validate(match);
        if (response.value.total_count <= (page - 1) * 100 + rows.length)
          return "denied";
        if (rows.length < 100) return "retry";
      }
      return "retry";
    }
    const installed = await find(
      "/user/installations",
      "installations",
      installationId,
      (row) => {
        const parsed = installation.safeParse(row);
        if (!parsed.success) return "retry";
        const { app_id, suspended_at, permissions } = parsed.data;
        return String(app_id) === appId &&
          suspended_at === null &&
          (permissions.issues === "read" || permissions.issues === "write")
          ? "allowed"
          : "denied";
      },
    );
    if (installed !== "allowed") return installed;
    if (!/^[1-9]\d*$/.test(installationId)) return "denied";
    return find(
      `/user/installations/${installationId}/repositories`,
      "repositories",
      repositoryId,
      (row) => {
        const parsed = repository.safeParse(row);
        if (!parsed.success) return "retry";
        return parsed.data.node_id === nodeId && parsed.data.has_issues
          ? "allowed"
          : "denied";
      },
    );
  };
}
