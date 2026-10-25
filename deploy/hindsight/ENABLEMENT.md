# OpenBot 个人记忆全员启用运行手册（AC2 / #396）

适用：已在别处运行的 OpenBot 自托管部署（代码升级到本仓库集成分支 `1123786563/hindsight-376-integration` @ `3e88bd4b3` 后执行）。
前置门槛（已满足并验证）：多租户隔离、真实 Hindsight 1.0.0 合约、隐私保留、删除证据、Spec 五场景（N-A/N-A2 报告）。
前置声明：本手册不适用于 `127.0.0.1` 测试实例或 `deploy/hindsight/test/contract-instance.sh` 的验证实例。

## 0. 启用前必读

- 启用 = 部署私有 Hindsight 服务 + 代码升级 + 生产库迁移（0168–0212）+ 环境配置 + 重启。迁移涉及既有表（0210/0211/0212 加列），**第 1 步备份是硬性前置**。
- 模型调用经 OpenBot 已批准网关（`OPENAI_BASE_URL` 同源或专用网关）；Hindsight 的提取/embedding 走同一网关，预算与限流由网关侧承担。
- 回滚路径：代码回退到前一部署 SHA 即可（迁移全部为 additive/可空加列，不破坏旧代码读取；隔离行不参与旧召回）。

## 1. 备份（硬性前置）

```bash
# 生产库全量备份（DATABASE_URL 同源凭据）
pg_dump "$DATABASE_URL" --format=custom --file openbot-pre-memory-enable-$(date +%Y%m%d).dump
# 校验可恢复
pg_restore --list openbot-pre-memory-enable-*.dump >/dev/null && echo BACKUP-OK
```

## 2. 代码升级

```bash
cd <部署 checkout>
git fetch origin && git checkout 1123786563/hindsight-376-integration   # 3e88bd4b3
bun install
bun run generate:app-config   # 若项目要求
```

## 3. 部署私有 Hindsight 服务（deploy/hindsight/）

```bash
cd deploy/hindsight
cp hindsight.env.example hindsight.env   # 填写以下必填项：
#  HINDSIGHT_API_TOKEN=<新生成强随机>                    # OpenBot 与服务共享
#  HINDSIGHT_API_TENANT_API_KEY=<新生成强随机>
#  HINDSIGHT_API_TENANT_ASSERTION_SECRET=<新生成强随机>  # 必须与 OpenBot 侧 HINDSIGHT_BANK_ASSERTION_SECRET 一致
#  HINDSIGHT_API_LLM_BASE_URL=<已批准网关 OpenAI 兼容根，含 /v1>
#  HINDSIGHT_API_LLM_API_KEY=<网关密钥>
#  HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=<同网关>
#  HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=<网关密钥>
#  HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=30
docker compose up -d
curl -s -H "Authorization: Bearer $HINDSIGHT_API_TOKEN" http://127.0.0.1:8888/health   # 期望 service_up
```

注意：网关地址在容器内不可用 `127.0.0.1`（Linux 用 `host.docker.internal`，见 README Linux 节）；API 只绑 127.0.0.1:8888，9999 控制台不发布。

## 4. 生产库迁移

```bash
cd <部署 checkout>
DATABASE_URL="$DATABASE_URL" bun server/scripts/migrate.ts
# 期望：应用 0168…0212（若部署库已在 0208 后则应用 0209–0212）；journal↔文件一致、孤儿 0
```

迁移内容：Hindsight 全部表/索引 + 0210 暂停门 user_id + 0211 记忆公司归属回填（不可证归属自动隔离，不猜公司）+ 0212 来源归属绑定时刻固化。

## 5. OpenBot 环境配置（.env 追加）

```bash
HINDSIGHT_API_URL=http://127.0.0.1:8888
HINDSIGHT_API_TOKEN=<与第 3 步 HINDSIGHT_API_TOKEN 相同>
HINDSIGHT_BANK_ASSERTION_SECRET=<与第 3 步 ASSERTION_SECRET 相同>
HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED=false
HINDSIGHT_PRIVACY_OPERATION_RETENTION_DAYS=1
HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=30
HINDSIGHT_BACKUP_MANIFEST_DIR=<deploy/hindsight/backups 的绝对路径>   # A-10：备份登记目录
```

## 6. 备份调度（A-10）

```bash
# cron（每日）：backup.sh 自带 30 天保留清扫
0 3 * * * cd <部署 checkout>/deploy/hindsight && ./backup.sh >> backup.log 2>&1
```

保留期两层同数核验：`HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS`（服务侧）与 backup.sh 窗口（脚本内默认 30）必须一致。

## 7. 重启与启用验证

```bash
# 按部署方式重启 OpenBot 服务后：
curl -s http://127.0.0.1:$PORT/api/health 2>/dev/null || 按既有健康检查
bun server/scripts 之外的健康四态：checkHindsightHealth(loadHindsightConfig()) → 期望 service_up
# 管理员视图（不含内容）：GET /api/hindsight/ops/health → 仅计数
# 冒烟：管理员账号确认一条记忆 → 列表可见 → 遗忘 → 下一次回答不再出现
```

## 8. 回滚

- 服务异常：`docker compose down`（deploy/hindsight）+ 移除 .env HINDSIGHT_* 块 + 重启 OpenBot → 回到未启用态（迁移保留，无害）。
- 数据异常：`pg_restore` 第 1 步备份。

## 9. 启用后义务

- 备份 cron 运行监控（manifest 目录有新登记）；外部模型日志留存单独核验（网关侧）。
- `HINDSIGHT_BACKUP_MANIFEST_DIR` 若服务与 OpenBot 不同主机，需共享挂载或登记同步（见 README）。
