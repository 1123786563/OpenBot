import { testDatabaseUrl } from "../tests/support/database";

/*
 * The isolated migration entry for the enterprise tenancy work, per plan 02 §5 T1-B step 3.
 *
 * `db:generate` / `db:migrate` in package.json load the repository root `.env` — the developer's
 * application database — so this entry never uses them. The URL comes from TEST_DATABASE_URL
 * through the same validator the integration suite uses: missing variable, non-postgres protocol,
 * empty database name or the live `openbot` database are all hard errors, and the child drizzle-kit
 * process receives an environment containing ONLY PATH, HOME and the one DATABASE_URL derived
 * here — no implicit `.env` can leak in (`--no-env-file` on the child too) and `--no-install`
 * forbids downloading anything outside the lockfile.
 *
 * The command is chosen by matching the argument against a fixed set; each child command is a
 * fully spelled-out constant list and the argument itself never reaches the child. Bun.spawn
 * takes an argument list and runs no shell.
 *
 * This helper is for the dedicated test database only. Production migrations are injected by an
 * approved release job and never routed through a test helper.
 */
const url = testDatabaseUrl();

function spawnDrizzleKit(args: ReadonlyArray<string>) {
  return Bun.spawn(
    ["bun", "--no-env-file", "x", "--no-install", "drizzle-kit", ...args],
    {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DATABASE_URL: url,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
}

let child: Bun.Subprocess;
switch (process.argv[2]) {
  case "generate":
    child = spawnDrizzleKit(["generate", "--config=drizzle.config.ts"]);
    break;
  case "migrate":
    child = spawnDrizzleKit(["migrate", "--config=drizzle.config.ts"]);
    break;
  case "custom":
    child = spawnDrizzleKit([
      "generate",
      "--custom",
      "--name=enterprise_tenancy_rls",
      "--config=drizzle.config.ts",
    ]);
    break;
  default:
    throw new Error("Use generate, migrate or custom");
}
process.exit(await child.exited);
