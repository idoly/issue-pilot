# 依赖补丁

[开发指南](../docs/DEVELOPMENT.md) · [发布流程](../docs/RUNBOOK.md#按风险发布与重启)

依赖由锁文件固定，postinstall 通过 Git 校验版本和正反向补丁上下文；不匹配即停止，不静默忽略。容器在 npm ci 前复制补丁，带入已修补的生产依赖。源码修改不自动更新 live node_modules。

## Pi 输出保存回调

文件：[@earendil-works+pi-coding-agent+1.5.0.patch](@earendil-works+pi-coding-agent+1.5.0.patch)。

为固定 SDK 1.5.0 的 Codemode／MCP 扩展增加可选 saveOutput(data, extension)，包括 read_mcp_resource。图片、二进制和截断输出交给当前 Issue 的工作文件 owner，以 0600 临时文件写入并原子公开；未提供回调保持 SDK 行为。

这一部分不修改 schema、发现、传输、错误、会话格式或授权，不给模型新增存储能力。上游提供等价公共接口后移除对应修改，保留输出保存、取消与失败回归。

## 服务 MCP 调用预算

同一 Pi 补丁将注册工具时捕获的 `timeoutMs` 改为 getter，应用的 MCP 配置也提供动态 `timeout`。Pi 在每次新请求开始时读到当前值并固定到该请求；已有会话可以使用更新后的 `mcpExecutionMs`，在途调用仍遵守原预算，保存参数不重新连接或重放调用。资源读取沿用 SDK 原有的动态取值路径。

该改动保留 Pi 的工具注册、连接、取消及 shutdown 所有权，不建立第二套协议执行层，也不改变 SDK 类型或依赖版本。只加外层 AbortSignal 无法解决调高预算时旧 SDK 计时器提前超时的问题。回归见 [mcp-extension.test.ts](../tests/agent/mcp-extension.test.ts)；升级 SDK 时复核此取值链，上游提供等价行为后移除该 hunk。

## Zod v3 集合上限保护

文件：[zod+4.6.7.patch](zod+4.6.7.patch)。

正式 Zod 4.6.7 已修复 [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) 的 v4 Classic/Mini。剩余补丁只保护包内公开 v3 Array／Set 的 ESM/CJS：原始集合超过已有上限时先拒绝，不遍历全部元素或执行后续转换／refinement。

正常大小、异步与无上限 schema 保留原路径；不自动增加业务限制，也不声称消除所有大输入风险。SRT 自身导入 zod/v3，因此统一包版本不等于把 SRT schema 切换到 v4。

[安全测试](../tests/agent/zod-security.test.ts) 在独立目录比较六种入口、正常／超限／异步数据、真实 MCP 往返和拒绝后重试、SRT 配置，并验证幂等、版本／上下文漂移及共享安装 hash。上游 v3 提供等价保护后应移除补丁。

## 版本覆盖

| 约束 | 目的与边界 |
| --- | --- |
| Zod 4.6.7 | MCP／DBHub 使用正式 v4，SRT 使用公开 v3，按实际 API 验证 |
| DOMPurify | Monaco 固定的清洗器版本与应用不同；覆盖为应用版本，避免浏览器构建带入旧副本 |

Forge／Azure 安全修复由正式依赖提供，不叠加旧回补；Pi 内部 undici 约束不重复覆盖。审计不通过修改版本报告、屏蔽公告或降级父依赖凑通过，无公告不等于业务安全。

Fastify Static 10.1.10 已正式依赖 glob 14，因此移除了应用的 glob 强制覆盖；锁文件继续固定 14.0.3。保留预计算路由、特殊文件名和 dotfile 排除回归，不再维护上游已支持的版本替换。

配套的 `solid-js` 和 `@solidjs/web` 已各自固定 seroval／seroval-plugins 1.7.0；移除重复的应用覆盖后，重新解析的锁文件保持字节一致。两个包仍是 Solid 的传递依赖。

## 升级与退出

1. 读取父依赖实际使用 API、变更与公告，确认正式升级能替代哪些本地补丁。
2. 在独立安装生成锁文件，检查依赖树与安装脚本，不触碰运行中的依赖。
3. fresh install／postinstall、攻击与兼容回归、完整检查、生产 audit 和适用部署验收分别执行。
4. 按授权发布整体切换；不要在 live 安装反向应用补丁做实验。

历史版本补丁和阶段结果通过 Git 查询；当前安装入口见 [apply-pi-sdk-patch.mjs](../scripts/apply-pi-sdk-patch.mjs)。
