#!/bin/zsh
# transfer-prereq.sh <DST-worktree> — 从执行工作区(集成事实源)转移当前 verified 交付快照到目标工作树
# 产物: <DST>/docs/plans/.../checkpoints/prereq-manifest.txt（BASE 首行 + 全文件 SHA-256，自校验）
set -e
DST="$1"
EXE=/Users/wuyongjun/orca/workspaces/OpenBot/company-team-multitenancy-execution
P=docs/plans/2026-10-15-company-team-multitenancy-execution
[ -d "$DST" ] || { echo "DST missing: $DST"; exit 1; }

rsync -a --delete "$EXE/server/scripts/multitenancy/" "$DST/server/scripts/multitenancy/"
rsync -a --delete "$EXE/server/tests/multitenancy/" "$DST/server/tests/multitenancy/"
mkdir -p "$DST/server/src/enterprise/tenancy" "$DST/server/src/db/schema"
mkdir -p "$DST/server/src/enterprise/runs"
mkdir -p "$DST/app/tests/multitenancy" "$DST/app/src/routes/_authed/tenant" "$DST/app/src/lib/enterprise/tenant"
for f in server/src/enterprise/runs/events.ts server/src/enterprise/runs/runner.ts server/src/enterprise/tenancy/store.ts server/src/enterprise/tenancy/scope-gate.ts \
         server/src/enterprise/tenancy/startup-checks.ts server/src/enterprise/tenancy/revocation.ts \
         server/src/enterprise/tenancy/resource-policy.ts server/src/enterprise/tenancy/resource-visibility.ts \
         server/src/enterprise/tenancy/workspace-admin.ts server/src/enterprise/tenancy/workspace-scope-routes.ts \
         server/src/enterprise/tenancy/runtime-config.ts server/src/enterprise/tenancy/personal-share-rules.ts server/src/enterprise/tenancy/admin-separation.ts server/src/enterprise/tenancy/team-public-rules.ts server/src/enterprise/tenancy/scoped-keys.ts server/src/enterprise/tenancy/not-found-semantics.ts server/src/enterprise/tenancy/routing-policy.ts server/src/enterprise/tenancy/sso-scim-config.ts server/src/enterprise/tenancy/scim-directory.ts server/src/enterprise/tenancy/identity-binding.ts server/src/enterprise/tenancy/people-lifecycle.ts server/src/enterprise/tenancy/preferences.ts server/src/enterprise/tenancy/bots-ownership.ts server/src/enterprise/tenancy/kb-ownership.ts server/src/enterprise/tenancy/job-ownership.ts server/src/enterprise/tenancy/credential-ownership.ts server/src/enterprise/tenancy/bot-publish.ts server/src/enterprise/tenancy/conversations-list.ts server/src/enterprise/tenancy/oauth-state.ts server/src/enterprise/tenancy/public-bot-usage.ts server/src/enterprise/tenancy/global-exceptions.ts \
         server/src/billing/payer-accounts.ts server/src/billing/company-reservation.ts server/src/kb/db/ownership-schema.ts server/src/kb/application/service/kb-restricted-query.ts server/src/kb/application/service/kb-restricted-retrieval.ts server/src/kb/application/service/kb-document-lifecycle.ts server/drizzle-kb.config.ts server/drizzle-kb/0001_handy_katie_power.sql server/drizzle-kb/meta/_journal.json server/drizzle-kb/meta/0001_snapshot.json \
         app/src/lib/enterprise/tenant/selection.ts app/src/routes/_authed/tenant/selection.tsx app/tests/multitenancy/selection.test.tsx app/src/lib/client.ts app/src/locales/en/tenant.json app/src/locales/zh-CN/tenant.json app/src/routeTree.gen.ts \
         server/src/db/schema/enterprise-tenancy.ts server/src/db/schema/enterprise-runtime-config.ts \
         server/src/db/schema/personal-shares.ts server/src/db/schema/enterprise-governance-policy.ts server/src/db/schema/enterprise-sso-scim.ts server/src/db/schema/payer-accounts.ts server/src/db/schema/enterprise-bot-ownership.ts server/src/db/schema/job-ownership.ts server/src/db/schema/enterprise-credentials.ts server/src/db/schema/call-attributions.ts server/src/db/schema/enterprise-oauth-state.ts server/src/db/schema/index.ts \
         server/src/index.ts server/src/config.ts server/src/app.ts; do
  cp "$EXE/$f" "$DST/$f"
