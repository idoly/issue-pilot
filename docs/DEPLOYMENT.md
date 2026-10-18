# 部署

部署先选择实际运行方式。当前工作站使用 user systemd 服务；仓库同时提供单容器 Kubernetes 清单。Vite 是开发服务，容器生产入口由 Fastify 同源提供页面、API 和入站 MCP。

## 运行前提

源码开发与 CI 使用 Node 24.18.0，镜像使用 Node 26。后端直接运行 TypeScript，前端先通过 Vite 构建。Git、ripgrep、OpenSSH 以及目标项目需要的 npm、Java/Maven 由运行环境提供。

[Containerfile](../Containerfile) 构建单一应用镜像，包含生产依赖、Git、Java 8/Maven 和 Pi CLI。Pi SDK 与 Monaco 的精确版本由 package/lockfile 固定。应用不启动每工单容器或额外格式执行服务，主机上的 Playwright/Podman 浏览器验证工具不属于 Agent 执行后端。

根配置基于应用安装目录解析，默认状态位于 `.issue-pilot`。Operator Pi 模型目录、认证、SSH known_hosts 和项目工具配置在受管 HOME 中；个人凭证在 SQLite，由应用按 owner 选取。state 路径没有环境变量覆盖。

## 源码与 systemd

首次运行在新项目副本检查根配置、依赖和初始用户：

```bash
npm ci
npm run typecheck
npm test
npm run build
node --experimental-strip-types src/http/production.ts
```

默认应用端口 3000。前端开发使用 `npm run dev:web`，默认端口 4173，代理本机 3000 API。需要远程开发访问时，检查根配置监听地址和实际网络转发，不在文档中固定工作站 IP。

本工作站已注册：

| 服务 | 入口 |
| --- | --- |
| issue-pilot-api.service | node --experimental-strip-types src/http/production.ts |
| issue-pilot-web.service | Vite，使用 src/web/vite.config.ts 与 strictPort |

服务文件由宿主管理，不是仓库中的通用安装脚本。操作前核对 unit 的 WorkingDirectory、ExecStart 和实际 PID：

```bash
systemctl --user status issue-pilot-api.service issue-pilot-web.service --no-pager
systemctl --user show issue-pilot-api.service issue-pilot-web.service --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

已有状态的更新、提交切换或重启先按[运维](RUNBOOK.md)完成停机、一致备份和独立验证，再启动已选定版本。后台不会因修改 TS 文件自动重载，Vite HMR 也不能代替后端发布；不要在同一 state 上启动另一个 API。

## 容器与挂载

[deploy/issue-pilot.yaml](../deploy/issue-pilot.yaml) 使用单副本、Recreate、UID/GID 1000、只读根文件系统，不自动挂载 ServiceAccount token，并移除容器 capabilities。

| 宿主或 volume | 容器路径 | 内容 |
| --- | --- | --- |
| /var/lib/issue-pilot | /opt/issue-pilot/.issue-pilot | DB、工单文件、Git stores、worktrees |
| /etc/issue-pilot，只读 | /home/node | Operator Pi、SSH 和工具配置 |
| tmp emptyDir | /tmp | 临时文件 |
| npm-cache emptyDir | /home/node/.npm | npm 缓存 |
| maven-cache emptyDir | /home/node/.m2/repository | Maven 缓存 |

准备目录、owner/mode、存储容量和带 `issue-pilot/state=true` 标签的节点。不同 volume 覆盖 HOME 中的缓存子目录，使配置只读而缓存可写。项目 wrapper 和 broker 继续管理工单命令及路径授权。

应用根 `.pi` 是独立资源目录，不等于 Operator HOME。当前镜像构建不复制该目录，现有清单也未单独挂载；使用应用 Skills、Prompts 或扩展时，应把资源及依赖部署到根配置指定的位置，例如只读挂载到 `/opt/issue-pilot/.pi`。

在独立构建 checkout 生成并发布镜像：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
podman build -f Containerfile -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
```

准备正确的 namespace、镜像引用、存储和入口后应用清单；已有数据的更新须先完成 Runbook 的备份与迁移演练。

```bash
kubectl -n issue-pilot apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
kubectl -n issue-pilot get deployment,pod,service
```

这些命令是对应运行方式的说明，不授权代理自行部署，也不会创建真实网关、DNS、证书或宿主配置。

## 网络、身份与可信执行

Service 为 ClusterIP，外部由可信 TLS/auth 网关转发。应用用户选择与身份头不是登录认证，网关必须约束已认证用户和 `X-Issue-Pilot-Subject` 的关系。保护 API、源码、下载、私有配置和 MCP，不把凭证、完整请求/响应或敏感结果加入访问日志。

反向代理禁用 SSE 缓冲并允许长连接。附件上传在应用层不设业务大小/数量上限，边缘请求限制由部署方明确；Agent 图片、MCP 和预览预算另有配置。放行实际 provider、Git/SSH、能力目标及包仓库网络，外部 stdio MCP 的程序和依赖由配置者准备。

Agent 代码以应用用户身份执行，可访问容器内该用户可访问的状态和 HOME。只读根文件系统、容器限额和网络策略约束应用容器，不构成工单间隔离。Source API 的只读策略和内建证据查询校验仍是业务边界。

## 健康与关闭

`GET /health` 返回 `{"ok":true}`。启动先迁移、恢复、校验和准备 runtime，再进入正常服务；进程 active 不等于验收完成。关闭等待维护与 Agent，清理 session/model/broker，最后关闭数据库。优雅停止可能需要等待运行中工作，应保留足够终止宽限。

发布后核对数据库 integrity/FK、业务不变量、附件和持久文件、Git refs/worktrees、静态资源、SSE 与只读页面。Kubernetes 使用探针与 supervisor 状态，本地使用实际 systemd；不要用另一 checkout 指向真实状态来探测。
