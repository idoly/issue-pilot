# 部署说明

本文面向首次安装和生产部署维护者，说明当前代码需要的宿主工具、进程、Podman runtime、反向代理、安全边界和验收步骤。状态原理见 [架构说明](ARCHITECTURE.md)，业务字段见 [配置说明](CONFIGURATION.md)，上线后的操作见 [运维手册](RUNBOOK.md)。

## 部署模型

Issue Pilot 是可信单机应用，不是多租户服务：

- Fastify API、SQLite、Pi SDK、Git 和 capability client 在同一宿主账号下运行。
- SolidJS Web 构建为静态资源，开发时由 Vite 提供。
- 一个共享 code-server Podman 容器打开不同 Issue runtime。
- Playwright 每次调用启动一个 `--rm` 临时容器。
- DMS/SLS 调用宿主 Aliyun CLI。
- API 没有内置 authentication/authorization。
- code-server 使用 `--auth none` 并提供终端。

推荐生产拓扑：

```text
Browser
   |
TLS + Authentication/Authorization Proxy
   |-- /             -> static Web
   |-- /api          -> 127.0.0.1:3000
   +-- /code-server  -> 127.0.0.1:18080
                            |
                 Fastify / Pi / SQLite / Git / Podman
```

API 和 code-server 只能监听 loopback。所有外部访问必须经过同机可信代理。

## 固定宿主工具

当前 infra 脚本要求以下路径：

| Component | 路径或版本 |
| --- | --- |
| Node.js | `/usr/local/node`，24+ |
| Node binary | `/usr/local/node/bin/node` |
| npm/corepack/Pi | `/usr/local/node/bin/{npm,corepack,pi}` |
| Pi package/model runtime | 项目依赖与 `~/.pi/agent` 配置 |
| Java | `/usr/local/java` |
| Maven | `/usr/local/maven` |
| Git | `/usr/bin/git` |
| Git exec path | `/usr/libexec/git-core` |
| Git templates | `/usr/share/git-core` |
| Git libraries | `/lib64/libpcre2-8.so.0`, `/lib64/libz.so.1` |
| Podman | `podman` in PATH |
| Aliyun CLI | `/usr/local/sbin/aliyun`，只在启用 DMS/SLS 时需要 |
| Playwright core | `1.62.1` |
| Playwright image | `mcr.microsoft.com/playwright:v1.62.1-noble` |
| code-server image | `ghcr.io/coder/code-server:4.131.0-39` |

code-server 脚本还要求运行账号拥有：

```text
~/.pi/agent/auth.json
~/.pi/agent/models.json
~/.pi/agent/models-store.json
~/.pi/agent/settings.json
~/.pi/agent/bin/rg
~/.pi/agent/bin/fd
~/.m2/settings.xml
~/.m2/repository
~/.npmrc
~/.npm
```

快速检查：

```bash
/usr/local/node/bin/node --version
/usr/local/node/bin/pi --version
/usr/local/java/bin/java -version
/usr/local/maven/bin/mvn --version
/usr/bin/git --version
podman version
/usr/local/sbin/aliyun version
```

不要用环境变量、临时 PATH 或不同容器镜像绕过缺失的固定工具；API、wrapper、测试和 code-server 必须使用一致工具链。

## 安装与构建

在固定项目目录中执行：

```bash
npm ci
infra/playwright.sh prepare
npm run typecheck
npm test
npm run build
```

准备状态：

```bash
infra/playwright.sh status
```

预期同时看到正确 `playwright-core` 和 image ready，并且没有带 `io.issue-pilot.component=pi-tool` label 的持久运行容器。

## 应用配置与 state root

所有运行配置都在根目录 `issue-pilot.config.ts`。应用不读取环境变量覆盖它。`src/config.ts` 根据项目根解析：

```text
stateRoot = <project-root>/<state.directory>
databaseFile = <stateRoot>/<state.databaseFile>
```

默认：

```text
stateRoot = <project-root>/.issue-pilot
databaseFile = <project-root>/.issue-pilot/issues.db
```

