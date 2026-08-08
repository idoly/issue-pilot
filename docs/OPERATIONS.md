# 运维说明

## 进程

| 组件 | 默认地址 | 启动方式 |
| --- | --- | --- |
| Fastify API | `http://127.0.0.1:3000` | `npm run server` |
| SolidJS/Vite | `http://127.0.0.1:4173` | `npm run dev:web -- --host 127.0.0.1` |
| code-server | `http://127.0.0.1:18080` | `infra/code-server.sh ensure` |

API 收到 `SIGINT` 或 `SIGTERM` 时只关闭一次 Fastify。未完成的 Agent workspace 在下次启动时标记为失败并恢复工单状态。

## API 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3000` | API 监听端口 |
| `ISSUE_PILOT_STATE_ROOT` | `.issue-pilot` | 数据库、workspace 和 session 状态根目录 |
| `ISSUE_PILOT_DATABASE` | `<state-root>/issues.db` | SQLite 文件 |
| `ISSUE_PILOT_SUBJECT` | 本地默认用户 | 未认证部署中的当前操作人 |
| `NODE_ENV` | 未设置 | `test` 时关闭默认 Fastify logger |
| `ISSUE_PILOT_ALIYUN_CLI` | `/usr/local/sbin/aliyun` | SLS 使用的宿主 Aliyun CLI |
| `PI_PLAYWRIGHT_CORE_ROOT` | `/usr/local/node/lib/node_modules/playwright-core` | 宿主全局 Playwright core |
| `PI_PLAYWRIGHT_IMAGE` | `mcr.microsoft.com/playwright:v1.62.1-noble` | 临时浏览器容器镜像 |

code-server 不读取环境变量覆盖；部署路径全部写在 `infra/code-server.sh` 中。

## 数据库和迁移

```bash
npm run db:migrate
```

API 启动时也会运行 migration。破坏性迁移前：

1. 停止 API。
2. 复制 `.issue-pilot/issues.db` 及现有 `-wal`、`-shm`，或先执行 SQLite checkpoint。
3. 执行迁移。
4. 启动 API，检查 `/health`、`/api/config` 和已有工单。

数据库和备份包含 deployment credentials，必须使用私有权限。

## Agent 工具准备

```bash
infra/pi-tools.sh prepare
infra/pi-tools.sh status
```

`prepare` 只做两件事：

1. 在宿主 Node global prefix 安装 `playwright-core@1.62.1`。
2. 准备 `mcr.microsoft.com/playwright:v1.62.1-noble` 浏览器镜像。

Node 和 Maven project wrapper 均直接使用宿主命令，不拉取工具镜像。Playwright capability 调用时才启动带 `--rm` 的临时浏览器容器；不会保留长驻 pi-tool 容器。

卸载全局 Playwright core：

```bash
infra/pi-tools.sh clean
```

## SLS CLI

Issue Pilot 使用 Aliyun CLI 3.4.11 内置的 `Sls 2020-12-30 GetLogs`，不需要 `aliyun-cli-sls` plugin。可验证：

```bash
aliyun plugin list
aliyun sls GetLogs help
```

调用时 `infra/aliyun-profile.sh` 设置 `ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP=true`，确保使用内置产品 API。deployment AccessKey 写入临时 `0600` profile，调用结束立即删除。

## code-server 部署

### 固定约定

`infra/code-server.sh` 不接受项目环境变量覆盖。固定值如下：

| 项目 | 固定值 |
| --- | --- |
| 容器名 | `code-server` |
| 镜像 | `ghcr.io/coder/code-server:4.131.0-39` |
| 地址 | `127.0.0.1:18080` -> container `8080` |
| workspace | `<repo>/.issue-pilot/workspaces` |
| bare repository cache | `<repo>/.issue-pilot/repositories` |
| code-server data/plugins | `<repo>/.issue-pilot/code-server/data` |
| password | `<repo>/.issue-pilot/code-server/password` |

