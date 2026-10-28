/**
 * The craft managed-content layer — ported from onyx's
 * `session/sandbox_lifecycle.py` (`build_managed_content_payload` /
 * `push_managed_content`) over OpenBot's own app sources.
 *
 * onyx resolves the skills payload and app guidance once per session-create /
 * reload, pushes the files into the sandbox, and only records `skills_hash`
 * when the push landed (`mcp_config_hash` rides along regardless — the MCP
 * config is written per session). A live session whose recorded hashes differ
 * from the current ones is stale and hot-reloads (skills.ts's predicate).
 *
 * The OpenBot sources are environment-equivalent adapters (the contract's C1/C2
 * rulings): the connectable-apps list answers from the plugins domain (enabled
 * connector rows that act in the person's own account), the skill fileset from
 * this deployment's managed-skill seam, the per-user craft MCP set from Task
 * 3's seam.
 */

import { getLogger } from "../../../shared/logger";
import {
  buildConnectableAppsList,
  type ConnectableApp,
} from "./agent-instructions";
import type { CraftMCPServerConfig } from "./opencode-config";
import { computeSkillRuntimeHash, craftMcpFingerprint } from "./skills";
import type { CraftSessionRow } from "./store";

const logger = getLogger("server");

/**
 * The Task 3 contract: everything a craft runtime consumes from the
 * deployment's managed content for one user.
 */
export type CraftManagedContent = {
  /** The rendered `{{CONNECTABLE_APPS_LIST}}` value for AGENTS.md. */
  connectableAppsSection: string;
  /** The managed skill files, keyed by skill-relative path (`{name}/SKILL.md`). */
  skillFiles: ReadonlyMap<string, Uint8Array>;
  /** The user's craft MCP servers (Task 3's per-user resolution). */
  mcpServers: readonly CraftMCPServerConfig[];
  /** Fingerprint of `skillFiles` + `connectableAppsSection` (onyx push.py:58-76). */
  skillsHash: string;
  /** Fingerprint of `mcpServers` (onyx mcp_config.py:78-95). */
  mcpConfigHash: string;
};

/** What the resolver answers: the contract content plus the un-hashed library. */
export type ResolvedCraftManagedContent = CraftManagedContent & {
  /**
   * The user's library files, pushed beside the skills and never hashed — onyx
   * keeps them out of `compute_skill_runtime_hash` too (staleness is about the
   * agent-visible skill surface, not a person's saved files).
   */
  libraryFiles: ReadonlyMap<string, Uint8Array>;
  /**
   * The web app scaffold template (onyx's image-baked `/workspace/templates/
   * outputs/web`), pushed to `.openbot/web-template/` so start-webapp.sh can
   * scaffold `outputs/web` on first start. Un-hashed like the library: the
   * template is static server content, not part of the agent-visible skill
   * surface, so it must not drive the staleness reload.
   */
  webTemplateFiles: ReadonlyMap<string, Uint8Array>;
};

/**
 * The scoped adapter contract (the plan's BLOCKED ruling): OpenBot's app
 * authorization surfaces, as seen by craft. Every leg defaults to
 * "none" so a deployment wires only what it can back.
 */
export type CraftManagedContentSources = {
  /**
   * Deployment apps the user could still connect (onyx
   * `get_connectable_apps_for_user`): enabled, personal-account apps the user
   * has NOT connected. Deployment/shared-account apps answer for everybody and
   * never appear — the agent can already call them.
   */
  connectableAppsFor(userId: string): Promise<readonly ConnectableApp[]>;
  /**
   * The managed skill fileset for the user (onyx: built-in + custom skills).
   * Default: none.
   */
  skillFilesFor?(userId: string): Promise<ReadonlyMap<string, Uint8Array>>;
  /** The user's library files. Default: none. */
  libraryFilesFor?(userId: string): Promise<ReadonlyMap<string, Uint8Array>>;
  /**
   * The web app scaffold template (onyx's image template, restored). Default:
   * the server-bundled `assets/craft/web-template/` tree, read once and cached.
   * Static — the userId is accepted for source symmetry, not consulted.
   */
  webTemplateFilesFor?(
    userId: string,
  ): Promise<ReadonlyMap<string, Uint8Array>>;
  /** The user's craft MCP servers (Task 3's seam). Default: none. */
  mcpServersFor?(userId: string): Promise<readonly CraftMCPServerConfig[]>;
};

/**
 * Resolves the session owner's managed content — never a deployment-wide id:
 * the connectable-apps list and skill fileset are per-user facts (onyx resolves
 * against the session's user). Throws when a source fails; callers that can
 * degrade (the staleness checks) catch and answer null.
 */
