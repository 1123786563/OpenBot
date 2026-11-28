# 跨服务器同步应用商店

适用于 1Panel v2，依据是 v2.5.1 源码和官方文档（2026-11-28 核对）。单台服务器导入见 [README](README.md#导入)。

## 结论

1. **官方远程应用不用同步。** 每个节点各自从同一个官方仓库拉列表：主节点的 agent 启动时同步一次，所有节点每天在 00:00–02:59 的一个随机时刻同步，也可以手动点「更新远程应用」。
2. **自建本地应用要自己铺。** 「同步本地应用」只读取本机的 `/opt/1panel/resource/apps/local/` 并写入本机数据库，v2 没有上传本地应用包的接口。多台机器保持一致的做法是把目录复制过去，再在每台机器上触发一次同步。
3. **已有已安装应用的面板不要启用「自定义应用仓库」。** 它会整体替换官方应用列表，切回官方前必须删除全部已安装应用。

## 把本地应用目录铺到其他服务器

以一台机器的目录为准：

```sh
# 不带 --delete：源里删掉的应用不会从目标机器消失
rsync -a /opt/1panel/resource/apps/local/ root@<目标>:/opt/1panel/resource/apps/local/

# 在目标机器上以 root 触发同步
ssh root@<目标> 'curl -sS --unix-socket /etc/1panel/agent.sock -H "Content-Type: application/json" -d "{}" http://unix/api/v2/apps/sync/local'
```

也可以从本仓库直接分发：在 `deploy/1panel/` 执行 `COPYFILE_DISABLE=1 tar -czf local-apps.tar.gz -C apps .`，上传后解压到目标机器的 `/opt/1panel/resource/apps/local/`，再触发同步。

触发同步的三种方式：

- 界面：应用商店 → **同步本地应用**。
- 节点本机 root：上面第二条命令。
- 面板 API：`POST /api/v2/apps/sync/local`，请求头 `1Panel-Token` 和 `1Panel-Timestamp`。先在面板设置里开启 API 接口并填写 IP 白名单，白名单为空时请求被拒绝。

注意事项：

- 同步是异步的，接口立即返回。结果看任务中心或 `/opt/1panel/log/task/AppStore/<taskID>.log`。
- 目录里已不存在、且本机没有已安装实例的本地应用会从应用列表删除；有已安装实例的保留为「已废弃」。使用 `rsync --delete` 会把源里的删除动作带到所有目标机器。
- 应用目录缺 `data.yml` 或 `logo.png`，或版本目录缺 `docker-compose.yml` 或 `data.yml` 时，该应用被跳过，只在任务日志里记一条。

## 商业版多节点

- **同步本地应用时联动子节点**（v2.5.0 起）：开启后，管理员在主节点点「同步本地应用」，任务会下发到子节点。它是否同时复制主节点的应用包，官方没有说明，实现也不在开源仓库里；对应的需求 [#11657](https://github.com/1Panel-dev/1Panel/issues/11657) 只要求免去逐个子节点点按钮。先复制目录再触发同步，两种情况都成立。
- **高级功能 → 资源同步 → 文件对传**可以在节点之间传目录，两端都要装 rsync。
- **应用对传**和应用迁移复制的是已安装的应用，目标节点必须已有相同应用（[#11329](https://github.com/1Panel-dev/1Panel/issues/11329)），且不支持依赖 OpenResty、Redis、MongoDB 的应用。

## 自定义应用仓库（专业版和企业版）

```sh
git clone https://github.com/1Panel-dev/appstore
cd appstore && tar -czf package.tar.gz apps data.yaml
```

在 应用商店 → 设置 里启用，包的内容与官方应用仓库同构。节点管理里的「数据同步配置 → 自定义应用仓库」和「同步至子节点」可以把它下发到子节点。

- 启用期间官方应用列表不再生效，远程应用同步直接跳过。官方支持的原话：「一旦你使用这个包 那么官方的包就不再生效 如果你安装了应用 必须删除所有应用之后才能切换回官方」。
- 只接受 tar.gz，不支持 Git 地址（[#13754](https://github.com/1Panel-dev/1Panel/issues/13754) 仍未实现）。
- 适合全新面板或离线环境：需要一个固定内容的应用源，并下发到所有节点。

## 依据

源码均为 1Panel-dev/1Panel @ v2.5.1：

- [agent/router/ro_app.go](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/agent/router/ro_app.go)：只有 `apps/sync/remote` 和 `apps/sync/local` 两个同步接口，没有上传接口。
- [SyncAppListFromLocal](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/agent/app/service/app.go#L676-L906) 只遍历本机目录；[SyncAppListFromRemote](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/agent/app/service/app.go#L1033-L1086) 在启用自定义应用仓库时直接返回。
- [handleLocalApp](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/agent/app/service/app_utils.go#L1359-L1483)：目录和文件的硬性要求。
- [cron.go](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/agent/cron/cron.go#L58-L75)：每日同步时刻；[global.go](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/agent/global/global.go#L86-L94)：官方仓库地址写死在代码里。
- [apps/index.vue](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/frontend/src/views/app-store/apps/index.vue#L215-L231)：联动子节点的触发条件；[zh.ts](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/frontend/src/lang/modules/zh.ts#L7139-L7163)：自定义仓库的界面文案。
- [api_auth.go](https://github.com/1Panel-dev/1Panel/blob/v2.5.1/core/app/auth/api_auth.go#L51-L52)：API 请求头。

官方文档：

- [应用商店设置](https://1panel-dev.github.io/docs/v2/user_manual/appstore/setting/)、[节点管理](https://1panel-dev.github.io/docs/v2/user_manual/xpack/node/)、[资源同步](https://1panel-dev.github.io/docs/v2/user_manual/xpack/resource_sync/)。
- [本地测试](https://1panel-dev.github.io/docs/v2/dev_manual/appstore_skills/)：本地应用目录布局与「复制目录后刷新」。
- [离线安装](https://1panel-dev.github.io/docs/v2/installation/package_installation/)、[更新日志](https://1panel-dev.github.io/docs/v2/changelog/)。
- 页面里标注的 `1panel.cn/docs/v2/...` 地址已返回 404，以上链接指向同一内容的站点。

维护者答复：

- [v2.5.0 发行说明](https://github.com/1Panel-dev/1Panel/releases/tag/v2.5.0)「【应用商店】本地应用同步支持联动子节点」。
- 官方论坛 [Pro版应用商店设置里的自定义仓库怎么自定义](https://bbs.fit2cloud.com/t/13959)：自定义仓库的包结构、替换行为与切回条件。
