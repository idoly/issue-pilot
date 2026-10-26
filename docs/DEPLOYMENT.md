# 部署指南

[文档导航](README.md) · [配置](CONFIGURATION.md) · [发布与恢复](RUNBOOK.md)

应用可在 Linux 主机或单副本容器中运行。Fastify 同源提供网页、API、SSE 和入站 MCP，同一 state root 只允许一个 API 实例。

## 部署结构

浏览器与 MCP 客户端经认证网关进入 Node 应用。应用连接持久 state、Operator 配置和允许的外部目标。

| 资源 | 要求 |
| --- | --- |
| 业务 state | SQLite 文件组、工单目录、Git 和单实例控制目录，独立持久化 |
| Operator HOME | Pi 模型、认证、settings、资源、SSH known_hosts 和工具配置 |
| 运行工具 | Python、Git、Java／Maven、aliyun CLI 与 SRT 系统依赖 |
| 外部目标 | 模型、Git、日志／数据源及服务 MCP 的精确网络出口 |
| 网关 | 认证并绑定 subject，支持 SSE 长连接，关闭流式代理缓冲 |

## 首次本地运行

开发与 CI 使用 Node 24.18.0。准备 Python 3.8+ 与 venv、Git、ripgrep、fd／fdfind、OpenSSH client、bubblewrap、socat、proxychains4、aliyun CLI，以及项目所需 Java／Maven。

在独立安装目录检查[根配置](../issue-pilot.config.ts)，设置部署账号的 bootstrapUser，准备 Operator Pi 模型和 SSH known_hosts，再执行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm run build
node --experimental-strip-types src/http/production.ts
```

默认 3000 同时提供网页和接口。state 默认为安装目录 `.issue-pilot`，路径由根配置决定，没有 state／database 环境变量覆盖。隔离运行使用独立项目和根配置；测试由 fixture 注入临时路径。

业务配置在页面／API 保存，个人凭证在“配置 → 用户”维护。`npm ci` 的 postinstall 校验并应用固定版本补丁，需要 Git；安装与 SDK 校验不能跳过。Python 库按 [requirements.txt](../requirements.txt) 安装到应用 `.venv`，原生 Bash 自动使用该环境。

### 前端入口与进程

| 入口 | 用途 |
| --- | --- |
| API 3000 | 直接提供构建网页和所有接口 |
| `npm run dev:web`，4173 | 开发 HMR，转发 API／MCP 到 3000 |
| `vite preview --config src/web/vite.config.ts --strictPort`，4173 | 提供构建产物，转发到同一个 API |

现有主机使用 user systemd units `issue-pilot-api.service` 与 `issue-pilot-web.service`。操作前核对实际启动目录、产物和 PID：

```bash
systemctl --user show issue-pilot-api.service issue-pilot-web.service --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

前端构建与 TypeScript 后端更新按[发布流程](RUNBOOK.md#按风险发布与重启)激活，开发 HMR 不替代后端发布。

## 容器构建与 Kubernetes

[Containerfile](../Containerfile) 以 Node 26 构建，安装生产依赖、Python venv、Git 2.56.0、aliyun CLI 3.5.2 与 Java／Maven，以 UID／GID 1000 运行。Git 使用官方 NO_RUST 构建选项，基础镜像跟随声明 tag；准确依赖由锁文件、requirements 和安装补丁决定。

在独立构建目录完成[验证](DEVELOPMENT.md#验证)，替换版本与 registry：

```bash
podman build -f Containerfile -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
```

构建网络需访问基础镜像、npm／Python／Debian 包源和 Git 源码。部署使用 [deploy/issue-pilot.yaml](../deploy/issue-pilot.yaml)，单副本 Recreate；SQLite、进程队列和受管 Git 不支持多个 API 共享写入。

| 挂载 | 容器路径 |
| --- | --- |
| `/var/lib/issue-pilot`，持久 hostPath | `/opt/issue-pilot/.issue-pilot` |
| `/etc/issue-pilot`，只读 hostPath | `/home/node`，Operator 配置 |
| 临时 emptyDir | `/tmp` |

准备目录的 owner／mode、容量及 `issue-pilot/state=true` 节点标签。已有状态的绝对路径必须继续可解析，路径迁移单独演练。Pi 资源随 Operator HOME 提供，默认位于 `~/.pi/agent`；Node／Maven 缓存和工具 TMPDIR 位于工单根。

容器只读根文件系统、移除 capabilities、不挂载 ServiceAccount token。节点需支持非特权 user／PID／mount／network namespace 与 seccomp，按 SRT 正常隔离条件部署，不使用 privileged 或弱隔离规避错误。

准备 namespace、网关和数据后执行：

```bash
kubectl -n issue-pilot apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
kubectl -n issue-pilot get deployment,pod,service
```

DNS、TLS 证书、认证网关和业务凭证由部署方准备。

## 网络与验收

网关保护 API、源码、下载、私有配置和 MCP，约束 `X-Issue-Pilot-Subject` 与认证身份，日志不记录密钥或完整敏感响应。应用附件不设业务总大小／数量上限，边缘传输限制由部署方明确，图片／MCP／预览预算见根配置。

本地工具与 stdio MCP 的出口通过全局 Agent runtime 追加精确域名／端口，SSH 22 与 HTTPS 443 分别声明。验证模型、包源、Git 和协议目标，远程服务仍实施自己的授权。

验收覆盖健康、页面、临时工单工具写入与越界拒绝、Python／Excel、stdio MCP、Git 暂存／提交。个人 SSH 用临时身份或 fixture 验证成功、错误身份和未知主机拒绝。容器隔离失败、协议异常和依赖审计按[开发指南](DEVELOPMENT.md)定位；数据与 Git 检查及回退按[运维手册](RUNBOOK.md)执行。
