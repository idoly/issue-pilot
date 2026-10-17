# 部署说明

Issue Pilot 提供单节点、单副本 Kubernetes application 部署清单；当前本机环境以用户级 systemd 服务运行 API 和 Web。Kubernetes image 包含应用、Web、Workbench、Pi、Node/npm、Maven/JDK、Git、ripgrep 和官方 SLS Node SDK，运行时只挂载正式 state、Operator 原生配置和临时 cache。分析沙盒在两种运行方式下的前提见下文。

## 拓扑

```text
TLS/auth Ingress
  -> ClusterIP Service :3000
  -> Deployment issue-pilot
       replicas: 1
       strategy: Recreate
       application container
       hostPath: state
       hostPath: Pi/npm/Maven/SSH config (read-only)
       emptyDir: /tmp, npm cache, Maven repository cache
```

SQLite、bare Git、worktree metadata、Pi JSONL 和 Attachment 存在跨介质关系，不能用多副本共享写入。应用不访问 Kubernetes API，不 automount ServiceAccount token，也不挂载 Docker/Podman socket。

## 部署事实源

| 文件 | 内容 |
| --- | --- |
| `Containerfile` | Image stage、工具版本、运行用户、entrypoint |
| `deploy/issue-pilot.yaml` | Deployment、Service、mount、resource、probe、security context |
| `issue-pilot.config.ts` | 应用 path、port、runtime、timeout、budget |

不要在文档、环境变量或第二份 manifest 中复制一套可执行配置。

## Image

`Containerfile` 当前包含：

- Build stage：`node:26-bookworm-slim`，先复制根清单、lockfile 和 `packages/workbench` 私有 workspace，再执行根目录 `npm ci`、Web build、`npm prune --omit=dev`；Workbench 的 editor 依赖只在该 workspace 的 devDependencies 中，裁剪后不进入 runtime node_modules。
- Maven stage：Maven 3.9 + Eclipse Temurin 8。
- Git stage：从 kernel.org 源码构建 Git `2.53.0`，保证 relative worktree 格式可读。
- Runtime：`node:26-bookworm-slim`。
- SLS 使用生产依赖 @alicloud/sls20201230 的签名 HTTPS API，不安装 Aliyun CLI。
- OpenSSH client、ripgrep、curl、Perl 与 Git runtime library。
- Production dependencies、Fastify API、Solid Web 和 VS Code Workbench assets。

DMS 由 application 内的 MCP SDK SSE client 调用。

Runtime 固定：

```text
WORKDIR=/opt/issue-pilot
USER=node (UID/GID 1000)
HOME=/home/node
PORT=3000
CMD=node --experimental-strip-types src/http/production.ts
```

## 宿主目录

### State

Manifest 映射：

```text
host /var/lib/issue-pilot
  -> container /opt/issue-pilot/.issue-pilot
```

使用全新 state 或经过验证的正式 backup，不要把 checkout 中用于开发的 `.issue-pilot` 复制到生产。

```bash
install -d -m 0700 -o 1000 -g 1000 /var/lib/issue-pilot
kubectl label node <node-name> issue-pilot/state=true
```

`nodeSelector` 固定为：

```yaml
issue-pilot/state: "true"
```

`hostPath.type` 必须保持 `Directory`。错误节点或错误路径应显式失败，不能改成 `DirectoryOrCreate` 静默创建空 state。

### Operator 配置

```text
/etc/issue-pilot/
  .pi/agent/
    auth.json
    models.json
    models-store.json
  .npmrc
  .m2/settings.xml
  .ssh/
    id_ed25519
    known_hosts
```

Manifest 将整个目录只读挂载到 `/home/node`，再以 writable `emptyDir` 覆盖 `.npm` 和 `.m2/repository` cache。

准备示例：

```bash
install -d -m 0700 -o 1000 -g 1000 \
  /etc/issue-pilot \
  /etc/issue-pilot/.pi/agent \
  /etc/issue-pilot/.m2 \
  /etc/issue-pilot/.ssh

install -m 0600 -o 1000 -g 1000 "$HOME/.pi/agent/auth.json" \
  /etc/issue-pilot/.pi/agent/auth.json
install -m 0600 -o 1000 -g 1000 "$HOME/.pi/agent/models.json" \
  /etc/issue-pilot/.pi/agent/models.json
install -m 0600 -o 1000 -g 1000 "$HOME/.pi/agent/models-store.json" \
  /etc/issue-pilot/.pi/agent/models-store.json
install -m 0600 -o 1000 -g 1000 "$HOME/.npmrc" \
  /etc/issue-pilot/.npmrc
install -m 0600 -o 1000 -g 1000 "$HOME/.m2/settings.xml" \
  /etc/issue-pilot/.m2/settings.xml
install -m 0600 -o 1000 -g 1000 "$HOME/.ssh/id_ed25519" \
  /etc/issue-pilot/.ssh/id_ed25519
install -m 0600 -o 1000 -g 1000 "$HOME/.ssh/known_hosts" \
  /etc/issue-pilot/.ssh/known_hosts
```

