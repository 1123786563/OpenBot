# Pre-R3 Driven Group Warning Baseline

Before T05-R3 modified `app/tests/bot-reaching-you.test.tsx`, the coordinator ran the full app/tests driven selector:

`E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=docs/verification/workspace-redesign/t08/final-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`

The command exited 0 with all 6 selected driver groups passing. The `app/tests part 1` output reported exactly five test files failing only when sharing a Bun process, then passing on the driver's isolated reruns: `account-mode-dialog.test.tsx`, `approvals-rules.test.tsx`, `bot-approval-rules.test.tsx`, `bot-memory.test.tsx`, and `bot-reaching-you.test.tsx`. It also noted the unrelated `server/tests/billing-period-fulfillment.integration.test.ts` collection skip because Node's default ESM loader does not support its `bun:` protocol.

The T05-R3 validator observed the same five shared-process-only paths and same unrelated collection skip after its change. This is a pre-existing shared-process warning set, not a new test group regression; full group and individual target status remain separately reported. A later UI-driven T05-R4 test update will be checked against this exact warning baseline.
