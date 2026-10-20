## Parent

- GitHub Issue: #359（已发布，标签 ready-for-agent）

- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`（已批准，D8/AC8）
- 覆盖验收标准：AC8
- 主战场：`openbot`（部署流水线）+ DNS 提供商

## What to build

生产 preview origin 的泛域名证书签发与续期自动化：`*.<preview-host>` 由 ACME DNS-01 自动签发，续期在到期前自动完成，失败可观测并告警。这是 D8 —— 一条真实工作项，不是部署前置核验。

**不阻塞 dev**：`127.0.0.1` 形态不需要证书。

## Acceptance criteria

- [ ] 首次签发无需人工：`*.<preview-host>` 证书由流水线产出并挂载
- [ ] DNS-01 challenge 自动应答（DNS 提供商凭据来自部署方提供的 secret，不落仓库）
- [ ] 续期在到期前自动完成；续期失败的告警可被值班发现（非静默）
- [ ] 证书挂载与 preview origin 的服务进程联动：新证书生效不需要人工干预
- [ ] 私钥权限最小化：仅服务进程可读；凭据不入仓库与普通日志
- [ ] 失效演练：人为使续期失败一次，告警触发且服务在旧证书有效期内不受影响
- [ ] 采用免费栈：CA 用 Let's Encrypt（通配符必须 DNS-01），客户端 acme.sh（或 lego/certbot），零许可费
- [ ] 通配符只覆盖一层标签：`*.<preview-host>` 匹配 `<hash>.<preview-host>`，不匹配更深嵌套（设计即一层，D7）
- [ ] 推荐子域委托：把 `preview.<主域>` 的 NS 委托给 API 友好的免费提供商（Cloudflare 免费 / deSEC），自动化凭据只授权该 zone，不碰主域 DNS（最小权限）
- [ ] 确认浏览器可解析 `<hash>.<preview-host>`：纯内网部署需 split-horizon DNS 或公网 DNS 指内网 IP

## Contracts

## 推荐实现（免费栈，¥0）

CA 用 **Let's Encrypt**（免费，通配符必须 DNS-01），客户端 **acme.sh**（纯 shell、零依赖、内置主流 DNS 提供商插件）。DNS-01 的验证是 LE 服务器查公开 DNS 的 TXT 记录，**不需要把 80/443 暴露到公网** —— 对内网部署的 preview origin 友好。

```bash
# 以 Cloudflare 免费版为例（Token 只授权 preview.<主域> 这个 zone）
export CF_Token="…"
acme.sh --issue --dns dns_cf \
  -d '*.<preview-host>' --keylength ec-256

# 安装 + 续期后自动重载（acme.sh 自装 cron，约 60 天自动续）
acme.sh --install-cert -d '*.<preview-host>' \
  --key-file       /etc/openbot/tls/key.pem \
  --fullchain-file /etc/openbot/tls/cert.pem \
  --reloadcmd "docker compose restart openbot-server"
```

其它提供商只需换插件与凭据：阿里云 `dns_ali`（Ali_Key/Ali_Secret）、DNSPod `dns_dp`（DP_Id/DP_Key）、华为云 `dns_huaweicloud`、开源免费的 deSEC `dns_desec`。无 API 的注册商需换 DNS 或做子域委托。

**Consumes**

- 部署方提供的 DNS 提供商 API 凭据（secret 注入，不落仓库）
- Spec Q1/D7 定下的 preview 主机后缀（证书的 DNS 名以它为准）

**Produces**

- `*.<preview-host>` 证书及其自动续期
- 续期状态的可观测信号（成功/失败事件，供 02 的准入与告警消费）

## Implementation steps

1. 选定 ACME 客户端与 DNS 提供商集成（凭据走 secret 注入）
2. DNS-01 challenge 应答 + 泛域名签发
3. 挂载 + 重载联动（不中断在途预览连接）
4. 续期调度与到期前告警
5. 失效演练：注入一次失败，验证告警与旧证书兜底

## Write scope

部署流水线/compose 与证书目录；`server/` 仅消费挂载结果。不触碰预览代理逻辑（那是 02/03）。
