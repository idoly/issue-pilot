# 离线旧工单目录迁移

[运维手册](../RUNBOOK.md) · [数据存储](../STORAGE.md)

## 使用范围

仅在 owner 确认旧 state 来源、正常启动要求目录迁移时使用，不是每次部署或空间清理的步骤。当前运行使用 workspaces 布局，不自动采用旧目录。工具、历史 SQL 和迁移证据不因含 legacy 名称而删除。

此操作将已识别的 issues/<key> 附件、会话、交付和运行普通文件归并到 workspaces/<key>，保留开发仓库路径。它不是将旧绝对链接转换为运行时兼容下载入口。

## 前提与预检

1. 排空任务，保存匹配的完整恢复点；若压缩，先校验并在独立目录解压演练。
2. 确认文件 mode/hash、DB 关系、会话头、路径和目标重名情况。
3. 演练所有尚未应用的数据库升级；apply 调用当前 migration owner，不限某个历史版本。
4. 验证当前文件 API、SRT 和 SDK 输出，再执行线上切换。真实 state 不用作测试夹具。

```bash
# 只读计划，不移动文件、不升级数据库
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts \
  --state-root /path/to/state

# 仅在 API 和子进程已停止后执行
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts \
  --state-root /path/to/state --apply
```

apply 使用 control/project-tools.sock 排他，与 API 共享实例边界。占用时失败，不删除 socket 夺锁。完整预检后写 0600 私有计划，再迁移 schema、协调文件和绑定事务；不启动 Agent，也不运行应用的中断恢复流程。

## 无损与失败语义

- 同内容交付可复用，冲突文件保留摘要后缀和离线索引，不覆盖用户编辑。
- 原件 mode/hash 与会话关系必须匹配，未知目录或文件停止供检查。
- 旧运行普通文件保留为 .runtime-legacy-*，只清理已识别链接和空目录，经过 quarantine。
- 文件移动或绑定失败回移本次文件；rollback 也失败则聚合报告，保留所有现场。
- schema 升级不会随文件回滚撤销，不能只换 DB 回退旧版本。
- flat_layout_committed_finalize_failed 表示绑定已提交、最终清理失败，先看计划，不盲目重跑。
- 成功重复调用不再次移动，但仍验证原件和会话。

迁移不重写 JSONL／用户脚本，脚本旧绝对路径由 owner 明确处理。离线映射仅供恢复，正常运行读取当前工作文件。

## 恢复服务

核对 integrity/FK、原件 hash/mode、会话绑定、Git refs/worktrees、未知路径和 quarantine，再启动验收下载、回放、文件链接、代码释放／重开。发现未解释差异停止进一步 mutation。

实现：[CLI](../../scripts/migrate-flat-issue-layout.ts)、[迁移 owner](../../src/workspace/flat-layout-migration.ts)；行为验证：[CLI tests](../../tests/workspace/flat-layout-cli.test.ts)。