done
mkdir -p "$DST/$P/reports" "$DST/$P/checkpoints" "$DST/$P/briefs"
for r in MT001.md MT002.md MT003-fix2.md MT003-review2.md MT003-fix2-review.md \
         MT004.md MT004-review.md MT004-fix.md MT004-fix-review.md \
         MT005.md MT005-review.md MT006.md MT006-review.md \
         MT112.md MT112-review.md MT008.md MT008-review.md MT012.md MT012-review.md MT013-review.md MT013-fix-review.md MT007.md MT007-review.md MT013.md MT014.md MT014-review.md MT010.md MT010-review.md MT075.md MT075-review.md MT009.md MT009-review.md MT015.md MT015-review.md MT011.md MT011-review.md MT077.md MT077-review.md MT026.md MT026-review.md MT076.md MT076-review.md MT079.md MT079-review.md MT069.md MT069-review.md MT016.md MT016-review.md MT036.md MT036-review.md MT080.md MT080-review.md MT041.md MT041-review.md MT027.md MT027-review.md MT017.md MT017-review.md MT070.md MT070-review.md MT021.md MT021-review.md MT021-fix-review.md MT028.md MT028-review.md MT037.md MT037-review.md MT018.md MT018-review.md MT030.md MT030-review.md MT038.md MT038-review.md MT038-fix.md MT071.md MT071-review.md MT071-fix.md MT098.md MT098-review.md seam-identification-mt005.md; do
  [ -f "$EXE/$P/reports/$r" ] && cp "$EXE/$P/reports/$r" "$DST/$P/reports/$r"
done
for c in MT004 MT004-fix MT005 MT010 MT075 MT009 MT015 MT011 MT077 MT026 MT076 MT079 MT069 MT016 MT036 MT080 MT041 MT041-fix MT027 MT017 MT070 MT021 MT021-fix MT028 MT037 MT037-fix MT017-integration MT070-integration MT021-integration MT028-integration MT037-integration MT018 MT030 MT038 MT038-fix MT071 MT071-fix MT098 MT018-integration MT030-integration MT038-integration MT071-integration MT098-integration; do
  [ -d "$EXE/$P/checkpoints/$c" ] && { mkdir -p "$DST/$P/checkpoints/$c"; rsync -a --delete "$EXE/$P/checkpoints/$c/" "$DST/$P/checkpoints/$c/"; }
done

cd "$DST"
MANIFEST="$P/checkpoints/prereq-manifest.txt"
{
  echo "BASE f0520524f0faa2b4533b9d2f1aa692c8f907ba71"
  find server/scripts/multitenancy server/tests/multitenancy server/src/enterprise/tenancy server/src/billing server/src/kb \
       server/drizzle-kb app/tests/multitenancy \
       server/src/db/schema/enterprise-tenancy.ts server/src/db/schema/enterprise-runtime-config.ts \
       server/src/db/schema/personal-shares.ts server/src/db/schema/enterprise-governance-policy.ts server/src/db/schema/enterprise-sso-scim.ts server/src/db/schema/payer-accounts.ts server/src/db/schema/enterprise-bot-ownership.ts server/src/db/schema/job-ownership.ts server/src/db/schema/enterprise-credentials.ts server/src/db/schema/call-attributions.ts server/src/db/schema/enterprise-oauth-state.ts server/src/db/schema/index.ts \
       server/src/index.ts server/src/config.ts server/src/app.ts -type f | sort | xargs shasum -a 256
} > "$MANIFEST"

n=0
while read -r h f; do
  [ "$h" = "BASE" ] && continue
  a=$(shasum -a 256 "$f" | awk '{print $1}')
  [ "$a" = "$h" ] || { echo "MISMATCH: $f"; exit 1; }
  n=$((n+1))
done < "$MANIFEST"
echo "$DST prereq OK ($n files)"
