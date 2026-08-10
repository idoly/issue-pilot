# 运维说明

## 部署模式

Issue Pilot 默认是可信单机应用。推荐拓扑：

```text
browser
  -> same-host TLS/auth reverse proxy
       +-- /             static src/web/dist
       +-- /api/*        127.0.0.1:3000 (Fastify + SSE)
       +-- /code/*       127.0.0.1:18080 (optional code-server)

Fastify -> SQLite / Pi SDK / Git / native capabilities
Podman  -> shared code-server + ephemeral Playwright Chromium only
```

API 没有内置 authentication，且 `/api/config` 返回真实 secret。即使有 reverse proxy，也必须保持 API 和 code-server 只监听 loopback，并在 proxy 层实施 identity、authorization、TLS、request size 和 audit policy。

## 固定 runtime

| component | fixed value |
| --- | --- |
| Node/Pi | `/usr/local/node`，Pi 0.84.1 |
| Java | `/usr/local/java` |
| Maven | `/usr/local/maven` |
| Git | `/usr/bin/git` + `/usr/libexec/git-core` + `/usr/share/git-core` |
| Aliyun CLI | `/usr/local/sbin/aliyun` |
| Playwright core | `/usr/local/node/lib/node_modules/playwright-core@1.62.1` |
| Browser image | `mcr.microsoft.com/playwright:v1.62.1-noble` |
| code-server image | `ghcr.io/coder/code-server:4.131.0-39` |

Capability runtime 路径、browser image 和版本不接受环境变量覆盖。这样部署检查、policy 行为和测试使用同一套已知 runtime。

验证宿主：

```bash
/usr/local/node/bin/node --version
/usr/local/node/bin/pi --version
/usr/local/java/bin/java -version
/usr/local/maven/bin/mvn --version
/usr/bin/git --version
/usr/local/sbin/aliyun version
podman version
```

还必须存在：

```text
~/.pi/agent/auth.json
~/.pi/agent/models.json
~/.pi/agent/models-store.json
~/.pi/agent/settings.json
~/.m2/settings.xml
~/.m2/repository
~/.npmrc
~/.npm
```

## API process

| variable | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port；host 始终为 `127.0.0.1` |
| `ISSUE_PILOT_STATE_ROOT` | `.issue-pilot` | database/workspace/session root |
| `ISSUE_PILOT_DATABASE` | `<state-root>/issues.db` | SQLite file |
| `ISSUE_PILOT_SUBJECT` | local default subject | 当前未认证操作人 |
| `ISSUE_PILOT_WORKSPACE_RETENTION_HOURS` | `168` | resolved workspace 保留小时数；`off` 关闭按时间清理，`0` 表示立即可清理 |
| `ISSUE_PILOT_WORKSPACE_HIGH_WATER_BYTES` | `21474836480` | workspace 总量高水位；`0` 关闭配额清理 |
| `ISSUE_PILOT_WORKSPACE_TARGET_BYTES` | high-water 的 `80%` | 超过高水位后释放到此目标；必须小于 high-water |
| `ISSUE_PILOT_WORKSPACE_MAINTENANCE_MINUTES` | `15` | 周期维护间隔；`0` 关闭定时执行，启动维护仍会运行 |
| `NODE_ENV` | unset | `test` 时关闭默认 Fastify logger |

这些变量只配置 API process/state，不配置 model、credential、connection 或 capability authorization。Deployment 授权只能来自 SQLite 中的页面配置。

API 收到 `SIGINT`/`SIGTERM` 时只关闭一次 Fastify、Agent session 和 database。下次启动会把中断的 workspace 标记为 failed，并恢复 issue 状态。

## Workspace 存储维护

`workspaces/<issue-key>` 只用于开发工单，是包含 Git worktree、Issue 本地依赖和构建输出的可重建 cache；workspace 根目录不保存 Issue Pilot 元数据。每个工单的持久数据集中在 `issues/<issue-key>`：唯一的 `0400` 附件原件位于 `attachments/`，Pi JSONL 和私有 sidecar 位于 `agent/`。拥有 workspace、会启用 bash 的开发工单在 `runtime/bin/` 获得自己的 `node-project` 和 `maven-project`；已释放的 dev 工单不在冷启动时生成 runtime。`issues/<issue-key>/workspace` 是指向可释放 workspace 的受管相对链接，仅用于从工单目录统一导航，释放 workspace 时同步删除。数据库备份集中在 `backups/`。

