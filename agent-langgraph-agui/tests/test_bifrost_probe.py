"""The managed AG-UI endpoint and real SDK, with a gateway and meter fixture."""

import asyncio
import hashlib
import json
from uuid import uuid4

import httpx
import pytest


@pytest.fixture
def probe(monkeypatch, request):
    from src.bifrost_probe import create_app

    provider, model = getattr(request, "param", ("fixture-a", "model-a"))
    monkeypatch.setenv("OPENBOT_BIFROST_PROBE_TOKEN", "synthetic-operator")
    monkeypatch.setenv("OPENBOT_BIFROST_PROBE_GATEWAY_TOKEN", "synthetic-gateway")
    monkeypatch.setenv("OPENBOT_BIFROST_PROBE_METER_TOKEN", "synthetic-meter")
    monkeypatch.setenv(
        "OPENBOT_BIFROST_PROBE_ROUTE",
        json.dumps(
            {
                "provider": provider,
                "model": model,
                "gatewayBaseUrl": "https://gateway.example/openai",
                "meterUrl": "https://meter.example/count",
                "gatewayRevision": "gateway-fixture",
                "meteringRevision": "meter-fixture",
                "maxInputTokens": 12,
                "maxOutputTokens": 4,
                "tools": True,
            }
        ),
    )
    seen = {"meter": [], "gateway": []}

    async def outbound(_, request):
        if request.url == httpx.URL("https://meter.example/count"):
            seen["meter"].append(request)
            count = seen["counts"].pop(0) if "counts" in seen else seen.get("count", 12)
            proof = {
                "inputTokenUpperBound": count,
                "meteringRevision": "meter-fixture",
                "gatewayRevision": "gateway-fixture",
                "requestSha256": hashlib.sha256(request.content).hexdigest(),
            }
            proof.update(seen.get("proof", {}))
            return httpx.Response(seen.get("meter_status", 200), json=proof)
        assert request.url == httpx.URL(
            "https://gateway.example/openai/chat/completions"
        )
        seen["gateway"].append(request)
        if status := seen.get("gateway_status"):
            return httpx.Response(
                status,
                headers={"location": "https://other.example/"} if status == 307 else {},
                json={"error": {"message": "fixture failure"}},
            )
        body = json.loads(request.content)
        deltas = [
            ({"role": "assistant", "content": "one "}, None),
            ({"content": "two"}, None),
            ({}, "length"),
        ]
        if body.get("tools"):
            if body["messages"][-1]["role"] == "tool":
                deltas = [
                    (
                        {
                            "role": "assistant",
                            "content": "echo: " + body["messages"][-1]["content"],
                        },
                        None,
                    ),
                    ({}, "stop"),
                ]
            else:
                deltas = [
                    (
                        {
                            "role": "assistant",
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "fixture-call",
                                    "type": "function",
                                    "function": {
                                        "name": "probe_echo",
                                        "arguments": '{"value":"marker"}',
                                    },
                                }
                            ],
                        },
                        None,
                    ),
                    ({}, "tool_calls"),
                ]
        parts = [
            {
                "id": "fixture-completion",
                "object": "chat.completion.chunk",
                "created": 0,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
            }
            for delta, reason in deltas
        ]
        if not seen.get("omit_usage"):
            prompt_tokens, completion_tokens = seen.get("usage", (12, 4))
            parts.append(
                {
                    **parts[0],
                    "choices": [],
                    "usage": {
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "total_tokens": prompt_tokens + completion_tokens,
                    },
                }
            )
        if seen.get("hold_stream"):

            class HeldStream(httpx.AsyncByteStream):
                async def __aiter__(self):
                    yield f"data: {json.dumps(parts[0])}\n\n".encode()
                    await asyncio.Future()

                async def aclose(self):
                    seen["stream_closed"].set()

            return httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=HeldStream()
            )
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content="".join(f"data: {json.dumps(part)}\n\n" for part in parts)
            + "data: [DONE]\n\n",
        )

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", outbound)
    return create_app(), seen


def probe_input(**overrides):
    return {
        "threadId": str(uuid4()),
        "runId": str(uuid4()),
        "state": {},
        "messages": [{"id": "input", "role": "user", "content": "Synthetic input."}],
        "tools": [],
        "context": [],
        "forwardedProps": {
            "openbotModel": {"model": "other", "reasoningEffort": "high"}
        },
        **overrides,
    }


async def agui(app, data, token="synthetic-operator", path="/bifrost-probe"):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://probe"
    ) as client:
        return await client.post(
            path, json=data, headers={"x-openbot-agent-token": token}
        )


