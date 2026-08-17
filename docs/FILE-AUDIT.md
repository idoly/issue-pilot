# Issue Pilot逐文件设计审计

范围：当前工作树中的227个Git tracked/new文件；排除本报告自身、node_modules、src/web/dist和.issue-pilot durable state。

## 判定原则

- 只有能移除真实协调复杂度的合并才执行；不按文件数或行数机械合并。
- HTTP、外部协议、Git/filesystem、SQLite和进程执行是实际边界，允许独立文件。
- 已发布migration和vendor shim不是可重构业务代码。
- 外部unknown只在Registry/HTTP/TypeBox边界解析一次；内部typed调用不重复shape校验。

## 当前结论

- Capability broker、Service revision、IssuePolicy及Workspace薄转发层已删除。
- AgentSessionContext只保留实际消费字段；Pi tool直接调用protocol client。
- Credential parse、ToolRuntime options、ApplicationResources signal和Nacos/MySQL内部shape校验已去重。
- 无引用helper、四个icon wrapper和不必要module export已删除。
- 共享process executor已从capability目录移到根级owner，与command授权ToolRuntime明确分层。
- 已发布migration、Solid testing vendor shim、Pi theme内部resource import和Workbench SearchService深路径override有明确保留理由。
- 大型Workspace/Agent owner共享queue、rollback、transaction或authorization状态，不按行数机械拆分。
- 零入站production文件均为application、Vite、Worker或Redis Worker入口；未发现其他dead production module。

## 逐文件清单

