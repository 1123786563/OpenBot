#!/bin/bash
# MT123 变异自证（每安全分支 ≥1：注入 → 聚焦捕获 → 字节复原 → 复绿）。
# 靶文件：server/src/enterprise/tenancy/startup-defaults.ts。
# 每个 MUT：python 注入 → 聚焦套件（期望 fail>0）→ 复原 → sha256 逐位核对 → 全部复原后终版复绿复跑。
set -euo pipefail
MT123_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$MT123_DIR/../../../../../.." && pwd)"
cd "$ROOT/server"
echo "cwd: $(pwd)"
source "$MT123_DIR/../test-env.sh"

SRC="src/enterprise/tenancy/startup-defaults.ts"
BAK="/tmp/mt123-startup-defaults-pristine.ts"
cp "$SRC" "$BAK"
SRC_HASH_BEFORE=$(shasum -a 256 "$SRC" | awk '{print $1}')
echo "pristine sha256: $SRC_HASH_BEFORE"

mutate() {  # mutate <label> <python-expr-file>
  local label="$1" script="$2"
  echo "=== $label inject ==="
  python3 "$script" || { echo "INJECT FAILED"; exit 1; }
  # 预期失败（变异被捕获 = 套件非零退出）：关掉 set -e 让脚本活到复原之后。
  set +e
  bun --no-env-file test tests/multitenancy/startup-defaults.test.ts 2>&1 | tail -4 | sed "s/^/[$label] /"
  set -e
  cp "$BAK" "$SRC"
  local now
  now=$(shasum -a 256 "$SRC" | awk '{print $1}')
  if [ "$now" = "$SRC_HASH_BEFORE" ]; then echo "[$label] RESTORE-VERIFIED byte-identical ($now)"; else echo "[$label] RESTORE FAILED ($now)"; exit 1; fi
}

mkdir -p /tmp/mt123-mut
cat > /tmp/mt123-mut/mut1.py <<'PYEOF'
# MUT1 多租户臂：默认公司复辟（defaultCompanyTenantId 回落租户包 tenantId）
p = "src/enterprise/tenancy/startup-defaults.ts"
s = open(p).read()
old = '  return deepFreeze({\n    mode: "multitenancy" as const,\n    defaultCompanyTenantId: null,'
new = '  return deepFreeze({\n    mode: "multitenancy" as const,\n    defaultCompanyTenantId: facts.tenantPackageTenantId ?? null,'
assert old in s
open(p, "w").write(s.replace(old, new))
PYEOF

cat > /tmp/mt123-mut/mut2.py <<'PYEOF'
# MUT2 单租户臂：线程种子丢弃租户包回退（只认显式 deploymentId）
p = "src/enterprise/tenancy/startup-defaults.ts"
s = open(p).read()
old = '      threadIdentitySeed:\n        facts.deploymentId ?? facts.tenantPackageTenantId ?? null,'
new = '      threadIdentitySeed: facts.deploymentId ?? null,'
assert old in s
open(p, "w").write(s.replace(old, new))
PYEOF

cat > /tmp/mt123-mut/mut3.py <<'PYEOF'
# MUT3 readiness：删除 entryContext 缺口判定
p = "src/enterprise/tenancy/startup-defaults.ts"
s = open(p).read()
old = '''  if (!facts.entryContextWired) {
    findings.push({
      source: "assembly.entryContext",'''
new = '''  if (false && !facts.entryContextWired) {
    findings.push({
      source: "assembly.entryContext",'''
assert old in s
open(p, "w").write(s.replace(old, new))
PYEOF

cat > /tmp/mt123-mut/mut4.py <<'PYEOF'
# MUT4 devBypass（AC2 分支）：多租户臂的单用户绕过裁决失效——绕过可被装配
p = "src/enterprise/tenancy/startup-defaults.ts"
s = open(p).read()
old = '    threadIdentitySeed: facts.deploymentId ?? null,\n    devBypassMounted: false,'
new = '    threadIdentitySeed: facts.deploymentId ?? null,\n    devBypassMounted: facts.singleUser,'
assert old in s
open(p, "w").write(s.replace(old, new))
PYEOF

cat > /tmp/mt123-mut/mut5.py <<'PYEOF'
# MUT5 scopeThreadIdentity：种子换成进程常量（per-scope 派生失效）
p = "src/enterprise/tenancy/startup-defaults.ts"
s = open(p).read()
old = '  return createThreadIdentity(resolved.threadIdentitySeed);'
new = '  return createThreadIdentity("mt123-process-default-seed");'
assert old in s
open(p, "w").write(s.replace(old, new))
PYEOF

cat > /tmp/mt123-mut/mut6.py <<'PYEOF'
# MUT6 mountDevBypass（唯一规则源分支）：单租户裁决失效——单租户绕过永不挂载
p = "src/enterprise/tenancy/startup-defaults.ts"
s = open(p).read()
old = '  return !facts.multitenancy && facts.singleUser;'
new = '  return false;'
assert old in s
open(p, "w").write(s.replace(old, new))
PYEOF

mutate MUT1 /tmp/mt123-mut/mut1.py
mutate MUT2 /tmp/mt123-mut/mut2.py
mutate MUT3 /tmp/mt123-mut/mut3.py
mutate MUT4 /tmp/mt123-mut/mut4.py
mutate MUT5 /tmp/mt123-mut/mut5.py
mutate MUT6 /tmp/mt123-mut/mut6.py

echo "=== final green re-run after all mutations restored ==="
set +e
bun --no-env-file test tests/multitenancy/startup-defaults.test.ts 2>&1 | tail -4
set -e
FINAL=$(shasum -a 256 "$SRC" | awk '{print $1}')
if [ "$FINAL" = "$SRC_HASH_BEFORE" ]; then echo "RESTORE-VERIFIED byte-identical ($FINAL)"; else echo "RESTORE FAILED ($FINAL)"; exit 1; fi