def events(response):
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("probe", "expected_model"),
    [
        (("fixture-a", "model-a"), "fixture-a/model-a"),
        (("fixture-b", "model-b"), "fixture-b/model-b"),
    ],
    indirect=["probe"],
)
async def test_streams_pinned_bounded_request_through_managed_harness(
    probe, expected_model
):
    app, seen = probe
    data = probe_input()
    result = events(await agui(app, data))

    assert [
        event["delta"] for event in result if event["type"] == "TEXT_MESSAGE_CONTENT"
    ] == ["one ", "two"]
    assert result[-1]["type"] == "RUN_FINISHED"
    (meter,), (gateway,) = seen["meter"], seen["gateway"]
    assert meter.content == gateway.content
    assert meter.headers["authorization"] == "Bearer synthetic-meter"
    assert gateway.headers["authorization"] == "Bearer synthetic-gateway"
    assert meter.headers["x-openbot-bifrost-metering-revision"] == "meter-fixture"
    assert gateway.headers["x-openbot-operation-id"] == data["runId"]
    assert json.loads(gateway.content) == {
        "model": expected_model,
        "messages": [{"role": "user", "content": "Synthetic input."}],
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_completion_tokens": 4,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("override", "message"),
    [
        ({"count": 13}, "input exceeds the configured cap"),
        ({"count": True}, "input bound could not be verified"),
        ({"count": -1}, "input bound could not be verified"),
        ({"meter_status": 503}, "input bound could not be verified"),
        ({"proof": {"requestSha256": "wrong"}}, "input bound could not be verified"),
        ({"proof": {"meteringRevision": "stale"}}, "input bound could not be verified"),
        ({"proof": {"gatewayRevision": "stale"}}, "input bound could not be verified"),
    ],
)
async def test_rejects_unproven_or_over_cap_input_before_gateway(
    probe, override, message
):
    app, seen = probe
    seen.update(override)

    result = events(await agui(app, probe_input()))

    assert result[-1]["type"] == "RUN_ERROR"
    assert message in result[-1]["message"]
    assert len(seen["meter"]) == 1
    assert not seen["gateway"]


@pytest.mark.asyncio
@pytest.mark.parametrize("gateway_status", [307, 429, 503])
async def test_gateway_failure_makes_one_attempt(probe, gateway_status):
    app, seen = probe
    seen["gateway_status"] = gateway_status

    result = events(await agui(app, probe_input()))

    assert result[-1]["type"] == "RUN_ERROR"
    assert len(seen["meter"]) == len(seen["gateway"]) == 1
    assert "fixture failure" not in result[-1]["message"]


@pytest.mark.asyncio
async def test_only_operator_can_reach_probe_and_product_route_is_absent(
    probe, monkeypatch
):
    app, seen = probe
    monkeypatch.setenv("MANAGED_AGENT_TOKEN", "regular-managed-agent")
    assert (
        await agui(app, probe_input(), token="regular-managed-agent")
    ).status_code == 401
    assert (await agui(app, probe_input(), path="/")).status_code == 404
    assert not seen["gateway"]


@pytest.mark.asyncio
@pytest.mark.parametrize("followup_count", [12, 13])
async def test_typed_tool_result_is_remetered_in_same_run(probe, followup_count):
    app, seen = probe
    data = probe_input(
        tools=[
            {
                "name": "probe_echo",
                "description": "Echo the synthetic verification value.",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
            }
        ]
    )
    seen["counts"] = [12, followup_count]
    result = events(await agui(app, data))

    assert any(event["type"] == "TOOL_CALL_START" for event in result)
    assert len(seen["meter"]) == 2
    followup = json.loads(seen["meter"][1].content)
    assert followup["messages"][-1] == {
        "role": "tool",
        "content": "marker",
        "tool_call_id": "fixture-call",
    }
    assert followup["max_completion_tokens"] == 4
    assert all(
        m.headers["x-openbot-operation-id"] == data["runId"] for m in seen["meter"]
    )
    if followup_count == 12:
        assert result[-1]["type"] == "RUN_FINISHED"
        assert any(event.get("delta") == "echo: marker" for event in result)
        assert seen["meter"][1].content == seen["gateway"][1].content
    else:
        assert result[-1]["type"] == "RUN_ERROR"
        assert "input exceeds the configured cap" in result[-1]["message"]
        assert len(seen["gateway"]) == 1


@pytest.mark.asyncio
async def test_agui_disconnect_closes_inflight_gateway_stream(probe):
    app, seen = probe
    seen["hold_stream"] = True
    seen["stream_closed"] = asyncio.Event()
    emitted_text = asyncio.Event()
    body = json.dumps(probe_input()).encode()
    first = True

    async def receive():
        nonlocal first
        if first:
            first = False
            return {"type": "http.request", "body": body}
        await emitted_text.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if b"TEXT_MESSAGE_CONTENT" in message.get("body", b""):
            emitted_text.set()

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "method": "POST",
        "path": "/bifrost-probe",
        "headers": [
            (b"content-type", b"application/json"),
            (b"x-openbot-agent-token", b"synthetic-operator"),
        ],
        "query_string": b"",
    }
    await asyncio.wait_for(app(scope, receive, send), timeout=5)

    assert emitted_text.is_set()
    await asyncio.wait_for(seen["stream_closed"].wait(), timeout=1)
    assert len(seen["gateway"]) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [{"omit_usage": True}, {"usage": (12, 5)}, {"count": 11}],
)
async def test_reports_error_if_gateway_usage_cannot_confirm_bounds(probe, override):
    app, seen = probe
    seen.update(override)

    result = events(await agui(app, probe_input()))

    assert result[-1]["type"] == "RUN_ERROR"
    assert "gateway usage could not confirm the token bounds" in result[-1]["message"]
    assert len(seen["gateway"]) == 1