export type CraftManagedContentResolver = (
  session: Pick<CraftSessionRow, "id" | "userId">,
) => Promise<ResolvedCraftManagedContent>;

/** Build a resolver over one deployment's sources. */
export function createCraftManagedContentResolver(
  sources: CraftManagedContentSources,
): CraftManagedContentResolver {
  return async (session) => {
    const [apps, skillFiles, libraryFiles, webTemplateFiles, mcpServers] =
      await Promise.all([
        sources.connectableAppsFor(session.userId),
        sources.skillFilesFor?.(session.userId) ??
          new Map<string, Uint8Array>(),
        sources.libraryFilesFor?.(session.userId) ??
          new Map<string, Uint8Array>(),
        sources.webTemplateFilesFor?.(session.userId) ??
          defaultWebTemplateFiles(),
        sources.mcpServersFor?.(session.userId) ?? [],
      ]);
    const connectableAppsSection = buildConnectableAppsList(apps);
    const files = skillFiles instanceof Map ? skillFiles : new Map(skillFiles);
    return {
      connectableAppsSection,
      skillFiles: files,
      mcpServers,
      skillsHash: computeSkillRuntimeHash(
        Object.fromEntries(files),
        connectableAppsSection,
      ),
      mcpConfigHash: craftMcpFingerprint(mcpServers),
      libraryFiles:
        libraryFiles instanceof Map ? libraryFiles : new Map(libraryFiles),
      webTemplateFiles:
        webTemplateFiles instanceof Map
          ? webTemplateFiles
          : new Map(webTemplateFiles),
    };
  };
}

/**
 * Reads the server-bundled web template (`assets/craft/web-template/`, the
 * byte-verbatim copy of onyx's image template) into a file map, once per
 * process. Dotfiles are included (the template ships `.oxlintrc.json`); an
 * absent directory resolves to an empty map so a deployment without the
 * assets tree degrades to "no template", never a crash.
 */
let webTemplateFilesCache: ReadonlyMap<string, Uint8Array> | null = null;
async function defaultWebTemplateFiles(): Promise<
  ReadonlyMap<string, Uint8Array>
> {
  if (webTemplateFilesCache !== null) return webTemplateFilesCache;
  const { readdir, readFile } = await import("node:fs/promises");
  const root = new URL("../../assets/craft/web-template/", import.meta.url);
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: URL, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = new URL(`${entry.name}/`, dir);
      if (entry.isDirectory()) {
        await walk(child, rel);
      } else if (entry.isFile()) {
        files.set(
          rel,
          new Uint8Array(await readFile(new URL(entry.name, dir))),
        );
      }
    }
  };
  await walk(root, "").catch((error) => {
    // An unreadable template tree must be visible: an empty/partial set cached here
    // would silently hydrate every session with missing web-template files.
    logger.warn({ error, root: String(root) }, "[craft] failed to walk web templates");
  });
  webTemplateFilesCache = files;
  return files;
}

/** One connector server row as the production app-list filter reads it. */
export type ConnectableAppServerRow = {
  id: string;
  title: string;
  /** Whose account a brokered app acts in; null when the row acts in none. */
  accountMode: "personal" | "shared" | null;
};

/**
 * The production app-list filter (the boot file's `connectableAppsFor` wiring):
 * personal-account connector rows the user has NOT already connected — onyx's
 * `get_connectable_apps_for_user` equivalence. Shared/deployment-account apps
 * answer for everybody and never appear (the agent can already call them), and
 * a personal app the person HAS connected — under either shape, their own vault
 * credential or a brokered account — is no longer connectable advice.
 */
export function personalUnconnectedApps(
  servers: readonly ConnectableAppServerRow[],
  connectedServerIds: ReadonlySet<string>,
): ConnectableApp[] {
  return servers
    .filter(
      (server) =>
        server.accountMode === "personal" && !connectedServerIds.has(server.id),
    )
    .map((server) => ({ id: server.id, name: server.title }));
}

/** The write surface managed content materializes through. */
export type ManagedContentFileApi = {
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  /**
   * Lists the paths under one directory (the gateway's `/file` listing). THROWS on
   * failure; a 404-shaped error (absent directory) is the fresh-workspace case and is
   * normalized to `[]` by the materializer — every other failure is real.
   */
  listFiles(path: string): Promise<string[]>;
  /** Deletes one file. The gateway's delete verb is files-only — a directory answers 404. */
  deletePath(path: string): Promise<boolean>;
};

