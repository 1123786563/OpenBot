# T08 Verification Repair 01 — Restore Chinese Evaluation Sample Keys

- **Parent:** `docs/plans/2026-10-20-workspace-redesign-b1-t08.md`.
- **Finding:** the full `app/src` Bun-driven group fails locale key parity. The English evaluation sample has `sample.showDetails` and `sample.usageUnavailable`, while `zh-CN` lacks both. These keys are in the authorized T06 evaluation surface and the failure is directly attributable to the current migration delta.
- **Goal:** restore locale parity with accurate Simplified Chinese values, without changing behavior or other translations.
- **Owner / sequence:** one `frontend_implementer`, then `frontend_validator` and independent `reviewer`; no commits.
- **Owned file:** `app/src/locales/zh-CN/ai-observability-evaluations.json` only.
- **PRE:** T08 full-app verification checkpoint; record file SHA before edit in the Ledger.
- **Steps:** add `sample.showDetails` translated as `显示详情` and `sample.usageUnavailable` translated as `用量不可用` adjacent to their corresponding English entries; preserve all other keys/values and JSON formatting.
- **Verification:** locale parity native test + all relevant `app/src` driven group, scoped Biome, JSON parse, diff-check. Independent review confirms exact key parity and translation intent.
- **Failure handling:** any additional locale omissions must be separately evidenced before scope expands; report unrelated baseline failures without changing them.
