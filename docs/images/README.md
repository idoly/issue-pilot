# 演示页面图

[项目首页](../../README.md) · [文档导航](../README.md)

本页保存既有展示图，对应 [manifest.json](manifest.json) 的 `sourceCommit=195c25b5ed7187f37ec0b9b6769f6c06e951b69d`，不是当前 checkout 的重新截图或验收证明。尤其是会话输入、思考折叠与滚动交互已继续演进，当前行为见[使用指南](../USAGE.md#阅读与补充)。本次文档同步不修改图片字节或 manifest 中的捕获记录。

按捕获记录，图片使用该版本 Web 生产构建，在独立 Fastify 应用中以演示 SQLite、Pi JSONL 和临时本地 Git 仓库生成，未读取真实 `.issue-pilot`、真实人员／凭证，也未执行模型或远程查询。图中调查结论是演示文本，不是业务证据。

| 图片 | 展示内容 |
| --- | --- |
| [overview.jpg](overview.jpg) | 运营首页、活动工单和分布统计 |
| [workspace.jpg](workspace.jpg) | 工单对话、工具卡片、描述和工作目录 |
| [code-browser.jpg](code-browser.jpg) | 实际 Monaco 只读编辑器与演示 Java 源码 |
| [parameters.jpg](parameters.jpg) | 捕获版本的参数 Tab、默认值及生效说明 |

捕获视口为 1440×1000，JPEG；使用捕获版本的真实组件，不绘制替代 DOM。独立 Agent controller 仅生成受理状态，预置会话通过真实 SSE 回放。中文字体通过临时 fontconfig 引用 Windows Microsoft YaHei，字体文件未复制进仓库或分发。

源码 commit、Web tree、Playwright／Chromium 版本、每图字节与 SHA-256 见 [manifest.json](manifest.json)。捕获检查包括加载完成、无 pageerror、无页面横向溢出，并人工检查中文、内容和编辑器。这些是该次捕获的记录，不是本次重新执行的结论；截图也不是外部模型、认证、数据库、容器或手机布局的完整验收。

展示图的更新要求见[开发指南](../DEVELOPMENT.md#页面图维护)。`npm run test:browser` 生成的是独立验收场景及可选临时截图，不会自动覆盖本目录的四张展示图或 manifest。原测试图片保留在 tests/fixtures，不因页面图更新而改动；历史界面从 Git 查询。
