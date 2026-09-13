# Issue Pilot模块设计审计

本文按目录和功能模块审计当前实现，补充[逐文件审计](FILE-AUDIT.md)。范围包括production code、Web、Container/Kubernetes、tests和migration；排除`node_modules`、`src/web/dist`和真实`.issue-pilot`。本轮静态依赖图包含98个生产TypeScript模块、275条内部依赖边，未发现循环依赖或无入口业务模块。

## 判定方法

每个模块回答：

- 它拥有哪个事实、状态或外部边界？
- 是否只是转发中间层？引入的概念是否减少了真实复杂度？
- 是否重复解析、校验、状态、代码或兼容逻辑？
- 是否存在zero-inbound、dead export或无用依赖？
- 删除、合并或移动后，transaction、rollback、authorization和failure semantics是否更简单？

结论分为：

- **保留**：独立事实、状态机、协议或安全边界。
- **精简**：职责成立，但公开面或重复代码可减少。
- **移动**：职责成立但目录归属错误。
- **删除/合并**：没有独立状态、协议、transaction或复用价值。

## 已执行结论

- 删除Capability broker、Service revision、IssuePolicy和Workspace薄转发层。
- 合并`ApplicationResources`重复people/users state。
- 删除重复credential parse、ToolRuntime双options和Nacos/MySQL内部shape校验。
- 删除无引用helper、icon wrapper和module export。
- 将共享底层process executor从`src/capabilities/local-exec.ts`移动到`src/process.ts`；对应test移动到`tests/process/process.test.ts`。它服务Source Browser、ToolRuntime和Aliyun client，不属于某一种capability。
- 将Agent Web theme收归Issue Pilot CSS，删除Pi terminal theme内部resource依赖。
- 升级Solid runtime/compiler到`2.0.0-rc.0`，改用上游testing library并删除本地vendor shim及镜像COPY残留。

## 根共享模块

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `issue-pilot.config.ts` + `src/config.ts` | 唯一application config和absolute path projection | 两层必要：前者由Node/Web共享，后者绑定project root | Image/resource只在Kubernetes manifest，不与应用配置重复 | 保留；禁止各模块复制config |
| `src/domain/contracts.ts` | 共享enum、Issue key、Deployment config和predicate | 领域事实值得集中 | 不应吸收HTTP/capability parser | 保留小型domain contract |
| `src/serial.ts` | Promise-tail serial和keyed serial mechanics | 去除queue实现重复，但不拥有业务锁 | 业务锁域仍独立，无global mutex | 保留 |
| `src/process.ts` | Generic spawn、abort、timeout、output budget | 稳定OS process边界，供多个domain复用 | Linux使用独立process group清理后代；不含command authorization | 保留根级primitive |
| `src/tool-runtime.ts` | Allowlist `npm/mvn/aliyun`、environment收敛、temporary HOME | 必要application process授权边界 | 不与generic process executor或protocol client合并 | 保留；单options API已精简 |

`src/process.ts`只执行明确command；`src/tool-runtime.ts`决定哪些command可执行。这两个概念分别对应mechanism和authorization，合并会让Source Browser被迫依赖project/capability allowlist，拆得更细则没有收益。

## Database和migration

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `src/db/client.ts` | `0600`SQLite/libSQL/Drizzle connection | 必要storage boundary | File mode和connection setup没有重复owner | 保留 |
| `src/db/bootstrap.ts` | Migration、structure check、interrupted recovery、bootstrap user、Environment sync | Startup transaction sequence内聚 | 不是通用migration wrapper | 保留 |
| `src/db/schema.ts` | Current relational model | 唯一schema事实源 | 不从historical migration反推current model | 保留 |
| `src/db/migrate.ts` | Operator migration entry | 独立process entrypoint | Knip zero-inbound不代表dead | 保留 |
| `drizzle/*` | Published upgrade history | 历史兼容是有意合同 | 即使旧column/trigger已无current用途也不可重写 | 保留immutable |

Bootstrap看似混合多个步骤，但它们共享“数据库打开后、API route注册前”的failure/close语义。拆成manager只会增加startup orchestration。

