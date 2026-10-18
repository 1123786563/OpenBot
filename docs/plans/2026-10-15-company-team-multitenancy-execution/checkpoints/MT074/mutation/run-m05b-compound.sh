#!/usr/bin/env bash
# M05b（复合）：activeCompanyAccount 的三道臂（status/type/tenant）全部移除——
# M05 单层（仅 status 臂）为等价变异：MT069 行形状 CHECK 强制隔离行
# type/tenant 全空，type 臂与 tenant 臂独立产出同一拒绝（COMPANY_ACCOUNT_REQUIRED），
# 与 MT070 M06/M06b「两层防护本就是设计」先例同构。复合移除必须被捕获。
set -uo pipefail
cd /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/server
source ../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/test-env.sh

SVC=src/billing/vendor-billing.ts
PRISTINE=$(sha256sum $SVC | cut -d' ' -f1)
cp $SVC /tmp/mt074-pristine-vendor-billing.ts

python3 - <<'EOF'
import pathlib
path = pathlib.Path("src/billing/vendor-billing.ts")
src = path.read_text()
old = """    const account = await payer.getAccountByCustomer(externalCustomerId);
    if (
      account?.status !== "active" ||
      account.accountType !== "company" ||
      account.tenantId !== tenantId
    ) {
      return null;
    }
    return { id: account.id };"""
new = """    const account = await payer.getAccountByCustomer(externalCustomerId);
    return account ? { id: account.id } : null;"""
assert old in src, "anchor missing"
path.write_text(src.replace(old, new, 1))
EOF
bun --no-env-file test tests/multitenancy/vendor-billing.test.ts 2>&1 | grep -E "^\(fail\)|^ [0-9]+ (pass|fail)" | tee /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/mutation/M05b-compound-retest.txt

cp /tmp/mt074-pristine-vendor-billing.ts $SVC
FINAL=$(sha256sum $SVC | cut -d' ' -f1)
if [ "$FINAL" = "$PRISTINE" ]; then
  echo "RESTORE: sha256 match ($FINAL)" | tee -a /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/mutation/M05b-compound-retest.txt
else
  echo "RESTORE: MISMATCH" | tee -a /Users/wuyongjun/orca/workspaces/OpenBot/w16-mt074/docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT074/mutation/M05b-compound-retest.txt
  exit 1
fi
