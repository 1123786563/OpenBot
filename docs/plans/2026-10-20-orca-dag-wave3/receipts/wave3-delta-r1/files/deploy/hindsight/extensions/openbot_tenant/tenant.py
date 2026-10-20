"""OpenBot's tenant extension: shared-key + signed-assertion authentication.

Extends the deployment Wave 1 posture (fixed image, loopback-only API, single shared
service key) with per-request tenant resolution: the company's PostgreSQL schema and the
bank allow-list arrive together, bound by one HMAC signature, and neither is taken from
an unverified source. The shared API key alone — the Wave 1 identity — authenticates
nothing on memory routes: it proves the caller is OpenBot's deployment only when paired
with a fresh assertion naming whose identity this request acts for.
"""

from __future__ import annotations

import logging

from hindsight_api.config import get_config
from hindsight_api.extensions.tenant import (
    AuthenticationError,
    Tenant,
    TenantContext,
    TenantExtension,
)
from hindsight_api.models import RequestContext

from .assertion import BankScopeAssertionError, verify_bank_scope_assertion

logger = logging.getLogger(__name__)

#: The header the assertion rides in; must be listed in
#: HINDSIGHT_API_EXTENSION_PASSTHROUGH_HEADERS for RequestContext.extra_headers to carry it.
DEFAULT_ASSERTION_HEADER = "x-openbot-bank-scope"

#: Schemas this extension owns, for tenant discovery (background maintenance). OpenBot
#: derives company schemas as ob_c_<16 hex>; only those are ever provisioned here.
_SCHEMA_PREFIX = "ob_c_"


class OpenBotTenantExtension(TenantExtension):
    """Authenticate OpenBot's server-issued identity and confine the request to its banks.

    Configuration (from HINDSIGHT_API_TENANT_* environment variables):

        api_key          the shared service key (Authorization: Bearer ...)
        assertion_secret HMAC secret shared with OpenBot's bank-scope mint
        assertion_header passthrough header carrying the assertion (default x-openbot-bank-scope)

    On success the RequestContext carries ``allowed_bank_ids`` (never None for an
    authenticated external caller) and the schema is set for every query this request
    runs. On failure the request is refused before any memory work starts.
    """

    def __init__(self, config: dict[str, str]):
        super().__init__(config)
        self.expected_api_key = config.get("api_key")
        if not self.expected_api_key:
            raise ValueError(
                "HINDSIGHT_API_TENANT_API_KEY is required: the shared service key is half "
                "of OpenBot's service identity"
            )
        self.assertion_secret = config.get("assertion_secret")
        if not self.assertion_secret:
            raise ValueError(
                "HINDSIGHT_API_TENANT_ASSERTION_SECRET is required: the secret shared with "
                "OpenBot's bank-scope mint is the other half of the service identity"
            )
        self.assertion_header = (
            config.get("assertion_header", DEFAULT_ASSERTION_HEADER) or DEFAULT_ASSERTION_HEADER
        ).lower()
        # Company schemas this process has already provisioned/seen: keeps the happy path
        # free of a catalog round trip, not a security boundary (the assertion still decides).
        self._known_schemas: set[str] = set()

    async def authenticate(self, context: RequestContext) -> TenantContext:
        if context.api_key != self.expected_api_key:
            raise AuthenticationError("Invalid service credentials")
        # MCP transport re-auth delegates here as well; the passthrough header reaches both
        # transports, so the assertion requirement is uniform.
        token = (context.extra_headers or {}).get(self.assertion_header)
        try:
            payload = verify_bank_scope_assertion(token, self.assertion_secret)
        except BankScopeAssertionError:
            # A 401, not 403: the caller did not establish a service identity at all.
            raise AuthenticationError("Invalid service credentials") from None
        schema = payload["sch"]
        banks = list(payload["b"])
        context.tenant_id = payload.get("tid")
        context.allowed_bank_ids = banks
        await self._ensure_schema(schema)
        return TenantContext(schema_name=schema)

    async def list_tenants(self) -> list[Tenant]:
        """The schemas this service currently serves, for startup and background maintenance.

        The engine calls this from inside ``initialize()`` (startup migrations discover
        schemas through it), so discovery MUST NOT touch the engine's pool before the
        engine is initialized — ``_get_pool()`` re-enters ``initialize()`` and the
        recursion exhausts PostgreSQL's connection budget. During initialization the
        answer is the base schema alone (the tables every request needs); once the
        engine is up, the company schemas are enumerated from the database (the durable
        truth: a schema that exists is a company that was provisioned). Failures answer
        the base schema alone so maintenance skips a turn rather than breaking.
        """
        base = get_config().database_schema
        try:
            engine = self.context.get_memory_engine()
            if not getattr(engine, "_initialized", False):
                return [Tenant(schema=base)]
            pool = await engine._get_pool()  # noqa: SLF001 - the documented data-plane handle
            rows = await pool.fetch(
                "SELECT schema_name FROM information_schema.schemata "
                "WHERE schema_name LIKE 'ob\\_c\\__%'"
            )
        except Exception as error:  # noqa: BLE001 - discovery must never take the service down
            logger.warning("OpenBot tenant discovery failed: %s", error)
            return [Tenant(schema=base)]
        schemas = sorted(row["schema_name"] for row in rows)
        self._known_schemas.update(schemas)
        return [Tenant(schema=base)] + [Tenant(schema=schema) for schema in schemas]

    async def _ensure_schema(self, schema: str) -> None:
        """Provision a company's schema on first sight (idempotent, advisory-locked).

        The migration runner creates the schema when it does not exist, so a new company's
        first authenticated request pays a one-time provisioning cost and every later one
        reuses the schema. Nothing here trusts the schema's existence for authorization —
        the assertion already confined the request — this only keeps queries from failing
        against a schema that has no tables yet.
        """
        if schema in self._known_schemas:
            return
        try:
            engine = self.context.get_memory_engine()
            if getattr(engine, "_initialized", False):
                pool = await engine._get_pool()  # noqa: SLF001
                row = await pool.fetchrow(
                    "SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", schema
                )
                if row is not None:
                    self._known_schemas.add(schema)
                    return
            logger.info("Provisioning Hindsight schema for a new OpenBot company: %s", schema)
            await self.context.run_migration(schema)
            self._known_schemas.add(schema)
        except Exception as error:  # noqa: BLE001
            # Provisioning failure surfaces as the request failing against a schema with no
            # tables — loud, retryable, and never a fallback to another tenant's schema.
            logger.error("Schema provisioning failed for %s: %s", schema, error)
