# Zhipu output-cap qualification

This record covers the pinned Bifrost adapter patch for `glm-5.3-flash`.

## Root cause

The adapter conversion was correct in the patched source, but the image build copied `transports/` after applying the Go module replacement. That copy overwrote `go.mod`, so the final binary compiled the upstream Bifrost core and omitted the patched adapter.

## Repository fix

- `zhipu-max-output.patch` maps `max_completion_tokens` to Zhipu's native `max_tokens` and removes conflicting passthrough keys.
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
