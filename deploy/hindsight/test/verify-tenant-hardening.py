"""Unit-level pins for the OpenBot tenant extension's hardening (wave3 round-1 F3/F4).

Runs INSIDE the contract container, where ``hindsight_api`` is importable and the
extension sources are mounted at ``/opt/openbot-extensions``:

    sh deploy/hindsight/test/contract-instance.sh start
    docker exec -i openbot-hindsight-w4-contract python - \
      < deploy/hindsight/test/verify-tenant-hardening.py
    sh deploy/hindsight/test/contract-instance.sh stop

F3 — the shared API key is compared in constant time (``hmac.compare_digest``), on
bytes so a non-ASCII probe key is still a 401 (``AuthenticationError``), never a
``TypeError`` turned 500, and a request without any key never reaches a comparison.

F4 — ``filter_bank_list`` answers an EXTERNAL caller without a grant (
``allowed_bank_ids is None``) with an EMPTY list, the same deny posture
``bank_list_scope`` takes for that caller, instead of the unfiltered full list.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import json
import sys

from hindsight_api.extensions.operation_validator import BankListContext
from hindsight_api.extensions.tenant import AuthenticationError
from hindsight_api.models import RequestContext

from openbot_tenant.tenant import OpenBotTenantExtension
from openbot_tenant.validator import OpenBotOperationValidator

CHECKS: list[str] = []


def check(name: str, condition: bool) -> None:
    if not condition:
        print(f"FAIL {name}", file=sys.stderr)
        sys.exit(1)
    CHECKS.append(name)
    print(f"ok   {name}")


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def mint_assertion(secret: str, schema: str, banks: list[str]) -> str:
    payload = json.dumps(
        {"v": 1, "iss": "openbot", "tid": "t1", "pid": "p1", "sch": schema, "b": banks},
        separators=(",", ":"),
    ).encode("utf-8")
    body = b64url(payload)
    signature = b64url(
        hmac.new(secret.encode("utf-8"), f"v1.{body}".encode("ascii"), hashlib.sha256).digest()
    )
    return f"v1.{body}.{signature}"


async def main() -> None:
    # ---- F3: the shared-key half of the service identity ----
    tenant = OpenBotTenantExtension(
        {"api_key": "unit-service-key", "assertion_secret": "unit-assertion-secret"}
    )
    token = mint_assertion("unit-assertion-secret", "ob_c_0123456789abcdef", ["bank_a"])

    # A no-key request is not a comparison candidate at all — refused, not crashed.
    try:
        await tenant.authenticate(
            RequestContext(api_key=None, extra_headers={"x-openbot-bank-scope": token})
        )
        check("F3: a request without any key is refused", False)
    except AuthenticationError:
        check("F3: a request without any key is refused", True)

    # A non-ASCII probe key must stay a 401 (bytes compare), never a TypeError → 500.
    try:
        await tenant.authenticate(
            RequestContext(
                api_key="не-ascii-ключ", extra_headers={"x-openbot-bank-scope": token}
            )
        )
        check("F3: a non-ASCII probe key is refused as credentials, not a crash", False)
    except TypeError:
        check("F3: a non-ASCII probe key is refused as credentials, not a crash", False)
    except AuthenticationError:
        check("F3: a non-ASCII probe key is refused as credentials, not a crash", True)

    # A wrong ASCII key with a valid assertion still fails the key half.
    try:
        await tenant.authenticate(
            RequestContext(
                api_key="wrong-key", extra_headers={"x-openbot-bank-scope": token}
            )
        )
        check("F3: a wrong key is refused even with a valid assertion", False)
    except AuthenticationError:
        check("F3: a wrong key is refused even with a valid assertion", True)

    # The comparison itself is the constant-time one; a regression to plain != loses here.
    check(
        "F3: authenticate compares the key with hmac.compare_digest",
        "compare_digest" in inspect.getsource(OpenBotTenantExtension.authenticate),
    )

    # ---- F4: the bank list for a caller that reached it without a grant ----
    validator = OpenBotOperationValidator({})
    banks = [{"id": "bank_a"}, {"id": "bank_b"}]

    no_grant = await validator.filter_bank_list(
        BankListContext(banks=list(banks), request_context=RequestContext(api_key="k"))
    )
    check(
        "F4: an external caller with no grant enumerates no banks",
        no_grant.banks == [],
    )

    granted = await validator.filter_bank_list(
        BankListContext(
            banks=list(banks),
            request_context=RequestContext(api_key="k", allowed_bank_ids=["bank_b"]),
        )
    )
    check(
        "F4: a granted caller's list is narrowed to the grant",
        [bank["id"] for bank in granted.banks] == ["bank_b"],
    )

    empty_grant = await validator.filter_bank_list(
        BankListContext(
            banks=list(banks),
            request_context=RequestContext(api_key="k", allowed_bank_ids=[]),
        )
    )
    check("F4: an empty grant enumerates no banks", empty_grant.banks == [])

    internal = await validator.filter_bank_list(
        BankListContext(banks=list(banks), request_context=RequestContext(internal=True))
    )
    check(
        "F4: internal background work keeps the full list",
        internal.banks == banks,
    )

    print(f"verify-tenant-hardening: {len(CHECKS)} checks passed")


asyncio.run(main())