prod/test 不创建 Issue workspace 或分支。每次执行先 fetch deployment `baseBranch`，代码按 commit 复用在 `git/checkouts/`；`issues/<issue-key>/runtime` 只有当前工单的 repository links。API 冷启动会重建可生成 runtime，并为已有只读 session 恢复最新快照和 code-server 入口。prod/test 数据中出现非空 `issue_repositories.local_path` 或 `working_branch` 属于不合法状态，不会自动修复或删除。

手动和自动释放只处理开发 workspace，并使用相同预检：Issue 必须空闲，所有 Git worktree 必须没有 modified/untracked 文件，Issue 根目录也不能有未知文件。任一仓库不满足时拒绝整个预检，不更新数据库；已经部分完成的基础设施错误可通过重复调用恢复。成功后清空 `issue_repositories.local_path`，workspace 变为 `stopped`，但保留 branch、base commit、session binding、JSONL 和附件。

```bash
# dry-run：容量、每个 Issue 的 releasable 状态和拒绝原因
curl -fsS http://127.0.0.1:3000/api/workspaces/stats

# 手动释放一个空闲、干净的 workspace
curl -fsS -X DELETE http://127.0.0.1:3000/api/issues/ISSUE-20260807-002/workspace
```

API 启动时执行一次维护，之后按 interval 周期执行。保留期只处理已解决 Issue；超过 high-water 后也只处理已解决 Issue，并按 workspace 最近活动时间从旧到新释放，直到 target。dirty、运行中或布局异常的 workspace 会跳过并保留。Web 不提供手动释放按钮；`DELETE /api/issues/:key/workspace` 只保留给运维排障，日常回收由框架维护任务负责。

## 首次部署

在固定 release directory 中执行：

```bash
npm ci
infra/playwright.sh prepare
infra/playwright.sh status
npm run typecheck
npm test
npm run build
npm run db:migrate
infra/code-server.sh ensure
```

首次启动 API 后：

1. 打开配置页面。
2. 确认 `prod`、`test`、`dev` 三个 environment 存在。
3. 创建 service 和 repository。
4. 为需要的每个 environment（包括 dev）配置 base branch、model、thinking level 和 capability。
5. 用 `/api/config` 或页面复核 deployment，但不要记录 response。
6. 创建一个只读测试 issue，验证 model、SSE replay、共享 checkout、issue runtime code-server，并确认没有 Issue workspace。

项目不提供业务 seed。环境由 database bootstrap 创建，用户由当前 subject 创建，service/deployment 必须由部署者明确配置。

## 本机开发

```bash
npm run server
npm run dev:web
infra/code-server.sh ensure
```

| component | address |
| --- | --- |
| Fastify API | `http://127.0.0.1:3000` |
| Vite Web | `http://127.0.0.1:4173` |
| code-server | `http://127.0.0.1:18080` |

`src/web/vite.config.ts` 已固定 Vite host 和 API proxy，不需要额外 `--host`。Vite 只用于开发。

## 生产部署

### API systemd 示例

下面示例使用专用低权限账号。把路径替换成实际 release directory；该账号必须拥有 `.issue-pilot`、Git cache、Pi config 和所需 package cache。

```ini
[Unit]
Description=Issue Pilot API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=issue-pilot
Group=issue-pilot
WorkingDirectory=/opt/issue-pilot/current
Environment=PATH=/usr/local/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
Environment=NODE_ENV=production
ExecStart=/usr/local/node/bin/node --experimental-strip-types src/http/api.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

安装和检查：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now issue-pilot-api
sudo systemctl status issue-pilot-api
journalctl -u issue-pilot-api -f
```

不要在 unit 中放 model API key、database password 或 capability credential。它们属于 Pi credential store 或 deployment config。

### Static Web

生产 Web 由 `npm run build` 生成到 `src/web/dist`。静态服务器应与 `/api` 使用同一 origin，避免额外 CORS surface。

Nginx location 核心配置：

```nginx
root /opt/issue-pilot/current/src/web/dist;

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
```

必须在这些 location 外层增加组织实际使用的 authentication/TLS policy。Agent stream 是长连接 SSE；不能启用 response buffering、compression cache 或短 read timeout。Proxy request body limit 至少覆盖应用的 attachment limit，同时不应无限放大。

### code-server proxy

code-server 使用 WebSocket。外部开放时应使用独立、受保护的 path/origin，并转发 upgrade headers：

