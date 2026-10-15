# Mastra OCR R3 Fix 1c — Invalid Credential Header Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure malformed stored provider credentials cannot throw after the gateway starts a request timer or leak an internal error.

**Architecture:** Build provider request headers before starting the request deadline. Convert invalid header-value errors into the gateway's existing generic credential failure, without dispatching or scheduling a timer. Keep all previous Task3 lifecycle behavior intact.

**Tech Stack:** TypeScript, Bun, Fetch API, `Headers`, injected manual timer.

**Spec:** Fix1b review finding `R3-T3-FIX1B-REV-01` in `.superpowers/sdd/2026-10-11-mastra-ocr-r3-fix1b-gateway-cleanup/reports/re-review.md`; parent R3 Task3 plan and settlement/secret-handling constraints.

## Global Constraints

- Modify only `server/src/enterprise/models/gateway.ts` and `server/tests/enterprise/model-gateway.test.ts`.
- Preserve HEAD `8d6b9bd71a810556ab46b5dffa9f72f0427f5289`, Fix1b and all Task1/Task2 changes; no commits/history changes.
- Invalid credentials fail safely before provider dispatch and leave zero active request/stream timers.
- No real provider calls, no sleep-based tests, no migrations.

## Review Focus

- A stored credential with a newline/invalid header value returns a generic safe failure instead of rejecting `handle()`.
- Header construction failure cannot leave active timers or dispatch to fetch.
- Ordinary valid API keys still reach the correct provider header and all existing gateway behavior remains green.

---

### Task 1: Build headers before deadline scheduling

**Depends on:** Frozen Task3 Fix1b checkpoint; finding `R3-T3-FIX1B-REV-01`. **Roles:** fresh backend_implementer → fresh backend_validator → independent reviewer. Serial; no commit.

**Files:** Modify only `server/src/enterprise/models/gateway.ts` and `server/tests/enterprise/model-gateway.test.ts`.

**Interfaces:** Consume the existing resolved provider `key`, provider kind, timer seam, and safe `MODEL_CREDENTIAL_UNAVAILABLE` response.

- [ ] **Step 1 — RED:** Add a manual-timer test where `resolveApiKey` returns an invalid header value such as `synthetic\nsecret`; assert `handle()` returns a generic credential error, active timers remain zero, and fetch is untouched. Confirm the frozen Fix1b code rejects/throws before producing a Response.
- [ ] **Step 2 — Implement:** Construct `Headers` and set provider credentials before calling `schedule`; catch invalid header values and return the existing generic credential error. Schedule request and stream deadlines only after header construction succeeds. Preserve cleanup try/finally around dispatch/body handling.
- [ ] **Step 3 — GREEN:** Run all gateway and Mastra model test suites, Biome, scoped diff check, and server typecheck. Record the known unowned probe-script TS2345 if it remains.
- [ ] **Step 4 — Freeze and gates:** Record exact Fix1c incremental patch from the Fix1b checkpoint, source hashes, RED/GREEN evidence and report. Fresh backend validator and independent reviewer must pass before Task3 is verified or outer OCR begins.

**Failure handling:** Never return header exception details or credential text. If a generic code is not suitable, use the existing safe upstream-unavailable response and record why; do not construct provider dispatch state or timers before validating headers.