| 文件 | 行数 | 作用 | 设计判断 | 重复/兼容/无用判断 | 建议 |
| --- | ---: | --- | --- | --- | --- |
| `.containerignore` | 7 | 项目构建、忽略或运行配置 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `.github/workflows/ci.yml` | 36 | 项目构建、忽略或运行配置 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `.gitignore` | 11 | 项目构建、忽略或运行配置 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `.npmrc` | 1 | 项目构建、忽略或运行配置 | 必要registry配置 | 旧peer兼容开关已删除 | 保留单行 |
| `AGENTS.md` | 181 | 项目说明或Agent工作约定 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `README.md` | 146 | 项目说明或Agent工作约定 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `deploy/kubernetes/base/kustomization.yaml` | 6 | 单副本Kubernetes/Kustomize部署资源 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `deploy/kubernetes/base/service-account.yaml` | 5 | 单副本Kubernetes/Kustomize部署资源 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `deploy/kubernetes/base/service.yaml` | 14 | 单副本Kubernetes/Kustomize部署资源 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `deploy/kubernetes/base/stateful-set.yaml` | 161 | 单副本Kubernetes/Kustomize部署资源 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `docs/ARCHITECTURE.md` | 361 | ARCHITECTURE主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `docs/CONFIGURATION.md` | 317 | CONFIGURATION主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `docs/DEPLOYMENT.md` | 296 | DEPLOYMENT主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `docs/DEVELOPMENT.md` | 383 | DEVELOPMENT主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `docs/KUBERNETES.md` | 143 | KUBERNETES主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `docs/MODULE-AUDIT.md` | 186 | MODULE-AUDIT主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `docs/RUNBOOK.md` | 432 | RUNBOOK主题的权威项目文档 | 文档事实owner | 与README只做层级分工 | 保留 |
| `drizzle/0000_schema.sql` | 302 | 已发布不可变migration：schema | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0001_service_sort_order.sql` | 1 | 已发布不可变migration：service sort order | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0002_simple_service_model.sql` | 7 | 已发布不可变migration：simple service model | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0003_service_multiple_repositories.sql` | 26 | 已发布不可变migration：service multiple repositories | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0004_drop_service_kind.sql` | 1 | 已发布不可变migration：drop service kind | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0005_repository_kind.sql` | 7 | 已发布不可变migration：repository kind | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0006_simplify_issue_types.sql` | 3 | 已发布不可变migration：simplify issue types | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0007_strict_issue_model.sql` | 7 | 已发布不可变migration：strict issue model | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0008_remove_unimplemented_capabilities.sql` | 2 | 已发布不可变migration：remove unimplemented capabilities | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0009_enforce_issue_scope.sql` | 13 | 已发布不可变migration：enforce issue scope | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0010_drop_issue_evidence.sql` | 1 | 已发布不可变migration：drop issue evidence | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0011_remove_agent_comments.sql` | 2 | 已发布不可变migration：remove agent comments | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0012_drop_attachment_scan_status.sql` | 1 | 已发布不可变migration：drop attachment scan status | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0013_agent_results.sql` | 14 | 已发布不可变migration：agent results | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0014_capability_keys.sql` | 9 | 已发布不可变migration：capability keys | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0015_playwright_config.sql` | 3 | 已发布不可变migration：playwright config | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0016_disable_unconfigured_capabilities.sql` | 10 | 已发布不可变migration：disable unconfigured capabilities | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0017_sls_region.sql` | 16 | 已发布不可变migration：sls region | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0018_validate_capability_configs.sql` | 66 | 已发布不可变migration：validate capability configs | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0019_drop_deployment_capabilities.sql` | 1 | 已发布不可变migration：drop deployment capabilities | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0020_drop_issue_pilot_events.sql` | 1 | 已发布不可变migration：drop issue pilot events | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0021_remove_legacy_agent_columns.sql` | 4 | 已发布不可变migration：remove legacy agent columns | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0022_simplify_issue_statuses.sql` | 2 | 已发布不可变migration：simplify issue statuses | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0023_drop_agent_results.sql` | 1 | 已发布不可变migration：drop agent results | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0024_shorten_environment_names.sql` | 3 | 已发布不可变migration：shorten environment names | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0025_business_issue_types.sql` | 8 | 已发布不可变migration：business issue types | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0026_flatten_issue_branches.sql` | 9 | 已发布不可变migration：flatten issue branches | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0027_remove_service_sort_order.sql` | 1 | 已发布不可变migration：remove service sort order | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0028_remove_unused_scope_fields.sql` | 31 | 已发布不可变migration：remove unused scope fields | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0029_remove_unused_owner_fields.sql` | 52 | 已发布不可变migration：remove unused owner fields | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0030_remove_repository_kind.sql` | 18 | 已发布不可变migration：remove repository kind | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0031_remove_unused_issue_metadata.sql` | 20 | 已发布不可变migration：remove unused issue metadata | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0032_remove_redundant_pi_session_id.sql` | 3 | 已发布不可变migration：remove redundant pi session id | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0033_repository_deployment_branches.sql` | 83 | 已发布不可变migration：repository deployment branches | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0034_issue_repository_workspace_names.sql` | 18 | 已发布不可变migration：issue repository workspace names | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0035_issue_deployment_scope.sql` | 39 | 已发布不可变migration：issue deployment scope | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0036_issue_status_resolution.sql` | 32 | 已发布不可变migration：issue status resolution | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/0037_managed_users.sql` | 7 | 已发布不可变migration：managed users | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/meta/0000_snapshot.json` | 2205 | Drizzle migration顺序/初始schema元数据 | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `drizzle/meta/_journal.json` | 272 | Drizzle migration顺序/初始schema元数据 | 必要升级合同 | 兼容代码有意保留；禁止合并改写 | 保留，不修改 |
| `infra/application-compose.mjs` | 63 | application镜像、Compose或Operator脚本 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `infra/application.sh` | 194 | application镜像、Compose或Operator脚本 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `infra/config-value.mjs` | 15 | application镜像、Compose或Operator脚本 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `infra/images/application/Containerfile` | 53 | application镜像、Compose或Operator脚本 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `infra/playwright.sh` | 96 | application镜像、Compose或Operator脚本 | 运行/部署边界 | 单镜像单副本设计，无旧runtime兼容 | 保留 |
| `issue-pilot.config.ts` | 119 | 应用唯一根配置事实源 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `package-lock.json` | 7684 | npm依赖解析锁文件 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `package.json` | 107 | 包、脚本和依赖清单 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/agent/context.ts` | 38 | Agent session实际消费的model、tool和代码写权限上下文 | 必要session数据 | 已删除未消费scope/path/commit/deployment字段 | 保留当前扁平结构 |
| `src/agent/engine.ts` | 361 | Issue reservation、Agent运行状态、Pi session和消息协调 | 大型但内聚的状态边界 | 拆分会新增queue/rollback/authorization协调 | 保留，不按行数拆 |
| `src/agent/events.ts` | 116 | Agent事件发布、replay和live缓冲 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/agent/footer.ts` | 65 | 从Pi JSONL计算usage、cache和context统计 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/agent/pi-session.ts` | 184 | Pi SDK session、私有JSONL、resource loader和tool核对 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/agent/prompts.ts` | 139 | 初始、继续、更新时间和授权prompt构造 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/capabilities/aliyun.ts` | 52 | Aliyun CLI私有profile和调用primitive | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/contracts.ts` | 18 | Capability结果、timeout和target共享primitive | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/capabilities/dms.ts` | 138 | DMS只读SQL和CLI protocol client | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/elasticsearch.ts` | 28 | Elasticsearch只读HTTP client | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/http-client.ts` | 31 | 有预算、拒绝redirect的HTTP读取primitive | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/mysql.ts` | 88 | MySQL只读transaction和streaming client | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/nacos.ts` | 82 | Nacos登录及exact Data ID读取client | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/rabbitmq.ts` | 30 | RabbitMQ management只读HTTP client | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/redis-worker.ts` | 43 | 隔离node-redis连接、结果和OOM的Worker入口 | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/redis.ts` | 74 | Redis worker边界和命令构造 | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/registry.ts` | 241 | 七类capability保存parser、tool schema和metadata | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/capabilities/sls.ts` | 76 | SLS时间窗、分页和CLI protocol client | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/capabilities/sql.ts` | 9 | MySQL/DMS共用只读SQL lexical guard | 独立外部协议边界 | 按协议拆分值得；无兼容fallback | 保留，不互相合并 |
| `src/config.ts` | 14 | 解析项目根、state、数据库和Web构建绝对路径 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/configuration/contracts.ts` | 73 | 后端/Web共用的配置DTO和credential update类型 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/configuration/credentials.ts` | 68 | 配置脱敏及preserve/replace/clear合并 | 必要secret边界 | 存量重复parse已删除；update仅解析一次 | 保留独立 |
| `src/configuration/read.ts` | 98 | Catalog和完整脱敏配置的SQLite投影 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/db/bootstrap.ts` | 72 | 打开数据库后的migration、恢复和环境同步 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/db/client.ts` | 25 | libSQL/Drizzle连接、权限和SQLite pragma | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/db/migrate.ts` | 9 | Operator独立migration命令入口 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/db/schema.ts` | 79 | 当前Drizzle数据库模型 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/domain/contracts.ts` | 103 | 业务枚举、Issue key、Deployment config和共享状态判断 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/agent-routes.ts` | 98 | Agent消息、事件和重试HTTP routes | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/api.ts` | 185 | Fastify装配、错误映射、启动和关闭生命周期 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/attachment-routes.ts` | 32 | 附件完整性校验和下载route | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/attachment-store.ts` | 113 | 附件写入、quarantine、rollback/finalize和安全路径 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/configuration-routes.ts` | 85 | Catalog/配置/Service写入routes | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/input.ts` | 35 | HTTP unknown输入的少量fail-fast解析器 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/issue-routes.ts` | 283 | Issue创建、编辑、列表、状态和评论routes | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/production.ts` | 7 | application镜像唯一生产入口 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/route-context.ts` | 55 | Route共享依赖、当前用户、Issue查找和reservation映射 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/service-configuration.ts` | 152 | Service配置边界解析和事务写入 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/source-browser-routes.ts` | 65 | Source tree/file/search/history/diff routes | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/sse.ts` | 107 | SSE顺序、背压、预算和断连状态机 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/http/user-routes.ts` | 89 | SQLite用户增改和启停routes | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/web-routes.ts` | 45 | 静态Web/Workbench和SPA fallback | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/http/workspace-routes.ts` | 45 | Workspace stats、转换和release routes | 按HTTP域拆分 | 没有额外manager；routes直接协调owner | 保留域边界 |
| `src/pi/models.ts` | 113 | 共享Pi ModelRuntime和离线可用模型快照 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/pi/tools.ts` | 49 | TypeBox解析Agent tool input并直调protocol client | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/process.ts` | 76 | 共享spawn、abort、timeout和output budget执行器 | 必要底层进程边界 | 已从capability目录移到共享根级owner | 保留，与授权ToolRuntime分层 |
| `src/serial.ts` | 43 | 进程内串行队列和按key串行队列 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/tool-runtime.ts` | 68 | npm/Maven/Aliyun命令白名单、环境收敛和临时HOME | 必要进程授权边界 | 双options中间层已删除 | 保留，不并入protocol client |
| `src/web/index.html` | 13 | Vite应用入口HTML | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/app/AgentPanel.test.ts` | 387 | web域的AgentPanel行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/AgentPanel.tsx` | 403 | AgentPanel前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/App.test.tsx` | 521 | App前端功能组件 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/App.tsx` | 180 | App前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/ApplicationResources.test.tsx` | 64 | ApplicationResources前端功能组件 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/ApplicationResources.tsx` | 88 | ApplicationResources前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/AttachmentPreview.tsx` | 150 | AttachmentPreview前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/CodeBrowser.tsx` | 94 | CodeBrowser前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/ConfigurationView.tsx` | 356 | ConfigurationView前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/IssueForm.tsx` | 89 | IssueForm前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/IssueQueue.tsx` | 187 | IssueQueue前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/IssueWorkspace.tsx` | 231 | IssueWorkspace前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/Statistics.tsx` | 157 | Statistics前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/UserManagement.tsx` | 155 | UserManagement前端功能组件 | 用户功能边界 | 显式UI比schema-driven动态表单更清晰 | 保留；不建通用页面框架 |
| `src/web/src/app/agent-stream.test.ts` | 51 | web域的agent-stream行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/agent-stream.ts` | 128 | EventSource握手、重连和generation状态机 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/app/configuration-model.test.ts` | 54 | web域的configuration-model行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/configuration-model.ts` | 41 | 配置表单draft到credential update请求序列化 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/app/conversation.ts` | 224 | Pi事件到可见对话的纯状态投影 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/app/model.test.ts` | 18 | web域的model行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/model.ts` | 52 | Issue显示标签、时间和文件大小纯投影 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/app/paste-editor.test.ts` | 59 | web域的paste-editor行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/app/paste-editor.ts` | 137 | 附件粘贴占位符的文本编辑算法 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/app/pi-theme.ts` | 33 | Pi dark theme到CSS变量转换 | 有价值但依赖内部资源 | Pi暂无适合浏览器的公开theme API | 暂留；升级Pi时重点复核 |
| `src/web/src/app/styles.css` | 738 | 对应前端界面样式 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/data/client.test.ts` | 176 | web域的client行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/data/client.ts` | 232 | Web DTO、HTTP client和current-user header | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/main.tsx` | 9 | 项目构建、忽略或运行配置 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/test-setup.ts` | 31 | 项目构建、忽略或运行配置 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/ui/Markdown.test.tsx` | 29 | web域的Markdown行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/ui/Markdown.tsx` | 36 | 主应用Markdown渲染、净化和缓存 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/ui/icons.tsx` | 86 | lucide core IconNode到Solid组件的单一适配器 | 必要Solid适配 | 四个无引用icon wrapper已删除 | 保留单一adapter |
| `src/web/src/ui/scrollbars.css` | 43 | 对应前端界面样式 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/extension-api.ts` | 23 | 固定LocalProcess Workbench extension注册 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/extensions.d.ts` | 7 | Vite虚拟extension模块类型声明 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/github-dark-default.LICENSE` | 21 | 项目构建、忽略或运行配置 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/github-dark-default.json` | 651 | 构建、主题或包元数据 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/main.ts` | 273 | 只读VS Code Workbench组合和布局命令 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/markdown-preview.test.ts` | 102 | markdown-preview Workbench集成模块 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/vscode/markdown-preview.ts` | 134 | 上游markdown.api.render到只读Preview Pane | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/search-service.ts` | 10 | 用上游SearchService阻止默认虚拟树遍历 | 必要上游例外 | 唯一深路径import；默认实现会越过服务端预算 | 保留并锁版本 |
| `src/web/src/vscode/source-control.test.ts` | 144 | source-control Workbench集成模块 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/vscode/source-control.ts` | 284 | 只读SCM Changes、history和revision diff | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/source-file-system.test.ts` | 97 | source-file-system Workbench集成模块 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/vscode/source-file-system.ts` | 157 | Source API到VS Code只读filesystem | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/source-search.test.ts` | 82 | source-search Workbench集成模块 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `src/web/src/vscode/source-search.ts` | 87 | VS Code text search到预算Source API | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/workbench.css` | 77 | 对应前端界面样式 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/src/vscode/workers.ts` | 26 | Monaco/Workbench worker工厂 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/tsconfig.json` | 17 | 构建、主题或包元数据 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/vite.config.ts` | 146 | 双入口构建及theme/icon/markdown extension资源注册 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/web/vscode.html` | 13 | Vite应用入口HTML | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/workspace/deployment.ts` | 42 | Deployment Repository关系完整性和顺序解析 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/workspace/generated-directory.ts` | 48 | 生成目录原子替换和rollback primitive | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/workspace/git.ts` | 388 | bare store、fetch、checkout、worktree和批量rollback | 大型但内聚的状态边界 | 拆分会新增queue/rollback/authorization协调 | 保留，不按行数拆 |
| `src/workspace/lifecycle.ts` | 491 | Workspace深检、release/reopen、quota和maintenance | 大型但内聚的状态边界 | 拆分会新增queue/rollback/authorization协调 | 保留，不按行数拆 |
| `src/workspace/project-tools.ts` | 309 | Issue-scoped Unix socket Node/Maven broker | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/workspace/project-wrappers.ts` | 66 | 生成固定node-project/maven-project客户端脚本 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/workspace/project.ts` | 396 | Issue项目prepare、dev/read-only hydration和finalize | 大型但内聚的状态边界 | 拆分会新增queue/rollback/authorization协调 | 保留，不按行数拆 |
| `src/workspace/runtime.ts` | 89 | Issue runtime链接原子生成和批量失败隔离 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `src/workspace/source-browser.ts` | 445 | 受控tree/file/search/history/diff服务端读取 | 大型但内聚的状态边界 | 拆分会新增queue/rollback/authorization协调 | 保留，不按行数拆 |
| `src/workspace/state.ts` | 210 | state路径、Repository持久状态分类和布局证据保护 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `tests/agent/context.test.ts` | 34 | agent域的context行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/agent/engine.test.ts` | 239 | agent域的engine行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/agent/events.test.ts` | 161 | agent域的events行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/agent/pi-session.test.ts` | 157 | agent域的pi-session行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/agent/prompts.test.ts` | 35 | agent域的prompts行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/agent/repository-preparation.test.ts` | 267 | agent域的repository-preparation行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/capabilities/dms.test.ts` | 101 | capabilities域的dms行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/capabilities/external-data.test.ts` | 200 | capabilities域的external-data行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/capabilities/mysql.test.ts` | 101 | capabilities域的mysql行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/capabilities/nacos.test.ts` | 88 | capabilities域的nacos行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/capabilities/sls.test.ts` | 75 | capabilities域的sls行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/configuration/credentials.test.ts` | 48 | configuration域的credentials行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/db/bootstrap.test.ts` | 111 | db域的bootstrap行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/db/sqlite.test.ts` | 211 | db域的sqlite行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/domain/contracts.test.ts` | 33 | domain域的contracts行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/domain/serial.test.ts` | 59 | domain域的serial行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/api-startup.test.ts` | 91 | http域的api-startup行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/attachment-api.test.ts` | 153 | http域的attachment-api行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/attachments.test.ts` | 45 | http域的attachments行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/configuration-api.test.ts` | 246 | http域的configuration-api行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/fixture.ts` | 141 | http域的fixture行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/issue-api.test.ts` | 216 | http域的issue-api行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/runtime-api.test.ts` | 68 | http域的runtime-api行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/service-configuration.test.ts` | 36 | http域的service-configuration行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/sse.test.ts` | 121 | http域的sse行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/user-api.test.ts` | 102 | http域的user-api行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/http/web.test.ts` | 70 | http域的web行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/infra/application.test.ts` | 146 | infra域的application行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/infra/playwright.test.ts` | 58 | infra域的playwright行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/pi/models.test.ts` | 105 | pi域的models行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/pi/tools.test.ts` | 40 | pi域的tools行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/process/process.test.ts` | 18 | process域的process行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/tool-runtime.test.ts` | 52 | tool-runtime.test.ts域的tool-runtime行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/deployment.test.ts` | 55 | workspace域的deployment行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/generated-directory.test.ts` | 77 | workspace域的generated-directory行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/git.test.ts` | 215 | workspace域的git行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/lifecycle.test.ts` | 691 | workspace域的lifecycle行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/project-tools.test.ts` | 155 | workspace域的project-tools行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/project-wrappers.test.ts` | 36 | workspace域的project-wrappers行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/read-only.test.ts` | 159 | workspace域的read-only行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/runtime.test.ts` | 75 | workspace域的runtime行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/source-browser.test.ts` | 125 | workspace域的source-browser行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tests/workspace/state.test.ts` | 166 | workspace域的state行为回归测试 | 必要回归证据 | 测试重复不进入生产调用链 | 保留；随owner变更 |
| `tsconfig.json` | 17 | 构建、主题或包元数据 | 职责明确 | 未发现重复校验、兼容fallback或死代码 | 保留原位 |
| `vendor/solid-testing-library/LICENSE` | 21 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
| `vendor/solid-testing-library/README.md` | 14 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
| `vendor/solid-testing-library/dist/index.cjs` | 130 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
| `vendor/solid-testing-library/dist/index.d.cts` | 160 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
| `vendor/solid-testing-library/dist/index.d.ts` | 160 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
| `vendor/solid-testing-library/dist/index.js` | 106 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
| `vendor/solid-testing-library/package.json` | 21 | 固定的第三方Solid testing shim内容 | 必要临时第三方shim | 不是业务抽象；上游兼容Solid 2后可删除 | 保留并隔离 |
