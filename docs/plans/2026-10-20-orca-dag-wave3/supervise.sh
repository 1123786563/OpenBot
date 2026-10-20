#!/bin/bash
# orca-dag-wave3 supervise.sh — 循环调用 watch.sh 直到出现待裁决消息
DIR="$(cd "$(dirname "$0")" && pwd)"
ERRS=0
while [ ! -f "$DIR/pending_message.json" ]; do
  "$DIR/watch.sh"
  rc=$?
  [ $rc -eq 2 ] && break
  if [ $rc -eq 1 ]; then
    ERRS=$((ERRS+1))
    [ $ERRS -ge 10 ] && { echo "$(date +%T) too many errors, stop" >> "$DIR/watch.log"; break; }
    sleep 30
  else
    ERRS=0
  fi
done
echo "$(date +%T) supervise round done (pending_message.json present: $([ -f "$DIR/pending_message.json" ] && echo yes || echo no))" >> "$DIR/watch.log"
