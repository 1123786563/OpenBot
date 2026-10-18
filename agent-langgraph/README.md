# agent-langgraph

The framework Bot (Issue #22 / DAG T16): an AG-UI process driving LangGraph, governed by
`src/governed-tracing.ts` (see that module's head for the observability contract).

## Run convention (R5-6)

This package is a **standalone deployable, not a root workspace**: it keeps its own
`bun.lock` and `Dockerfile`, and the root `package.json` `workspaces` are only
`app`, `server`, `worker`. That has one consequence everyone who touches this package
must know:

> The root `bun run typecheck` is `bun run --filter '*' typecheck`, and `--filter '*'`
> enumerates root workspaces only — **it never runs this package's `typecheck` script.**
> The same is true of `bun run build`/`dev`. Nothing about the root scripts covers this
> tree; the only executor of `tsc --noEmit` here is the script below, run here.

The package's tool dependencies are declared in its own `devDependencies`
(`typescript`, `@types/bun`) so the scripts are self-contained from this directory —
they do not lean on a hoisted root `node_modules` (that accident is exactly what R5-6
recorded: `tsc` "worked" only when a root install happened to be present).

Commands, all from this directory:

```sh
bun install --frozen-lockfile   # this package's own tree (lockfile-pinned)
bun run typecheck               # tsc --noEmit over src/ (tsconfig extends ../tsconfig.base.json)
bun test                        # the package's suite (tests/)
```

CI (`.github/workflows/ci.yml`): the root `test` job installs this tree (alongside the
other standalone Bots) so root `bun test` discovery can run the suite. The standalone
typecheck executor is the `deployables` matrix pattern (`agent-computer`, `supervisor`
today); registering this package there is the recorded follow-up — this README is the
registered run convention until that line lands.