## Configuration

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `src/configuration/contracts.ts` | Catalog/config DTO和credential update protocol | Config GET返回完整credential，`preserve/replace/clear`仍提供明确更新语义 | `Projected*`命名避免把含secret DTO误认为public-safe | 保留 |
| `src/configuration/credentials.ts` | Credential projection、intent merge、单次Registry parse | Secret边界独立且可测试 | 与Registry各自保留小型record parser，避免新增万能validation层 | 保留；不合并validator |
| `src/configuration/read.ts` | Catalog和完整config snapshot projection | 隔离raw row、join和DTO组装 | 仅被route调用不等于薄层；拥有复杂join/DTO | 保留 |
| `src/http/service-configuration.ts` | Service request parse、model/repository validation、transaction apply | Command prepare/apply边界值得保留 | Route不应吸收配置write transaction | 保留 |

已删除revision/If-Match链。当前scope queue + snapshot transaction已提供进程内一致性，再加revision token会重复协调且增加Web状态。

## HTTP

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `src/http/api.ts` + `production.ts` | API assembly/resource lifecycle和production entry | Assembly与entry分离便于test injection | `production.ts`是runtime entrypoint，不能因zero-inbound删除 | 保留 |
| `src/http/input.ts` | HTTP `unknown` parser和`ApiError` | 小型HTTP boundary helper | 与Registry parser的error/status语义不同 | 保留，不做全局validation框架 |
| `src/http/route-context.ts` | Shared dependencies、subject/Issue guard、reservation error mapping | 有重复消除和authorization价值 | 不是额外service layer | 保留 |
| `*-routes.ts` | User/Config/Issue/Agent/Attachment/Source/Workspace/Web domains | 按HTTP domain拆分便于测试和授权 | 合成单route文件会降低清晰度；再加manager会增加ceremony | 保留当前粒度 |
| `attachment-store.ts` | Cross-media attachment transaction | Prepare/rollback/finalize边界必要 | 不能并入route或generic file store | 保留 |
| `sse.ts` | Ordered writer、backpressure和transport lifecycle | 独立状态机值得存在 | 不与Agent event projection或Web controller合并 | 保留 |

HTTP helper只处理HTTP shape/status；business/parser由owner处理。相似`text/record`校验跨层合并会制造一个同时知道HTTP status和capability error的万能validation layer。

## Agent和Pi

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `src/agent/context.ts` | Minimal session model/tool/write permission | 替代旧IssuePolicy后概念足够小 | 已删除path/commit/deployment/scope复制 | 保留 |
| `engine.ts` | Per-Issue run/steer、reservation、state和session | 大型但共享并发状态，内聚 | 拆分会复制maps/queue/cleanup | 保留，不按行数拆 |
| `events.ts` + `footer.ts` | Event bus/replay和JSONL usage projection | 一个拥有transport-neutral event，一个拥有pure stats | 不与SSE/Web state合并 | 保留 |
| `pi-session.ts` | Pi storage/resource/session lifecycle | 外部SDK边界和private JSONL规则集中 | 不新增adapter/grant/session manager | 保留 |
| `prompts.ts` | Prompt text/time context | 内容变化可独立测试 | 不把credential/scope复制进prompt | 保留 |
| `src/pi/models.ts` | Shared offline ModelRuntime/catalog | 避免每请求重复runtime和远程catalog | Process-private writable copy有Pi storage必要性 | 保留 |
| `src/pi/tools.ts` | TypeBox parse和direct protocol dispatch | 当前链路最短 | Broker/grant/policy均已删除 | 保留direct dispatch |

AgentEngine虽大，但run counts、reservations、sessions和shutdown必须共享原子判断。拆成多个manager会增加cross-manager synchronization，属于过度设计。

## Capability

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `registry.ts` | Save parser、Pi input schema、metadata | 三者围绕同一capability definition，集中有价值 | Client不再重复typed config shape | 保留Registry，不引入schema framework |
| `contracts.ts` | Result serialization、timeout signal、Pi text result | 多client真实复用 | 不包含target policy或broker | 保留小型helper |
| `sql.ts` | MySQL/DMS read-only lexical guard | 数据库SQL安全边界 | DMS只在`executeScript`窄例外复用，不恢复旧CLI合同 | 保留 |
| `http-client.ts` | Bounded HTTP、redirect拒绝、abort | Nacos/RabbitMQ/ES共享网络机制 | Target URL仍由各client授权 | 保留 |
| `aliyun.ts` | Temporary profile和Aliyun invocation | SLS secret lifecycle | 不使用Operator profile或container adapter | 保留 |
| Nacos/MySQL/RabbitMQ/ES/DMS/SLS clients | 各外部协议和response validation | Protocol边界值得独立 | 不互相合并成generic connector | 保留 |
| `redis.ts` + `redis-worker.ts` | Authorization/Worker lifecycle和node-redis执行 | Worker heap隔离完整RESP materialization | Worker是entrypoint，不是dead module | 保留双文件 |

