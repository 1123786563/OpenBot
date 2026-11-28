# 部署维护资料

第一次搭建只读[Linux 安装指南](../README.md)，运行 `deploy/deploy.sh`。本目录供维护人员处理扩展、迁移与故障。

| 任务 | 文档或入口 |
| --- | --- |
| 三台及以上服务器部署 | [multi-server.md](multi-server.md) |
| 按报错排查 | [troubleshooting.md](troubleshooting.md) |
| 了解共享中间件与数据库合并边界 | [集中部署方案](../centralized-deployment-plan.md) |
| 修改底层 Compose、端口、网络或数据库 | [配置资源说明](../centralized/README.md) |
| 准备 Flexprice | [Flexprice 扩展](flexprice.md) |
| 备份、日志保留和已有实例迁移 | [运维手册](../operations.md) |
| 维护原独立 Compose | [legacy-compose.md](legacy-compose.md) |
| 维护 1Panel 服务器 | [1Panel 安装包](../1panel/README.md) |
| 维护已有本机环境 | [本机开发环境](../local-development.md) |

## 验证安装器变更

在仓库根目录执行：

```sh
python3 -m unittest discover -s deploy/tests -v
python3 deploy/centralized/verify.py
python3 deploy/centralized/smoke-postgres.py
python3 deploy/centralized/smoke-redis.py
python3 deploy/centralized/smoke-rustfs.py
# 可选：需预先拉取 docker:29-dind，启动三个临时 privileged 测试 Engine。
python3 deploy/cluster/smoke-network.py
```

前两项不启动平台服务。配置检查在开发机有 Bun 时还会调用主应用的真实配置加载器。后三项使用临时容器，要求相应镜像已存在，测试完成后清理自己的容器和卷。它们不等于在一台全新 Linux 机器上完成全平台安装验收。发布安装器前，还需按新手指南完成模型、浏览器、附件、记忆、追踪和日志的完整业务验收。
