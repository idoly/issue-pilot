# 当前页面图

[项目首页](../../README.md) · [文档导航](../README.md)

图片来自当前 Web 源码的生产构建，在独立 Fastify 应用中使用演示 SQLite、Pi JSONL 和临时本地 Git 仓库生成。没有读取真实 .issue-pilot、真实人员／凭证，也没有执行模型或远程查询。图中调查结论是演示文本，不是业务证据。

| 图片 | 展示内容 |
| --- | --- |
| [overview.jpg](overview.jpg) | 运营首页、活动工单和分布统计 |
| [workspace.jpg](workspace.jpg) | 工单对话、工具卡片、描述和工作目录 |
| [code-browser.jpg](code-browser.jpg) | 实际 Monaco 只读编辑器与演示 Java 源码 |
| [parameters.jpg](parameters.jpg) | 当前参数 Tab、默认值及生效说明 |

视口为 1440×1000，JPEG；使用真实当前组件，不绘制替代 DOM。独立 Agent controller 仅生成受理状态，预置会话通过真实 SSE 回放。中文字体通过临时 fontconfig 引用 Windows Microsoft YaHei，字体文件未复制进仓库或分发。

源码 commit、Web tree、Playwright／Chromium 版本、每图字节与 SHA-256 见 [manifest.json](manifest.json)。捕获检查包括加载完成、无 pageerror、无页面横向溢出，并人工检查中文、内容和编辑器。截图不是外部模型、认证、数据库、容器或手机布局的完整验收。

更新方法见[开发指南](../DEVELOPMENT.md#页面图维护)。原测试图片保留在 tests/fixtures，不因页面图更新而改动；历史界面从 Git 查询。