Registry和TypeBox解析内部input/config一次；client仍必须验证network response、external target membership和timeout；除明确不设应用层byte limit的DMS MCP外还验证result size。这些不是重复校验。

## Workspace、Git和Source

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `state.ts` | Path owner、Repository三态、managed layout/evidence protection | 多owner共享的核心事实 | 不添加legacy layout repair | 保留 |
| `deployment.ts` | Deployment Repository completeness/order | 独立authoritative join | 虽只被Project调用，但避免Agent/route重写join | 保留 |
| `git.ts` | Bare/fetch/checkout/worktree/batch rollback/Repository lock | 大型但共享Git transaction和lock | 拆client/manager会分散rollback | 保留 |
| `generated-directory.ts` | Atomic generated directory replace/rollback | Runtime和wrapper两处真实复用 | 不是过度抽象 | 保留 |
| `runtime.ts` + `project-wrappers.ts` | Runtime links和dev wrapper生成 | 产物/lifecycle不同，共用atomic primitive即可 | 合并会混合symlink与script协议 | 保留分离 |
| `project.ts` | Agent/cold-start/reopen project prepare | 单一project coordinator | 已吸收development/read-only薄层 | 保留 |
| `project-tools.ts` | Unix socket、DB/path reauthorization、npm/Maven | 稳定security/process boundary | 不能并入protocol client或Pi bash | 保留 |
| `source-browser.ts` | SQLite/runtime授权、有界读取和dev文件/Git mutation | 大型但同一Source security boundary | Tree/file/search/history/diff/mutation共享context/path checks和reservation前提 | 保留；已删除重复可写判断和未使用exit-code参数 |
| `lifecycle.ts` | Inspection/stats/release/reopen/maintenance | 共享lifecycle/inspection queue和rollback | 拆分会产生reverse lock风险 | 保留 |

`deployment.ts`、`generated-directory.ts`虽然文件较小，但各自对应可复用且可单测的稳定合同。删除它们只会把逻辑复制回大型owner。

## Web application

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `data/client.ts` | Request、DTO、Source response validation、subject header | 单一browser API boundary | 文件较长但按同一transport组织；拆domain client会增加re-export | 保留 |
| `ApplicationResources.tsx` | Catalog/config/user shared resources和generation | Latest-wins async state有真实价值 | people/users duplicate signal已合并 | 保留 |
| `App.tsx` | Navigation、selection和top-level composition | App shell职责明确 | Business form不塞回App | 保留 |
| IssueQueue/IssueWorkspace/IssueForm | Queue、detail/edit和form controls | 按user workflow拆分 | Form复用有价值，无generic form framework | 保留 |
| AgentPanel + `agent-stream.ts` + `conversation.ts` | UI、transport state、pure event projection | 三层分别拥有UI/connection/projection | 合并会重引入stale EventSource bugs | 保留 |
| ConfigurationView + `configuration-model.ts` | Explicit capability forms和payload serializer | 显式UI适合异构capability | Draft克隆复用Solid 2 `snapshot`；generic schema form会隐藏credential intent | 保留 |
| AttachmentPreview、Statistics、UserManagement | 独立user workflows | Feature component边界清楚 | 无重复domain state | 保留 |
| `model.ts`、`paste-editor.ts` | Pure display/edit algorithms | 有多处调用或独立edge-case tests | 不需要service class | 保留function module |
| `ui/Markdown.tsx`、`icons.tsx` | Shared sanitized Markdown和Solid icon adapter | UI primitive真实复用 | Dead icons已删除 | 保留 |

`data/client.ts`和`ConfigurationView.tsx`是Web较大文件，但前者共享request/Source validation，后者共享同一Service draft和credential intent。当前没有可独立拥有状态的子manager；按行数拆分收益不足。

