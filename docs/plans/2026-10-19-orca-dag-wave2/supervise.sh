#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
while [ ! -f "$DIR/pending_message.json" ]; do
  "$DIR/watch.sh"
  rc=$?
  [ $rc -eq 2 ] && break
  echo "$(date +%T) watch round restart" >> "$DIR/watch.log"
done
echo "$(date +%T) supervise done" >> "$DIR/watch.log"
