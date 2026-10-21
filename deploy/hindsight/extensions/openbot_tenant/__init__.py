"""OpenBot's custom tenant authentication and bank-scope validation for Hindsight.

This package is mounted read-only into the Hindsight container (deploy/hindsight/
docker-compose.yml) and selected with:

    HINDSIGHT_API_TENANT_EXTENSION=openbot_tenant:OpenBotTenantExtension
    HINDSIGHT_API_OPERATION_VALIDATOR_EXTENSION=openbot_tenant:OpenBotOperationValidator
    HINDSIGHT_API_EXTENSION_PASSTHROUGH_HEADERS=x-openbot-bank-scope

The design (#381, spec #376): OpenBot is the only client of this service and the only
authority for who may touch which memory. A request carries the deployment's shared
service API key (Authorization: Bearer ...) AND a short-lived HMAC-signed bank-scope
assertion (x-openbot-bank-scope) minted server-side by OpenBot for one trusted identity.
Neither alone is a service identity:

* the key without an assertion authenticates nothing (every memory operation is refused);
* an assertion without the right key never reaches the assertion check;
* a forged, expired, or tampered assertion is refused with 401/403;
* every retain/recall/delete is confined to the banks the assertion names, so a guessed
  bank id is rejected however well-formed it is, and tags/tag-groups (classification,
  not security) cannot widen the grant.

The same global user holding principals in two companies arrives with two different
schemas and two different banks: the schema is derived from the company, the bank from
the principal, and the pair is bound by the signature.
"""

from .assertion import BankScopeAssertionError, verify_bank_scope_assertion
from .tenant import OpenBotTenantExtension
from .validator import OpenBotOperationValidator

__all__ = [
    "BankScopeAssertionError",
    "OpenBotTenantExtension",
    "OpenBotOperationValidator",
    "verify_bank_scope_assertion",
]
