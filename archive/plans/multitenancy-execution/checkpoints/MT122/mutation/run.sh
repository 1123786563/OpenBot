#!/bin/bash
# MT122 mutation runs: one semantic mutation at a time, focused suite must FAIL
# (mutation killed). Original file restored after each run; final hash re-verified.
# MUT1 = 默认范围 fail-closed（brief 变异自证之一）
# MUT2 = 工厂按上下文（brief 变异自证之二）
# MUT3 = 机器上下文拒绝（brief 变异自证之三）
# MUT4 = AC3 共享签发（scope 脱离 WeakSet 即拒）
# MUT5 = AC4 事务零外呼
set -u
cd /Users/wuyongjun/orca/workspaces/OpenBot/i14-mt122/server || exit 1
SRC=src/enterprise/tenancy/entry-context.ts
CP=../docs/plans/2026-10-15-company-team-multitenancy-execution/checkpoints/MT122
ENVSH=$CP/test-env.sh
OUT=$CP/mutation/results.txt
cp "$SRC" /tmp/mt122-entry-context.orig.ts
: > "$OUT"

run_case() {
  local id="$1" desc="$2" from="$3" to="$4"
  python3 - "$SRC" "$from" "$to" <<'EOF'
import sys
path, frm, to = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if frm not in s:
    print(f"MUTATION_TARGET_NOT_FOUND: {frm[:60]}")
    sys.exit(2)
open(path, "w").write(s.replace(frm, to, 1))
EOF
  if [ $? -ne 0 ]; then echo "$id TARGET NOT FOUND — aborting" >> "$OUT"; cp /tmp/mt122-entry-context.orig.ts "$SRC"; exit 1; fi
  source "$ENVSH"
  result=$(bun --no-env-file test tests/multitenancy/entry-context.test.ts 2>&1 | grep -E "^ [0-9]+ (pass|fail)" | tr '\n' ' ')
  echo "$id | $desc | $result" >> "$OUT"
  cp /tmp/mt122-entry-context.orig.ts "$SRC"
}

# MUT1 fail-closed 破坏：fromRequest 建立失败时回退默认范围（AC1 拒绝码用例必须失败）
run_case MUT1 "fromRequest falls back to a default scope on establishment failure" \
  "      return businessFor(await httpScopes.resolve(request));
    },
    async fromInternalIdentity" \
  "      try {
        return businessFor(await httpScopes.resolve(request));
      } catch {
        return businessFor({
          tenantId: 'default-tenant',
          workspaceId: 'default-workspace',
          principalId: 'default-principal',
          actorId: 'default-actor',
          memberEpoch: 1,
          aclEpoch: 1,
          entrypoint: 'web',
        } as PlatformScope);
      }
    },
    async fromInternalIdentity"

# MUT2 工厂按上下文破坏：所有 scope 共享第一个业务对象（AC2 双上下文差异/每请求新实例必须失败）。
# 开头与结尾一次替换完成，避免中间态语法错误导致非行为性失败。
run_case MUT2 "factory shared-singleton for every scope" \
  "  const businessFor = (scope: PlatformScope): DeploymentEntryBusiness => ({
    scope,
    runtimeConfig: () =>
      runtimeConfig.resolve({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      }),
    transaction: (operation) => gate.transaction(scope, operation),
  });" \
  "  let mt122SharedBusiness: DeploymentEntryBusiness | null = null;
  const businessFor = (scope: PlatformScope): DeploymentEntryBusiness =>
    (mt122SharedBusiness ??= {
    scope,
    runtimeConfig: () =>
      runtimeConfig.resolve({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
      }),
    transaction: (operation) => gate.transaction(scope, operation),
    } as DeploymentEntryBusiness);"

# MUT3 机器上下文拒绝破坏：内部建立失败时绕过 DB 成员资格重验直接授予（机器身份用例必须失败）
run_case MUT3 "internal establishment skips DB membership revalidation on failure" \
  "      return businessFor(await internalScopes.resolve(request));
    },
  };" \
  "      try {
        return businessFor(await internalScopes.resolve(request));
      } catch {
        return businessFor({
          tenantId,
          workspaceId,
          principalId: actorId,
          actorId,
          memberEpoch: 1,
          aclEpoch: 1,
          entrypoint: 'schedule',
        } as PlatformScope);
      }
    },
  };"

# MUT4 AC3 共享签发破坏：businessFor 克隆 scope（脱离签发 WeakSet，assertTrustedScope 必拒）
run_case MUT4 "businessFor clones the scope out of the issuance WeakSet" \
  "  const businessFor = (scope: PlatformScope): DeploymentEntryBusiness => ({
    scope," \
  "  const businessFor = (scope: PlatformScope): DeploymentEntryBusiness => ({
    scope: { ...scope } as PlatformScope,"

# MUT5 AC4 事务零外呼破坏：transaction 包装里发起外部 fetch（零拨号用例必须失败）
run_case MUT5 "transaction wrapper dials an external host" \
  "    transaction: (operation) => gate.transaction(scope, operation)," \
  "    transaction: async (operation) => {
      void fetch('https://mt122-mutation.invalid/dial').catch(() => {});
      return gate.transaction(scope, operation);
    },"

# 终验：文件与交付哈希逐位一致
sha256sum "$SRC" >> "$OUT"
diff <(shasum -a 256 "$SRC" | awk '{print $1}') <(shasum -a 256 /tmp/mt122-entry-context.orig.ts | awk '{print $1}') \
  && echo "RESTORE-VERIFIED: byte-identical" >> "$OUT" \
  || echo "RESTORE-FAILED" >> "$OUT"
cat "$OUT"
