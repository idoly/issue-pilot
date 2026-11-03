# 部署指南

[文档导航](README.md) · [配置](CONFIGURATION.md) · [运维](RUNBOOK.md)

## 部署拓扑

应用在 Linux 主机或单副本容器运行。API 同源提供网页、HTTP、SSE 和入站 MCP，同一 state root 只能有一个 API 实例。生产访问经可信认证网关，不能仅把 subject 请求头或页面账号选择当认证。

| 资源 | 要求 |
| --- | --- |
| 业务 state | SQLite 文件组、工单、Git、控制目录持久化 |
| Operator 配置 | 运行账号的 Pi 设置／模型／资源、SSH known_hosts 和工具配置 |
| 系统能力 | 非特权 namespace、seccomp、SRT 依赖和实际开发工具 |
| 外部出口 | 精确模型、Git、查询目标和服务 MCP 地址 |
| 网关 | 认证并绑定 subject，限制传输和内存压力，支持长 SSE |

## 首次本地运行

开发／CI 使用 Node 24.18.0，容器使用 Node 26。安装 Python 与 venv、Git、ripgrep、fd／fdfind、OpenSSH client、bubblewrap、socat、proxychains4；SLS 需要 aliyun CLI，开发项目另需对应 Java／Maven／Node 工具。

在独立安装目录检查 [issue-pilot.config.ts](../issue-pilot.config.ts)：bootstrapUser、监听地址、端口、预算和根路径必须适合该部署。准备运行用户的 Pi models／settings 和可信 known_hosts，再执行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm run build
node --experimental-strip-types src/http/production.ts
```

npm postinstall 校验固定版本补丁，需要 Git，不可跳过。不要擅自批准被安装策略阻止的脚本；外部数据库原生驱动等能力需单独验收。

state 默认是安装目录 `.issue-pilot`，数据库文件名来自根配置。路径相对于源码根解析，没有 state／database 环境变量覆盖；手工隔离服务器使用独立项目和根配置，测试使用构造器注入。

用户、凭证、仓库、服务与部署由页面／API 保存到 SQLite，不创建业务 YAML。模型请求 Key 来自数据库，Pi 的认证文件不作为 fallback。

## HTTP 与 Web 入口

| 入口 | 行为 |
| --- | --- |
| API 3000 | 提供构建后的 Web、API、SSE 和 MCP |
| dev:web 4173 | 开发 HMR，代理 /api 和 /mcp |
| vite preview 4173 | 提供已构建产物，代理到同一 API |

```bash
npm run dev:web
# 或仅提供构建产物
node node_modules/vite/bin/vite.js preview --config src/web/vite.config.ts --strictPort
```

现有主机的 user units 为 issue-pilot-api.service 和 issue-pilot-web.service。4173 是可选入口，但已有使用者时不能仅因 API 也能提供网页就认定它无用。

```bash
systemctl --user show issue-pilot-api.service issue-pilot-web.service \
  --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

supervisor 应使用匹配的源码、依赖、venv 和产物，后端允许足够时间优雅排空。已有实例的更新、备份和回退遵循[运维手册](RUNBOOK.md)，不能在运行中混装依赖。

## 容器构建

[Containerfile](../Containerfile) 使用 Node 26 构建 Web 并保留已修补生产依赖；从 Maven 镜像提供 Java 8／Maven，从独立阶段构建 Git 2.56.0，安装 aliyun CLI 3.5.2 和 Python requirements。Git 采用 NO_RUST 构建，不依赖主机 Git。

```bash
podman build -f Containerfile -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
```

替换 registry 和版本，网络须能访问声明的基础镜像、包源和源码。构建缓存是可再生成资源，但当前 Containerfile 引用的基础镜像不是运行服务本身；清理前区分镜像、容器、挂载和 volume。

## Kubernetes

[deploy/issue-pilot.yaml](../deploy/issue-pilot.yaml) 使用单副本 Recreate、UID／GID 1000、只读根文件系统、RuntimeDefault seccomp，不挂载 ServiceAccount token，并移除 capabilities。不能用 privileged 或弱隔离绕过 SRT 失败。

| 主机资源 | 容器路径 |
| --- | --- |
| /var/lib/issue-pilot | /opt/issue-pilot/.issue-pilot，持久 state |
| /etc/issue-pilot | /home/node，只读 Operator 配置 |
| emptyDir | /tmp，临时执行资源 |

hostPath 不受 `fsGroup` 影响，state 目录必须由容器用户（UID/GID 1000）拥有，否则启动时创建／收紧 0700 目录失败：

```bash
install -d -m 0700 -o 1000 -g 1000 /var/lib/issue-pilot
install -d -m 0755 -o 1000 -g 1000 /etc/issue-pilot
```

准备 owner／mode、容量、节点标签 `issue-pilot/state=true`、网关与镜像后执行：

```bash
kubectl -n issue-pilot apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
kubectl -n issue-pilot get deployment,pod,service
```

示例域名和 registry 不能直接当生产配置。绝对路径已成为状态记录时，迁移路径必须独立演练，不能仅改挂载点或批量改数据库绑定。

## 网络与验收

网关限制可信 subject、源码／下载／私有配置／MCP 的访问，日志不能记录密钥或完整敏感响应。应用为 HTML 响应设置 CSP（不含外部脚本、表单或内联框架来源）、`X-Frame-Options: DENY` 与 `Referrer-Policy: no-referrer`；`/assets` 中仅内容哈希文件可长期缓存。优雅停机等待进行中的请求，超过 `http.shutdownGraceMs`（默认 30 秒）后强制关闭连接，`terminationGracePeriodSeconds` 应大于该值。SSE 代理关闭缓冲并设置合理长连接超时；应用附件没有业务总大小／数量上限，边缘层应约束请求和容量。

本地工具及 stdio MCP 按全局 runtime 追加精确出口域名／端口，SSH 与 HTTPS 分别配置；不能用允许列表代替外部业务授权。

上线验收至少覆盖健康、页面与身份、SSE、动态工具执行、文件越界拒绝、Python／Excel、stdio MCP、Git 与个人 SSH。健康 200 只说明服务可响应，不能证明外部模型、数据库、认证或所有沙箱链路可用。验收方法见[开发指南](DEVELOPMENT.md#验证)，真实状态检查见[运维手册](RUNBOOK.md)。
