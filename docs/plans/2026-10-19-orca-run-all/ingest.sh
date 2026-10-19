#!/usr/bin/env bash
# R1: 递归摄取 #6/#5/#358/#376 子 Issue 树（只读）。产物：contains.tsv、nodes.txt、issues/*.json
set -euo pipefail
REPO=1123786563/OpenBot
DIR="$(cd "$(dirname "$0")" && pwd)"
: > "$DIR/contains.tsv"

frontier="6 5 358 376"
seen="6 5 358 376"
while [ -n "$frontier" ]; do
  next=""
  for n in $frontier; do
    kids=$(gh api --paginate "repos/$REPO/issues/$n/sub_issues" --jq '.[].number' | sort -n | tr '\n' ' ')
    for k in $kids; do
      echo -e "$n\t$k" >> "$DIR/contains.tsv"
      if ! grep -qw "$k" <<< "$seen"; then
        seen="$seen $k"
        next="$next $k"
      fi
    done
  done
  frontier=$(echo $next)
done

echo $seen | tr ' ' '\n' | sed '/^$/d' | sort -n > "$DIR/nodes.txt"
wc -l "$DIR/nodes.txt"

mkdir -p "$DIR/issues"
xargs -P 8 -I{} bash -c "gh api 'repos/$REPO/issues/{}' --jq '{number,title,state,labels:[.labels[].name],body}' > '$DIR/issues/{}.json'" < "$DIR/nodes.txt"
ls "$DIR/issues" | wc -l