`infra/config-value.mjs` 只读取根配置标量，Shell 中没有第二套默认值。API、migration、Git、runtime 和 code-server 必须使用同一个 state root。

生产项目目录必须持久存在。升级时不能切换到一个不包含原 state root 的新 WorkingDirectory，也不能在 API 运行期间移动项目、数据库或 `.issue-pilot`。

完整字段见 [配置说明](CONFIGURATION.md#根配置)。

## 数据库初始化

显式执行 migration：

```bash
npm run db:migrate
```

API 启动时也会执行同一组 Drizzle migration。数据库文件创建为 `0600`，启用 WAL 和配置的 busy timeout；migration 后启用 foreign keys。

生产升级前仍必须停止 API 并创建一致备份。不要把“API 会自动 migrate”当作跳过备份和 dry-run 的理由。

## 本机启动

启动 API：

```bash
npm run server
```

另一个终端启动 Vite：

```bash
npm run dev:web
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Web | `http://127.0.0.1:4173` |
| API | `http://127.0.0.1:3000` |
| code-server | `http://127.0.0.1:18080` |

Vite 根据根配置监听 `0.0.0.0:4173`，并代理 `/api` 和 `/code-server`。这只适用于受信任开发网络。Vite 入口本身能访问真实 Issue 数据和无认证 code-server，不能直接暴露到不可信 LAN 或 Internet。

## API 启动行为

每次 API 启动会：

1. 打开数据库、执行 migration、恢复中断 Agent 状态并同步 Environment。
2. 验证 state root 中没有 unmanaged Issue/workspace 目录。
3. 验证 shared checkout ownership、HEAD 和 cleanliness，再受管移除可重建 checkout。
4. 删除受管 Issue runtime 和中断的 `.runtime-*` 生成目录。
5. 重建 active/released dev runtime。
6. 为已有 session 的 prod/test Issue fetch 当前 Deployment commit并重建 runtime。
7. 执行一次 workspace maintenance。
8. 注册 route，并启动定时 maintenance。

任一 durable-state 不变量失败会停止启动并保留现场。详细错误处理见 [运维手册](RUNBOOK.md)。

## 生产 API 服务

推荐使用独立低权限账号和固定 WorkingDirectory。示例 systemd unit：

```ini
[Unit]
Description=Issue Pilot API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=issue-pilot
Group=issue-pilot
WorkingDirectory=/opt/issue-pilot
Environment=PATH=/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/usr/local/node/bin/node --experimental-strip-types src/http/api.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

运行账号需要：

- 读写项目 `.issue-pilot`。
- 访问 Repository 所需 Git credential。
- 读取 Pi model/auth 配置。
- 读写需要复用的 npm/Maven cache。
- 调用 Podman。
- 启用 DMS/SLS 时执行固定 Aliyun CLI。

不要把 model key、Deployment password 或 AccessKey 写入 unit environment。Model credential 属于 Pi 配置；capability credential 属于 SQLite Deployment config。

安装 unit 后：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now issue-pilot-api
sudo systemctl status issue-pilot-api
journalctl -u issue-pilot-api -f
```

`SIGINT`/`SIGTERM` 会触发 graceful shutdown：停止 maintenance、等待 lifecycle/inspection 队列和 Agent reservation、停止 Pi session、关闭 SQLite。`TimeoutStopSec` 应覆盖长 Git/code-server 操作。

## Production Web 与反向代理

`npm run build` 输出：

```text
src/web/dist
```

Web、API 和 code-server 应使用同一个受保护 origin。Nginx 核心示例：

```nginx
root /opt/issue-pilot/src/web/dist;

location / {
    try_files $uri $uri/ /index.html;
}

location /api/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
}

location /code-server/ {
    proxy_pass http://127.0.0.1:18080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

必须在这些 location 外层加入组织实际使用的 authentication、authorization、TLS 和审计策略。

Agent stream 使用 SSE：

- `/api` 不能 response buffer。
- 不能使用短 read timeout。
- 代理应保留 `Cache-Control: no-cache, no-transform` 和 `X-Accel-Buffering: no` 语义。

code-server 使用 WebSocket，必须传递 Upgrade headers。

## code-server

### 管理命令

```bash
infra/code-server.sh ensure
infra/code-server.sh status
infra/code-server.sh stop
```

API 每次准备 Issue runtime 都会调用 `ensure <absolute-state-root>`。手工 `ensure` 默认从根配置解析 state root。

脚本会：

- 验证固定宿主 runtime 和用户配置。
- 创建 code-server data、settings 和私有 `container.env`。
- 拉取配置 image。
- 按 runtime version label 复用或替换 `code-server` 容器。
- 使用 `--auth none`、`--cap-drop ALL`、`no-new-privileges` 和 `userns=keep-id`。

### Mounts

| Host | Container | Mode |
| --- | --- | --- |
| `<state>/workspaces` | `/home/coder/state/workspaces` | read-write |
| `<state>/git/repositories` | `/home/coder/state/git/repositories` | read-write |
| `<state>/issues` | `/home/coder/state/issues` | read-only |
| `<state>/git/checkouts` | `/home/coder/state/git/checkouts` | read-only |
| `<state>/code-server/data` | `/home/coder/.local/share/code-server` | read-write |
| `/usr/local/node` | `/opt/host/node` | read-only |
| `/usr/local/java` | `/opt/host/java` | read-only |
| `/usr/local/maven` | `/opt/host/maven` | read-only |
| `~/.m2` | `/home/coder/.m2` | read-write |
| `~/.npm` | `/home/coder/.npm` | read-write |
| `~/.npmrc` | `/home/coder/.npmrc` | read-only |
| `~/.pi/agent` | `/home/coder/.pi/agent` | read-write mount |
| Host Git binary/exec/templates/libs | `/opt/host/git/*` | read-only |

Bare repository 必须 read-write，因为 Git worktree index 和 metadata 存在那里。Issue data 和 immutable checkout 在容器中保持 read-only。Dev runtime link最终指向 read-write worktree。

每个 Issue 通过 multi-root manifest 打开，URL 形如：

```text
/code-server/?workspace=/home/coder/state/issues/<key>/runtime/<key>.code-workspace
```

### Editor settings

脚本管理以下关键设置：

- Disable workspace trust prompt。
- Disable built-in chat AI feature according to root config。
- Use host-mounted Git。
- Auto-detect repositories in multi-root subfolders。
- Use fixed Java/Maven runtime和 Maven settings。

不要通过复制 `.git` 或给每张 Issue 启动独立 code-server 容器解决 Git discovery。

## Playwright runtime

管理命令：

```bash
infra/playwright.sh prepare
infra/playwright.sh status
infra/playwright.sh clean
```

`prepare` 确保全局 `playwright-core` 版本和 browser image与根配置一致。它不会安装持久 browser daemon。

每次 capability 调用：

1. 创建私有临时 request 和 secret directory。
2. 写入 `0600` request/credential files。
3. 启动 `podman run --rm`，使用 host network、drop all capabilities、no-new-privileges、PID/memory limit 和 keep-id。
4. Runner 限制 navigation/request/WebSocket到 frozen Deployment origin。
5. 返回 bounded 文本和可选 PNG。
6. 删除临时目录。

`infra/playwright.sh status` 如果发现持久 pi-tool container 会返回失败。

## Aliyun CLI runtime

DMS 和 SLS 使用根配置的 `/usr/local/sbin/aliyun`。运行时不会读取或修改 operator 的 `~/.aliyun`。

每次调用：

1. 验证 CLI 是普通文件且 group/world 不可写。
2. 创建临时 HOME。
3. 写入 `0600 ~/.aliyun/config.json`。
4. 用该 HOME 执行 CLI。
5. 在 finally 中删除整个临时 HOME。

DMS 使用 `dms-enterprise ExecuteScript`、固定 central endpoint 和 `--secure`。SLS 使用 regional log endpoint。Credential 不进入 argv，但 DMS SQL 和 SLS query 会短暂出现在宿主进程参数中。详细权限和字段见 [配置说明](CONFIGURATION.md#dms)。

## 安全边界

### Authentication 与网络

- Issue Pilot API 没有内置认证。
- `X-Issue-Pilot-Subject` 和页面用户切换不是认证。
- code-server `--auth none` 并提供终端。
- API 与 code-server必须监听 `127.0.0.1`。
- 外部入口必须由可信代理执行 authentication、authorization 和 TLS。
- `/api/config` 应单独限制和审计，因为它返回真实 Deployment credential。
- 不要直接暴露 Vite dev server 到不受信任网络。

### 宿主权限

Pi built-in tools 和 code-server terminal 不是 OS sandbox。API/Pi/code-server 必须使用专用低权限账号，不能以 root 运行。该账号能访问的文件、网络和 credential都可能被项目命令或终端访问。

当前容器限制降低了容器权限，但 Agent 的 Pi session仍在宿主 API 进程中运行；不要把 Podman Playwright/code-server 边界误认为 Agent host sandbox。

### Secret 与敏感数据

Deployment credential存储在 SQLite。`GET /api/config` 返回真实值以支持页面回写。禁止记录：

- Config request/response body。
- Authorization、Cookie 或代理 identity token。
- Deployment password、AccessKey 或临时 profile。
- Playwright credential file。
- code-server `container.env`。
- 包含生产数据的完整 capability result。

SQLite、backup、Pi JSONL、Attachment、code-server data 和 API log 都按敏感数据管理。Capability 结果会进入模型上下文和 Pi JSONL。

## 首次业务配置

服务启动后在 Web 中：

1. 创建 Service。
2. 添加至少一个 Repository，并设置唯一 alias。
3. 为需要的 Environment 创建 Deployment。
4. 为每个 Repository 设置 `baseBranch`。
5. 选择当前可用的 Pi provider/model/thinking level。
6. 只启用确实需要的 capability，并使用最小权限 credential。

字段和权限见 [配置说明](CONFIGURATION.md)。系统不提供业务 seed。

建议先创建 test `smart_analysis` Issue验证只读路径，再创建 dev Issue 验证独立 worktree。

## 首次验收

### 服务检查

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
curl -fsS http://127.0.0.1:3000/api/users
curl -fsS http://127.0.0.1:3000/api/workspaces/stats
infra/playwright.sh status
infra/code-server.sh status
ss -ltnp | rg ':3000|:18080'
```

预期：

- `/health` 返回 `{"ok":true}`。
- API/code-server 只监听 loopback。
- Playwright tool/image ready且无持久 tool container。
- code-server image/runtime label与根配置一致。

### Web 与业务检查

- 四名配置用户可加载和切换，未知 subject 被拒绝。
- Service/Repository/Deployment round-trip正确。
- `/api/config` 响应带 `private, no-store`，且代理/日志不记录 body。
- Prod/test policy只含 read tools，`workspaces/<key>` 不存在。
- Dev 创建 `hotfix-*` 或 `feature-*` 本地 branch和独立 worktree。
- Agent stream先 replay，再收到 `snapshot_ready`，刷新后仍可恢复。
- code-server URL使用 multi-root `workspace=`，全部 Repository可见 Git history。
- Attachment 可读取，mode、size和 SHA-256正确；不存在独立写 route。

### 全量 Repository 验收

对已有全部 Issue，而不是只抽查一张：

- 读取 `/api/issues/<key>` 并确认 runtime URL。
- 解析 `.code-workspace`，验证 folder link均存在。
- 使用 `GIT_OPTIONAL_LOCKS=0` 只读检查 HEAD、branch、`status --porcelain` 和最近 log。
- Prod/test 为 detached checkout且 HEAD等于当前 Deployment fetched commit。
- Active dev worktree HEAD等于本地 working branch ref。
- Released dev runtime HEAD等于本地 working branch tip。

Released dev历史 Repository集合与当前 Service不同可以合法存在；不要只按数量批量补行或改写 base branch。
