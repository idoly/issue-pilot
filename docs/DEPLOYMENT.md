# 部署

## 应用拓扑

[Containerfile](../Containerfile) 构建单一应用镜像：生产 Node 进程运行 Fastify、SQLite、Agent 和项目工具 broker，同时提供编译后的 Solid 页面和本地代码浏览器。镜像包含 Node/npm、Git、ripgrep、OpenSSH、Java 8/Maven 和 Pi；SLS 使用 HTTPS SDK，没有额外 CLI。

默认端口 3000。Vite 的 4173 仅用于前端开发，不是生产第二进程。模型 provider、Git remote 和能力目标的网络由应用访问；正式/测试查询及 Source 只读由应用 owner 强制执行。API、静态页面和入站 MCP 同源。

镜像使用 node 用户。Kubernetes 清单采用单副本、Recreate、UID/GID 1000、只读根文件系统、禁止提权、移除 capabilities，不自动挂载 ServiceAccount token。不要以多副本共享同一 SQLite/state、宿主引擎 socket 或 privileged 模式绕过当前设计。

## 持久挂载

[deploy/issue-pilot.yaml](../deploy/issue-pilot.yaml) 定义实际挂载和预算：

| 宿主或 volume | 容器路径 | 内容 |
| --- | --- | --- |
| /var/lib/issue-pilot | /opt/issue-pilot/.issue-pilot | SQLite、工单文件、Git stores/worktrees、备份 |
| /etc/issue-pilot，只读 | /home/node | Operator 运行配置、Pi 配置、SSH、npm/Maven 配置 |
| tmp emptyDir | /tmp | 临时文件 |
| npm-cache emptyDir | /home/node/.npm | 项目工具缓存 |
| maven-cache emptyDir | /home/node/.m2/repository | Maven 依赖缓存 |

根配置基于应用安装目录解析 state 路径，不能用环境变量改变它。宿主缓存挂载不表示所有工单共享可写依赖；实际项目命令、config 和 Issue 私有目录由 [project-tools.ts](../src/workspace/project-tools.ts)、[tool-runtime.ts](../src/tool-runtime.ts) 授权。

部署前准备挂载目录、正确 owner/mode 和有持久存储的节点。清单选择 `issue-pilot/state=true` 节点。初始用户和默认值来自根配置；不要复制另一套环境变量配置。

Pi 模型目录和 Operator 凭证按 Pi runtime 的配置位置放在受管 HOME。个人开发模型 Key/SSH 和个人生产凭证保存在 SQLite，经应用配置维护，具体优先级见[配置](CONFIGURATION.md)。SSH 主机验证所需 known_hosts 必须可用，不能关闭验证解决连接问题。

## 首次发布

在独立构建 checkout 中执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
podman build -f Containerfile -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
```

将镜像引用替换为审核后的 tag/digest，确认 namespace、节点标签、持久目录和可信入口，再应用清单：

```bash
kubectl -n issue-pilot apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
kubectl -n issue-pilot get deployment,pod,service
```

上述命令是操作说明，不会自动为你准备 Ingress、namespace、DNS、证书或持久存储。已有数据的发布属于升级，先按[运维](RUNBOOK.md)停机、备份并验证迁移，不能直接套首次安装步骤。

## 网络与身份

Service 为 ClusterIP，外部入口使用可信 TLS/auth 网关。应用没有内置登录；`X-Issue-Pilot-Subject` 和浏览器用户选择器只是身份选择。网关必须校验已认证用户与该 header 的关系，不能把任意客户端头当认证结果。

保护 API、源码、下载、配置描述和 MCP，避免公网直连应用端口。反向代理应禁用 SSE 缓冲，支持长连接及配置允许的上传/请求体；应用附件上传不设业务大小/数量上限，边缘限制由部署方明确设置。Agent 图片、MCP、成果预览和协议请求仍有独立预算。

网络放行按实际 provider、Git/SSH、能力目标和包仓库配置。业务查询可包含敏感结果，不把请求/响应 body、配置或认证头加入访问日志。

## 代码执行

Agent 直接使用应用容器中的 Pi 原生工具、Node/Shell 和已安装库。所有工单都有自己的 work 目录；正式数据处理通过通用文件发布交付成果。应用不按文件格式运行模型脚本，也不启动嵌套容器、VM 或每工单执行服务。

应用和 Agent 代码共享容器内信任。只读根文件系统和容器资源限额仍按清单生效，但可写 state 挂载、HOME 配置与其他工单不是互相隔离的权限域。cwd 只组织工作，原生代码拥有应用用户权限；Source API 和内建查询的只读约束不构成对 Shell 的强制限制。

生产镜像已包含 Node 和应用 runtime 依赖，原生 bash 通过 NODE_PATH 使用这些库。工作文件位于 issues/<key>/work，跨轮次保留；成果 publish 按字节原子复制到 outputs。Node/Git 操作使用同一容器，不需要额外容器引擎或执行后端配置。

## 健康与关闭

`GET /health` 返回 `{"ok":true}`。启动执行迁移、恢复、Git/runtime 校验和维护，进程存在不等于 ready；清单 startup/readiness/liveness probe 指向 /health。实际 probe、资源和终止宽限以 YAML 为准。

SIGINT/SIGTERM 触发 Fastify 关闭，等待维护、Agent、session、model runtime、project broker 和数据库清理。Recreate 防止两个版本同时写 state；不要在旧进程未退出时启动第二个 API。

发布后核对健康、Web/代码浏览器资源、SSE、数据库不变量、受管 Git/ref 与附件完整性。禁止用真实工单写消息作为默认 smoke；使用独立 state 或授权的最小只读检查。恢复和故障处理见[运维](RUNBOOK.md)。