/** The managed mounts, as paths inside one session's workspace root. */
export const MANAGED_SKILLS_DIR = ".opencode/skills";
export const USER_LIBRARY_DIR = "user_library";
/** Where the web app scaffold template lands (read by start-webapp.sh). */
export const WEB_TEMPLATE_DIR = ".openbot/web-template";

/**
 * A skill-relative path as the materializer accepts it, or null when the entry
 * tries to escape its mount (absolute, empty, dot-dot, or backslash tricks).
 */
function containedRelativePath(path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("\\")) return null;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return path;
}

/**
 * Push the managed skills + user library into one session's workspace — the
 * environment-equivalent of onyx's mount swap: onyx renames a shared mount
 * into place per sandbox, OpenBot has no shared mount, so the files land
 * directly under the session's own `.opencode/skills/` and `user_library/`
 * (session ownership + path containment are the whole point).
 *
 * Mirrors `push_managed_content`'s failure contract: push failures are
 * logged, never raised — the workspace still finishes building, and because
 * the skills hash is only acked on success the next create/reload retries.
 * The skills tree is emptied first so a skill the source dropped does not
 * linger beneath a hash that no longer names it — file-by-file, because the
 * gateway's delete verb refuses directories.
 *
 * @returns whether the skills push fully succeeded (gates the skills-hash ack).
 */
export async function materializeManagedContent(
  api: ManagedContentFileApi,
  root: string,
  content: Pick<
    ResolvedCraftManagedContent,
    "skillFiles" | "libraryFiles" | "webTemplateFiles"
  >,
): Promise<boolean> {
  const skillsRoot = `${root}/${MANAGED_SKILLS_DIR}`;
  let skillsHydrated = true;
  // The listing contract (finding F-C's family): a 404 is the honest "the skills
  // directory does not exist yet" — a fresh workspace with nothing to clear — but
  // any other failure means the tree's stale state is UNKNOWN. The old code
  // swallowed every failure as "nothing stale", skipped the clear, and still acked
  // the fingerprint; a real failure now refuses the ack (the next create/reload
  // retries) while the writes below still land what they can.
  let stale: string[];
  try {
    stale = await api.listFiles(skillsRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/answered 404/.test(message)) {
      stale = [];
    } else {
      logger.warn({ error, root }, "[craft] failed to list managed skills");
      skillsHydrated = false;
      stale = [];
    }
  }
  for (const old of stale) {
    // A delete is destructive: only paths anchored at the managed root, the same
    // containment the three write legs below are required to pass.
    if (containedRelativePath(old) === null) {
      logger.warn({ path: old, root }, "[craft] stale skill path failed containment; not deleting");
      skillsHydrated = false;
      continue;
    }
    await api.deletePath(old).catch((error) => {
      // A stale file that refuses to delete would linger under the new hash —
      // the push cannot claim to have hydrated what it could not clear.
      logger.warn(
        { error, path: old, root },
        "[craft] failed to clear managed skill file",
      );
      skillsHydrated = false;
    });
  }

  for (const [path, bytes] of content.skillFiles) {
    const rel = containedRelativePath(path);
    if (rel === null) {
      logger.warn(
        { path, root },
        "[craft] rejecting path-escaping managed skill entry",
      );
      skillsHydrated = false;
      continue;
    }
    try {
      await api.writeFileBytes(`${skillsRoot}/${rel}`, bytes);
    } catch (error) {
      logger.warn(
        { error, path, root },
        "[craft] failed to push managed skill file",
      );
      skillsHydrated = false;
    }
  }

  for (const [path, bytes] of content.libraryFiles) {
    const rel = containedRelativePath(path);
    if (rel === null) {
      logger.warn(
        { path, root },
        "[craft] rejecting path-escaping library entry",
      );
      continue;
    }
    try {
      await api.writeFileBytes(`${root}/${USER_LIBRARY_DIR}/${rel}`, bytes);
    } catch (error) {
      logger.warn(
        { error, path, root },
        "[craft] failed to push user library file",
      );
    }
  }

  // The web template leg rides the library's contract: pushed on every setup
  // (first setup included — start-webapp.sh scaffolds from it), never hashed,
  // and a failed write degrades to "no scaffold template" rather than failing
  // hydration (the template is static; it is not a staleness input).
  for (const [path, bytes] of content.webTemplateFiles) {
    const rel = containedRelativePath(path);
    if (rel === null) {
      logger.warn(
        { path, root },
        "[craft] rejecting path-escaping web template entry",
      );
      continue;
    }
    try {
      await api.writeFileBytes(`${root}/${WEB_TEMPLATE_DIR}/${rel}`, bytes);
    } catch (error) {
      logger.warn(
        { error, path, root },
        "[craft] failed to push web template file",
      );
    }
  }
  return skillsHydrated;
}
