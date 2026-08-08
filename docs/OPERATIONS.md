# 运维说明

## 进程

开发环境通常运行三个进程：

| 组件 | 默认地址 | 启动方式 |
| --- | --- | --- |
| Fastify API | `http://127.0.0.1:3000` | `npm run server` |
| SolidJS/Vite | `http://127.0.0.1:4173` | `npm run dev:web -- --host 127.0.0.1` |
| code-server | `http://127.0.0.1:18080` | `infra/code-server.sh ensure` |

API 收到 `SIGINT` 或 `SIGTERM` 时只执行一次 Fastify close。长连接会随服务关闭，未完成的 Agent workspace 在下次 API 启动时标记为失败并恢复工单状态。

## 环境变量

### API 和状态

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API 监听地址 |
| `PORT` | `3000` | API 监听端口 |
| `ISSUE_PILOT_STATE_ROOT` | `.issue-pilot` | 数据库、workspace、session、工具和 code-server 状态根目录 |
| `ISSUE_PILOT_DATABASE` | `<state-root>/issues.db` | SQLite 文件 |
| `ISSUE_PILOT_SUBJECT` | 本地默认用户 | 未认证部署中的当前操作人 |
| `ISSUE_PILOT_INTERNAL_URL` | `http://127.0.0.1:3000` | Pi extension 回调 capability broker 的内部地址 |
| `NODE_ENV` | 未设置 | `test` 时关闭默认 Fastify logger |

### 能力

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PI_TOOL_CACHE_ROOT` | `<state-root>/tools` | Playwright 工具缓存 |
| `PI_PLAYWRIGHT_IMAGE` | `mcr.microsoft.com/playwright:v1.62.1-noble` | Playwright 临时容器镜像 |
| `PI_NACOS_IMAGE` | `docker.io/library/node:26.5.1-bookworm-slim` | Nacos 临时容器镜像 |
| `ISSUE_PILOT_ALIYUN_CLI` | `/usr/local/sbin/aliyun` | Aliyun CLI 路径 |
| `ISSUE_PILOT_ALIYUN_PLUGIN_DIR` | `~/.aliyun/plugins` | Aliyun CLI plugin 目录 |

`ISSUE_PILOT_RUNTIME_CONFIG` 由 AgentEngine 为 Pi RPC 子进程临时设置，包含 issue ID、能力列表、broker URL 和一次性 token。不要手工配置。

### code-server

常用变量：

- `ISSUE_PILOT_CODE_SERVER_URL`
- `ISSUE_PILOT_CODE_SERVER_SCRIPT`
- `ISSUE_PILOT_CODE_SERVER_IMAGE`
- `ISSUE_PILOT_CODE_SERVER_PORT`
- `ISSUE_PILOT_CODE_SERVER_PASSWORD_FILE`
- `ISSUE_PILOT_CODE_SERVER_DATA`
- `ISSUE_PILOT_CODE_SERVER_PI_DATA`
- `ISSUE_PILOT_CODE_SERVER_PI_CONFIG_ROOT`
- `ISSUE_PILOT_CODE_SERVER_NODE_RUNTIME`

脚本还允许覆盖 workspace、repository、Git binary、Git exec path 和所需动态库路径。完整名称以 `infra/code-server.sh` 为准。

## 数据库和迁移

手工迁移：

```bash
npm run db:migrate
```

API 启动时也会运行 migration。执行破坏性迁移前：

1. 停止 API，防止同时写入。
2. 复制 `.issue-pilot/issues.db` 及现有 `-wal`、`-shm` 文件，或在 SQLite checkpoint 后备份数据库。
3. 执行迁移。
4. 启动 API并检查 `/health`、`/api/config` 和已有工单。

数据库包含 deployment credentials，备份文件必须使用私有权限并按密钥材料管理。

## 容器准备

准备 Pi 工具：

```bash
infra/pi-tools.sh prepare
infra/pi-tools.sh status
```

该脚本拉取固定 Node、Maven 和 Playwright 镜像，并把 `playwright-core@1.62.1` 安装到状态目录。`status` 还会检查是否存在不应持续运行的 pi-tool 容器。

清理工具缓存：

```bash
infra/pi-tools.sh clean
```

Nacos 和 Playwright 容器按能力调用临时启动并使用 `--rm`。Redis、MySQL、Elasticsearch 和 RabbitMQ 不使用工具容器。

## code-server

启动或修复共享容器：

```bash
infra/code-server.sh ensure
```

查看状态或停止：

```bash
infra/code-server.sh status
infra/code-server.sh stop
```

密码默认保存在 `.issue-pilot/code-server/password`，权限为 `0600`。端口默认只发布到 `127.0.0.1:18080`。Pi 的认证和模型配置以只读方式挂载，code-server 的独立 Pi 数据保存在状态目录。

## 健康检查

```bash
curl -fsS http://127.0.0.1:3000/health
```

预期：

```json
{"ok":true}
```

配置检查会返回秘密，只在可信终端执行：

```bash
curl -fsS http://127.0.0.1:3000/api/config
```

建议同时检查：

- 服务和 deployment 数量符合预期。
- 每个 deployment 有 model 和 thinking level。
- 服务顺序保持创建顺序。
- 长 Agent 会话能够回放并继续接收 SSE。
- code-server URL 打开对应工单 folder。

## 测试和构建

提交前执行：

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

后端测试使用 Node test runner；Web 测试使用 Vitest/jsdom；构建产物写入 `src/web/dist`。

## 网络暴露

API 当前没有内置认证。即使 `HOST` 支持外部绑定，也不代表可以直接暴露：

1. 保持默认 loopback，或在前方部署认证代理。
2. 为 API、Web 和 code-server 使用 TLS。
3. 对 `/api/config` 和 attachment 下载实施严格授权。
4. 不记录 Authorization、broker token、deployment config 或完整请求体。
5. code-server 必须验证当前用户是否有权访问工单 workspace。

## 故障处理

Agent 失败后：

- 工单回到 `open`。
- workspace 状态标记为 `failed` 并保存 `lastError`。
- runtime token 被撤销，临时 runtime 文件被删除。
- Pi session JSONL 和已准备的 worktree 保留，便于 retry 继续上下文。

若 API 异常退出，重启时会修复处于 `preparing` 或 `running` 的 workspace。不要直接删除 session JSONL；它是对话历史事实源。删除工单时，状态清理会移除不再存在工单的 workspace 和 session，并 prune Git worktree 元数据。
