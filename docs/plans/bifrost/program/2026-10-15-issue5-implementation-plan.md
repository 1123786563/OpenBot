# Implementation Plan: Issue #5 Bifrost integration

## Global Constraints

- Fixed payer: trusted company workbench calls use the company account; external Bot personal grants use the personal account. No fallback on insufficient balance.
- Personal Keys grant no company content or business-tool permission. Company financial history is retained.
- Strict admission must precede every provider attempt; unknown price, usage or unenforceable maximum stays disabled.
- Unknown outcomes retain reservations. Settlement is idempotent and tied to immutable payer/attempt/pricing basis.
- Cleanup is inventory/dry-run/hash/test-database rehearsal only; never production or unknown ownership.
- No commits, pushes, merges, deployment, gateway enablement or release actions.

## Review Focus

Payer immutability, authorization/key revocation, admission-before-provider, complete cost bounds, atomic reservation, idempotent settlement, unknown-result retention, fractional remainder, payment callback ownership, cleanup scope, and capability conformance.

## Task sequence

1. **Core identity, payer and ledger contracts** — nodes #207–#260. Establish stable personal Customer/grant/Key/binding, payer-aware reservation/settlement and recovery seams. RED→GREEN→REFACTOR with DB concurrency/failure injection tests. Backend owner; Pi validator and Pi reviewer.
2. **Catalog, pricing, conversion and model preference** — nodes #261–#263. Consume core contracts; implement freshness, approved scope, explicit free/unknown pricing and model selection. Backend/frontend as ticket states; provider conformance evidence required.
3. **Gateway admission and settlement** — nodes #264–#285. Consume the locked ledger contract; enforce PreLLM reservation, dispatch claim, provider attempt admission, post-use settlement, outbox/recovery and hard refusal. Bifrost/backend owners must not bypass OpenBot admission.
4. **Company and payment ownership** — nodes #286–#295. Integrate trusted company payer, content/tool boundary, subscription harness distinction and persisted order ownership. Do not expand #6 tenancy implementation.
5. **Capability verticals** — nodes #296–#344. Parallel only where owned files and ports/test databases are disjoint; otherwise serialize by adapter. Each adapter must prove pricing, usage and enforceable maximum or remain unavailable.
6. **Test-only cleanup** — nodes #345–#351. Inventory, classify, dry-run, hash and dedicated test-database transaction/rebuild. No production data mutation.
7. **Delivery conformance and review gates** — nodes #352–#357. Enumerate all entrances, run AC01–AC19, freeze versions, independent Pi full review, then OCR. Findings create a new repair DAG; original tasks are not replayed.

Every task includes a Review Package containing HEAD, staged/unstaged diff, untracked-file contents and hashes, exact verification commands/results, and report path. The coordinator integrates only hash-verified increments.

