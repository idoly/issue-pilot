# 部署指南

[文档导航](README.md) · [配置](CONFIGURATION.md) · [运维](RUNBOOK.md)

## 部署模型

Linux 主机或单副本容器运行 Node API，同源提供 Web、HTTP、SSE、/mcp。一个 state root 只有一个 API；可选 4173 前端不是独立业务实例。

部署需准备持久 state、运行用户的 Operator 配置、系统工具、允许的外部出口和可信认证网关。subject 请求头只是选择身份，网关必须校验并绑定，不能允许任意冒充。

## 首次本地运行

以下命令在 **Linux、Bash、独立安装目录的仓库根**执行，不在正在提供业务的 checkout 中安装或构建。Node 使用 [CI](../.github/workflows/ci.yml) 声明的版本；容器使用 [Containerfile](../Containerfile) 声明的版本。运行模型本地工具需要 Python/venv、Git、rg、fd/fdfind、OpenSSH client、bubblewrap、socat、proxychains4。SLS 另需 aliyun CLI；Java／Maven 等按被处理项目准备。只启动页面不代表这些工具已可用。

### 1. 启动前准备

1. 获取要运行的源码 revision 并记录 `git rev-parse --short HEAD`；不要把示例 registry 当作已发布安装源。
2. 检查[根配置](../issue-pilot.config.ts)：首次空数据库会使用 `bootstrapUser` 创建活跃开发管理员。将其改为自己的演示／部署身份，不沿用仓库中的人员信息。**只有用户表为空时才创建**，修改此项不会更新已有用户；已有账号通过用户管理维护。
3. 本机试运行将 `http.host` 和 `web.host` 设为 `127.0.0.1`，或先实施等效网络隔离。仓库默认是 `0.0.0.0`，没有登录服务；接入网络前必须准备认证网关。
4. 为运行用户准备全局 Pi 目录（默认 `~/.pi/agent`）中的 `models.json`。应用只列出该文件 `providers` 声明的 provider 下的模型；不是安装全局 Pi 或执行 `/login` 后就自动完成。文件格式按所安装 Pi SDK 的 `docs/models.md`／`docs/models-configuration.md`；应用的选择逻辑见 [model-runtime.ts](../src/agent/model-runtime.ts)。模型目录首次没有可选项会使启动报 `global_agent_model_unavailable`。不要将密钥放进文档、命令或示例文件；实际模型 Key 在启动后由页面写入 SQLite。
5. 需要 Git/SSH 的仓库准备可信 `~/.ssh/known_hosts`，之后为工单 owner 配置个人 SSH Key。不要关闭主机校验。

### 2. 安装与启动

确认尚未启动此安装目录的 API，然后执行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm run build
node --experimental-strip-types src/http/production.ts
```

postinstall 使用 Git 校验固定补丁，不可跳过。被策略阻止的原生驱动等脚本要单独审查与验收，不因 npm 安装成功声称全部数据库驱动可用。

启动会创建 state、执行数据库迁移与恢复检查，不是只读操作；已有安装先走[发布流程](RUNBOOK.md#按风险发布与重启)。首次启动自动初始化用户、prod/test/dev 环境与共享模型选择，但**不会**初始化可用的模型 Key、业务仓库或服务。无需先另跑 `npm run db:migrate`。

state 默认是源码根下 `.issue-pilot`，`databaseFile` 相对此根，无 state/database 环境变量覆盖。手工隔离使用独立项目和根配置，测试使用构造器注入。业务设置由页面写 SQLite，不创建用户／服务 YAML。

### 3. 检查入口并完成首张工单

在第二个终端执行（API 仍在前台运行）：

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/api/me
```

第一条应返回 `{"ok":true}`，第二条应是本次初始化的账号；它们只检查 HTTP 与用户初始化。浏览器访问 `http://127.0.0.1:3000`，按顺序完成：

