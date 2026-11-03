# 开发指南

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [Agent 规则](../AGENTS.md)

## 环境与依赖

| 项目 | 当前约束 |
| --- | --- |
| Node | 本地／CI 24.18.0，容器 Node 26；后端直接 strip-types 执行 TS |
| Pi AI／Coding Agent／Schema | 1.5.0，Coding Agent 有固定补丁 |
| Solid | runtime／web 2.0.0-rc.20，Vite 插件 3.0.0-next.55，编译器按锁文件 |
| SRT | 0.0.81，需要真实 Linux namespace／seccomp 能力 |
| Monaco | 0.57.0，使用公开 editor／model API |
| Python | 应用 .venv，版本约束见 requirements.txt |
| DBHub | 1.5.0，stdio 与只读配置由应用生成 |

准确 npm 版本与 overrides 以 [package.json](../package.json)／[package-lock.json](../package-lock.json) 为准。安装入口见[部署](DEPLOYMENT.md#首次本地运行)，补丁含义见[依赖补丁](../patches/README.md)。不得跳过 postinstall，也不批准来源未审查的安装脚本。

## 开始修改

1. 运行 `git status --short`，固定任务基线，保留已有改动。
2. 找到 owner、业务契约、根配置、schema 和聚焦测试，先读当前实现。
3. 将影响状态分类为持久、有条件持久或生成，确认提交／推送／重启／真实状态操作的授权范围。
4. 实现最小完整修改，不把路由变成协议、Git 或存储的第二个 owner。
5. 验证边界与失败路径，检查最终 diff 中的无关改动、密钥、生成文件和迁移前缀。

责任索引见[架构](ARCHITECTURE.md#owner-与入口)。业务规则集中在 domain，路径和预算集中在根配置，配置／凭证集中在 configuration，媒体事务交给存储 owner。

## 代码约定

TS／TSX 沿用相邻风格，模块 kebab-case、组件与类型 PascalCase、局部符号 camelCase。后端不使用 strip-types 不支持的 enum、参数属性或装饰器。内部 UUID 称 issueId，业务编号称 issueKey，普通工作文件称 workFile，不混淆持久名称。

应用 schema 使用公开 Pi Schema builders 与 `compile().check()`，默认对象关闭额外字段。HTTP、入站 MCP 和 execute 检查严格，不靠 coercion 修正输入；Pi 的初始模型工具管线可做其协议规范化，但不能代替可变钩子后的执行检查。外部格式显式使用官方 formats，重复验证器编译复用，公开 schema 与执行快照隔离。

第三方 SDK／SRT 的 schema 继续使用其官方类型。应用不直接使用 TypeBox；SDK 的传递依赖仍可能包含它。默认值、凭证选择和授权不放进 schema 转换器。

抽象须有具体维护收益。重复校验若保护不同时间点／边界不能删；仅转发的层、不显著的扫描合并和无依据缓存也不应加入。

## 隔离与变更边界

真实 `.issue-pilot` 可能含密钥、附件、会话、dirty worktree 和恢复证据，绝不能作为测试夹具。后端使用 `buildApi({ stateRoot, databaseFile })` 或 manager 构造器注入临时根；手工服务器使用独立项目及根配置，没有 state 环境变量覆盖。

Pi 会话测试显式传临时 agentDirectory，不能因注入模型 runtime 就忽略资源目录隔离。结束时关闭会话、扩展、协议和句柄；断言失败也必须 finally／onTestFinished 清理。

不要在运行中的 checkout 安装依赖或覆盖 dist。动态 native-tool-executor／network-exec 会读取磁盘源码，即使 API 主进程没重启；健康 200 不证明动态执行可用。运行环境切换按[发布流程](RUNBOOK.md#按风险发布与重启)。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run lint
git diff --check
```

检查失败时先区分格式化、lint 与类型错误，再运行测试。资源受限时使用等价的有界并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

| 范围 | 验证重点 |
| --- | --- |
| 后端 | 身份重检、事务、预约、文件模式／哈希、Git、协议与关闭 |
| Web | DTO、身份切换、取消、草稿、重连、冲突与局部状态 |
| 迁移 | fresh DB、已有 schema、无损失败、纠正后重试、幂等和历史保留 |
| 工具 | 可变钩子后输入、范围、只读、取消、预算与凭证不回退 |
| 构建 | Worker、动态入口、字体、图标、许可证和生产依赖可导入 |

运行时、依赖、协议安全或容器变化还检查：

```bash
npm audit --omit=dev --audit-level=high
.venv/bin/python3 -m pip check
```

审计不能靠屏蔽或降级通过，主版本 override 必须覆盖父依赖实际 API。需要 sshd 的 SSH 测试缺夹具时明确 skip，不得把 skip 当通过。远程模型、认证、数据库和容器验收需要对应环境，测试不能证明所有代码安全。

CI 见 [.github/workflows/ci.yml](../.github/workflows/ci.yml)：main push／PR 使用 Ubuntu 24.04，安装匹配依赖与 Python 后运行类型、测试、构建；本机通过不代表远程 Actions 已通过。

## Web 与浏览器

Solid 2 使用双参数 createEffect；回调只返回清理函数或 undefined。显式键的 For 子项是 accessor，读取最新值，不捕获会失效的原始对象。Match render callback 保留参数，零参数函数会按 accessor 处理，可能重建 DOM。

会话应覆盖流式帧批处理、最终覆盖、完整消息选区、原生 details 键盘操作、快照去重和身份隔离。不能只用 jsdom 断言节点来代替浏览器选区与布局检查。

Markdown／HTML 经过授权路径解析和 DOMPurify。预览按响应声明与实际字节限制，超限取消读取；下载不因此截断。Monaco 负责释放 editor／model，保留 SHA-256 冲突、CRLF、撤销、自动保存和导航拦截。

CodeBrowser／Monaco 已动态加载。单个上游编辑器或语言服务仍可能超过默认 chunk 提醒；先看加载图和压缩传输，不为消除提示抬高阈值、任意拆分或删掉编辑能力。

真实浏览器使用独立演示数据、临时工具／镜像，记录源码版本、工具版本、视口、场景及缺口；不要把历史截图当当前验收。图片读取夹具在 [tests/fixtures](../tests/fixtures/README.md)，替换其字节须运行 `tests/agent/codemode.test.ts`。

## 文档与资源清理

指南按 owner 描述当前契约，不维护功能变更流水账。检查相对链接、锚点、示例和源码一致性；旧方案留在 Git 历史，必要离线迁移说明单独保存。

删除前检查静态和动态 import、CLI、Worker、构建复制、URL、测试夹具和外部使用者。迁移 SQL／journal 不变，无法证明无用的路径保留。node_modules、venv 和 dist 若服务仍在使用就不是垃圾；测试临时根、旧构建与镜像也须确认进程／挂载和持久引用后再删。
