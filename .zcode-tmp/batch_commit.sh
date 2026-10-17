#!/bin/bash
while IFS= read -r wt; do
  [ -d "$wt" ] || { echo "MISSING	$wt"; continue; }
  gd=$(git -C "$wt" rev-parse --git-dir 2>/dev/null) || { echo "NOTGIT	$wt"; continue; }
  if [ -f "$gd/MERGE_HEAD" ] || [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; then
    echo "SKIP-MERGE	$wt"; continue
  fi
  n=$(git -C "$wt" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" = "0" ] && continue
  git -C "$wt" add -A >/dev/null 2>&1
  if git -C "$wt" diff --cached --quiet 2>/dev/null; then
    echo "NOTHING-STAGED	$wt"; continue
  fi
  if git -C "$wt" commit -q -m "chore: checkpoint 保存分支未提交改动" >/dev/null 2>&1; then
    echo "COMMITTED	$n	$wt"
  else
    echo "FAIL	$n	$wt"
  fi
done < /tmp/wt_list.txt
