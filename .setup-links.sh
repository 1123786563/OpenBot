#!/bin/bash
# worktree 依赖布局：镜像主 checkout 的根+12 包级 node_modules symlink（ba503-island-scaffold-gotchas）
MAIN=/Users/wuyongjun/trea/OpenBot
WT=/Users/wuyongjun/trea/OpenBot/.claude/worktrees/openshell-t02-736
cd "$WT" || exit 1
for p in agent-bot agent-computer agent-langgraph agent-mastra agent-sandbox app desktop server shared supervisor toolkit worker; do
  ln -sfn "$MAIN/$p/node_modules" "$p/node_modules"
done
ln -sfn "$MAIN/node_modules" node_modules
# chart 依赖 tgz（主 checkout gitignore 目录，helm template 需要）
mkdir -p charts/openbot/charts
cp -n "$MAIN/charts/openbot/charts/postgresql-16.7.27.tgz" charts/openbot/charts/ 2>/dev/null
echo "linked: $(find . -maxdepth 2 -name node_modules -type l | wc -l | tr -d ' '); chart deps: $(ls charts/openbot/charts/ | wc -l | tr -d ' ')"