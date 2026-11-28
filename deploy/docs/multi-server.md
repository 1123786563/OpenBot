# 在三台 Linux 服务器搭建同一套平台

这是“data + apps + compute”的推荐多机路径。你只维护一份清单，由控制端统一初始化、同步源码、构建镜像、启动服务和检查结果。不要在三台服务器分别运行单机 `up`。

## 1. 准备三台服务器

三台主机都使用相同 CPU 架构的 Ubuntu 24.04，并拥有互通的私网。按[Linux 安装指南](../README.md#1-准备服务器)在每台安装 Docker、Compose 和 Python，把维护用户加入 Docker 组后重新登录。

| 角色 | 放置的服务 |
| --- | --- |
| data | 一套 PostgreSQL、MySQL、RustFS、ClickHouse、ZooKeeper，Redis 初始主节点和一个 Sentinel |
| apps | OpenBot Web、API、Worker，Bifrost、Hindsight、Opik、Infisical、OpenObserve，Redis 副本和一个 Sentinel |
| compute | Bot、LangGraph、共享浏览器、Supervisor、SPIRE Server 与 Agent，Redis 副本和一个 Sentinel |

每台都运行本机日志采集。SPIRE Server 放在 compute，是因为 Supervisor 通过本机 Unix socket 注册工作负载；它的数据库仍在 data 上。不要把这个 socket 配成一个跨服务器文件路径。

这是一套共享服务按角色分机部署。Redis 的副本与 Sentinel 跨三台主机，其他数据库和应用仍为单实例，不能据此宣称全平台多活。默认仍是通过 SSH 使用的个人版，团队公网发布需要另配登录、TLS 和访问入口。

## 2. 放通私网端口

仅允许清单内服务器之间访问以下端口。公网不开放这些端口。

| 协议与端口 | 用途 |
| --- | --- |
| TCP 2377 | Swarm 管理节点通信 |
| TCP 和 UDP 7946 | 节点发现与通信 |
| UDP 4789 | overlay 数据传输 |
| IP 协议 50，ESP | 加密 overlay 的 IPsec 数据包 |

SSH 端口只向维护端开放。数据库不发布宿主机端口，服务通过 overlay 内的名称访问。依据见 [Docker overlay 文档](https://docs.docker.com/engine/network/drivers/overlay/)和 [Swarm 网络要求](https://docs.docker.com/engine/swarm/swarm-tutorial/)。

脚本使用 Swarm 建立跨主机的加密 attachable 网络，应用仍由每台服务器上的 Compose 管理。首次部署前三台加入为 manager，额外 observer 加入为 worker。脚本不接管已有的不相关 Swarm，不会强制退出集群。

## 3. 选择控制端并配置 SSH

控制端可以是其中一台服务器，也可以是你的开发电脑。控制端需要 Python、Git、Docker CLI 与 Compose 插件，以及完整源码。它不需要通过公网暴露 Docker API。

先保证控制端能用 SSH key 登录每台服务器，并能执行 Docker。首次连接时人工核对服务器指纹，确认后再继续。示例地址必须换成你的实际地址。

```sh
ssh ubuntu@data-server 'docker info >/dev/null && python3 --version'
ssh ubuntu@app-server 'docker info >/dev/null && python3 --version'
ssh ubuntu@compute-server 'docker info >/dev/null && python3 --version'
```

安装器使用 `BatchMode=yes` 与严格主机指纹校验，不弹出密码输入，也不会自动接受未知指纹。需要跳板机或其他 SSH 端口时，先在控制端 `~/.ssh/config` 定义别名，清单填 `用户名@别名`。

## 4. 初始化并填写唯一的服务器清单

在控制端的仓库根目录运行：

```sh
./deploy/deploy.sh cluster init
```

首次运行会询问模型信息，并创建私有清单 `deploy/centralized/config/inventory.json`。修改这一个文件，例如：

```json
{
  "overlay_cidr": "10.240.0.0/16",
  "nodes": [
    {"name":"data","ssh":"ubuntu@data-server","private_ip":"10.0.0.11","directory":"/home/ubuntu/OpenBot","role":"data"},
    {"name":"apps","ssh":"ubuntu@app-server","private_ip":"10.0.0.12","directory":"/home/ubuntu/OpenBot","role":"apps"},
    {"name":"compute","ssh":"ubuntu@compute-server","private_ip":"10.0.0.13","directory":"/home/ubuntu/OpenBot","role":"compute"}
  ]
}
```

- `ssh` 是控制端能访问的地址，可以与私网地址不同。
- `private_ip` 是服务器自身的私网 IPv4，三台不能相同。
- `directory` 是维护用户能写入的独立安装目录，脚本会创建并复制源码，无需手动在三台 clone。
- `overlay_cidr` 是容器跨机网络地址池，不能与现有 VPC、VPN 或 Docker 网段重叠。检查失败时先换一个不冲突的私网网段。

前三台必须分别承担一个 data、apps、compute 角色。清单可有更多 observer 节点，用于采集该机器的日志；当前不提供多应用副本或多计算节点自动调度。

## 5. 检查计划并启动

```sh
./deploy/deploy.sh cluster plan
./deploy/deploy.sh cluster doctor
./deploy/deploy.sh cluster up
```

`plan` 只在控制端生成每台节点的配置，不连接或变更服务器。它会检查角色、IP、目录和跨机依赖，并且不会把整套管理凭据分发到每个节点。

`doctor` 检查 SSH、Linux Docker Engine、Compose、Python、CPU 架构和路由冲突。rootless Docker 不在本流程支持范围。安全组、ESP 和 UDP 的真实连通性仍需网络建立后的验证。

`up` 自动建立私网网络、复制当前源码与角色配置，在 apps 构建主应用、在 compute 构建 Agent 和浏览器。然后显示 `[多机 1/10]` 到 `[多机 10/10]`，按依赖顺序初始化并启动同一套平台。无需配置镜像仓库，也不需要把数据库和浏览器全部装到每台服务器。

每一步失败都会停止后续操作并保留数据。修复问题后再次运行 `cluster up`。源代码同步不会复制控制端的私有 `.env` 或整套生成配置，只分发该角色实际需要的配置。

## 6. 检查并从电脑访问

```sh
./deploy/deploy.sh cluster status
./deploy/deploy.sh cluster check
```

check 在每台验证指定服务、Sentinel quorum、HTTP 入口，以及 overlay DNS 与跨机 TCP。之后还需完成[主指南的业务验收](../README.md#5-完成业务验收)，包括模型回复、浏览器、附件、记忆、追踪和日志。

在你自己的电脑上开两个终端，并保持 SSH 会话运行。第一个连接 apps：

```sh
ssh -N \
  -L 18001:127.0.0.1:18001 -L 15173:127.0.0.1:15173 \
  -L 18080:127.0.0.1:18080 -L 18082:127.0.0.1:18082 \
  -L 15080:127.0.0.1:15080 -L 19999:127.0.0.1:19999 ubuntu@app-server
```

第二个连接 data，转发对象存储：

```sh
ssh -N -L 19000:127.0.0.1:19000 -L 19001:127.0.0.1:19001 ubuntu@data-server
```

然后打开 `http://localhost:18001`。其他管理页面和凭据查看方法与[主指南](../README.md#4-从自己的电脑打开平台)相同。服务器之间用 overlay 服务名访问 RustFS，浏览器通过 `s3.localhost:19000` 和第二条 SSH 隧道访问同一 endpoint。

## 日常运维

| 任务 | 命令 |
| --- | --- |
| 查看整个部署 | `./deploy/deploy.sh cluster status` |
| 全节点检查 | `./deploy/deploy.sh cluster check` |
| 查看 apps 全部日志 | `./deploy/deploy.sh cluster logs --node apps` |
| 查看 API 日志 | `./deploy/deploy.sh cluster logs --node apps --service openbot-server` |
| 停止全部服务，保留数据 | `./deploy/deploy.sh cluster stop` |
| 恢复或继续安装 | `./deploy/deploy.sh cluster up` |

备份控制端整个私有配置目录、各服务器的数据卷，以及 compute 的 `.openbot/runtime-state.json`。该状态保留身份加入信息，重复同步源码不会覆盖它。不要在控制端丢失密钥后重新 init 来接管旧数据。

第一次网络初始化后，清单中的角色、IP、目录与网络池会被记录。直接改动后重新 up 会被拒绝，避免把 data 角色移动到空卷。主机更换、数据迁移、多人登录、多活数据库或新增活跃计算节点需要另行实施迁移，不在清单更新时自动完成。
