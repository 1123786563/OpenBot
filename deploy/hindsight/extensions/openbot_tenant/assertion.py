"""Verification of OpenBot's signed bank-scope assertions.

The token is ``v1.<body>.<signature>`` where ``body`` is url-safe base64 of the JSON
payload and ``signature`` is url-safe base64 of HMAC-SHA256(secret, "v1.<body>") — the
same bytes OpenBot's server-side mint (server/src/hindsight/bank-scope.ts) signs.
Verification only ever parses the received body bytes, so no canonical-serialization
agreement is needed beyond the secret.

The payload carries the wire contract:

    v   1
    iss "openbot"
    tid OpenBot tenant (company) id — descriptive; the schema is the isolation unit
    pid OpenBot principal id in that company
    sch PostgreSQL schema on this service the request is confined to
    b   the bank ids the request may touch
    iat / exp  issued-at / expiry, whole unix seconds
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

ASSERTION_VERSION = "v1"
ASSERTION_ISSUER = "openbot"
#: Hard ceiling on how far in the future a clock skew may push a fresh check.
_ALLOWED_SKEW_SECONDS = 0


class BankScopeAssertionError(Exception):
    """Raised when an assertion is malformed, wrongly signed, or expired.

    Carries a stable, non-revealing reason: nothing about WHICH check failed is
    distinguishable to a caller probing the service.
    """

    def __init__(self) -> None:
        super().__init__("Invalid bank scope assertion")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def verify_bank_scope_assertion(
    token: str | None, secret: str, *, now: float | None = None
) -> dict:
    """Verify one assertion; return its payload or raise :class:`BankScopeAssertionError`.

    Every failure raises the same error with the same message: a caller probing with
    guessed or tampered tokens learns nothing about which structural element was wrong.
    """
    if not isinstance(token, str):
        raise BankScopeAssertionError()
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != ASSERTION_VERSION:
        raise BankScopeAssertionError()
    _, body, signature = parts
    try:
        received = _b64url_decode(signature)
    except Exception:
        raise BankScopeAssertionError() from None
    expected = hmac.new(
        secret.encode("utf-8"), f"{ASSERTION_VERSION}.{body}".encode("ascii"),
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(received, expected):
        raise BankScopeAssertionError()
    try:
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
    except Exception:
        raise BankScopeAssertionError() from None
    if not isinstance(payload, dict):
        raise BankScopeAssertionError()
    if payload.get("v") != 1 or payload.get("iss") != ASSERTION_ISSUER:
        raise BankScopeAssertionError()
    schema = payload.get("sch")
    banks = payload.get("b")
    if not isinstance(schema, str) or not _is_safe_identifier(schema):
        raise BankScopeAssertionError()
    if not isinstance(banks, list) or not banks:
        raise BankScopeAssertionError()
    if not all(isinstance(bank, str) and _is_safe_identifier(bank) for bank in banks):
        raise BankScopeAssertionError()
    if len(set(banks)) != len(banks):
        raise BankScopeAssertionError()
    expiry = payload.get("exp")
    if not isinstance(expiry, (int, float)) or isinstance(expiry, bool):
        raise BankScopeAssertionError()
    current = time.time() if now is None else now
    if expiry <= current + _ALLOWED_SKEW_SECONDS:
        raise BankScopeAssertionError()
    return payload


def _is_safe_identifier(value: str) -> bool:
    """OpenBot derives every schema/bank id as ``ob_[ctusb]_<16 hex>``; accept exactly that."""
    if len(value) != 21 or not value.startswith("ob_"):
        return False
    if value[3] not in "ctusb" or value[4] != "_":
        return False
    return all(character in "0123456789abcdef" for character in value[5:])
