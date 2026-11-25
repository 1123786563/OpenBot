/**
 * Where OpenBot's settings live: one file per service, each rendered from one Infisical folder by
 * `bun run sync:env`. The root folder holds what belongs to no one service: the database address, the
 * ports. Paths are relative to the repository root.
 */
export const ENV_FILES = [
  { folder: "/", file: "deploy/openbot/.env", service: "deployment" },
  { folder: "/server", file: "deploy/openbot/.env.server", service: "server" },
  { folder: "/worker", file: "deploy/openbot/.env.worker", service: "worker" },
  { folder: "/agents", file: "deploy/agents/.env", service: "agents" },
] as const;

/**
 * The files the API server is started with, and the order that settles a key two of them hold: the
 * first wins, so the deployment's ports are never overruled. It reads the agents' file as well as its
 * own, because it picks each Bot's model and needs the settings the Bots run with: the model address
 * and key, the model names, the tokens they share. That is why those have one home, and are never
 * copied into the server's file.
 */
export const SERVER_ENV_FILES = [
  "deploy/openbot/.env",
  "deploy/openbot/.env.server",
  "deploy/agents/.env",
];

/**
 * The worker's: the deployment's file, the server's, then its own. It runs the server's own billing
 * and sign-in code against the same database, so it reads what that code reads.
 */
export const WORKER_ENV_FILES = [
  "deploy/openbot/.env",
  "deploy/openbot/.env.server",
  "deploy/openbot/.env.worker",
];

/**
 * What Infisical answers for a service folder nobody has created yet. It reads as empty: a folder is
 * created when a key is first moved into it, and until then every key sits in `/` and the deployment's
 * file carries it, so a checkout moves to the folders in its own time.
 */
export function isMissingInfisicalFolder(error: unknown): boolean {
  return (error as { statusCode?: unknown } | null)?.statusCode === 404;
}

/** For Compose's `--env-file`, where the last file wins: the deployment's, so a value there is final. */
export const COMPOSE_ENV_FILES = [...ENV_FILES]
  .reverse()
  .map(({ file }) => file);
