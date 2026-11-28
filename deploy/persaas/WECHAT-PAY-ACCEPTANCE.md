# 验收并启用微信点数包收款

[#220](https://github.com/1123786563/OpenBot/issues/220) 的本地验收已通过。Web [#127](https://github.com/1123786563/OpenBot/issues/127) 完成并解除暂停后，再执行生产复验。真实商户到账、整单原路退款和生产启用均待验收。

## 复跑本地验收

OpenBot 集成基线为 `2dbef5ead`。从工作树根目录运行下列命令。`.env.test` 链接到主工作区的私有测试文件。使用独立 Compose 项目和两个测试库。

```sh
POSTGRES_PORT=15490 docker compose --env-file .env.test -p openbot-wechat220 up -d --wait postgres
docker compose --env-file .env.test -p openbot-wechat220 exec -T postgres createdb -U openbot openbot_wechat_test
docker compose --env-file .env.test -p openbot-wechat220 exec -T postgres createdb -U openbot flexprice_wechat_test

DATABASE_URL=postgres://openbot:openbot@127.0.0.1:15490/openbot_wechat_test \
  bun --no-env-file --env-file=.env.test server/scripts/migrate.ts
bun --no-env-file --env-file=.env.test scripts/generate-app-config.ts
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:15490/openbot_wechat_test \
  bun test --no-env-file --env-file=.env.test \
  server/tests/credit-pack-checkout.integration.test.ts \
  server/tests/paid-refunds.integration.test.ts \
  app/tests/billing-page.test.tsx
```

从 Flexprice 候选源码 `bb780f798bcdf2b14ac68debedee54254e901e74` 的根目录运行下列命令。

```sh
FLEXPRICE_TEST_POSTGRES_DSN='postgres://openbot:openbot@127.0.0.1:15490/flexprice_wechat_test?sslmode=disable' \
  go test -count=1 -v ./internal/integration/wechat ./internal/config ./internal/ee/service \
  -run 'WeChat|Infisical|AlipayCheckoutPostgres'
```

2026-11-28，OpenBot 的 54 个测试通过。微信单开时默认使用微信且拒绝支付宝结账，双关时购买入口返回 404。用本地 Flexprice HTTP fixture 将微信 Native 二维码的付款结果送入实际 OpenBot 账本。补查及重复通知合计只发一次点。管理员退款沿原微信付款提交，确认全额退款后订单为 `refunded`，余额回到付款前，重复确认保持同一退款记录。

Flexprice 的三个测试包通过，含 PostgreSQL 结算用例、微信 Native 通知验签及解密、退款回执金额与订单匹配、Infisical 读取微信配置及关闭注册。测试使用本地服务或构造的回执。复验结束后，用 `docker compose --env-file .env.test -p openbot-wechat220 down` 停止本次测试服务。

## 核对发布版本和密钥

部署前用 `go version -m` 和 `sha256sum` 核对两个 Linux amd64 文件。候选二进制内的 `vcs.revision` 均为 `bb780f798bcdf2b14ac68debedee54254e901e74`，`vcs.modified=false`。

| 文件 | SHA-256 |
| --- | --- |
| `server` | `2c600567d9c4e2ac875924e9c89fcc373e00491709a96167874048b2bffdfa70` |
| `migrate` | `10eb3438efd57aaee3080ed46ce9a9a3b2d48042d4352f79648097250bc0cd46` |

- 在目标 Flexprice 的 Infisical 服务目录保存 `FLEXPRICE_AUTH_DISABLE_SIGNUP=true`，以及 `FLEXPRICE_WECHAT_CHECKOUT_MERCHANTS_JSON`。数组中启用对应商户，核对 `tenant_id` 和 `environment_id`。商户条目使用 `enabled`、`app_id`、`merchant_id`、`serial_number`、`private_key`、`public_key`、`public_key_id`、`api_v3_key` 和 `notify_url`。通知 URL 使用目标 Flexprice HTTPS 地址的 `/v1/webhooks/wechat`。
- 如目标使用 Flexprice 自身的 Infisical 加载器，核对 `INFISICAL_ENABLED=true`、`INFISICAL_SITE_URL`、`INFISICAL_PROJECT_ID`、`INFISICAL_ENVIRONMENT`、`INFISICAL_SECRET_PATH` 和只读身份的 `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`、`INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`。同名容器环境变量会覆盖 Infisical。若使用 Persaas 现有下发流程，从已授权的 Infisical 目录下发到私有容器 env。参见 [Infisical 中间件管理](INFISICAL-MIDDLEWARE.md)。
- 在 OpenBot API 的 Infisical 配置中填入 `OPENBOT_FLEXPRICE_WECHAT_MERCHANT`，使其与 OpenBot 商户控制所用标识一致。核对共享的 `OPENBOT_FLEXPRICE_ALIPAY_URL`、`OPENBOT_FLEXPRICE_ALIPAY_API_KEY`、`OPENBOT_FLEXPRICE_ALIPAY_WEBHOOK_TOKEN`、`OPENBOT_FLEXPRICE_ENVIRONMENT_ID`、`OPENBOT_FLEXPRICE_ALIPAY_PRODUCTS` 和 `OPENBOT_FLEXPRICE_ALIPAY_APPLICATION_IDS`。Flexprice API Key 必须能在该租户与环境读写发票及支付。两渠道共用 OpenBot 发票通知路径 `/api/billing/credit-pack-flexprice/alipay/callback`。
- 部署候选版本后，先核对健康、已有账号登录和匿名 `POST /v1/auth/signup` 被拒绝，再配置试付。保留部署前版本及私有配置备份。

## 真实商户验收后启用

1. 将 `OPENBOT_FLEXPRICE_ALIPAY_ACCOUNT_IDS` 限定为获准试付的账号。设 `OPENBOT_FLEXPRICE_WECHAT_ENABLED=true`。独立验收环境将 `OPENBOT_FLEXPRICE_ALIPAY_ENABLED` 设为 `false`。生产发布时微信开关独立调整，支付宝开关按 #219 的验收结果设置。
2. 用已批准的点数包创建一笔最小额真实订单。用微信扫 Native 二维码付款。核对商户平台交易及到账、Flexprice 发票和 OpenBot 订单的同一笔 CNY 金额。记录付款前后的可用点数。重复查询订单，确认只发一次点。
3. 保留整包点数未消费。由管理员提交整单退款。用 `POST /api/admin/billing/accounts/{accountId}/credit-pack-orders/{orderId}/refund/approve` 发起退款，用同路径的 `/verify` 核对结果。等待微信商户侧确认全额原路退款和 OpenBot 返回 `confirmed`。核对订单为 `refunded`、可用点数回到基线，重复验证返回同一退款 ID。
4. 保存脱敏证据，包括时间、发布版本及哈希、开关状态、匹配的订单与商户流水引用、金额、退款结果和点数变化。去除二维码、支付链接、凭据、身份信息和完整商户流水号。真实验收通过后，按批准的账号范围开放微信。
5. 若验收失败，在仅开放微信的试付环境中清空账号白名单以阻止新购，保持查询和退款处理可用。检查已签发二维码是否仍可支付，并逐笔核对待支付与待退款订单。两个支付开关都关闭时，OpenBot 会卸载共享查询、通知、退款路由和扫单任务，因此先处理在途订单，再关闭最后一个渠道。
