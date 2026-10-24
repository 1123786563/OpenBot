# CUA Driver + Guacamole 原生桌面演示

这是一套独立的本地演示环境。`desktop` 容器运行 Linux X11 桌面、原生 `xterm`、CUA Driver daemon 和 VNC；Guacamole 通过 `guacd` 连接同一个桌面。CUA Driver 负责观察与输入，Guacamole 负责让用户在浏览器中查看、接管这个桌面。

## 启动

需要 Docker Desktop 或 Docker Engine + Compose。CUA Driver 的 Linux 发布包仅有 x86_64；在 Apple Silicon 上，本例通过 Docker 的 `linux/amd64` 模拟运行，性能会低于原生 x86_64 主机。

```sh
cd examples/cua-guacamole-demo
docker compose up --build -d
docker compose exec desktop cua-driver status
docker compose exec desktop cua-driver doctor
```

打开 <http://127.0.0.1:18081/>，用户名 `demo`，密码 `demo-local-only`，选择 **OpenBot CUA desktop**。该密码仅供本机演示；Web 端口只绑定 `127.0.0.1`，VNC 没有发布到宿主机。

## 运行 CUA 操作

保持 Guacamole 页面打开，在另一个终端执行：

```sh
./run-demo.sh
```

脚本使用 CUA Driver 找到 xterm 窗口、读取窗口状态、向窗口输入 `echo CUA_WORKED | tee /tmp/cua-demo-result.txt` 并回车，然后检查桌面内生成的结果文件。Guacamole 页面可以看到同一个 xterm 中的命令与输出。脚本需要宿主机有 Python 3。

也可以手动查看 Driver 的观察结果：

```sh
docker compose exec desktop cua-driver call list_windows
docker compose exec desktop cua-driver call get_desktop_state \
  '{"screenshot_out_file":"/tmp/cua-desktop.png"}'
```

`list_windows` 应显示名为 `OpenBot CUA + Guacamole` 的原生 xterm 窗口。`run-demo.sh` 使用前台输入，因为 Xvfb 无法提供 Driver 的 X11 后台虚拟键盘路径。浏览器中的用户输入也会进入这个桌面，因此生产环境需要由应用层协调自动化与人工接管，避免同时输入。

## 停止

```sh
docker compose down
```

本例是单用户概念演示，没有实现 OpenBot 的登录态关联、租户隔离、会话租约、凭据托管或审计。生产集成应按用户和任务隔离桌面，并通过 OpenBot 后端授权后再提供 Guacamole 连接与 CUA 控制权。

CUA Driver 发布包固定为 `0.38.0`。此例只使用 [MIT 授权的 CUA Driver](https://github.com/trycua/cua/blob/main/LICENSING.md)，不包含 CUA Spaces 或可选的感知扩展。Driver 命令以 [官方 CLI 文档](https://cua.ai/docs/cua-driver/reference/cli/serve-and-configure) 为准。