## Workbench

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `main.ts` | Workbench services/settings/extension assembly | Browser entrypoint，组合集中更清楚 | Knip zero-inbound是HTML entry误报 | 保留 |
| `extension-api.ts` | Fixed LocalProcess extension manifest/API | 隔离唯一可执行Workbench extension | 不开放gallery或dynamic extension | 保留 |
| `source-file-system.ts` | Access-aware multi-root filesystem | VS Code协议边界 | Dev复用框架文件创建/保存/删除/重命名；server再次授权，readonly环境拒绝 | 保留 |
| `source-search.ts` | Native Search provider | 将progress/case/word映射到Source API | 不在browser遍历tree | 保留 |
| `search-service.ts` | Override upstream default tree traversal | 唯一深路径exception有性能/授权价值 | 上游无public hook | 暂留并锁version |
| `source-control.ts` | SCM Changes/Graph、workspace/revision Diff、dev Git action和当前行blame | 共享SCM/revision cache、public EditorService和provider state | Stage/Unstage/Discard/Commit经Source API，不开放任意Git命令 | 保留 |
| `markdown-preview.ts` | Extension render到readonly Editor Pane | 使用upstream render避免第二Markdown parser | 不创建Webview/Service Worker | 保留 |
| `workers.ts` | Monaco/language/extension worker factory | Worker entrypoint | Knip zero-inbound是`new URL`/Vite误报 | 保留 |
| `vite.config.ts` | Multi-entry和static resource registration | Build-time owner | Virtual modules是必要bundler boundary | 保留 |

Workbench依赖较多不是微服务式过度设计，而是嵌入VS Code所需的service/extension协议。约束是固定贡献、prod/test与released snapshot readonly、dev文件/Git mutation经Source API且无Node host。`main.ts`中的少量DOM菜单桥接用于补足嵌入式Context View和父层布局限制，不扩展成自有IDE abstraction。

## Container和Kubernetes

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `Containerfile` | Node/Pi/Maven/Aliyun和application的single image | 标准multi-stage artifact，无项目build wrapper | 不拆tool images或sidecar | 保留根目录单文件 |
| `deploy/issue-pilot.yaml` | Single-node Deployment、hostPath和Service | 当前唯一生产拓扑 | 无Kustomize、PVC/Secret abstraction、RBAC或多副本兼容 | 保留单manifest |
| `scripts/playwright.sh` | Ephemeral browser test container | 仅Operator测试边界 | 参数由脚本拥有，不进入application config | 保留开发脚本 |

Compose generator、application lifecycle shell、config scalar bridge、Kustomize base和独立Kubernetes文档已删除。标准`podman build/push`与`kubectl apply`足够表达当前部署。

## Tests和docs

| 模块 | 作用 | 设计判断 | 重复/兼容/无用判断 | 结论 |
| --- | --- | --- | --- | --- |
| `tests/*` | Backend/deployment real behavior regression | 按owner/domain组织 | Test fixture重复用于隔离，不进入production | 保留 |
| Web colocated tests | Component/pure state/Workbench tests | 与source同目录便于Vite resolver | 不与backend tests强制统一目录 | 保留 |
| `styles.css` Agent theme tokens | Agent会话颜色、字体和状态token | Web视觉事实由Issue Pilot拥有 | 已删除Pi内部theme resource依赖和runtime转换 | 保留CSS-local token |
| Solid test toolchain | 上游testing library和Solid RC compiler/runtime | 依赖边界清晰，无本地第三方副本 | Peer metadata override集中在package manifest | 保留上游包；上游发布RC peer后删除override |
| `docs/*` | Architecture/config/deploy/develop/runbook/audit owners | 按事实职责拆分 | README只做入口，避免重复细节 | 保留 |

## 最终判断

当前架构没有值得删除的production中间层或zero-inbound业务模块。继续把HTTP domains、protocol clients、Git/lifecycle owner或Workbench providers合并，会减少文件数但增加共享状态、反向依赖和failure-path复杂度。审计文档本身已收敛：删除重复且失真的巨型历史报告，只保留本模块判断和逐文件清单。

模块审计中的可执行精简项均已完成。Agent Web主题已归Issue Pilot CSS所有；Solid RC使用上游testing library，不再维护vendor副本。剩余两个package-level peer override仅修正上游尚未发布的RC metadata，待对应包声明RC兼容后直接删除。

除此之外，新增抽象必须证明它减少至少一种真实复杂度：重复transaction、重复rollback、重复authorization、重复protocol parsing或重复UI state。仅为缩短文件、统一命名或让静态分析器不报entrypoint，不足以成立。
