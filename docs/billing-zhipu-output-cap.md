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

Every correlated request carries Zhipu's own response id next to the gateway row joined by request id, so usage and termination are attributable to the provider independently of the gateway. The correlation records are in [bifrost-zhipu-family-cap-fixed6.jsonl](./evidence/bifrost-zhipu-family-cap-fixed6.jsonl), the gateway rows in [bifrost-zhipu-family-cap-fixed6.gateway.json](./evidence/bifrost-zhipu-family-cap-fixed6.gateway.json), and the image identity in [bifrost-zhipu-family-cap-fixed6.image.json](./evidence/bifrost-zhipu-family-cap-fixed6.image.json). The run artifacts remain outside the checkout at `/Users/wuyj/.local/share/openbot/bifrost-89/route2`.

One ingress caveat surfaced while qualifying tools: Bifrost v1.5.8 (stock and patched alike) only forwards tools given in the OpenAI envelope shape (`{"type":"function","function":{…}}`); a flat `{name, description, parameters}` object is dropped from the upstream request, with `tool_choice` still forwarded. Probes and Harness callers must send the envelope shape.
