"""OpenBot's operation validator: bank-level confinement of every memory operation.

The tenant extension establishes WHO is calling (schema + allowed banks, bound by one
signature). This validator enforces the second half of #381: every operation — retain,
recall, reflect, curation, bank reads, bank writes, bank creation, mental models — is
confined to the banks that identity was granted. A bank id that is merely well-formed but
not in the grant is refused; sharing tags, or observing with no tags at all, changes
nothing, because the bank boundary is checked before tags are ever consulted (tags are
classification, never isolation); and an external caller with no assertion at all has no
grant, so nothing is allowed — the shared service key alone authorizes no memory work.
"""

from __future__ import annotations

import logging

from hindsight_api.extensions.operation_validator import (
    BankListContext,
    BankListResult,
    BankListScope,
    OperationValidatorExtension,
    TagScopeContext,
    ValidationResult,
)
from hindsight_api.models import RequestContext

logger = logging.getLogger(__name__)

_DENY_NO_GRANT = ValidationResult.reject(
    "No bank grant established for this caller", status_code=403
)
_DENY_BANK = ValidationResult.reject(
    "Bank is outside this caller's grant", status_code=403
)


def _grant_allows(request_context: RequestContext, bank_id: str) -> bool:
    """Whether the caller's signed grant names this bank.

    ``allowed_bank_ids is None`` on an EXTERNAL request means authentication produced no
    grant (no assertion; the shared key alone) — nothing is allowed. ``internal`` contexts
    are background work the submission path already validated and scoped; the engine
    guarantees the same for them (see TenantExtension.authenticate docs).
    """
    if request_context is None or getattr(request_context, "internal", False):
        return True
    allowed = getattr(request_context, "allowed_bank_ids", None)
    if not allowed:
        return False
    return bank_id in allowed


class OpenBotOperationValidator(OperationValidatorExtension):
    """Confine every memory operation to the banks the authenticated grant names.

    One rule, applied to every hook: the bank the operation names must be in the caller's
    grant. The validator keeps no state and consults nothing but the request context the
    tenant extension populated, so the signature is the only way in and every refusal is
    the same shape.
    """

    def _check(self, request_context: RequestContext, bank_id: str) -> ValidationResult:
        if _grant_allows(request_context, bank_id):
            return ValidationResult.accept()
        return _DENY_BANK

    async def validate_retain(self, ctx) -> ValidationResult:  # noqa: ANN001 - engine-owned dataclass
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_recall(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_reflect(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_consolidate(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_bank_read(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_bank_write(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_create_bank(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_mental_model_get(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_mental_model_refresh(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def validate_memory_update(self, ctx) -> ValidationResult:  # noqa: ANN001
        return self._check(ctx.request_context, ctx.bank_id)

    async def resolve_tag_scope(self, ctx: TagScopeContext) -> None:
        """Tags are classification, never isolation.

        The bank grant is the security boundary; returning no tag scope keeps tags from
        being load-bearing for access — a caller sharing another's tags, or observing with
        no tags, is still confined to (and only to) the banks in its own grant.
        """
        return None

    async def bank_list_scope(self, request_context: RequestContext) -> BankListScope | None:
        """A caller's bank list shows exactly the granted banks — nothing else to enumerate."""
        allowed = getattr(request_context, "allowed_bank_ids", None)
        if request_context is None or getattr(request_context, "internal", False):
            return None
        if not allowed:
            return BankListScope(bank_ids=[])
        return BankListScope(bank_ids=list(allowed))

    async def filter_bank_list(self, ctx: BankListContext) -> BankListResult:
        """The post-query narrowing for callers that reached the list without a scope."""
        allowed = getattr(ctx.request_context, "allowed_bank_ids", None)
        if getattr(ctx.request_context, "internal", False) or allowed is None:
            return BankListResult(banks=ctx.banks)
        return BankListResult(
            banks=[bank for bank in ctx.banks if bank.get("id") in set(allowed)]
        )