脚本不构建自定义镜像。首次缺少官方镜像时只执行 `podman pull`；容器以 `/home/coder/state/workspaces` 为 workdir，直接使用镜像自带 entrypoint 和 bind address。

### 宿主运行时挂载

| 宿主路径 | 容器路径 | 模式 | 用途 |
| --- | --- | --- | --- |
| `/usr/local/node` | `/opt/host/node` | read-only | Node、npm、corepack、Pi |
| `/usr/local/java` | `/opt/host/java` | read-only | 当前 Java 25 |
| `/usr/local/maven` | `/opt/host/maven` | read-only | Maven 3.9.16 |
| `/usr/bin/git` | `/opt/host/git/bin/git` | read-only | Git 2.55.0 |
| `/usr/libexec/git-core` | `/opt/host/git/libexec/git-core` | read-only | Git 子命令 |
| `/usr/share/git-core` | `/opt/host/git/share/git-core` | read-only | Git templates |
| `/lib64/libpcre2-8.so.0` | `/opt/host/git/lib/libpcre2-8.so.0` | read-only | Git runtime library |
| `/lib64/libz.so.1` | `/opt/host/git/lib/libz.so.1` | read-only | Git runtime library |

Git 必须与宿主保持同一版本，因为 worktree 使用 Git 2.55.0 的 `relativeWorktrees` repository extension。只挂 binary 不够，必须同时挂 exec path、templates 和动态库。

### 宿主配置和缓存挂载

| 宿主路径 | 容器路径 | 模式 |
| --- | --- | --- |
| `~/.m2` | `/home/coder/.m2` | read-write |
| `~/.npm` | `/home/coder/.npm` | read-write |
| `~/.npmrc` | `/home/coder/.npmrc` | read-only |
| `~/.pi/agent` | `/home/coder/.pi/agent` | read-write |

因此 code-server Maven 直接复用本机 `settings.xml` 和已下载的 `~/.m2/repository`；npm 和 Pi 也使用本机状态。code-server 内运行的进程能访问这些凭据，只应在可信本机使用。

### Java 版本

当前脚本和 editor settings 指向 `/usr/local/java`，并登记为 `JavaSE-25`。后续把宿主 Linux Java 替换为 Java 8 时：

1. 保持路径 `/usr/local/java` 不变。
2. 把脚本中 `JavaSE-25` 改为 `JavaSE-1.8`。
3. 删除并重建容器以刷新 bind mount：

```bash
podman rm --force code-server
infra/code-server.sh ensure
```

这不是镜像 rebuild；仍使用同一个官方 code-server 镜像。

### 插件

插件安装在宿主目录：

```text
.issue-pilot/code-server/data/extensions
```

在 code-server Extensions 页面安装或卸载即可，容器重建不会丢失，也不需要修改镜像。不要直接挂 Windows 的 `win32-x64` extension 目录到 Linux code-server；Java 等平台扩展应在 code-server 内安装 Linux 版本。

### 操作

```bash
infra/code-server.sh ensure
infra/code-server.sh status
infra/code-server.sh stop
```

`ensure` 会校验所有固定宿主路径、更新 editor settings、创建私有密码，并按 runtime label 决定启动或重建容器。容器使用 `userns=keep-id`、`no-new-privileges` 和 `cap-drop ALL`。

## 健康检查

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/config
```

第二个响应包含真实 secrets，只在可信终端执行。还应检查服务/deployment 数量、model/thinking 配置、Agent SSE replay 和 code-server folder URL。

## 测试和构建

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

## 网络暴露

API 没有内置认证并固定监听 `127.0.0.1`。如需外部访问，只能通过带认证和 TLS 的本机代理转发。必须限制 `/api/config`、附件下载和 code-server workspace 访问，不记录 deployment config、Authorization 或完整 secret 请求体。

## 故障处理

Agent 失败后工单回到 `open`，workspace 标记为 `failed`，Pi SDK session 被 abort/dispose；JSONL 和 worktree 保留以便 retry。API 异常退出后，数据库 bootstrap 会修复 `preparing`/`running` 状态。
