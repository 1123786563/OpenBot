# 支付宝点数包验收与上线

[#219](https://github.com/1123786563/OpenBot/issues/219) 属于 [#214](https://github.com/1123786563/OpenBot/issues/214)。2026-11-28 已完成本机演练。待 Web #127 完成且获准恢复生产复测后，再执行商户验收。商户验收通过前，购买名单仅用于经授权的验收账号。

## 固定版本并复跑本机验收

OpenBot 验收从 `2dbef5eade7576a8889579924d215e49d48036cf` 开始。本机支付演练使用 Flexprice `bb780f798bcdf2b14ac68debedee54254e901e74`。包含 webhook 配置支持的发布候选为 `bb02a7f3ca720e53af215dc46258b90285647d1b`。两个候选可执行文件的 Go 构建信息均记录该提交、`vcs.modified=false`、`linux/amd64`。

| 文件 | SHA-256 |
| --- | --- |
| `server` | `e9a39ac4fa2f1d9058efd22aa7cf3ba28e2d999b0caac72ea2218ab053def1fa` |
| `migrate` | `10e0395ae9147fc77d0226f8d17e9ddf445c6811ddb5247cd39603ea71614b6f` |

候选文件位于本机 `/tmp/flexprice-214-linux.iBmCp1`。归档时保留对应源码、迁移目录、配置及镜像摘要。当前 `data.yml` 的 `flexprice:2.1.52-persaas` 标签不足以证明运行的是候选版本。发布包中服务和迁移任务应引用同一候选镜像摘要。先在隔离环境执行迁移和启动检查。

在 OpenBot 仓库根目录连接专用本机 PostgreSQL，设置 `TEST_DATABASE_URL`，链接本地 `.env.test` 并安装锁定依赖后执行：

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun --no-env-file --env-file=.env.test server/scripts/migrate.ts
bun test --no-env-file --env-file=.env.test \
  server/tests/credit-pack-checkout.integration.test.ts \
  server/tests/paid-refunds.integration.test.ts
```

两套测试合计 34 项通过。增加环境隔离校验后，修复前的退款核验返回 `unknown`。退款提交及查询带上与结账相同的 `X-Environment-ID` 后，核验返回 `confirmed`。支付宝专用测试使用回环 Flexprice HTTP fixture 和真实 PostgreSQL。它验证了以下结果：

- 仅展示支付宝，拒绝微信下单和生成二维码，锁定 ¥25.00 的人民币报价。
- 拒绝无凭据的通知。并发状态核验和重复通知只发放一次 25,000,000 微点。
- 清空账号名单后停止新购，已有订单仍能核验。管理员发起原路退款后冻结余额，按原发票及支付宝付款记录确认整单 ¥25.00 退款后余额回到购买前。重复退款核验和付款通知均未再次改变余额。

从 Flexprice 候选源码执行以下命令。第二条使用专用本机 PostgreSQL URL，测试会创建并删除自己的 schema。

```sh
go test -count=1 ./internal/config ./internal/integration/alipay ./internal/api -run 'Infisical|Alipay|Signup'
FLEXPRICE_TEST_POSTGRES_DSN="$LOCAL_FLEXPRICE_TEST_DSN" \
  go test -v -count=1 ./internal/ee/service -run '^TestAlipayCheckoutPostgres$'
```

三个包的筛选测试及 PostgreSQL 测试通过。覆盖了 Infisical 读取商户配置和注册开关、认证失败、商户退款回执，以及原付款渠道全额退款。另用 `--network none` 运行了候选 `server`，启用 Infisical 且缺少项目 ID 时进程启动失败。商户付款、真实通知传递及目标部署的注册端点留待上线前核验。

## 准备 Infisical 配置

1. 在 **Persaas Infrastructure → prod → /flexprice** 保存 `FLEXPRICE_AUTH_DISABLE_SIGNUP=true`。把 `FLEXPRICE_ALIPAY_CHECKOUT_MERCHANTS_JSON` 保存为单个 JSON 数组变量。支付宝配置项包括 `enabled`、`production`、`tenant_id`、`environment_id`、`app_id`、`private_key`、`public_key`、`seller_id`、`notify_url`。真实商户验收使用与租户及环境匹配的商户配置，启用 `enabled` 与 `production`。通知地址使用 Flexprice 的 HTTPS `/v1/webhooks/alipay`。下发方法见 [Infisical 中间件管理](INFISICAL-MIDDLEWARE.md)。
2. 在 **Persaas Runtime → prod → /server** 保存以下 OpenBot 变量。启动读取沿用 API 的 Runtime 只读身份。

   | 变量 | 配置 |
   | --- | --- |
   | `OPENBOT_FLEXPRICE_ALIPAY_ENABLED` | 准备阶段 `false`。批准定向验收后设为 `true` |
   | `OPENBOT_FLEXPRICE_WECHAT_ENABLED` | 支付宝单渠道验收配置使用 `false` |
   | `OPENBOT_FLEXPRICE_ALIPAY_URL` | Flexprice HTTP(S) origin |
   | `OPENBOT_FLEXPRICE_ALIPAY_API_KEY` | 可创建发票、支付及退款的对应租户凭据 |
   | `OPENBOT_FLEXPRICE_ENVIRONMENT_ID` | 支付宝商户配置对应的 Flexprice 环境 |
   | `OPENBOT_FLEXPRICE_ALIPAY_WEBHOOK_TOKEN` | 独立的 24 至 256 字符 bearer，字符范围为字母、数字、下划线和连字符 |
   | `OPENBOT_FLEXPRICE_ALIPAY_MERCHANT` | 与 Flexprice 商户 `app_id` 和 OpenBot 路径签核匹配 |
   | `OPENBOT_FLEXPRICE_ALIPAY_PRODUCTS` | 已发布的点数包代码 |
   | `OPENBOT_FLEXPRICE_ALIPAY_APPLICATION_IDS` | 已签核的 OpenBot 应用 ID |
   | `OPENBOT_FLEXPRICE_ALIPAY_ACCOUNT_IDS` | 初始为空。定向验收时仅填专用验收账号 UUID |

   多个产品、应用或账号以逗号分隔。检查旧支付宝直连和测试入口在验收环境保持关闭，分别确认 `OPENBOT_CREDIT_PACK_ALIPAY_LIVE_ORIGIN` 和 `OPENBOT_CREDIT_PACK_ALIPAY_TEST_ORIGIN` 缺省。

3. 按[配置到账通知](#配置到账通知)注入回调凭据。先在隔离环境验证实际 HTTP 通知送达，再安排真实商户试付。支付确认仍由 OpenBot 重新读取发票和 QR 状态，定时核验间隔约 60 秒。

## 在授权窗口验收并启用

1. 记录候选镜像摘要。验证 Flexprice 健康、现有账号可登录、匿名 `POST /v1/auth/signup` 返回 404。核对支付宝商户、回调 URL、租户及环境。保存脱敏配置键与检查结果。
2. 仅加入验收账号，检查支付宝可选、微信不可选、其他账号无法购买。检查点数包价格、点数及路径签核。记录验收账号的购买前余额。
3. 用真实支付宝商户完成一笔小额付款。核对商户到账、Flexprice 人民币发票全额结清及 OpenBot 订单的支付宝付款记录。再次核验订单，确认点数只发放一次。退款前保留点数包全部未使用。
4. 用管理员对该订单调用 `POST /api/admin/billing/accounts/<accountId>/credit-pack-orders/<orderId>/refund/approve`。如果返回 202，使用同目录的 `POST verify` 查询。核对商户原路退回相同金额，确认 OpenBot 退款状态为 `confirmed`、点数撤销且余额回到购买前。重复核验确认结果稳定。
5. 保存脱敏记录，包括时间、版本摘要、CNY 金额、关联订单及发票的脱敏标识、商户付款和退款状态、通知与余额变化。移除密钥、签名、二维码及个人信息。通过后按已批准的范围扩大支付宝账号名单。

## 暂停支付宝新购

清空支付宝单渠道配置的 `OPENBOT_FLEXPRICE_ALIPAY_ACCOUNT_IDS` 并重建 OpenBot。保留支付宝配置、商户通知及核验路由，直至待支付、已支付及待退款订单完成对账。关闭整个 Flexprice checkout 配置会卸载核验、通知和退款入口。双渠道共用名单，双渠道上线后的单渠道停购需另行验证。

## 配置到账通知

在 Flexprice 的 Infisical 服务目录设置 `FLEXPRICE_WEBHOOK_ENABLED=true` 和 `FLEXPRICE_WEBHOOK_TENANTS_JSON`。JSON 的顶层键是 Flexprice 租户 ID。对应租户对象设置 `enabled` 为 `true`，`included_events` 为 `["invoice.update.payment"]`，`endpoint` 为目标 OpenBot 的 HTTPS `/api/billing/credit-pack-flexprice/alipay/callback` 完整 URL。`headers.Authorization` 使用 `Bearer` 加空格及 OpenBot `OPENBOT_FLEXPRICE_ALIPAY_WEBHOOK_TOKEN` 的值。当前环境已有原生 webhook 时，保留其他租户的配置条目。

用测试订单核对 Flexprice 原生通知返回 2xx、OpenBot 只发一次点。校验凭据不一致时通知被拒绝。验收证据只记录回调时间、HTTP 状态及脱敏订单引用。