1. 管理员在“我的凭证”的共享 API Key 设置中选择实际可用的 provider／model／thinking／Codemode 并保存 Key；确认 provider／model 来自运行用户的模型目录。不要用 Operator 登录状态替代该步骤。
2. 在“配置 → 仓库”登记一处可访问的仓库，再在“服务”中关联它，为 `test` 部署配置仓库真实存在的基线分支。服务不能没有仓库；调查可以不配置 DMS、SLS 或 MCP 查询目标。开发模式还需要同服务的 `prod` 和 `dev` 部署，dev 基线从 prod 推导。
3. 如仓库使用 SSH，为实际 owner（处理人，否则报告人）配置个人 SSH Key。创建测试调查工单，写明“只读取仓库，说明一个模块的用途，不修改或提交代码”，选择刚配置的服务。
4. 创建返回并不代表执行完成。观察会话从排队／运行到空闲，确认有回复、源码可读且工单进入 `pending`，再确认解决成为 `resolved`。失败时读取详情的 `workspace.lastError` 并按[排障步骤](RUNBOOK.md#从启动到首张工单的定位顺序)处理，不反复创建工单。

这条路径会调用真实模型并可能产生费用，也会访问所选仓库；只在自己的演示安装中执行。完成后用前台 `Ctrl+C` 请求优雅关闭，等待进程退出；工单数据保留在该安装的 state 中。不要为清理演示而删除未知或正在使用的 state。

没有模型／外部仓库条件时，开发者可执行[隔离接口验证](DEVELOPMENT.md#无需真实模型的核心流程验证)，但它不能替代上述真实集成验收。

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

上面的 `systemctl` 命令仅适用于已经创建这些名称的 user units；仓库不提供对应 unit 文件，也不会在 npm 安装时注册服务。主机自行配置 supervisor 时，需匹配实际 Node/PATH、WorkingDirectory、源码、依赖、venv 和 dist，并允许足够时间排空 Engine。API 的 shutdownGraceMs 有界关闭卡住 HTTP 连接，不替代 Agent 优雅结束。已有安装的更新按[发布步骤](RUNBOOK.md#按风险发布与重启)，不要混装运行中依赖。

参数 Tab 可以调整一部分运维策略，不需要重启；state 路径、端口、bootstrap、区域及硬预算仍是部署级变更。不要把“参数热更新”扩展解释为任意代码配置都能即时切换。

## 容器

[Containerfile](../Containerfile) 以 Node 26 构建 Web 与修补后的生产依赖，使用 Maven 镜像提供 Java 8／Maven，独立构建 Git 2.56.0，安装 aliyun CLI 3.5.2、Python requirements 和 SRT 系统依赖。

```bash
# 先替换为自己有推送权限的镜像仓库及本次源码 revision tag；push 会对外写入镜像。
IMAGE='registry.example.com/issue-pilot:replace-with-revision'
podman build -f Containerfile -t "$IMAGE" .
podman push "$IMAGE"
```

替换镜像地址和版本，核对包源／镜像／源码网络。基础镜像按声明 tag，准确软件依赖按锁文件；不能用删除必要构建镜像或弱化 sandbox 的方式掩盖环境失败。

## Kubernetes

[示例清单](../deploy/issue-pilot.yaml) 为单副本 Recreate、UID/GID 1000、RuntimeDefault seccomp、只读根文件系统，移除 capabilities，不挂载 ServiceAccount token。节点须支持 SRT 所需的非特权 namespace，不采用 privileged 绕过。

| 资源 | 容器位置 |
| --- | --- |
| /var/lib/issue-pilot | /opt/issue-pilot/.issue-pilot，持久 state |
| /etc/issue-pilot | /home/node，只读 Operator HOME |
| emptyDir | /tmp，临时执行空间 |

清单不创建 namespace、主机目录、Operator 配置或认证网关。先将示例镜像替换为已构建并推送的实际镜像，创建 `issue-pilot` namespace；在匹配节点准备 `/var/lib/issue-pilot` 和 `/etc/issue-pilot`（含 `.pi/agent/models.json`、按需 `.ssh/known_hosts`），核对 UID/GID 1000 的访问权限和容量，设置清单要求的 `issue-pilot/state=true` 节点标签。只读 HOME 的内容要在挂载前准备，不能指望容器内 `/login` 写入。完成这些前置条件及网关后：

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