不要把这些文件写入 image、ConfigMap、manifest environment 或日志。Deployment capability credential 通过受信配置 API 保存到 SQLite，不进入该目录。

## 构建与发布

```bash
podman build --pull=always \
  --file Containerfile \
  --tag registry.example.com/issue-pilot:0.1.0 \
  .

podman push registry.example.com/issue-pilot:0.1.0
```

生产应把 manifest image 替换成 reviewed immutable tag 或 digest。

首次部署：

```bash
kubectl create namespace issue-pilot
kubectl apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=10m
```

## 分析沙盒执行环境

新增 `sandbox` 分析工具的运行前提见[工单分析沙盒](SANDBOX.md#部署与诊断)。第一版要求应用进程所在 Linux 用户环境可运行 rootless Podman 并已有镜像；当前 image/manifest 未提供该能力，调用会明确失败，其余工具不受影响。不要添加引擎 socket 挂载或 privileged 来绕过隔离边界。

## Manifest 不变量

- `replicas: 1`。
- `strategy.type: Recreate`。
- `runAsNonRoot: true`，UID/GID/fsGroup 1000。
- `allowPrivilegeEscalation: false`。
- Drop all Linux capabilities。
- RuntimeDefault seccomp。
- Read-only root filesystem。
- `automountServiceAccountToken: false`。
- `/tmp` emptyDir 1 GiB。
- npm cache emptyDir 2 GiB。
- Maven repository cache emptyDir 5 GiB。
- CPU request/limit 1/4 core，memory request/limit 1/4 GiB。
- Startup/readiness/liveness 均检查 `/health`。
- `terminationGracePeriodSeconds: 1800`，覆盖最长 project action。

不要挂载整个项目目录。Application 源码来自 image；生产只挂载 state、明确的原生配置和 cache。

## 网络

ClusterIP Service 只暴露 3000。Ingress 必须：

- 提供 TLS 和组织 authentication/authorization。
- 禁用 SSE response buffering。
- 设置至少 1 小时 read timeout。
- 不记录 Config response/write body、Source body、credential 或 capability result。

API 没有内置认证。页面用户切换和 `X-Issue-Pilot-Subject` 只选择 active user 及写入署名，不是认证凭据。

建议 NetworkPolicy：

- Ingress 只能访问 application 3000。
- Egress 只允许 Repository、Pi provider、Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS MCP、SLS target 和必要 DNS。
- 未提供 TLS 的 protocol 必须位于可信加密网络。

## 首次验收

```bash
kubectl -n issue-pilot get deployment,pod,service
kubectl -n issue-pilot logs deployment/issue-pilot --tail=200
kubectl -n issue-pilot port-forward service/issue-pilot 3000:3000
curl -fsS http://127.0.0.1:3000/health
```

还应验证：

- `/` 与 `/vscode.html` 和 API 同源可达。
- SQLite mode、integrity、foreign keys 和业务不变量。
- Project broker socket 为 owner-only `0600`。
- Global model catalog 可用。
- 一个 prod/test Issue 的只读 runtime 与 Source。
- 一个隔离 dev Issue 的文件/Git mutation 和 project wrapper。
- 必要 capability 的最小只读 smoke。
- SSE `snapshot_ready`、heartbeat 和 proxy 不缓冲。

## 升级与回滚

升级顺序：

1. Build/push reviewed image。
2. 在 state backup 副本 dry-run migrations。
3. 隔离 Ingress 流量并等待 Agent/Workspace 操作结束。
4. 正常停止 Pod。
5. 创建一致 database 和 full-state backup。
6. 更新 immutable image tag/digest。
7. Apply manifest 并等待 probes。
8. 验证 DB、Git/runtime、Attachment、SSE、Source、project tools 和 capability。

Rollback 必须恢复 matching code image 与 matching DB/state backup，不能只回退 image。详细流程见[运维手册](RUNBOOK.md)。
