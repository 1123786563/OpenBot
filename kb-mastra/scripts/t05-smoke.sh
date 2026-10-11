#!/usr/bin/env bash
# T05 冒烟全序列（v1 §9 1-4 + 越权）：前置——postgres/qdrant/redis/docreader/mock-ollama 已起，
# kb-mastra :8082 已起（KB_API_KEYS 含 sk-t05-admin/tenant-a/admin, sk-t05-read/tenant-a/read,
# sk-t05-other/tenant-b/admin）。
set -u
B="http://127.0.0.1:8082"
CURL="curl -s --noproxy *"
A="Authorization: Bearer sk-t05-admin"
RD="Authorization: Bearer sk-t05-read"
OT="Authorization: Bearer sk-t05-other"
PASS=0; FAIL=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; PASS=$((PASS+1)); else echo "FAIL $1: expected $2 got $3"; FAIL=$((FAIL+1)); fi
}

echo "=== 1. 建库（admin） ==="
CREATE=$($CURL -X POST $B/kb -H "$A" -H "content-type: application/json" -d '{"name":"t05-'$RANDOM'","description":"e2e smoke","chunk_size":64,"chunk_overlap":8}')
KB_ID=$(echo "$CREATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
check "create-kb returns id" "36" "${#KB_ID}"
echo "$CREATE" | python3 -m json.tool | head -8

echo "=== 2. 上传 text 文档 ==="
TEXT_BODY=$(python3 -c "print('\n\n'.join('第%d段：OpenBot 知识库迁移冒烟测试内容填充。' % i for i in range(1, 9)))")
ADD=$($CURL -X POST $B/kb/$KB_ID/documents -H "$A" -H "content-type: application/json" -d "$(python3 -c "import json,sys;print(json.dumps({'type':'text','title':'t05 text doc','content':'''$TEXT_BODY'''}))")")
DOC_ID=$(echo "$ADD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('doc_id',''))")
check "upload-text returns doc_id" "36" "${#DOC_ID}"
echo "$ADD"

echo "=== 3. 轮询 task 至 completed ==="
for i in $(seq 1 30); do
  STATUS=$($CURL $B/kb/$KB_ID/tasks/$DOC_ID -H "$A" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))")
  [ "$STATUS" = "completed" ] && break
  [ "$STATUS" = "failed" ] && break
  sleep 1
done
check "task reaches completed" "completed" "$STATUS"
$CURL $B/kb/$KB_ID/tasks/$DOC_ID -H "$A" | python3 -m json.tool

echo "=== 4. 检索命中 ==="
RET=$($CURL -X POST $B/kb/$KB_ID/retrieve -H "$A" -H "content-type: application/json" -d '{"query":"知识库迁移冒烟","top_k":5,"hybrid":true}')
HITS=$(echo "$RET" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))")
if [ "$HITS" -gt 0 ] 2>/dev/null; then echo "PASS retrieve-hits ($HITS)"; PASS=$((PASS+1)); else echo "FAIL retrieve-hits: $RET"; FAIL=$((FAIL+1)); fi
echo "$RET" | python3 -m json.tool | head -14

echo "=== 5. 删除文档 → retrieve 不再命中 → 404 ==="
DEL=$($CURL -X DELETE $B/kb/$KB_ID/documents/$DOC_ID -H "$A" -w "|%{http_code}")
check "delete-doc" "{|200" "$(echo $DEL | sed 's/ $//' | tail -c 10 | head -c 2)" || true
$CURL -X DELETE $B/kb/$KB_ID/documents/$DOC_ID -H "$A" > /dev/null 2>&1 # idempotent second delete
RETR_AFTER=$($CURL -X POST $B/kb/$KB_ID/retrieve -H "$A" -H "content-type: application/json" -d '{"query":"知识库迁移冒烟","top_k":5}')
HITS_AFTER=$(echo "$RETR_AFTER" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))")
check "retrieve-after-delete empty" "0" "$HITS_AFTER"
TASK_AFTER=$($CURL -o /dev/null -w "%{http_code}" $B/kb/$KB_ID/tasks/$DOC_ID -H "$A")
check "task-after-delete" "404" "$TASK_AFTER"

echo "=== 6. PDF 上传全链（docreader builtin） ==="
python3 - << 'PYEOF'
# 生成一个最小合法 PDF（1 页 Hello）。
content = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 24 Tf 72 700 Td (OpenBot kb-mastra PDF smoke) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
"""
import re
objs = re.findall(rb"(\d+) 0 obj", content)
open("/tmp/t05-smoke.pdf", "wb").write(content)
print("pdf written:", len(content), "bytes")
PYEOF
PDF_ADD=$($CURL -X POST $B/kb/$KB_ID/documents -H "$A" -F "file=@/tmp/t05-smoke.pdf;type=application/pdf" -F "title=t05 pdf doc")
PDF_ID=$(echo "$PDF_ADD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('doc_id',''))")
check "pdf-upload returns doc_id" "36" "${#PDF_ID}"
echo "$PDF_ADD"
for i in $(seq 1 60); do
  PSTATUS=$($CURL $B/kb/$KB_ID/tasks/$PDF_ID -H "$A" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))")
  [ "$PSTATUS" = "completed" ] && break
  [ "$PSTATUS" = "failed" ] && break
  sleep 1
done
check "pdf parses to completed" "completed" "$PSTATUS"
$CURL $B/kb/$KB_ID/tasks/$PDF_ID -H "$A" | python3 -m json.tool | head -8

echo "=== 7. 越权：tenant-b 访问 tenant-a 的库 → 404 ==="
CROSS=$($CURL -o /dev/null -w "%{http_code}" $B/kb/$KB_ID -H "$OT")
check "cross-tenant-404" "404" "$CROSS"

echo "=== 8. 越权：read 角色建库 → 403 ==="
ROLE=$($CURL -o /dev/null -w "%{http_code}" -X POST $B/kb -H "$RD" -H "content-type: application/json" -d '{"name":"nope"}')
check "read-role-403" "403" "$ROLE"

echo "=== 9. 删库（admin）→ 列表不再含 ==="
DEKB=$($CURL -X DELETE $B/kb/$KB_ID -H "$A" -w "|%{http_code}")
KB_GONE=$($CURL -o /dev/null -w "%{http_code}" $B/kb/$KB_ID -H "$A")
check "delete-kb then 404" "404" "$KB_GONE"

echo ""
echo "RESULT: $PASS pass, $FAIL fail"
[ "$FAIL" = "0" ] && echo "SMOKE PASS" || echo "SMOKE FAIL"
exit $FAIL
