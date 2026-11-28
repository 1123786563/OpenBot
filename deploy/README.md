# 搭建 OpenBot 平台

有三台及以上、私网互通的 Linux 服务器时，使用 **[多服务器安装指南](docs/multi-server.md)**。填写一份清单，由 `./deploy/deploy.sh cluster up` 按角色部署同一套平台。不要逐台执行下文的单机 up。

只有一台服务器时，继续阅读下面的单机流程。

这份指南面向第一次部署 OpenBot 的开发者。推荐从一台全新 Ubuntu 24.04 服务器开始，在一个目录完成配置、镜像构建、启动和检查。日常操作统一使用 `deploy/deploy.sh`。

默认安装 OpenBot Web、API、Worker、Bot、LangGraph、浏览器 Computer、Supervisor、Bifrost、Hindsight、Opik、Infisical、OpenObserve、日志采集和 SPIRE，以及它们共用的数据库、Redis Sentinel 和 RustFS。Flexprice 是后续扩展，Lago 不安装。

## 1. 准备服务器

准备能访问 GitHub、容器镜像仓库和模型 API 的 Ubuntu 24.04 服务器。全套服务包含镜像编译、Chromium、向量模型和多个数据库，建议从 8 核、16 GiB 内存、100 GiB SSD 开始。这是初始部署建议，不是容量或性能保证。

用有 sudo 权限的普通用户通过 SSH 登录。以下安装命令来自 [Docker 的 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)。若服务器已有 Docker，跳过安装，直接检查版本。

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/docker.sources
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

退出 SSH 后重新登录，让 Docker 用户组生效。确认以下命令均成功。

```sh
docker info
docker compose version
python3 --version
```

需要 Python 3.10+、Docker Engine 和 Compose 2.24.4+。不需要在主机安装 Node.js、Bun、PostgreSQL 或 Redis。Docker 组具有主机管理权限，仅给平台维护人员使用。

## 2. 获取仓库并初始化

使用你有权限访问的 OpenBot Git 仓库地址替换下面的地址。

```sh
git clone <你的-OpenBot-仓库地址> OpenBot
cd OpenBot
./deploy/deploy.sh init
```

脚本只询问四项：管理员邮箱、OpenAI 兼容模型 API 地址、模型名称和 API key。API key 输入时不回显。填写你的供应商提供的完整 API 基础地址，通常以 `/v1` 结尾，以及该地址实际支持的模型名称。

脚本自动生成其他账号密码、加密密钥、内部连接、数据库账号、Agent 令牌和浏览器配置。生成文件保存在 `deploy/centralized/config/`，权限为 0600，已被 Git 忽略。重复运行不会更换数据库密码或加密密钥。

需要修改邮箱或模型配置时运行 `./deploy/deploy.sh configure`。首次安装不需要自己编辑十几个 `.env`，也不要把旧服务器的数据卷直接挂进来。

## 3. 检查、构建并启动

在仓库根目录依次运行：

```sh
./deploy/deploy.sh doctor
./deploy/deploy.sh build
./deploy/deploy.sh up
```

`doctor` 检查 Docker、配置、磁盘余量和端口冲突。`build` 构建主应用、Bot、LangGraph、浏览器和 Supervisor。首次构建需要下载较多依赖，终端会持续显示构建日志。

`up` 按顺序启动数据库，初始化独立库与账号，启动 Redis Sentinel、RustFS 和 ClickHouse，再初始化对象存储、管理员、日志采集、SPIRE、Agent 与主应用。你会看到 `[1/10]` 到 `[10/10]` 的进度。某一步失败就停止后续步骤，保留已有数据，给出查看日志的方法。

看到“服务与 HTTP 验收通过”说明容器和入口检查完成。第一次启动 Hindsight 还需要下载模型，下载时间取决于网络。服务检查不能代替最后的业务验收。

## 4. 从自己的电脑打开平台

服务端口默认仅监听服务器回环地址。先在你自己的电脑打开一个新终端，建立 SSH 隧道，替换 `user@server`。

