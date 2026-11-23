# Zhipu output-cap qualification

This record covers the pinned Bifrost adapter patch for `glm-5.3-flash`.

## Root cause

The adapter conversion was correct in the patched source, but the image build copied `transports/` after applying the Go module replacement. That copy overwrote `go.mod`, so the final binary compiled the upstream Bifrost core and omitted the patched adapter.

## Repository fix

- `zhipu-max-output.patch` maps `max_completion_tokens` to Zhipu's native `max_tokens` for every `glm-*` chat model and removes conflicting passthrough keys. The gate originally matched only `glm-5.3-flash`, which left `glm-5.3` sending `max_completion_tokens` (ignored by Zhipu, and silently raised to the transport minimum) — the gate is now the model family.
- `pinned-build-replace.patch` reapplies `replace github.com/maximhq/bifrost/core=/zhipu-core` after `COPY transports/ ./`.
- `scripts/billing-pilot/apply-bifrost-patch.sh` applies both patches to a pinned Bifrost checkout and is idempotent.

## Qualification result

Image `openbot-bifrost89:zhipu-cap-fixed5` was built for `linux/arm64` with digest `sha256:a571fdb8fa58b9bbf3e4b10d5768960041b862430a4766d8b81e11bf103f638e`.

Both non-streaming and streaming requests passed with the following observed values.

| Check | Non-streaming | Streaming |
| --- | ---: | ---: |
| Output cap | 8 | 8 |
| Completion tokens | 8 | 8 |
| Finish reason | `length` | `length` |
| Provider | `zhipu` | `zhipu` |
| Retries | 0 | 0 |
| Fallback index | 0 | 0 |

The complete correlation records are in [bifrost-zhipu-cap-fixed5.jsonl](./evidence/bifrost-zhipu-cap-fixed5.jsonl). Gateway rows are in [bifrost-zhipu-cap-fixed5.gateway.json](./evidence/bifrost-zhipu-cap-fixed5.gateway.json). The full build and runtime evidence remains outside the checkout at `/Users/wuyj/.local/share/openbot/bifrost-89/provider-qualification-fixed5.ZPllLP`.

## Two-route family qualification (fixed6)

The family gate was widened after `glm-5.3` was observed returning 276 completion tokens against an 8-token cap: the model-conditional patch let its `max_completion_tokens` through as-is, which Zhipu ignores, and the transport minimum raised the value instead of lowering it.

Image `openbot-bifrost89:zhipu-cap-fixed6` was built for `linux/arm64` with digest `sha256:2fe9cf9c28eee03a9392ee7d032538dc6c9be53c266c70e08fbf6a4e36523cf1`, from the same pinned checkout with both repository patches applied. Both routes ran against real Zhipu through this one image.

| Check | `glm-5.3-flash` | `glm-5.3` |
| --- | --- | --- |
| Non-streaming cap 8 | 8, `length` | 8, `length` |
| Streaming cap 8 | 8, `length` | 8, `length` |
| Cancel mid-stream | gateway `error`, 0 retries | gateway `error`, 0 retries |
| Tool invoke | `probe_echo` exact arguments | `probe_echo` exact arguments |
| Tool result consumed | marker echoed back | marker echoed back |
| Retries / fallback | 0 / 0 | 0 / 0 |

The correlation records join the response IDs to gateway request IDs. Completed samples retain provider response usage and finish reasons. The cancellation samples record a gateway error after client abort. The correlation records are in [bifrost-zhipu-family-cap-fixed6.jsonl](./evidence/bifrost-zhipu-family-cap-fixed6.jsonl), the gateway rows in [bifrost-zhipu-family-cap-fixed6.gateway.json](./evidence/bifrost-zhipu-family-cap-fixed6.gateway.json), and the image identity in [bifrost-zhipu-family-cap-fixed6.image.json](./evidence/bifrost-zhipu-family-cap-fixed6.image.json). The run artifacts remain outside the checkout at `/Users/wuyj/.local/share/openbot/bifrost-89/route2`.

