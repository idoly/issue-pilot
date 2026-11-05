# 部署指南

[文档导航](README.md) · [配置](CONFIGURATION.md) · [运维](RUNBOOK.md)

## 部署模型

Linux 主机或单副本容器运行 Node API，同源提供 Web、HTTP、SSE、/mcp。一个 state root 只有一个 API；可选 4173 前端不是独立业务实例。

部署需准备持久 state、运行用户的 Operator 配置、系统工具、允许的外部出口和可信认证网关。subject 请求头只是选择身份，网关必须校验并绑定，不能允许任意冒充。

## 首次本地运行

使用 Node 24.18.0（容器 Node 26）、Python/venv、Git、rg、fd/fdfind、OpenSSH client、bubblewrap、socat、proxychains4。SLS 需要 aliyun CLI；开发任务按项目安装 Java／Maven 等正常工具。

在独立安装目录检查[根配置](../issue-pilot.config.ts)的 bootstrapUser、监听、区域、路径与预算，准备 Pi models/settings 和可信 known_hosts，再执行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm run build
node --experimental-strip-types src/http/production.ts
```

postinstall 使用 Git 校验固定补丁，不可跳过。被策略阻止的原生驱动等脚本要单独审查与验收，不因 npm 安装成功声称全部数据库驱动可用。

state 默认是源码根下 .issue-pilot，databaseFile 相对此根，无 state/database 环境变量覆盖。手工隔离使用独立项目和根配置，测试使用构造器注入。业务设置由页面写 SQLite，不创建用户／服务 YAML。

## 入口与 supervisor

| 入口 | 用途 |
| --- | --- |
| API 3000 | 构建网页、HTTP、SSE、MCP |
| npm run dev:web，4173 | HMR 开发，代理 /api、/mcp |
| Vite preview，4173 | 提供构建产物并代理同一 API |

```bash
node node_modules/vite/bin/vite.js preview --config src/web/vite.config.ts --strictPort
systemctl --user show issue-pilot-api.service issue-pilot-web.service \
  --property=MainPID,ExecStart,WorkingDirectory --no-pager
```

主机使用 user units，需匹配实际 Node/PATH、源码、依赖、venv 和 dist，并允许足够时间排空 Engine。API 的 shutdownGraceMs 有界关闭卡住 HTTP 连接，不替代 Agent 优雅结束。已有安装的更新按[发布步骤](RUNBOOK.md#按风险发布与重启)，不要混装运行中依赖。

参数 Tab 可以调整一部分运维策略，不需要重启；state 路径、端口、bootstrap、区域及硬预算仍是部署级变更。不要把“参数热更新”扩展解释为任意代码配置都能即时切换。

## 容器

[Containerfile](../Containerfile) 以 Node 26 构建 Web 与修补后的生产依赖，使用 Maven 镜像提供 Java 8／Maven，独立构建 Git 2.56.0，安装 aliyun CLI 3.5.2、Python requirements 和 SRT 系统依赖。

```bash
podman build -f Containerfile -t registry.example.com/issue-pilot:<version> .
podman push registry.example.com/issue-pilot:<version>
```

替换镜像地址和版本，核对包源／镜像／源码网络。基础镜像按声明 tag，准确软件依赖按锁文件；不能用删除必要构建镜像或弱化 sandbox 的方式掩盖环境失败。

## Kubernetes

[示例清单](../deploy/issue-pilot.yaml) 为单副本 Recreate、UID/GID 1000、RuntimeDefault seccomp、只读根文件系统，移除 capabilities，不挂载 ServiceAccount token。节点须支持 SRT 所需的非特权 namespace，不采用 privileged 绕过。

| 资源 | 容器位置 |
| --- | --- |
| /var/lib/issue-pilot | /opt/issue-pilot/.issue-pilot，持久 state |
| /etc/issue-pilot | /home/node，只读 Operator HOME |
| emptyDir | /tmp，临时执行空间 |

准备 owner/mode、容量、节点标签、网关和镜像后：

```bash
kubectl -n issue-pilot apply -f deploy/issue-pilot.yaml
kubectl -n issue-pilot rollout status deployment/issue-pilot --timeout=35m
kubectl -n issue-pilot get deployment,pod,service
```

示例 registry 不是可直接使用的生产地址。现有绝对路径已进入绑定时，迁移路径需独立演练，不能只改 mount 或批量改 DB。

## 网络与上线验收

网关保护源码、下载、私有配置和 MCP，限制传输和内存压力；SSE 关闭代理缓冲，设置长连接超时。HTTP 附件不设业务总量／数量上限，入站 MCP Base64 有独立限额，不能混同。

参数维护网络基础列表，全局 Agent runtime 可追加精确域名／端口；SSH 和 HTTPS 分别声明，允许出口不代表业务授权。Operator 身份和模型密钥选择继续由应用隔离。

验收至少覆盖 health、页面、身份、SSE、动态 native executor、路径越界、Python/Excel、stdio MCP 与 Git/SSH。health 200 不证明模型、外部数据库、驱动或 sandbox 可用。CI、本机与真实容器结果分别报告，不互相替代。
