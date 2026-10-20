# OpenBot docs

新增文档按[目录与产物归处](../.agents/rules/artifacts.md)分类。实施方案和方案细节从[方案目录](../docs/plans/README.md)进入；Agent 规范见根 [AGENTS.md](../AGENTS.md)；运行与验证证据存 `.archive/runs/<run-key>/`。本页保留现有产品与操作参考文档的索引，历史内容按规范分批迁移；测试实际读取的配置不能直接归档。

Start with the root [README](../README.md), then use these references:

- [Architecture](architecture.md): services, ports, browser governance, computers, components, plugins, knowledge, and security boundaries.
- [Configuration](configuration.md): environment variables and tenant package YAML.
- [Development](development.md): local setup, migrations, ports, and quality checks.
- [Coworkers](coworkers.md): durable Bot profiles, channels, visibility, deletion, and external AG-UI registration.
- [Routines](routines.md): standing instructions a Bot runs on a schedule, the worker that fires them, and who they run as.
- [Automatic Learning](automatic-learning.md): which Bots contribute conversations to a Learning container, and receive its published skills.
- [Parallel research](parallel-research.md): public-web search and extraction through the Parallel Search connector.
- Plugins, one connector per page — what an administrator registers, what each person consents to, and what the failures mean:
  - [Composio](plugins/composio.md): the broker, and so the one page here that is a catalogue of apps rather than a single connector.
  - [Google Drive](plugins/google-drive.md)
  - [Notion](plugins/notion.md)
- [Compose stacks](compose.md): which `docker compose` files exist, what each one brings up, and when to reach for it.
- [Observability](observability.md): metrics, logs, and traces.
- [Enterprise Go runtime](enterprise-runtime.md): the optional Go runtime candidate — 接入方式与运行手册.
- [Opik](opik.md) and the [Opik upstream contract](opik-contract.md): optional self-hosted tracing, and the verified contract the server codes against.
- [Workshop × CodeSandbox testing](workshop-testing-guide.md): how to test the workshop surface against CodeSandbox.
- [Craft preview origin](craft-preview-origin.md): the preview origin's runtime behavior and known constraints.
- [Preview-origin TLS certificates](tls-certs.md): ACME DNS-01 wildcard certificates for the preview origin.
- [Deployment](deployment.md): the container, what is in the image, minimum sizes, and the platform notes.
- [Kubernetes](../charts/openbot/README.md): the Helm chart, what a cluster needs before it, and the values that differ per cloud.
- [Releasing](releasing.md): how a release is proposed, reviewed and published.
- [Windows desktop signing](windows-signing.md): protected Azure Key Vault signing and verification of the app and NSIS installer.
- [Desktop provider OAuth](../desktop/PROVIDER_OAUTH.md): what a distributor configures to offer Google and xAI sign-in in a desktop build.
- [Desktop telemetry](../desktop/TELEMETRY.md): every event the desktop app sends, and what it carries.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
