#!/usr/bin/env bash
# MT074 变异自证：每次注入一个安全语义变异 → 聚焦套件必须捕获（≥1 fail）→
# 逐位还原（sha256 闭环）。全部变异被杀灭后输出汇总。
set -uo pipefail
cd /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/server
source ../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/test-env.sh

SVC=src/billing/vendor-billing.ts
rm -f /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/mutation/results.txt
CK=/Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/mutation
PRISTINE=$(sha256sum $SVC | cut -d' ' -f1)
cp $SVC /tmp/mt074-pristine-vendor-billing.ts

declare -a NAMES=()
declare -a RESULTS=()

mutate() { # mutate <name> <python-expr applying replacement on src>
  local name="$1"
  NAMES+=("$name")
  cp /tmp/mt074-pristine-vendor-billing.ts $SVC
  python3 - "$2" <<'EOF'
import sys, pathlib
expr = sys.argv[1]
path = pathlib.Path("src/billing/vendor-billing.ts")
src = path.read_text()
old, new = expr.split("=====")
assert old in src, f"anchor missing for mutation: {old[:60]}"
path.write_text(src.replace(old, new, 1))
EOF
  if [ $? -ne 0 ]; then RESULTS+=("INJECT-FAILED"); return; fi
  local injected
  injected=$(sha256sum $SVC | cut -d' ' -f1)
  local out
  out=$(bun --no-env-file test tests/multitenancy/vendor-billing.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)" | tr '\n' ' ')
  local fails
  fails=$(echo "$out" | grep -oE "[0-9]+ fail" | grep -oE "[0-9]+")
  cp /tmp/mt074-pristine-vendor-billing.ts $SVC
  local restored
  restored=$(sha256sum $SVC | cut -d' ' -f1)
  local verdict="SURVIVED"
  if [ "${fails:-0}" -ge 1 ]; then verdict="KILLED"; fi
  RESULTS+=("$verdict ($out)")
  echo "MUT $name: $out| injected=$injected restored=$restored restore-vs-pristine=$([ "$restored" = "$PRISTINE" ] && echo OK || echo DRIFT)" >> /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/mutation/results.txt
}

mutate M01-call-identity-gate-removed 'if (!(await activeMembership(tenantId, principalId))) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: null,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLER_REQUIRED",
        });
        throw new Error(
          `VENDOR_CALLER_REQUIRED: principal ${principalId} is not an active member of company ${tenantId}`,
        );
      }====='

mutate M02-call-payload-minimality-broken '      const customer = {
        externalId: mapping.externalCustomerId,
        name: company?.name ?? "",
      };=====      const customer = {
        externalId: mapping.externalCustomerId,
        name: mapping.externalCustomerId,
      };'

mutate M03-call-mapping-guard-removed '      const mapping = await payer.resolveCompanyCustomer(tenantId);
      if (!mapping) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: null,
          operation,
          outcome: "refused",
          denialCode: "CUSTOMER_MAPPING_REQUIRED",
        });
        throw new Error(
          `CUSTOMER_MAPPING_REQUIRED: company ${tenantId} has no billing customer mapping`,
        );
      }=====      const mapping = (await payer.resolveCompanyCustomer(tenantId)) ?? {
        tenantId,
        externalCustomerId: tenantId,
        createdAt: new Date(),
      };'

mutate M04-call-payer-guard-removed '      const account = await activeCompanyAccount(
        tenantId,
        mapping.externalCustomerId,
      );
      if (!account) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: mapping.externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "COMPANY_ACCOUNT_REQUIRED",
        });
        throw new Error(
          `COMPANY_ACCOUNT_REQUIRED: company ${tenantId} has no active company credit account on customer ${mapping.externalCustomerId}`,
        );
      }=====      const account = { id: "mutated-payer" };'

mutate M05-quarantined-account-accepted '    if (
      account?.status !== "active" ||
      account.accountType !== "company" ||
      account.tenantId !== tenantId
    ) {=====    if (
      account?.accountType !== "company" ||
      account.tenantId !== tenantId
    ) {'

mutate M06-callback-unmapped-guard-removed '      const tenantId = mapping?.tenantId ?? null;
      if (!tenantId) {
        await audit({
          direction: "callback",
          tenantId: null,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLBACK_UNMAPPED",
        });
        throw new Error(
          `VENDOR_CALLBACK_UNMAPPED: customer ${externalCustomerId} is not the registered billing customer of any company`,
        );
      }=====      const tenantId = mapping?.tenantId ?? null;'

mutate M07-callback-cross-company-compare-removed '      if (claimedTenantId !== undefined && claimedTenantId !== tenantId) {=====      if (false) {'

mutate M08-callback-membership-gate-removed '      if (!(await activeMembership(tenantId, actingPrincipalId))) {
        await audit({
          direction: "callback",
          tenantId,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLBACK_MEMBER_INELIGIBLE",
        });
        throw new Error(
          `VENDOR_CALLBACK_MEMBER_INELIGIBLE: principal ${actingPrincipalId} is not an active member of company ${tenantId}`,
        );
      }====='

mutate M09-callback-payer-guard-removed '      const account = await activeCompanyAccount(tenantId, externalCustomerId);
      if (!account) {
        await audit({
          direction: "callback",
          tenantId,
          principalId: actingPrincipalId,
          externalCustomerId,
          operation,
          outcome: "refused",
          denialCode: "COMPANY_ACCOUNT_REQUIRED",
        });
        throw new Error(
          `COMPANY_ACCOUNT_REQUIRED: company ${tenantId} has no active company credit account on customer ${externalCustomerId}`,
        );
      }=====      const account = { id: "mutated-payer" };'

mutate M10-vendor-non2xx-treated-applied '      if (vendorStatus < 200 || vendorStatus >= 300) {=====      if (false) {'

mutate M11-applied-call-audit-removed '      await audit({
        direction: "call",
        tenantId,
        principalId,
        externalCustomerId: mapping.externalCustomerId,
        operation,
        outcome: "applied",
        denialCode: null,
        detail: { fields: ["externalId", "name"], vendorStatus },
      });
      return { outcome: "applied", vendorStatus, customer };=====      return { outcome: "applied", vendorStatus, customer };'

mutate M12-refused-attempt-audit-removed '      if (!(await activeMembership(tenantId, principalId))) {
        await audit({
          direction: "call",
          tenantId,
          principalId,
          externalCustomerId: null,
          operation,
          outcome: "refused",
          denialCode: "VENDOR_CALLER_REQUIRED",
        });
        throw new Error(
          `VENDOR_CALLER_REQUIRED: principal ${principalId} is not an active member of company ${tenantId}`,
        );
      }=====      if (!(await activeMembership(tenantId, principalId))) {
        throw new Error(
          `VENDOR_CALLER_REQUIRED: principal ${principalId} is not an active member of company ${tenantId}`,
        );
      }'

mutate M13-detail-value-leak '          denialCode: "VENDOR_UNREACHABLE",
          detail: { fields: ["externalId", "name"] },
        });=====          denialCode: "VENDOR_UNREACHABLE",
          detail: { fields: ["externalId", "name"], leaked: customer.externalId },
        });'

echo "== mutation results =="
for i in "${!NAMES[@]}"; do
  echo "${NAMES[$i]}: ${RESULTS[$i]}"
done

FINAL=$(sha256sum $SVC | cut -d' ' -f1)
if [ "$FINAL" = "$PRISTINE" ]; then
  echo "RESTORE: sha256 match ($FINAL)"
else
  echo "RESTORE: MISMATCH ($FINAL != $PRISTINE)"
  exit 1
fi
