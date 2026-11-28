# 用服务器清单部署三节点平台

面向初级开发的完整步骤见[多服务器安装指南](../docs/multi-server.md)。用户填写服务器名、SSH 地址、私网 IP 和目录，控制端生成每个角色的配置，再通过 SSH 分发和执行。

- `inventory.example.json` 是可复制的三节点清单。
- `../cluster.py` 负责清单验证、角色编译、加密 overlay 和 SSH 编排。
- `../cluster_node.py` 只在目标节点执行本机 Compose、初始化与验收。
- `smoke-network.py` 在三个临时 Docker-in-Docker Engine 内验证加密 overlay，不改变宿主机 Swarm。

默认将 data、apps、compute 三个角色各放一台服务器。清单前三台必须分别承担这三个角色，顺序可调整。额外节点使用 observer，运行本机日志采集。当前不支持多个活跃 compute 或 apps 角色，不支持通过改清单把数据卷自动搬到另一台主机。

生成配置在控制端私有配置目录的 `cluster/<节点名>/`，服务器配置在清单目录的 `.openbot/`。两个位置都包含角色所需的凭据，需要备份和限制访问。计算节点不会收到 PostgreSQL、MySQL、RustFS 或 OpenObserve 的管理密码。
