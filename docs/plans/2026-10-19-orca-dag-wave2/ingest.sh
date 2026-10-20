#!/usr/bin/env bash
# R1 rescan v3: 基线上轮 nodes.txt，8 路并行核验全部节点 sub_issues；新节点迭代入队。只读。
set -euo pipefail
REPO=1123786563/OpenBot
DIR="$(cd "$(dirname "$0")" && pwd)"
export DIR REPO
run_one() { set -o pipefail; gh api --paginate "repos/$REPO/issues/$1/sub_issues" --jq '.[].number' 2>/dev/null | sed "s/^/$1\t/" || echo "FAIL $1" >> "$DIR/fetch_failures.txt"; }
export -f run_one
: > "$DIR/fetch_failures.txt"
BASE="$DIR/../2026-10-19-orca-run-all/nodes.txt"
seen=$(sort -n < "$BASE" | tr '\n' ' ')
queue=$(sort -n < "$BASE")
round=0
while [ -n "$queue" ]; do
  round=$((round+1))
  qfile=$(mktemp); echo "$queue" > "$qfile"
  xargs -P 8 -I{} bash -c 'run_one {}' < "$qfile" > "$DIR/round${round}.raw" || true
  rm -f "$qfile"
  sort -k2 -n "$DIR/round${round}.raw" > "$DIR/round${round}.tsv"
  next=""
  for k in $(awk -F'\t' '{print $2}' "$DIR/round${round}.raw" | sort -n | uniq); do
    grep -qw "$k" <<< "$seen" || { seen="$seen $k"; next="$next $k"; }
  done
  queue=$(echo $next | tr ' ' '\n' | sed '/^$/d')
done
awk -F'\t' '{print $1"\t"$2}' "$DIR"/round*.tsv | sort -k2 -n -u > "$DIR/contains.tsv"
echo $seen | tr ' ' '\n' | sed '/^$/d' | sort -n > "$DIR/nodes.txt"
echo "rounds=$round nodes=$(wc -l < "$DIR/nodes.txt") failures=$(grep -c FAIL "$DIR/fetch_failures.txt" || true)"
