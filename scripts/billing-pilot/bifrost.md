# Publish Bifrost pilot routes

1. Deploy Bifrost separately with two approved provider/model pairs. Inject upstream credentials through Bifrost's `env.*` references. Set both providers' `network_config.max_retries` to `0`. Disable routing and request fallbacks and restrict verification traffic to the controlled runner. Record the gateway image digest and the effective configuration revision for each route. [Bifrost provider setup](https://docs.getbifrost.ai/deployment-guides/config-json/providers)
2. As an OpenBot administrator, send `PUT /api/admin/bifrost/configuration` with the Harness image digest and route drafts. The response gives each draft a revision UUID. The pilot supports the managed LangGraph AG-UI Harness and up to two distinct model/provider pairs.
3. For each draft, run bounded probes using the managed Harness probe below and record the matching Bifrost and provider request IDs. Confirm streamed output and reconcile token counts with upstream usage. Cancel a separate request while it is streaming and confirm upstream termination. Verify that an oversized input reaches no provider and an output-limited request stops at its configured bound. For a tools-enabled route, run a separate call that emits a structured invocation and consumes the tool result. Confirm zero retries and zero fallback attempts in the gateway trace, including on failure.
4. Keep the correlated traces and usage records in the deployment's evidence store. Have the deployment operator write a redacted report named `<revision>.json` into the directory OpenBot sees as `OPENBOT_BIFROST_EVIDENCE_DIRECTORY`. Mount the directory read-only for OpenBot. Only the trusted verification operator or runner should be able to write reports. The report is the operator's attestation. Its `artifactDigest` identifies the retained trace bundle.
5. Call `POST /api/admin/bifrost/routes/<id>/verify` with `{"revision":"<revision>"}`. OpenBot checks the trusted report against the current draft before storing compatibility evidence. Repeat for the second route.
6. Call `POST /api/admin/bifrost/publication` with `{"routes":["route-a","route-b"],"defaultRoute":"route-a"}`. Use `GET /api/admin/bifrost` to check the active options and default. Save the returned release ID to retrieve the same snapshot from `GET /api/admin/bifrost/price-versions/<id>`.

The configuration body is `{harnessImage, routes}`. The route map uses stable IDs as keys. Each route has `provider`, `model`, `gatewayRevision`, `meteringRevision`, `maxInputTokens`, `maxOutputTokens`, `tools`, and `price`. The two price fields are integer microcredits per million tokens, `inputPerMillion` and `outputPerMillion`. Each release rounds the combined maximum charge up to a whole microcredit. The response encodes that integer as a decimal string.

The evidence report uses the [server schema](../../server/src/admin/bifrost-catalog.ts). Its top-level provider/model, route UUID, Harness image, gateway configuration revision, and metering revision identify the deployment under test. It also records the gateway image digest, an evidence bundle digest, and individual probe records. Keep credentials, headers, prompts, and provider response bodies out of the report. Fixture results do not qualify as live-provider evidence.

Update a route's gateway or metering revision when its effective configuration changes. A changed or removed route drops out of the active options immediately. If it was the default, the active default becomes empty until an administrator publishes a new one. Other verified routes remain available. Price edits take effect in a new Price Version, and previous snapshots retain the original rates and evidence. This admin catalog does not admit, dispatch, or bill end-user requests.

## Run the managed Harness probe

Use the managed LangGraph AG-UI image pinned in the draft. Start a private verification workload for one draft route at a time with this command.

```sh
uvicorn src.bifrost_probe:create_app --factory --host 0.0.0.0 --port 4206
```

This entry point serves `POST /bifrost-probe` and a liveness endpoint. Keep the workload accessible only to the verification operator. Inject three distinct secrets into `OPENBOT_BIFROST_PROBE_TOKEN` (operator), `OPENBOT_BIFROST_PROBE_GATEWAY_TOKEN` (Bifrost verification credential), and `OPENBOT_BIFROST_PROBE_METER_TOKEN` (meter credential). The regular Harness entry point is `src.main:app`. The verification workload uses Bifrost Chat Completions and supports synthetic text turns and an optional typed echo tool.

Set `OPENBOT_BIFROST_PROBE_ROUTE` to a JSON object with the draft's exact `provider`, `model`, `gatewayRevision`, `meteringRevision`, `maxInputTokens`, `maxOutputTokens`, and `tools` values. Add `gatewayBaseUrl`, the Bifrost Chat Completions base URL before `/chat/completions`, and `meterUrl`, the full metering endpoint URL. Both URLs use HTTPS. Plain HTTP is accepted for loopback fixtures.

The operator supplies the meter for the approved model and gateway configuration. It receives the byte-for-byte Chat Completions body with a bearer credential, `X-OpenBot-Operation-Id`, `X-OpenBot-Bifrost-Gateway-Revision`, and `X-OpenBot-Bifrost-Metering-Revision`. It returns a JSON object matching the following shape.

```json
{
  "inputTokenUpperBound": 120,
  "gatewayRevision": "approved-gateway-revision",
  "meteringRevision": "approved-meter-revision",
  "requestSha256": "<lowercase hex SHA-256 of the received body>"
}
```

The meter must calculate a conservative bound using the approved provider's tokenizer and chat template, including gateway/provider framing, message roles, tool schemas and results. It must refuse unknown routes, revisions or payloads it cannot bound. Bind the meter and Bifrost credentials to the isolated verification workload and disable gateway retries, fallbacks and transformations outside the approved configuration. Verify that the upstream model enforces `max_completion_tokens`, including any reasoning tokens it bills as completion tokens.

Use a fresh UUID in the AG-UI `runId` for every probe. The Harness sends it to Bifrost as `X-OpenBot-Operation-Id`. Capture it in the gateway trace and correlate each upstream step by its own request ID. The request below uses curl with a private config containing the operator token under `X-OpenBot-Agent-Token`.

```sh
curl -q --config "$PROBE_CURL_CONFIG" --fail --no-buffer --retry 0 \
  -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  --data-binary @probe-input.json "$PROBE_ORIGIN/bifrost-probe"
```

```json
{
  "threadId": "probe-thread",
  "runId": "13e7a58c-120c-4bc7-b55e-c2e78f75a51d",
  "state": {},
  "messages": [{"id": "input", "role": "user", "content": "Reply with two short sentences."}],
  "tools": [],
  "context": [],
  "forwardedProps": {}
}
```

For the standalone tool probe, replace `tools` with the array below and request `probe_echo` with a short synthetic marker. The Harness executes the echo once and passes its matching result back in the same run. The input meter and output cap apply to each of the two model requests. Record both request IDs and account for both steps when evaluating the tool probe's maximum cost.

```json
[
  {
    "name": "probe_echo",
    "description": "Echo the synthetic verification value.",
    "parameters": {
      "type": "object",
      "properties": {"value": {"type": "string"}},
      "required": ["value"],
      "additionalProperties": false
    }
  }
]
```

An unavailable, inconsistent, or over-cap input proof ends the run before Bifrost receives that model request. A completed model step requires gateway usage within the preflight input bound and output cap. Use independently attributable provider traces to verify actual usage, translation of the generation cap, retries, fallbacks, and provider-side terminal cancellation. Fixture results establish the Harness protocol behavior. Publication requires the live evidence and report import described above.