```nginx
location /code/ {
    proxy_pass http://127.0.0.1:18080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
}
```

code-server 使用 `--auth none`，自身没有身份认证。不要把 `18080` 直接发布到 LAN；通过 `4173/code-server` 访问时，任何能访问 Web 入口的客户端都拥有编辑器和终端权限。

## Playwright runtime

```bash
infra/playwright.sh prepare
infra/playwright.sh status
infra/playwright.sh clean
```

`prepare` 只安装固定 global `playwright-core@1.62.1` 并拉取固定 Noble browser image。它不准备 Node/Maven container，不创建 persistent browser container。

每次 Playwright capability 调用：

1. 创建 private input/secret directory。
2. 写入 request 和 credential `0600` file。
3. 以 `--rm`、`no-new-privileges`、`cap-drop ALL`、`pids-limit`、memory limit 启动 browser。
4. 只允许 deployment base origin 的 HTTP/WebSocket。
5. 返回结构化 snapshot 和可选 screenshot。
6. 删除 temporary directory。

`status` 还会拒绝带 `io.issue-pilot.component=pi-tool` label 的意外 persistent tool container。

## SLS CLI

Issue Pilot 使用 `/usr/local/sbin/aliyun` 的内置 `Sls 2020-12-30 GetLogs`，不需要 `aliyun-cli-sls` plugin：

```bash
/usr/local/sbin/aliyun version
/usr/local/sbin/aliyun sls GetLogs help
```

调用时 command executor 为单次调用设置 private HOME 和 `ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP=true`。Deployment AccessKey 写入该 HOME 下的 `0600` profile，调用结束立即删除。CLI path 固定，且启动前拒绝 group/world writable binary。

## code-server 部署

### 固定约定

| item | fixed value |
| --- | --- |
| container name | `code-server` |
| image | `ghcr.io/coder/code-server:4.131.0-39` |
| address | `127.0.0.1:18080` -> container `8080` |
| development workspace | `<repo>/.issue-pilot/workspaces` |
| issue data/runtime | `<repo>/.issue-pilot/issues` |
| shared checkout | `<repo>/.issue-pilot/git/checkouts` |
| repository cache | `<repo>/.issue-pilot/git/repositories` |
| data/extensions | `<repo>/.issue-pilot/code-server/data` |
| authentication | disabled with `--auth none` |
| container env file | `<repo>/.issue-pilot/code-server/container.env` |

脚本不构建 custom image。`ensure` 校验固定 host runtime、更新 editor settings、创建 private runtime env file，并按 runtime label 启动或重建容器。`status` 只输出 state、image 和 runtime label，不输出完整 inspect。

### State mounts

| host | container | mode |
| --- | --- | --- |
| `.issue-pilot/workspaces` | `/home/coder/state/workspaces` | read-write |
| `.issue-pilot/git/repositories` | `/home/coder/state/git/repositories` | read-write |
| `.issue-pilot/issues` | `/home/coder/state/issues` | read-only |
| `.issue-pilot/git/checkouts` | `/home/coder/state/git/checkouts` | read-only |

prod/test runtime 使用相对链接指向只读 checkout，因此宿主 Agent 与容器内 code-server 看到相同 repository 目录；开发 workspace 保持可写。

### Host runtime mounts

| host | container | mode |
| --- | --- | --- |
| `/usr/local/node` | `/opt/host/node` | read-only |
| `/usr/local/java` | `/opt/host/java` | read-only |
| `/usr/local/maven` | `/opt/host/maven` | read-only |
| `/usr/bin/git` | `/opt/host/git/bin/git` | read-only |
| `/usr/libexec/git-core` | `/opt/host/git/libexec/git-core` | read-only |
| `/usr/share/git-core` | `/opt/host/git/share/git-core` | read-only |
| `/lib64/libpcre2-8.so.0` | `/opt/host/git/lib/libpcre2-8.so.0` | read-only |
| `/lib64/libz.so.1` | `/opt/host/git/lib/libz.so.1` | read-only |

Git 必须与 host 保持同一版本。只挂 binary 不足以支持 relative worktree extension，所以 exec path、templates 和 dynamic libraries 也固定挂载。

### Host config/cache mounts

| host | container | mode |
| --- | --- | --- |
| `~/.m2` | `/home/coder/.m2` | read-write |
| `~/.npm` | `/home/coder/.npm` | read-write |
| `~/.npmrc` | `/home/coder/.npmrc` | read-only |
| `~/.pi/agent` | `/home/coder/.pi/agent` | read-write |

