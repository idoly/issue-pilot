# 2026-11-05 SSH、浏览器与构建验收

延续[前四轮可靠性改造](2026-11-05-four-round-reliability.md)，在同一独立 worktree `/tmp/issue-pilot-architecture-20261105`、分支 `refactor/architecture-reliability-20261105` 继续实施。HEAD 为 `195c25b5ed7187f37ec0b9b6769f6c06e951b69d`，代码未提交／推送；没有使用真实 `.issue-pilot`、生产连接或重启原服务。

## 结论与范围

SSH 原先唯一 skip 已补齐，完整后端 733 项全部通过。新增可重复的 Chromium 验收及 CI 步骤，实际覆盖生产 Web 构建、HTTP、SSE、SQLite 与隔离 Git 文件操作。清除了 JSON 高亮带入的未启用语言服务及无用主题字段；保留公开 editor/model API、编辑能力、冲突规则和按需加载设计，没有进行公共接口或持久结构迁移。

## 确认的问题与处理

| 优先级 | 位置、证据与触发 | 影响与最小处理 | 代价及验证 |
| --- | --- | --- | --- |
| P2 | `src/web/src/app/monaco.ts` 导入 JSON register；打开 JSON 会加载 jsonMode → WorkerManager → internal/common/workers，后者注册所有编辑器 contributions，即使全部语言服务已禁用 | JSON 文件额外下载语言服务和不需要的编辑功能；直接使用固定版本已有的 tokenizer，通过公开 languages API 注册，保留原词边界、注释、括号和自动闭合配置 | tokenizer 导出没有类型声明，增加精确的局部声明；升级 Monaco 时复查。真实浏览器验证高亮、粘贴、查找、撤销和差异；产物与加载资源均无 jsonMode／json.worker |
| P3 | `src/web/src/app/EditorIcons.tsx` 整体导入主题 JSON，构建包含 unused languageIds/light/highContrast 等字段 | 改为明确字段导入，让已有构建工具去除未使用字段，不维护第二套图标表 | 图标选择规则不变；浏览器检查图片成功加载，CodeBrowser 包下降到默认阈值以内 |
| P2 验证缺口 | `tests/workspace/ssh-transport.test.ts` 无 sshd 时 skip 文案声称由容器 harness 验证，但仓库无该入口；显式错误路径也会 skip | 添加专用 OpenSSH 镜像、`scripts/test-ssh.sh`、`npm run test:ssh` 和 CI 步骤；指定夹具不可用即失败；负例断言明确认证／主机校验错误 | rootless Podman 和镜像下载为额外测试依赖，不加入生产镜像。实测个人身份 push/ls-remote 成功、错误密钥与未知主机均拒绝，结束无残留容器 |
| P2 验证缺口 | jsdom 使用 Monaco mock，无法覆盖 Worker、剪贴板、真实选区和布局 | 新增 `tests/browser/acceptance.mjs`、`npm run test:browser`、CI 和开发说明 | Playwright 1.64.1 安装在临时目录，不修改应用依赖或锁文件。模型目录和执行器仍使用测试实现，远程模型不在此测试范围 |

测试夹具全部是生成状态；应用真实 Issue、附件、凭证及数据库未被修改。保持现有 owner：运行时／事务修复仍归前四轮对应模块，Web 编辑规则仍在 CodeBrowser／SourceText／SourceDiff，不新增泛化加载框架或自制 JSON 语法。

## 构建测量

同一 Node、Vite、依赖和源码基线，比较本轮前后构建 `assets/*.js`。gzip 使用 Node `gzipSync` 默认参数逐文件计算并求和；包含按需脚本与 Worker，不能解读为首页传输或耗时改善。

| 指标 | 改造前 | 改造后 |
| --- | ---: | ---: |
| 全部 JS 原始字节 | 5,657,871 | 4,504,285 |
| 全部 JS gzip 字节 | 1,456,893 | 1,140,803 |
| JS 文件数 | 20 | 17 |
| CodeBrowser 原始字节 | 507,341 | 494,554 |
| 首页入口原始字节 | 387,887 | 387,887 |

总 JS 产物减少 **1,153,586 字节（20.4%）**，逐文件 gzip 总量减少 **316,090 字节（21.7%）**。JSON 服务包 686,544 字节及专用 Worker 433,120 字节不再产出；其他编辑器模块经构建自然合并。浏览器验证首页未加载 CodeBrowser／Monaco，打开文件才加载编辑器。

仍有一个按需 Monaco 核心包 **3,273,169 字节**超过默认 500 kB 提示。未提高阈值、关闭告警、任意拆块或删掉编辑器能力；进一步消除该包需要重新评估编辑器功能边界，不能声称本轮已经消除所有大 chunk 提示。未测量 CPU、用户网络或首次可交互耗时，不报告这些收益。

## 实际验证

- Biome 实际格式化本轮 JS／TS／JSON；`format:check`、Lint、typecheck 与 `git diff --check` 通过。Shell 使用 `bash -n`；Markdown／YAML／Containerfile 遵循仓库风格，Biome 不覆盖这些文件。
- 全量后端有界并发：**733 通过，0 失败，0 skip**，通过显式隔离 sshd 提供唯一原缺失夹具。
- 全量 Web：**32 文件、328 测试通过**。SSH 新入口单独执行通过，之后强化负例错误断言的聚焦复测也通过。
- 协议聚焦测试 **134 通过**，覆盖 MCP transport／stdio、Pi 集成、DMS/SLS 和钉钉边界；部分使用响应或执行器注入。全量测试另含真实回环 HTTP MCP、stdio 子进程以及 DMS 协议服务，均不等价于厂商系统验收。
- `npm run build` 通过，保留上述一个 Monaco 警告；既有 Biome 配置弃用信息未改变全局规则。
- `npm audit --omit=dev --audit-level=high`：**0 vulnerabilities**；Python `pip check`：通过。
- Chromium **156.0.8078.4**／Playwright **1.64.1**，桌面 **1680×1050、1280×800**：真实编辑器高亮、图标、查找、粘贴、保存、CRLF、undo/redo、并排／行内差异、切换文件、冲突保留磁盘和草稿、导航拦截、重新读取、Agent 草稿跨页、真实 SSE、跨段落选区及编辑区布局全部通过；未出现意料之外的页面／控制台错误。测试主动制造的一次 409 为预期结果。
- 临时服务器 `/health` 返回 200，SQLite `integrity_check=ok`，`foreign_key_check` 无记录；测试释放浏览器、API、临时数据库和 worktree。
- 本机首次截图发现缺中文字体；仅在验收临时目录提供 Noto CJK 并给 Chromium 设置专用 Fontconfig，随后截图中文字正确显示。CI 显式安装中文字体。未修改应用字体或宿主全局字体配置。

当前浏览器输出的源码 diff SHA-256 为 `721f1278a17407624ac861507b3e241b141ded862e30173adf2001c558c1ae29`（`git diff HEAD -- src package.json issue-pilot.config.ts`）。本次日志、构建比较和截图保存在 `/tmp/issue-pilot-acceptance-y4xnzL/`，为可清理的临时验收产物，不进入仓库。命令和前置条件见[开发指南](../DEVELOPMENT.md#可重复的真实浏览器验收)。

## 尚未覆盖

外部厂商测试目标和受控凭证位置尚未提供。未调用真实模型、企业 Git、DMS/SLS、钉钉或外部 MCP；需指定独立环境和允许的验收查询后才能完成该部分。未执行生产部署、远程 GitHub Actions、Safari／Firefox 或移动端验收。新增 CI 配置已静态复查，本机通过不代表远程 CI 已运行。