One ingress caveat surfaced while qualifying tools: Bifrost v1.5.8 (stock and patched alike) only forwards tools given in the OpenAI envelope shape (`{"type":"function","function":{…}}`); a flat `{name, description, parameters}` object is dropped from the upstream request, with `tool_choice` still forwarded. Probes and Harness callers must send the envelope shape.

## Pilot publication (2026-11-22)

The version 2 publication flow ran against a local pinned deployment. Two provider routes were configured on one `fixed6` gateway (`max_retries: 0`, no fallback): `zhipu/glm-5.3-flash` (native path override, `ZHIPU_API_KEY`) and `zhipu-compat/glm-5.3` (OpenAI-compatible path, separate credential) — distinct credentials, endpoints and gateway provider configs, both hosted by Zhipu. The managed Harness probe (`src.bifrost_probe`) ran each route with the operator meter `scripts/billing-pilot/zhipu-meter.py`, which bounds input with Zhipu's own tokenizer API (`/api/paas/v4/tokenizer`, exact match to provider `prompt_tokens` on text, tool-schema and tool-result shapes).

Per route the v2 evidence covers: streaming output (cap-stopped), mid-stream client cancellation with the gateway row finalizing after the abort (`status=error`, 0 retries), oversized input refused before the gateway on a 4515-token meter bound against the 4096 cap, output stopping at the 64-token cap with `length`, a real Zhipu 429 (`1302`) absorbed with zero retries and zero fallback, and both tool steps (`probe_echo` invocation with exact arguments and the consumed result in one run). The completed steps correlate the gateway row ID, meter proof, and response ID. The cancellation steps capture the response ID from an early chunk.

The server accepted both reports via `POST /api/admin/bifrost/routes/<id>/verify` and published release `a3a198aa-b53b-4dbd-8457-5fcf5c4915a0` (default `route-a`; options `glm-5.3-flash` and `glm-5.3`, each capped at 4160 microcredits for the 4096/64 bounds at 1 credit per token). The historical, redacted version 2 reports are in [`evidence/bifrost-publication/`](./evidence/bifrost-publication/) (`e2fd40ab…` = route-a, `d13818f8…` = route-b). Retained trace bundles (referenced by each `artifactDigest`) and the run artifacts live outside the checkout at `/Users/wuyj/.local/share/openbot/bifrost-89/route3`.

### Issue #89 evidence review

Both retained bundles match their report digests. The stream, output-limit, and tool-invocation samples include matching gateway and probe usage, with zero retries and fallback index zero in the retained gateway rows. Each second tool step has a response ID and usage in the correlation record. The bundles omit the corresponding second-step gateway rows. The retained gateway database contains those rows and matches usage for both routes. The database has zero linked fallback rows for the dispatched samples and contains no raw upstream request or response bytes for those IDs. Each oversized input reached a 4515-token meter bound with no corresponding gateway row in the bundle. The bundles contain no independent provider dispatch query for those rejections.

The publisher computed each cancellation timestamp from the gateway row and assigned the cancelled outcome. Both runs captured an early provider response ID, then a gateway error. The retained evidence contains no provider terminal event. The publisher also constructed the failure ID from the gateway UUID and the Zhipu error code. Capture a provider-issued failure correlation ID before using either failure sample for qualification.

The [Zhipu streaming Chat Completions reference](https://docs.bigmodel.cn/api-reference/模型-api/对话补全.md) describes streaming output and disconnect billing. The [async result endpoint](https://docs.bigmodel.cn/api-reference/模型-api/查询异步结果.md) covers a separate asynchronous API. A provider log export or provider support trace for each streaming request is still needed to establish terminal cancellation. The version 2 Price Version records the historical release. Requalification follows the [version 3 procedure](../scripts/billing-pilot/bifrost.md).
