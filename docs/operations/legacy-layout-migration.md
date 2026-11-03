# 离线旧工单目录迁移

[返回运维手册](../RUNBOOK.md) · [执行边界](../AGENT.md#执行边界)

## 何时使用

这是确认来源的旧 state 升级工具，不是正常启动、例行部署或清理命令。当前运行只使用 workspaces 布局，不自动采用旧目录。文件名包含 legacy 不代表工具无用：它由独立 CLI、状态租约和回归测试维护。

迁移把已识别的 `issues/<key>` 附件、Pi JSONL、交付和运行普通文件归并到 `workspaces/<key>`，保留开发仓库路径、原件和被编辑过的文件。未知目录、绑定冲突、mode/hash 或会话头异常会停止，不能靠删除或猜测继续。

## 前提

1. owner 确认旧布局来源与要迁移的 state，排空任务并建立匹配的完整恢复点。
2. 在独立完整副本演练，核对现行 schema 升级的全部前置条件；CLI apply 会运行所有尚未应用的数据库迁移，不只处理某个历史版本。
3. 验证 SRT、SDK 文件输出和当前文件 API 后再执行真实切换；不将生产 state 当测试夹具。

## 命令与排他

```bash
# 只读计划：不移动文件、不升级数据库，只输出计数
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts \
  --state-root /path/to/state

# 确认 API／子进程已停止后才应用
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts \
  --state-root /path/to/state --apply
```

apply 独占 `control/project-tools.sock`，与 API 使用同一实例控制边界；占用时报错，不删除 socket 夺锁。预检后写 0600 私有计划，执行数据库迁移，再协调文件与绑定事务。此入口不启动 Agent，也不运行应用的中断恢复流程。

## 文件与失败语义

- 校验原件与 DB 的大小／哈希／模式，校验会话头、路径、目标重名和旧运行目录。
- 同内容交付可复用，冲突交付保留摘要后缀及离线索引；不覆盖用户编辑。
- 旧运行普通文件保留为 `.runtime-legacy-*`；只清理已识别的链接和空目录，经过 quarantine。
- 文件移动或绑定事务失败回移本次文件；回滚失败聚合报告并保留证据。
- schema 已升级不会随文件回滚撤销，回退需完整恢复点。
- `flat_layout_committed_finalize_failed` 表示绑定已提交、最终清理失败，先核对私有计划，不盲目重跑。
- 成功重复应用不再次移动，但仍校验原件和会话。

## 恢复服务前

检查 integrity／FK、文件哈希／mode、会话绑定、Git refs/worktrees、未知路径与 quarantine。恢复后验收下载、对话回放、文件链接、代码释放和重开。

迁移不重写 JSONL 或用户脚本；脚本中的旧绝对路径由 owner 明确处理。离线映射索引只供恢复，不作为正常运行的下载兼容层。

实现：[CLI](../../scripts/migrate-flat-issue-layout.ts)、[迁移 owner](../../src/workspace/flat-layout-migration.ts)；验证：[CLI tests](../../tests/workspace/flat-layout-cli.test.ts)。
