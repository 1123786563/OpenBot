"""Operator-only Bifrost verification using the managed LangGraph AG-UI Harness."""

import asyncio
import hashlib
import hmac
import json
import os
from contextlib import aclosing, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

import httpx
from ag_ui.core import RunAgentInput, RunErrorEvent, Tool
from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from anyio import CancelScope
from fastapi import Depends, FastAPI, HTTPException, Request
from langchain_core.messages import ToolMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .main import TOKEN_HEADER, build_graph, health
from .tool_runtime import (
    RunRefused,
    ToolAwareAgent,
    bind_tools,
    current_tools,
    model_messages,
)

_run_id: ContextVar[str] = ContextVar("bifrost_probe_run_id")

# Same identifiers and bounds as the Bifrost admin catalog.
Reference = Annotated[str, Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$")]
TokenCap = Annotated[int, Field(gt=0, le=10_000_000)]

ECHO = Tool(
    name="probe_echo",
    description="Echo the synthetic verification value.",
    parameters={
        "type": "object",
        "properties": {"value": {"type": "string"}},
        "required": ["value"],
        "additionalProperties": False,
    },
)


class Route(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", alias_generator=to_camel)

    provider: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]
    model: Reference
    gateway_base_url: str
    meter_url: str
    gateway_revision: Reference
    metering_revision: Reference
    max_input_tokens: TokenCap
    max_output_tokens: TokenCap
    tools: bool


class MeterBound(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", alias_generator=to_camel)

    input_token_upper_bound: Annotated[int, Field(ge=0)]
    metering_revision: str
    gateway_revision: str
    request_sha256: str


@dataclass
class ProbeRequest:
    closed: bool = False
    model_task: asyncio.Task | None = None


_request: ContextVar[ProbeRequest] = ContextVar("bifrost_probe_request")


def endpoint(value: str) -> httpx.URL:
    url = httpx.URL(value)
    local = url.host in {"localhost", "127.0.0.1", "::1"}
    if (
        not url.host
        or url.userinfo
        or url.query
        or url.fragment
        or not (url.scheme == "https" or (url.scheme == "http" and local))
    ):
        raise ValueError("Invalid Bifrost probe URL.")
    return url


class ProbeAgent(ToolAwareAgent):
    async def run(self, input: RunAgentInput):
        try:
            run_id = str(UUID(input.run_id))
        except ValueError:
            yield RunErrorEvent(message="Bifrost probe runId must be a UUID.")
            return

        # Only the graph's deterministic tool can execute. Discard model, effort and callback
        # overrides before the ordinary Harness sees the request.
        props = {"openbotDeploymentTools": [ECHO.name]}
        token = _run_id.set(run_id)
        try:
            async with aclosing(
                super().run(input.model_copy(update={"forwarded_props": props}))
            ) as stream:
                async for event in stream:
                    yield event
        finally:
            _run_id.reset(token)


async def echo_tool(state):
    messages = state["messages"]
    calls = messages[-1].tool_calls
    if len(calls) != 1 or any(isinstance(message, ToolMessage) for message in messages):
        raise RunRefused("The Bifrost probe allows one tool call per run.")
    call = calls[0]
    args = call["args"]
    if args.keys() != {"value"} or not isinstance(args["value"], str):
        raise RunRefused("The Bifrost probe tool requires a string value.")
    return {
        "messages": [
            ToolMessage(content=args["value"], tool_call_id=call["id"], name=ECHO.name)
        ]
    }


def create_app() -> FastAPI:
    """Start with uvicorn src.bifrost_probe:create_app --factory."""
    try:
        route = Route.model_validate_json(os.environ["OPENBOT_BIFROST_PROBE_ROUTE"])
        base_url = endpoint(route.gateway_base_url.rstrip("/"))
        completion_url = httpx.URL(f"{base_url}/chat/completions")
        meter_url = endpoint(route.meter_url)
        operator_token = os.environ["OPENBOT_BIFROST_PROBE_TOKEN"].strip()
        gateway_token = os.environ["OPENBOT_BIFROST_PROBE_GATEWAY_TOKEN"].strip()
        meter_token = os.environ["OPENBOT_BIFROST_PROBE_METER_TOKEN"].strip()
        if len({operator_token, gateway_token, meter_token}) != 3 or not all(
            (operator_token, gateway_token, meter_token)
        ):
            raise ValueError
        if completion_url == meter_url:
            raise ValueError
    except (KeyError, ValueError, httpx.InvalidURL):
        raise RuntimeError("Invalid Bifrost probe deployment configuration.") from None

    model_id = f"{route.provider}/{route.model}"

    async def require_operator(request: Request):
        if request.url.path == "/health":
            yield
            return
        token = request.headers.get(TOKEN_HEADER, "").strip()
        if not hmac.compare_digest(token.encode(), operator_token.encode()):
            raise HTTPException(status_code=401, detail="unauthorised")
        probe = ProbeRequest()
        context = _request.set(probe)
        try:
            yield
        finally:
            probe.closed = True
            # The AG-UI adapter owns the event generator. Stop the current model task even
            # when a disconnected HTTP consumer leaves that generator suspended at a yield.
            try:
                if task := probe.model_task:
                    task.cancel()
                    with CancelScope(shield=True), suppress(asyncio.CancelledError):
                        await task
            finally:
                _request.reset(context)

    async def answer(state):
        probe = _request.get()
        if probe.closed:
            raise asyncio.CancelledError
        probe.model_task = asyncio.current_task()
        try:
            return await invoke_model(state, probe)
        finally:
            probe.model_task = None

    async def invoke_model(state, probe):
        offered = current_tools().tools
        if offered and (not route.tools or offered != (ECHO,)):
            raise RunRefused("Only the configured Bifrost probe tool may be offered.")
        messages = model_messages(state["messages"])
        run_id = _run_id.get()
        refusal = None
        input_upper_bound: int | None = None

        async def meter_before_send(request: httpx.Request):
            nonlocal refusal, input_upper_bound
            # Check the exact SDK request. A change of API, redirect, or alternate request
            # parameters cannot turn the metering hook into an unbounded dispatch.
            body = json.loads(request.content)
            allowed = {
                "model",
                "messages",
                "max_completion_tokens",
                "stream",
                "stream_options",
                "tools",
            }
            if (
                input_upper_bound is not None
                or request.method != "POST"
                or request.url != completion_url
                or request.headers.get("authorization") != f"Bearer {gateway_token}"
                or request.headers.get("x-openbot-operation-id") != run_id
                or not isinstance(body, dict)
                or body.keys() - allowed
                or body.get("model") != model_id
                or body.get("max_completion_tokens") != route.max_output_tokens
                or body.get("stream") is not True
                or body.get("stream_options") != {"include_usage": True}
            ):
                refusal = "Bifrost probe request does not match its pinned route."
                raise RunRefused(refusal)

            digest = hashlib.sha256(request.content).hexdigest()
            try:
                async with httpx.AsyncClient(
                    trust_env=False, follow_redirects=False, timeout=10
                ) as meter:
                    response = await meter.post(
                        meter_url,
                        content=request.content,
                        headers={
                            "content-type": "application/json",
                            "authorization": f"Bearer {meter_token}",
                            "x-openbot-operation-id": run_id,
                            "x-openbot-bifrost-gateway-revision": route.gateway_revision,
                            "x-openbot-bifrost-metering-revision": route.metering_revision,
                        },
                    )
                    response.raise_for_status()
                    proof = MeterBound.model_validate_json(response.content)
                if (
                    proof.request_sha256 != digest
                    or proof.gateway_revision != route.gateway_revision
                    or proof.metering_revision != route.metering_revision
                ):
                    raise ValueError
            except (httpx.HTTPError, ValueError):
                refusal = "Bifrost probe input bound could not be verified."
                raise RunRefused(refusal) from None

            if proof.input_token_upper_bound > route.max_input_tokens:
                refusal = "Bifrost probe input exceeds the configured cap."
                raise RunRefused(refusal)
            if probe.closed:
                raise asyncio.CancelledError
            input_upper_bound = proof.input_token_upper_bound

        async with httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
            timeout=85,
            event_hooks={"request": [meter_before_send]},
        ) as gateway:
            try:
                model = ChatOpenAI(
                    model=model_id,
                    base_url=str(base_url),
                    api_key=gateway_token,
                    openai_proxy="",
                    use_responses_api=False,
                    streaming=True,
                    stream_usage=True,
                    max_completion_tokens=route.max_output_tokens,
                    max_retries=0,
                    timeout=85,
                    http_async_client=gateway,
                    default_headers={"x-openbot-operation-id": run_id},
                )
                reply = await bind_tools(model).ainvoke(messages)
            except Exception:  # noqa: BLE001 - SDK errors may include upstream response bodies.
                # The SDK also wraps request-hook failures.
                raise RunRefused(
                    refusal or "Bifrost probe gateway request failed."
                ) from None

        usage = reply.usage_metadata
        if (
            input_upper_bound is None
            or usage is None
            or not 0 <= usage["input_tokens"] <= input_upper_bound
            or not 0 <= usage["output_tokens"] <= route.max_output_tokens
        ):
            raise RunRefused(
                "Bifrost probe gateway usage could not confirm the token bounds."
            )
        return {"messages": [reply]}

    app = FastAPI(
        dependencies=[Depends(require_operator)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_api_route("/health", health, methods=["GET"])
    add_langgraph_fastapi_endpoint(
        app=app,
        agent=ProbeAgent(
            name="bifrost-probe",
            graph=build_graph(answer, echo_tool),
            config={"recursion_limit": 25},
        ),
        path="/bifrost-probe",
    )
    return app