```sh
ssh -N \
  -L 18001:127.0.0.1:18001 \
  -L 15173:127.0.0.1:15173 \
  -L 18080:127.0.0.1:18080 \
  -L 18082:127.0.0.1:18082 \
  -L 15080:127.0.0.1:15080 \
  -L 18888:127.0.0.1:18888 \
  -L 19999:127.0.0.1:19999 \
  -L 19000:127.0.0.1:19000 \
  -L 19001:127.0.0.1:19001 user@server
```

保持这个终端打开，在 Chrome 或 Edge 访问以下地址。

| 页面 | 地址 | 凭据 |
| --- | --- | --- |
| OpenBot | http://localhost:18001 | 默认个人版，在页面完成首次设置 |
| Opik | http://localhost:15173 | Opik 用户名与密码 |
| Bifrost | http://localhost:18080 | Bifrost setup token |
| Infisical | http://localhost:18082 | 管理员邮箱与平台管理员密码 |
| OpenObserve | http://localhost:15080 | 管理员邮箱与 OpenObserve 密码 |
| Hindsight 控制台 | http://localhost:19999 | Hindsight 控制台 key |
| RustFS 控制台 | http://localhost:19001 | RustFS access key 与 secret key |

在服务器运行 `./deploy/deploy.sh credentials` 查看管理员凭据。该命令会明确显示密码，仅在自己的终端使用，不要复制到工单或聊天。

Opik 的对象地址为 `http://s3.localhost:19000`。浏览器将 `.localhost` 域名解析到你的电脑，SSH 将 19000 转发到服务器；Docker 内同一个域名是 RustFS 的网络别名。若电脑的 DNS 工具不识别该域名，在本机 hosts 文件添加 `127.0.0.1 s3.localhost`。首次安装无需购买域名或配置证书。

默认个人版没有多人登录，入口只通过 SSH 隧道开放。面向团队发布前，另行配置域名、TLS 和企业登录。

## 5. 完成业务验收

按下面顺序检查，任何一步失败都不要宣布安装完成。

1. 在 OpenBot 完成首次设置，发送一条消息，确认模型返回回复。
2. 打开平台中的浏览器，确认画面可见且能访问网页。
3. 查看 Opik，确认测试对话的追踪能够写入。
4. 验证一份记忆的写入与召回，以及一个附件的上传和下载。
5. 查看 OpenObserve，确认能查询到这次安装产生的日志。
6. 再运行 `./deploy/deploy.sh check`，确认所有组件仍正常。

Bifrost 已运行，默认模型请求使用初始化时提供的供应商地址。需要把模型统一路由到 Bifrost 时，在它的控制台配置供应商，再用 `configure` 修改模型地址和 key。空的 Bifrost 配置不会自动获得模型供应商额度。

## 日常只需要这些命令

| 要做什么 | 命令 |
| --- | --- |
| 看所有服务状态 | `./deploy/deploy.sh status` |
| 验收容器与 HTTP 入口 | `./deploy/deploy.sh check` |
| 看主应用日志 | `./deploy/deploy.sh logs openbot` |
| 看后台依赖日志 | `./deploy/deploy.sh logs infrastructure` |
| 修改模型输入 | `./deploy/deploy.sh configure`，然后 `./deploy/deploy.sh up` |
| 更新源码后的镜像 | `./deploy/deploy.sh build`，然后 `./deploy/deploy.sh up` |
| 停止，保留数据 | `./deploy/deploy.sh stop` |
| 停止后恢复 | `./deploy/deploy.sh up` |

遇到问题先看[按报错排查](docs/troubleshooting.md)。运行 `up` 可以继续中断的安装，不会自动删除卷。升级前仍需备份数据库、RustFS 对象与私有配置。

## 目录按用途阅读

- [centralized/](centralized/README.md) 是安装器使用的共享存储与应用配置，一般不需要手动操作。
- [docs/](docs/README.md) 保存架构、扩展、验收和排错资料。
- [1panel/](1panel/README.md) 是旧安装包，维护现有实例时才使用。
- `openbot/`、`agents/`、`bifrost/` 等目录是镜像和旧部署资源，安装器复用其中的配置，不是新手需要选择的安装入口。
- [本机开发](local-development.md) 与[旧独立 Compose](docs/legacy-compose.md) 用于维护原环境。新服务器不要混用这些步骤。
