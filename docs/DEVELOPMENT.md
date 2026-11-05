# 开发指南

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [代理规则](../AGENTS.md)

## 环境与入口

后端直接用 Node strip-types 执行 TypeScript，开发／CI 使用 Node 24.18.0，容器 Node 26。Pi AI／Coding Agent／Schema 1.5.0，Solid runtime／web 2.0.0-rc.20 与对应 Vite 插件、Monaco 0.57.0、SRT 0.0.81 按锁文件配套。

准确版本见 [package.json](../package.json)、[package-lock.json](../package-lock.json)、[requirements.txt](../requirements.txt)。安装须执行 postinstall 校验[依赖补丁](../patches/README.md)，不默许被策略阻止的脚本。工具环境见[部署](DEPLOYMENT.md#首次本地运行)。

修改前运行 git status，固定基线，读取 owner、契约、配置、schema 与聚焦测试；区分持久、有条件持久和生成状态。路由协调 owner，不重实现协议／Git／附件授权，不为风格重写合理设计。

## 代码约定

模块 kebab-case，组件／类型 PascalCase，局部符号 camelCase，遵循相邻 TS／TSX 风格。内部 UUID 称 issueId，业务编号称 issueKey；后端不用 strip-types 不支持的 enum、参数属性或装饰器。

业务规则集中在 domain，参数及凭证有各自 owner。应用 schema 用公开 Pi Schema builders 和 compile().check()；HTTP／入站 MCP／execute 严格，不隐式 coercion。公开 schema 与执行快照隔离，外部格式使用官方 formats，重复验证器只编译一次。SDK 内部传递依赖不代表应用仍直接依赖 TypeBox。

不同时间点的重授权、可变钩子后的校验和跨介质收尾不是冗余。抽象、缓存和依赖须有具体维护收益；微小性能差异不构成改写理由。

## 隔离测试

真实 .issue-pilot 含凭证、附件、JSONL、分支和恢复证据，不作夹具。后端通过 buildApi({ stateRoot, databaseFile }) 或 manager 注入临时根；手工服务器使用独立项目与根配置，没有 state 环境变量覆盖。

Pi 会话显式使用临时 agentDirectory，注入模型不能替代资源隔离。所有会话、连接、句柄和临时根在 finally／onTestFinished 关闭，断言失败也清理。不要在运行中的 checkout 安装依赖或覆盖 dist；动态 executor 会读取磁盘源码，health 200 不代表其可用。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run lint
git diff --check
```

资源受限可用等价有界并发：

```bash
node --experimental-strip-types --test --test-concurrency=2 'tests/**/*.test.ts'
npx vitest run --config src/web/vite.config.ts --environment jsdom --maxWorkers=1
```

| 变更 | 必要覆盖 |
| --- | --- |
| 业务／HTTP | 身份与等待后重检、DTO、预约、事务、错误含义 |
| Agent／协议 | 可变钩子后输入、范围、只读、取消、预算、重试与 shutdown |
| 文件／Git | mode/hash、符号链接、竞争、rollback/finalize、refs 与 dirty 状态 |
| 迁移 | fresh／已有 DB、失败原子性、纠正重试、历史保留 |
| Web | 导航、身份切换、草稿、重连、冲突、图片 URL 和 editor/model 释放 |
| 文档／截图 | 当前代码依据、相对链接与锚点、图片 hash、浏览器可见内容与演示隔离 |

运行时、依赖、协议安全、容器变化还执行生产 npm audit、pip check 和可用部署健康验证。SSH E2E 缺 sshd fixture 明确 skip，不当作通过；远程模型／数据库／认证与完整容器需要对应环境。本机结果不代表远程 CI 成功。

纯文档可以按文档范围验证，不必为了文档运行用户工单的依赖安装或完整构建。应用自身检查与工单 Agent 的“默认不构建”策略是不同职责。

## Web 与浏览器

Solid 2 使用 compute／callback 形式的 createEffect；callback 只返回清理或 undefined。函数 keyed For 的子项是 accessor，避免捕获过时原始对象；Match render callback 保留参数，零参数函数可能被当 accessor 重建 DOM。

会话验证帧批处理、最终覆盖、完成消息选区、原生 details 键盘操作、快照去重和身份隔离。jsdom 不替代真实浏览器布局、选区和网络验收。

Markdown 在链接授权解析后清洗 HTML；文件预览同时检查声明和实际字节。Monaco 保存需处理 SHA-256、换行、撤销、自动保存及导航拦截，关闭释放 editor/model。CodeBrowser 动态加载，大型上游 chunk 提醒不通过抬阈值或随意拆分掩盖。

## 页面图维护

[页面图](images/README.md) 用当前源码的独立应用、演示 SQLite／JSONL、临时本地 Git 和替代 Agent controller 生成，不读真实业务、不调用模型或外部查询。记录 sourceCommit、Web tree、浏览器版本、视口和 SHA-256；不要把旧图说成当前验收。

可在临时工具目录安装 Playwright，不增加应用依赖、不修改全局 Pi 设置。中文字体在临时 fontconfig 中引用，不能分发系统字体。检查截图文本、状态、加载完成、无页面异常和横向溢出，结束关闭浏览器／服务器并删除临时安装。

原始图片读取夹具在 [tests/fixtures](../tests/fixtures/README.md)，不是产品截图；不要因替换页面图而改变该夹具。

## 文档、清理与交付

现行指南描述当前契约，历史审查留在 records，不追加成变更流水账。静态／动态 import、Worker、CLI、构建复制、资源 URL 和测试引用都确认后才删除文件；迁移 SQL／journal 不变。

真实操作遵循[运维](RUNBOOK.md)，未知状态和独有证据保留。完成时报告改动、检查与缺口；提交、推送、部署和状态 mutation 依授权分别执行。
