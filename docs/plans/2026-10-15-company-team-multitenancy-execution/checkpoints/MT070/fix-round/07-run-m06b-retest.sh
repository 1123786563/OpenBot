#!/bin/bash
# MT070 修复轮 F1：M06b 复合变异重做（复审 finding：原存档正文为 pristine 绿跑指纹，
# 未落档被杀轮次计数）。方法与实现轮 run-mutations.sh 完全一致：
#   M06 预检移除  : existingCall &&  →  existingCall && false &&
#   M09 兜底移除  : if (isUniqueViolation(error))  →  if (isUniqueViolation(error) && false)
# 两补丁同时注入 = 复合变异 M06b；跑聚焦 company-reservation.test.ts 记录真实
# pass/fail（复审独立重放预期 14/2）+ 注入文件 SHA-256 + 恢复后哈希 == 冻结值。
set -uo pipefail
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT/server"
SRC=src/billing/company-reservation.ts
BAK=/tmp/mt070-fix-pristine-service.ts
source /tmp/mt070-fix-env.sh

FROZEN="ea3fc1e912345ad2528dea6494a65325f5ffe09bfc546532527b752e37f0c213"
PRISTINE=$(sha256sum "$SRC" | cut -d' ' -f1)
echo "pristine hash: $PRISTINE"
[ "$PRISTINE" = "$FROZEN" ] || { echo "FROZEN-VALUE MISMATCH — abort"; exit 1; }
cp "$SRC" "$BAK"

# 复合注入：M06 预检 + M09 兜底 双移除（补丁逐字取自实现轮 run-mutations.sh）
cp "$BAK" "$SRC"
perl -0pi -e 's/existingCall &&\n        existingCall\.idempotencyKey !== input\.idempotencyKey/existingCall \&\& false \&\&\n        existingCall.idempotencyKey !== input.idempotencyKey/s' "$SRC" || { echo "M06 PATCH FAILED"; exit 1; }
perl -0pi -e 's/if \(isUniqueViolation\(error\)\) \{/if (isUniqueViolation(error) \&\& false) {/' "$SRC" || { echo "M09 PATCH FAILED"; exit 1; }
if cmp -s "$SRC" "$BAK"; then echo "PATCH NO-OP (anchor not found) — abort"; exit 1; fi
INJECTED=$(sha256sum "$SRC" | cut -d' ' -f1)
echo "injected hash: $INJECTED"

echo "--- focused run under compound mutation M06b ---"
bun --no-env-file test tests/multitenancy/company-reservation.test.ts
RC=$?
echo "--- focused exit=$RC ---"

cp "$BAK" "$SRC"
RESTORED=$(sha256sum "$SRC" | cut -d' ' -f1)
echo "restored hash: $RESTORED"
[ "$RESTORED" = "$FROZEN" ] && echo "RESTORE: byte-identical to frozen value OK" || { echo "RESTORE: MISMATCH — ABORT"; exit 1; }

echo "--- focused green re-run after restore ---"
bun --no-env-file test tests/multitenancy/company-reservation.test.ts | tail -5