这些目录可能包含 credential，只能由可信本机 operator 使用。`~/.pi/agent/bin` 也直接提供本机 `rg` 和 `fd`；code-server PATH 不维护第二份工具副本。Editor 不强制 npm/yarn；project wrapper 根据 repository `packageManager` 和 lockfile 选择。

### 操作

```bash
infra/code-server.sh ensure
infra/code-server.sh status
infra/code-server.sh stop
```

`ensure` 使用 `userns=keep-id`、`no-new-privileges`、`cap-drop ALL`。Container rebuild 不删除 data/extensions。Java host runtime 变更后保持 `/usr/local/java` 路径不变，并同步脚本中的 editor runtime name 后执行：

```bash
podman rm --force code-server
infra/code-server.sh ensure
```

## Database backup

API 启动时自动 migration，也可以显式执行：

```bash
npm run db:migrate
```

破坏性 migration 前必须获得一致 backup：

1. 停止 API，等待 process 完全退出。
2. 确认 `.issue-pilot/issues.db-wal` 已 checkpoint/消失；若仍存在，连同 `-wal`、`-shm` 一起保存。
3. 复制 database，并保持 `0600`。
4. 执行 migration。
5. 启动 API，检查 migration journal、row counts 和 `PRAGMA foreign_key_check`。

```bash
systemctl stop issue-pilot-api
install -d -m 0700 .issue-pilot/backups
cp --preserve=mode .issue-pilot/issues.db \
  ".issue-pilot/backups/issues.db.before-$(date +%Y%m%d%H%M%S)"
npm run db:migrate
systemctl start issue-pilot-api
```

Database 和 backup 含真实 deployment credential。不要上传到 artifact store，除非目标支持组织要求的 encryption、retention 和 access audit。

### Restore

1. 停止 API。
2. 另存当前损坏 database 供调查。
3. 恢复一组一致的 database/WAL/SHM；只有确认 backup 已 checkpoint 时才删除残留 WAL/SHM。
4. 保持 owner 和 `0600`。
5. 启动与 backup schema 兼容的代码。
6. 检查 foreign keys、service/deployment、issue、session binding。

## Upgrade 和 rollback

推荐升级顺序：

```bash
git fetch --all --prune
git checkout <reviewed-commit>
npm ci
infra/playwright.sh prepare
npm run typecheck
npm test
npm run build
systemctl stop issue-pilot-api
# create database backup here
npm run db:migrate
systemctl start issue-pilot-api
infra/code-server.sh ensure
```

验证通过前保留旧 release directory 和 database backup。Rollback code 前先判断新 migration 是否向后兼容；不能让旧 schema code 直接读取已发生 destructive migration 的 database。最可靠 rollback 是旧 release + 升级前一致 backup 成对恢复。

## Health and acceptance

基础检查：

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
infra/playwright.sh status
infra/code-server.sh status
ss -ltnp | grep -E ':3000|:18080'
```

`/api/config` 包含 secret，只在可信终端临时检查。部署验收还应覆盖：

- service/deployment/repository count
- provider/model/thinking readiness
- prod/test issue 不出现 mutation tools 或 Issue workspace
- prod/test shared checkout 对应 deployment 最新 commit，code-server folder 指向 issue runtime
- dev issue 从 dev deployment 配置分支创建 worktree branch，并获得正确 tool allowlist
- SSE replay 后 live event 不丢失
- compaction 后 active context 正确
- code-server folder URL 与 issue workspace 一致
- capability oversize 明确失败
- database `foreign_key_check` 为 0

## Logs and incident handling

禁止记录：

- `/api/config` response/body
- Authorization/Cookie
- deployment password/AccessKey
- Playwright credential file
- code-server `container.env`
- 完整包含敏感业务数据的 capability result

Agent 失败后 issue 回到 `open`，运行状态标记为 `failed`，Pi session abort/dispose；JSONL、共享 Git cache 和已有开发 worktree 保留用于 retry。排障顺序：

1. 查看 workspace `last_error` 和 API structured log。
2. 检查 model catalog/credential readiness。
3. 检查 deployment scope 是否改变。
4. 检查 Git remote/base branch 和 dirty workspace。
5. 检查 fixed runtime version/path。
6. 在缩小 scope 后单独重试 capability。

不要通过放宽 policy、提高无限结果上限或把 credential 放入 prompt 来绕过故障。
