# 按报错排查安装

命令从仓库根目录执行。所有生成配置都在 `deploy/centralized/config/`。失败后保留这个目录和数据卷，修复后重新运行 `./deploy/deploy.sh up`。

## 找不到 Docker，或没有连接 Docker 的权限

执行 `docker info`。出现 permission denied 时，确认用户已加入 docker 组并重新 SSH 登录。服务未运行时执行 `sudo systemctl start docker`。安装器不会替你更改用户权限或卸载系统组件。

## 模型 key 或模型名称缺失

运行 `./deploy/deploy.sh configure`，填写供应商提供的地址、key 和可用模型。API 地址不能填成服务器的 `localhost`，除非模型确实与应用运行在同一容器中。重跑 `up` 后，在 OpenBot 发一条消息检查实际请求。

## 某个端口已被其他服务占用

这是新服务器安装流程，不会停止不属于自己的容器。运行 `docker ps` 和 `ss -ltnp` 查找占用者。如果服务器已经部署过旧版 OpenBot，先按迁移流程处理，或改用全新服务器。不要为了释放端口直接删除数据库容器和卷。

## 镜像拉取或构建失败

保留终端中失败阶段的最后一段日志，确认服务器能访问镜像仓库、GitHub 和依赖下载源。运行 `df -h` 检查磁盘，运行 `free -h` 检查内存。网络恢复后重跑 `build`，Docker 会复用已完成的构建层。构建期间不要运行带 `--volumes` 的清理命令。

## RustFS 初始化失败

运行 `./deploy/deploy.sh logs infrastructure`。检查 RustFS 的健康检查、数据目录权限和 rc 初始化任务。安装器会创建 `opik` bucket，再创建限定该 bucket 的服务账号，不向 Opik 传 root 密钥。已有账号的密钥与配置不一致时，不会用新密钥静默覆盖旧账号。

页面出现附件域名或连接错误时，确认 SSH 隧道包含 19000，并检查本机能否解析 `s3.localhost`。检查 Opik 的实际上传、预签名下载和 CORS，不要只检查控制台是否能登录。

## OpenObserve 采集账号初始化失败

运行 `./deploy/deploy.sh logs openobserve`。安装器使用管理员 API 创建独立的 `collector@openbot.local` 账号并验证凭据，不把管理员密码传给 Collector。默认使用 editor 角色，不能把它称为仅写入账号；权限范围取决于锁定版本与版本授权能力。

若已有同名账号但密码不同，安装器会停止，保留原账号。核对生成配置与原实例来源，不能通过重建配置来绕过已有密码。

## SPIRE 或 Agent 启动失败

分别运行 `./deploy/deploy.sh logs spire`、`./deploy/deploy.sh logs agents`。确认 Docker socket 在默认路径可用，SPIRE Server 正常。首次 join token 有效期为一小时，自动启动通常会在生成后立即加入。若首次启动中断超过一小时且 Agent 尚未加入，维护人员需重新签发 token 并同步生成配置，不能删除整个身份数据卷来重试。

## Hindsight 第一次启动较慢

运行 `./deploy/deploy.sh logs hindsight`。初次需要下载模型，确认模型源网络可用。扩展安装成功不等于向量计算兼容，目标 CPU 上的真实 vector 写入测试也必须通过。离线模型准备属于高级部署流程。

## check 失败，但页面还能打开

check 同时检查 API、Worker、Agent、存储、日志服务以及 HTTP 入口。页面打开不代表后台任务和追踪工作正常。根据输出中的组件名运行 `logs`，修复后重跑 `check`。健康检查仍处于 starting 时，等待其就绪后再验收。

## 如何回退或重新安装

`stop` 只停止，不删除卷。新手入口不提供删除数据命令。迁移已有数据库或执行破坏性重装前，先完成备份与恢复演练，见[运维手册](../operations.md)。

## 多机 SSH 或 overlay 连接失败

先运行 `cluster doctor`。SSH 失败时人工核对 host key、登录用户和 Docker 组权限。不要通过关闭主机指纹检查来绕过错误。网络失败时确认服务器之间放通 TCP 2377、TCP/UDP 7946、UDP 4789 与 IP 协议 50，只限私网来源。

运行 `cluster logs --node 节点名`。Sentinel 无法发现副本、跨机 DNS 不通或数据库 TCP 不通时，先修复网络，不要新建第二套数据库。已经属于其他 Swarm 的主机会被拒绝，安装器不会强制接管。

## 多机清单改动被拒绝

部署后的角色、IP、目录与网段绑定现有数据和网络。需要迁移时保留控制端配置、远端 `.openbot/` 与数据卷，再制定迁移步骤。不要删除 `cluster/swarm.json` 来绕过保护。
