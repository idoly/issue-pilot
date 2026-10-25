# 退役旧工作目录迁移入口

基线 414ecfb。集中清理已被完整布局迁移替代的早期 work-only 迁移链路，没有触碰真实状态、历史数据库或已发布 SQL。

删除：

- `scripts/migrate-issue-work.ts`：只移动旧 `issues/<key>/work` 并独立更新会话 cwd；自行维护 socket 锁，与当前 ApplicationStateLease 重复。
- `src/workspace/work-directory-migration.ts`：只供上述旧入口及专用自测试调用的规划／应用实现。
- `tests/workspace/work-directory-migration.test.ts`：旧实现的专用测试；有价值的行为由当前迁移 owner 测试覆盖。
- HTTP work-files 测试内针对旧 CLI 的用例和随之无用的子进程／文件读取导入。
- `file-configuration.ts` 无消费者的 FileConfigurationError 转导出；错误定义仍属于 file-layout.ts，实际解析和调用保持原样。

发现依据：静态调用搜索、scripts／package／Containerfile／CI 入口及 Runbook 核对。当前文档唯一操作入口为 migrate-flat-issue-layout.ts，统一完成附件、会话、工作文件、旧 outputs/runtime 与相应 schema。旧命令没有独立当前业务用途，不再提供第二套可更新会话绑定的离线操作。早期旧命令允许的复杂目录并不因此自动由新命令接管：遇到未支持结构仍拒绝并保留现场，按 Runbook 演练和检查。

增强 `flat-layout-cli.test.ts`：除既有在线应用拒绝、数据库升级、附件／会话和历史成果保护外，加入旧 work/checkpoint.json，确认 plan 不改原文、apply 保留正文与 0600 模式、重复 apply 不重复移动。当前完整迁移模块原有 collision、rollback、未知路径和特殊文件测试继续保留。

继续保留 legacyIssueRoot、.legacy-output-links.json 管理文件保护、旧 Git registration 证据命名、退役配置字段以及独立用户／钉钉来源转换。它们有实际安全、历史或恢复用途，不按 legacy 关键词批量删除。历史 review 文档描述过去交付事实，保留原文。

本轮属于源码清理，不需要真实状态迁移。临时构建使用独立目录，完成后清理；线上不运行旧或新迁移命令。

验证：类型检查、独立构建及 git diff --check 通过；后端 541 项（540 通过、1 项 SSH fixture 环境跳过、0 失败），前端 27 文件、221 项通过。当前 CLI 的新增文件模式断言也单独复验通过。独立构建已清理，测试临时根由 fixture 清理；线上未重启、未修改真实状态。
