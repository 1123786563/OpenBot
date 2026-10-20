# Billing Reliability Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate five independently testable billing remediation plans so payment, subscription, credit, usage, webhook, and statement records can be recovered and reconciled.

**Architecture:** Keep the current provider adapters, payment store/service, credit writer, billing routes, and Lago projections as the existing seams. Add durable usage delivery and deployment-scoped purchase serialization where needed, then extend historical order snapshots and reconciliation over committed facts. Execute this master plan as an ordering guide; implementation details and tests live in the linked subplans.

**Tech Stack:** TypeScript, Bun, Hono, Drizzle ORM, PostgreSQL, Lago, Alipay, WeChat Pay, Bun Test.

**Spec:** `docs/superpowers/specs/2026-10-11-billing-reliability-design.md`

## Global Constraints

- Keep stored payment amounts and credit units as integers; do not introduce binary floating-point accounting.
- Use database uniqueness, transactions, or durable idempotency records as correctness authorities; read-before-write checks may remain optimizations only.
- Do not acknowledge a payment callback as successful when its durable paid fact was not committed.
- Credit enforcement, billing visibility, and duplicate-payment recovery policies must be recorded before implementing the behavior they govern.
- Add migrations; do not edit already-applied migrations.
- Integration tests use a dedicated `TEST_DATABASE_URL`; never substitute the application `DATABASE_URL`.
- Preserve provider-specific wire formats inside the Alipay, WeChat, and Lago adapters.

---

## Plan set and responsibilities

| Plan | Owns | Main deliverable |
|---|---|---|
| [01 — Usage events](./2026-10-11-billing-reliability-01-usage-events.md) | Model/code-run usage identity, durable storage, delivery and retry | A persisted usage event with stable identity and separately retryable Lago/credit effects |
| [02 — Payment ordering](./2026-10-11-billing-reliability-02-payment-ordering.md) | Concurrent order creation, callback settlement, activation recovery | One open deployment purchase intent and a callback ack tied to durable settlement |
| [03 — Credit enforcement](./2026-10-11-billing-reliability-03-credit-enforcement.md) | Reservation or explicit overdraft semantics | A selected, tested credit policy shared by model and code-run usage |
| [04 — Lago webhooks](./2026-10-11-billing-reliability-04-webhook-resilience.md) | Provider webhook refresh, inbox persistence, retry grading | No event is marked complete before its projection refresh and inbox record are durable |
| [05 — Bills and reconciliation](./2026-10-11-billing-reliability-05-bills-reconciliation.md) | Historical bill facts, access scope, full reconciliation evidence | Stable past bills and actionable detection of money/entitlement/credit/usage drift |

## Dependency graph

```text
Business decisions (credit policy, billing visibility, duplicate-payment resolution)
       ├── Usage identity and durable delivery ──┬── Credit enforcement
       │                                         └── Usage reconciliation
       ├── Payment ordering and activation ──────┬── Historical bill facts
       │                                         └── Payment reconciliation
       ├── Lago webhook retry resilience ─────────── Subscription projection correctness
       └── Billing visibility decision ────────────── Bill and order authorization

Historical bills + durable usage + payment/credit outcomes ──> complete reconciliation
```

## Recommended execution order

1. **Decision gate completed:** hard credit cap with pre-reservation, configurable model/input-output and code-run rates, fail-closed behavior for missing configuration, user-scoped bill/order visibility, and manual resolution for duplicate collections are approved. Numeric rate/limit values are deployment inputs and must be configured before enabling hard-cap billing.
2. **Usage and payment foundations in parallel:** execute plans 01 and 02. Both fix independent high-impact reliability defects.
3. **Lago webhook retry behavior:** execute plan 04. It can run alongside plans 01–02, but finish it before relying on webhook projections for payment recovery or reconciliation.
4. **Credit policy:** execute plan 03 after plan 01 has supplied stable event identities. Use only the approved hard-cap branch; absent per-model/per-run pricing or a configured maximum reservation, fail closed and do not fall back to the old temporary rate.
5. **Historical bills and reconciliation:** execute plan 05 after the order and usage record shapes are stable. The visibility decision must be recorded before changing read authorization.
6. **Integrated verification:** run all targeted tests, migrations against a dedicated PostgreSQL database, typecheck, and review the deployment/backfill procedure before rollout.

## Cross-plan acceptance criteria

- Replaying a usage event after a process restart or from another replica does not duplicate either Lago metering or credit accounting.
- Simultaneous purchases for different plans/providers cannot independently open live order intents for one deployment.
- A transient payment-store failure produces a retryable callback response; a callback success means the fact or its durable duplicate was committed.
- The selected credit policy is reflected identically in model calls, code runs, ledger reads, and operator-facing reconciliation.
- A historical bill uses the order's own committed period and payment timestamp, not the current subscription's period or a generic terminal timestamp.
- Reconciliation detects each injected inconsistency and reports stable identifiers sufficient for an operator to locate the underlying rows.

## Execution notes

- Run tests from the repository root with `bun test <test-file>`.
- Run server type checks with `bun run --filter server typecheck`.
- Before a migration integration run, apply the appended Drizzle migration to the dedicated test database; integration tests under `server/tests` expect their tables and indexes to exist.
- Keep commits scoped to one task and stage only that task's files. Use the repository's required co-author trailer on implementation commits.
