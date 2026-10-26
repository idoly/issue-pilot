# 旧工单目录迁移（仅旧状态升级）

[返回运维手册](../RUNBOOK.md)

当前正常使用和普通发布无需执行本页。只在启动明确报告旧目录未迁移、且 owner 确认状态来源时按完整状态迁移流程演练。不要把历史迁移当成每次部署的步骤。

先验证 SRT 的跨目录写入、宿主 TCP/Unix socket 旁路、取消与 SDK 文件输出，再完成独立完整副本演练，最后执行线上目录切换。执行边界与信任范围见[Agent](../AGENT.md#执行边界)。

迁移将旧 `issues/<key>` 中的附件原件、Pi JSONL、成果和运行文件直接归并到现有 `workspaces/<key>`，保留开发仓库路径。先按上文建立匹配的一致恢复点，再在独立副本执行：

```bash
# 只读预检，不升级数据库或移动文件；只输出统计。
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts --state-root /path/to/state
# 停止入口、优雅停止 API，确认进程和子进程退出后应用。
node --experimental-strip-types scripts/migrate-flat-issue-layout.ts --state-root /path/to/state --apply
```

应用先独占 API 使用的实例控制 Socket（沿用 `control/project-tools.sock` 以阻止旧版本并发启动，不处理项目命令），预检完整布局并写 `0600` 计划记录，然后调用数据库 migration owner 执行尚未应用的迁移。0061 增加附件工作副本名，0062 将旧正式数据处理工单及 SQL 处理历史统一转为正式问题调查，并拒绝新写入旧值。此步骤不启动 Agent 或运行应用的中断恢复逻辑。

文件迁移校验 mode/hash、原件与 DB 的关系、会话头和路径、目标重名及旧运行目录结构。编辑过的工作副本保持原样；同内容旧交付复用当前文件，不同内容交付保留摘要后缀文件和离线迁移索引。历史运行普通文件也保留为根目录 `.runtime-legacy-*`，原目录内已识别链接和空目录经 quarantine 后清理。未知目录或非预期文件停止供 owner 检查。

文件移动或绑定事务失败会回移本次文件；回滚失败聚合报告并保留证据。数据库 schema 升级不随文件回滚自动撤销，回退旧版本必须恢复匹配的完整恢复点。`flat_layout_committed_finalize_failed` 表示绑定已提交、最终清理失败，应先按私有计划核对现场。不要只替换 DB，也不要直接重试掩盖失败状态。重复成功应用不重新移动文件，但仍校验已迁移的原件和会话。

恢复服务后验证目录、附件下载、历史成果链接、会话回放、释放与重开，核对 DB integrity/FK、文件哈希和模式、Git refs/worktrees 及未知目录。JSONL 和用户脚本内容不改写；旧脚本中的绝对文件路径由工单 owner 检查。
