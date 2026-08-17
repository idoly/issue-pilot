# Issue Pilot全面代码审查

审查基线：`0e1924d`；范围为220个Git tracked文件，排除本报告自身、`node_modules`、`src/web/dist`和真实`.issue-pilot`。本报告是该提交的历史审查证据；当前文件和部署结论以[模块审计](MODULE-AUDIT.md)、[逐文件清单](FILE-AUDIT.md)和[部署说明](DEPLOYMENT.md)为准。其后已落实Linux process group后代清理，并将Compose/Kustomize收敛为根`Containerfile`和单个Kubernetes manifest。

## 执行摘要

- **整体评价**：架构与当前规模匹配。SQLite、Git、Agent、Web保持单体，复杂度主要来自真实transaction、rollback、授权和外部协议，不是形式化分层。
- **P0**：未发现。
- **P1**：进程后代终止、Solid RC peer override、Workbench深路径、明文capability transport、外部身份边界，共5类。
- **P2**：ConfigurationView源码可读性、Workbench产物体积、部署实例配置与base image可复现性。
- **依赖方向**：Madge处理107个源码模块，未发现循环依赖。
- **重复**：jscpd分析90个production文件，仅1处9行clone，重复行0.08%、token 0.05%；该clone跨Registry/credential错误边界，建议保留。
- **无用代码**：Knip剩余6个文件均为CLI/HTML/Worker/深路径入口，4个export均有动态或测试消费；未发现可直接删除的production文件。
- **供应链**：`npm audit`为0 vulnerability；严格`npm ci --legacy-peer-deps=false`通过。

## 优先级发现

### P0 必须处理

无。当前测试、边界检查和rollback合同未暴露可确认的P0正确性或安全缺陷。

## 项目整体分析

- **目录划分**：`agent`、`capabilities`、`configuration`、`db`、`http`、`pi`、`workspace`和`web`各自对应稳定事实或协议边界；没有职责混乱的`services`/`utils`收纳目录。`src/process.ts`已从capability目录移到共享根级，归属正确。
- **分层与依赖方向**：HTTP协调domain owner，Web只经HTTP DTO，capability client不反向依赖route，Workspace不依赖Web。107个源码模块无循环依赖。
- **中间层**：route-context、ToolRuntime、GeneratedDirectory、PiSessionRuntime都拥有授权、rollback、外部SDK或测试注入价值，不是纯转发。已删除的broker/policy/revision薄层不应恢复。
- **复杂度匹配**：单体复杂度来自SQLite transaction、Git rollback、Agent concurrency、SSE backpressure和只读协议，这些是当前功能的必要复杂度。没有微服务、事件总线平台、通用repository layer或schema-form等提前设计。
- **自然演进**：新增capability沿Registry + protocol client + tool schema演进；新增HTTP行为沿domain route演进；schema只追加migration。无需预建plugin framework。

## 代码质量分析

- **可读性**：命名总体直接，owner清楚。主要弱点是`ConfigurationView.tsx`超长JSX行，而不是文件数量。
- **可维护性**：transaction/rollback测试覆盖较强；大Workspace和Agent owner虽长，但拆分会复制queue和状态，当前保持内聚更易维护。
- **稳定性**：附件、Git、runtime和shutdown均有失败恢复；唯一明显缺口是child process descendants。
- **性能**：Source、capability、SSE、Markdown cache和Workspace检查均有budget；Workbench静态体积是主要可测优化点。
- **安全**：credential脱敏、scope校验、只读事务、路径realpath和文件模式较完整；身份和部分TLS由部署边界承担，必须显式验收。
- **三年维护判断**：新人可沿目录和owner定位修改点。最应避免的是重新引入通用manager、validation framework或为减少文件数拆散transaction state。

### P1 推荐处理

1. **后代进程可能残留**：`src/process.ts`只kill直接child。npm/Maven或脚本产生后代进程时，timeout/abort不保证整个任务树退出。建议Linux容器中使用独立process group并对group发送TERM/KILL，补后代进程回归测试。
2. **Solid RC peer metadata债务**：`package.json`对Ant Design Solid和testing library做精确override。当前严格安装、测试和构建通过，但升级任何相关包都必须重新验证并尽快删除已被上游覆盖的override。
3. **Workbench深路径脆弱性**：`search-service.ts`导入上游内部SearchService。它能阻止默认远程树遍历，价值高于风险；应锁版本并在升级时重点验收，不应复制上游类。
4. **Capability明文传输依赖内网**：RabbitMQ固定HTTP，Nacos/ES允许HTTP，MySQL/Redis没有TLS配置。若目标跨越不可信网络，credential和结果可能被监听。简单方案是把加密可信网络设为部署硬条件；只有真实需要时才逐协议增加TLS字段。
5. **身份与审计归属依赖外部边界**：subject header由浏览器选择，API只确认它是active user，不证明调用者身份。这是明确的部署模型而非隐藏bug；裸端口不能暴露。若操作归属必须可信，proxy需派生并覆盖subject，或API需验证身份。

### P2 可选优化

1. **ConfigurationView可读性**：七种显式capability表单是正确选择，但多行超过1500字符。先格式化，不要引入schema form或新增manager。
2. **Workbench产物体积**：构建产物约46MB，最大主chunk约12.2MB，另含上游7MB source map。Workbench独立入口避免拖累主应用；只有测量确认网络/镜像收益后再做资源裁剪。
3. **部署可移植性**：root config包含bootstrap用户和网络参数。保持单一配置源，但新环境上线前必须显式审查，不增加环境变量覆盖。
4. **镜像base可复现性**：当前tag + lockfile已满足一般内部部署；若供应链保证要求提高，可固定base digest，同时建立定期更新流程。

## 最大问题Top 10

1. 子进程timeout不能保证后代进程退出。
2. Solid RC依赖两个临时peer override。
3. Workbench SearchService依赖未公开深路径。
4. 部分capability credential可经明文内网协议传输。
5. API无内置身份验证，浏览器subject只提供可选择的操作归属标签。
6. ConfigurationView超长JSX行增加review成本。
7. Workbench静态产物较大，但已与主入口隔离。
8. Repository脚本与API共享UID，不是恶意代码sandbox；必须只运行可信代码。
9. root config带部署实例身份，跨环境复用需要人工审查。
10. 单副本启动会检查全部durable state；规模显著增长后启动时间是首个扩展瓶颈，但当前并发与数据规模匹配。

## 删除、合并与抽象结论

- **可以删除**：当前无新的production删除项。旧broker、revision、IssuePolicy、Workspace薄层、Pi theme和testing vendor已完成删除。
- **可以合并**：当前无建议合并项。合并HTTP domains、protocol clients或Workspace owner会破坏错误、transaction或lock边界。
- **可以减少的抽象**：当前没有只有形式价值的interface/manager；`CommandExecutor`、`ToolRuntime`和generated-directory operations都承担测试注入或安全边界。
- **可以减少的模块**：无。零入站模块均为工具约定入口。
- **推荐方向**：优先加强process group终止；随后消除上游peer/deep-import债务；UI只做格式化和测量驱动的资源优化。

## 预计收益

- process group修复不会显著减少代码量，但可消除timeout后残留任务这一类运维故障。
- 删除peer override和深导入最终可减少约10-20行脆弱配置/集成代码，并降低升级验收成本。
- ConfigurationView纯格式化不减少代码，但预计显著降低该文件review冲突和定位时间。
- 不执行无收益合并，避免新增约5-10个协调接口或manager；长期收益主要是保持调用链和failure semantics稳定，而不是追求行数。

## 逐文件审查

### 根配置与共享模块

#### .containerignore

- **类型**：Project configuration/resource；7行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### .gitignore

- **类型**：Project configuration/resource；11行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### .npmrc

- **类型**：Project configuration/resource；1行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：必要registry配置。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留单行

#### issue-pilot.config.ts

- **类型**：TypeScript module；119行。
- **作用**：应用唯一根配置事实源。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站41处：`infra/application-compose.mjs`、`infra/config-value.mjs`、`src/agent/prompts.ts`、`src/capabilities/contracts.ts`、`src/capabilities/dms.ts`等。
- **问题**：P2：bootstrap身份和网络参数是部署实例事实，仓库复用时需要显式修改；无环境覆盖是有意合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：root config projection有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：继续单一配置源；部署前审查bootstrap identity和端口，不增加环境变量双源。

#### package-lock.json

- **类型**：Structured configuration/resource；7694行。
- **作用**：npm依赖解析锁文件。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### package.json

- **类型**：Structured configuration/resource；115行。
- **作用**：包、脚本和依赖清单。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：P1：Solid RC依赖仍需两个peer metadata override；上游声明变化时安装合同可能漂移。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：存在临时RC peer override；上游声明兼容后删除。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：锁定当前版本；上游发布RC兼容peer后删除对应override并执行严格npm ci。

#### src/config.ts

- **类型**：TypeScript module；14行。
- **作用**：解析项目根、state、数据库和Web构建绝对路径。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：`node:path`、`node:url`、`../issue-pilot.config.ts`、`..`。
- **被使用情况**：静态入站4处：`src/db/client.ts`、`src/http/api.ts`、`src/http/production.ts`、`tests/db/bootstrap.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/process.ts

- **类型**：TypeScript module；76行。
- **作用**：共享spawn、abort、timeout和output budget执行器。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：`node:child_process`、`../issue-pilot.config.ts`。
- **被使用情况**：静态入站9处：`src/capabilities/aliyun.ts`、`src/tool-runtime.ts`、`src/workspace/source-browser.ts`、`tests/capabilities/dms.test.ts`、`tests/capabilities/sls.test.ts`等。
- **问题**：P1：timeout/abort只向直接child发送SIGTERM/SIGKILL；npm/Maven派生进程可能在父进程退出后残留。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：存在但有价值：统一spawn/timeout/output budget mechanism。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：Linux容器内采用独立process group并测试后代进程终止；不要并入ToolRuntime授权。

#### src/serial.ts

- **类型**：TypeScript module；43行。
- **作用**：进程内串行队列和按key串行队列。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站7处：`src/agent/engine.ts`、`src/http/api.ts`、`src/workspace/git.ts`、`src/workspace/lifecycle.ts`、`src/workspace/project-tools.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/tool-runtime.ts

- **类型**：TypeScript module；68行。
- **作用**：npm/Maven/Aliyun命令白名单、环境收敛和临时HOME。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：`node:fs/promises`、`node:os`、`node:path`、`./process.ts`。
- **被使用情况**：静态入站13处：`src/agent/engine.ts`、`src/agent/pi-session.ts`、`src/capabilities/aliyun.ts`、`src/capabilities/dms.ts`、`src/capabilities/sls.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：必要进程授权边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不并入protocol client

#### tsconfig.json

- **类型**：Structured configuration/resource；17行。
- **作用**：构建、主题或包元数据。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

### Infra、CI与Kubernetes

#### .github/workflows/ci.yml

- **类型**：Deployment/CI manifest；36行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### deploy/kubernetes/base/kustomization.yaml

- **类型**：Deployment/CI manifest；6行。
- **作用**：单副本Kubernetes/Kustomize部署资源。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Kustomize、Compose或容器构建工具按路径消费。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### deploy/kubernetes/base/service-account.yaml

- **类型**：Deployment/CI manifest；5行。
- **作用**：单副本Kubernetes/Kustomize部署资源。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Kustomize、Compose或容器构建工具按路径消费。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### deploy/kubernetes/base/service.yaml

- **类型**：Deployment/CI manifest；14行。
- **作用**：单副本Kubernetes/Kustomize部署资源。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Kustomize、Compose或容器构建工具按路径消费。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### deploy/kubernetes/base/stateful-set.yaml

- **类型**：Deployment/CI manifest；161行。
- **作用**：单副本Kubernetes/Kustomize部署资源。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Kustomize、Compose或容器构建工具按路径消费。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### infra/application-compose.mjs

- **类型**：Node script/module；63行。
- **作用**：application镜像、Compose或Operator脚本。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：`node:fs`、`node:path`、`../issue-pilot.config.ts`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### infra/application.sh

- **类型**：Operator shell script；194行。
- **作用**：application镜像、Compose或Operator脚本。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### infra/config-value.mjs

- **类型**：Node script/module；15行。
- **作用**：application镜像、Compose或Operator脚本。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：`../issue-pilot.config.ts`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

#### infra/images/application/Containerfile

- **类型**：Container build manifest；52行。
- **作用**：application镜像、Compose或Operator脚本。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Kustomize、Compose或容器构建工具按路径消费。
- **问题**：P2：构建依赖RC前端工具链和上游资源，镜像可复现性依赖lockfile与base image pull结果。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：multi-stage build有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：发布时记录image digest；高保证环境可进一步固定base digest，但需承担更新流程。

#### infra/playwright.sh

- **类型**：Operator shell script；96行。
- **作用**：application镜像、Compose或Operator脚本。
- **职责**：负责构建或部署单application运行模型；不拥有业务状态和route逻辑。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：运行/部署边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留

### 文档

#### AGENTS.md

- **类型**：Project documentation；181行。
- **作用**：项目说明或Agent工作约定。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### README.md

- **类型**：Project documentation；147行。
- **作用**：项目说明或Agent工作约定。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/ARCHITECTURE.md

- **类型**：Project documentation；361行。
- **作用**：ARCHITECTURE主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/CONFIGURATION.md

- **类型**：Project documentation；317行。
- **作用**：CONFIGURATION主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/DEPLOYMENT.md

- **类型**：Project documentation；296行。
- **作用**：DEPLOYMENT主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/DEVELOPMENT.md

- **类型**：Project documentation；383行。
- **作用**：DEVELOPMENT主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/FILE-AUDIT.md

- **类型**：Project documentation；248行。
- **作用**：项目事实、实现或验证文件。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/KUBERNETES.md

- **类型**：Project documentation；143行。
- **作用**：KUBERNETES主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/MODULE-AUDIT.md

- **类型**：Project documentation；185行。
- **作用**：MODULE-AUDIT主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

#### docs/RUNBOOK.md

- **类型**：Project documentation；432行。
- **作用**：RUNBOOK主题的权威项目文档。
- **职责**：负责记录其文档owner范围内的当前合同；不作为runtime事实源。
- **主要依赖**：人工导航和相邻文档链接；无runtime import。
- **被使用情况**：由维护者和文档导航使用，不进入runtime调用图。
- **问题**：问题：无；需随owner合同变化更新。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不属于runtime中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保持文档事实分工，避免复制同一细节。

### Migration与Meta

#### drizzle/0000_schema.sql

- **类型**：Immutable SQL migration；302行。
- **作用**：已发布不可变migration：schema。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0001_service_sort_order.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：service sort order。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0002_simple_service_model.sql

- **类型**：Immutable SQL migration；7行。
- **作用**：已发布不可变migration：simple service model。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0003_service_multiple_repositories.sql

- **类型**：Immutable SQL migration；26行。
- **作用**：已发布不可变migration：service multiple repositories。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0004_drop_service_kind.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：drop service kind。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0005_repository_kind.sql

- **类型**：Immutable SQL migration；7行。
- **作用**：已发布不可变migration：repository kind。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0006_simplify_issue_types.sql

- **类型**：Immutable SQL migration；3行。
- **作用**：已发布不可变migration：simplify issue types。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0007_strict_issue_model.sql

- **类型**：Immutable SQL migration；7行。
- **作用**：已发布不可变migration：strict issue model。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0008_remove_unimplemented_capabilities.sql

- **类型**：Immutable SQL migration；2行。
- **作用**：已发布不可变migration：remove unimplemented capabilities。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0009_enforce_issue_scope.sql

- **类型**：Immutable SQL migration；13行。
- **作用**：已发布不可变migration：enforce issue scope。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0010_drop_issue_evidence.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：drop issue evidence。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0011_remove_agent_comments.sql

- **类型**：Immutable SQL migration；2行。
- **作用**：已发布不可变migration：remove agent comments。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0012_drop_attachment_scan_status.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：drop attachment scan status。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0013_agent_results.sql

- **类型**：Immutable SQL migration；14行。
- **作用**：已发布不可变migration：agent results。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0014_capability_keys.sql

- **类型**：Immutable SQL migration；9行。
- **作用**：已发布不可变migration：capability keys。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0015_playwright_config.sql

- **类型**：Immutable SQL migration；3行。
- **作用**：已发布不可变migration：playwright config。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0016_disable_unconfigured_capabilities.sql

- **类型**：Immutable SQL migration；10行。
- **作用**：已发布不可变migration：disable unconfigured capabilities。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0017_sls_region.sql

- **类型**：Immutable SQL migration；16行。
- **作用**：已发布不可变migration：sls region。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0018_validate_capability_configs.sql

- **类型**：Immutable SQL migration；66行。
- **作用**：已发布不可变migration：validate capability configs。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0019_drop_deployment_capabilities.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：drop deployment capabilities。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0020_drop_issue_pilot_events.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：drop issue pilot events。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0021_remove_legacy_agent_columns.sql

- **类型**：Immutable SQL migration；4行。
- **作用**：已发布不可变migration：remove legacy agent columns。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0022_simplify_issue_statuses.sql

- **类型**：Immutable SQL migration；2行。
- **作用**：已发布不可变migration：simplify issue statuses。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0023_drop_agent_results.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：drop agent results。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0024_shorten_environment_names.sql

- **类型**：Immutable SQL migration；3行。
- **作用**：已发布不可变migration：shorten environment names。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0025_business_issue_types.sql

- **类型**：Immutable SQL migration；8行。
- **作用**：已发布不可变migration：business issue types。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0026_flatten_issue_branches.sql

- **类型**：Immutable SQL migration；9行。
- **作用**：已发布不可变migration：flatten issue branches。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0027_remove_service_sort_order.sql

- **类型**：Immutable SQL migration；1行。
- **作用**：已发布不可变migration：remove service sort order。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0028_remove_unused_scope_fields.sql

- **类型**：Immutable SQL migration；31行。
- **作用**：已发布不可变migration：remove unused scope fields。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0029_remove_unused_owner_fields.sql

- **类型**：Immutable SQL migration；52行。
- **作用**：已发布不可变migration：remove unused owner fields。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0030_remove_repository_kind.sql

- **类型**：Immutable SQL migration；18行。
- **作用**：已发布不可变migration：remove repository kind。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0031_remove_unused_issue_metadata.sql

- **类型**：Immutable SQL migration；20行。
- **作用**：已发布不可变migration：remove unused issue metadata。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0032_remove_redundant_pi_session_id.sql

- **类型**：Immutable SQL migration；3行。
- **作用**：已发布不可变migration：remove redundant pi session id。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0033_repository_deployment_branches.sql

- **类型**：Immutable SQL migration；83行。
- **作用**：已发布不可变migration：repository deployment branches。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0034_issue_repository_workspace_names.sql

- **类型**：Immutable SQL migration；18行。
- **作用**：已发布不可变migration：issue repository workspace names。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0035_issue_deployment_scope.sql

- **类型**：Immutable SQL migration；39行。
- **作用**：已发布不可变migration：issue deployment scope。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0036_issue_status_resolution.sql

- **类型**：Immutable SQL migration；32行。
- **作用**：已发布不可变migration：issue status resolution。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/0037_managed_users.sql

- **类型**：Immutable SQL migration；7行。
- **作用**：已发布不可变migration：managed users。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/meta/0000_snapshot.json

- **类型**：Drizzle migration metadata；2205行。
- **作用**：Drizzle migration顺序/初始schema元数据。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

#### drizzle/meta/_journal.json

- **类型**：Drizzle migration metadata；272行。
- **作用**：Drizzle migration顺序/初始schema元数据。
- **职责**：负责记录已发布schema升级顺序；不代表当前业务模型且不得重写。
- **主要依赖**：Drizzle migration journal/order；无runtime import。
- **被使用情况**：由Drizzle journal和数据库升级流程消费。
- **问题**：问题：无；历史兼容SQL是发布合同。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：存在历史重复但必须保留；migration是不可变升级合同。
- **兼容代码**：存在且当前必要；删除会破坏已发布数据库升级路径。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：禁止合并、重排或重写；新增schema变化只能追加migration。

### Agent与Pi

#### src/agent/context.ts

- **类型**：TypeScript module；38行。
- **作用**：Agent session实际消费的model、tool和代码写权限上下文。
- **职责**：负责Agent并发、session或event生命周期；不拥有HTTP、Git实现或外部协议。
- **主要依赖**：`../domain/contracts.ts`。
- **被使用情况**：静态入站8处：`src/agent/engine.ts`、`src/agent/pi-session.ts`、`src/agent/prompts.ts`、`src/pi/tools.ts`、`tests/agent/context.test.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：必要session数据。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留当前扁平结构

#### src/agent/engine.ts

- **类型**：TypeScript module；361行。
- **作用**：Issue reservation、Agent运行状态、Pi session和消息协调。
- **职责**：负责Agent并发、session或event生命周期；不拥有HTTP、Git实现或外部协议。
- **主要依赖**：`node:crypto`、`node:fs/promises`、`node:path`、`drizzle-orm`、`@earendil-works/pi-coding-agent`、`../tool-runtime.ts`、`../serial.ts`、`./events.ts`等17项。
- **被使用情况**：静态入站5处：`src/http/api.ts`、`src/http/route-context.ts`、`src/workspace/lifecycle.ts`、`tests/agent/engine.test.ts`、`tests/agent/repository-preparation.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：大型但内聚的状态边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不按行数拆

#### src/agent/events.ts

- **类型**：TypeScript module；116行。
- **作用**：Agent事件发布、replay和live缓冲。
- **职责**：负责Agent并发、session或event生命周期；不拥有HTTP、Git实现或外部协议。
- **主要依赖**：`@earendil-works/pi-coding-agent`。
- **被使用情况**：静态入站7处：`src/agent/engine.ts`、`src/http/agent-routes.ts`、`src/http/api.ts`、`src/http/route-context.ts`、`src/web/src/data/client.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/agent/footer.ts

- **类型**：TypeScript module；65行。
- **作用**：从Pi JSONL计算usage、cache和context统计。
- **职责**：负责Agent并发、session或event生命周期；不拥有HTTP、Git实现或外部协议。
- **主要依赖**：`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`../domain/contracts.ts`。
- **被使用情况**：静态入站2处：`src/http/agent-routes.ts`、`tests/agent/events.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/agent/pi-session.ts

- **类型**：TypeScript module；184行。
- **作用**：Pi SDK session、私有JSONL、resource loader和tool核对。
- **职责**：负责Agent并发、session或event生命周期；不拥有HTTP、Git实现或外部协议。
- **主要依赖**：`node:fs/promises`、`@earendil-works/pi-coding-agent`、`../domain/contracts.ts`、`../pi/models.ts`、`../pi/tools.ts`、`./context.ts`、`../tool-runtime.ts`。
- **被使用情况**：静态入站2处：`src/agent/engine.ts`、`tests/agent/pi-session.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/agent/prompts.ts

- **类型**：TypeScript module；139行。
- **作用**：初始、继续、更新时间和授权prompt构造。
- **职责**：负责Agent并发、session或event生命周期；不拥有HTTP、Git实现或外部协议。
- **主要依赖**：`../../issue-pilot.config.ts`、`./context.ts`。
- **被使用情况**：静态入站3处：`src/agent/engine.ts`、`src/http/issue-routes.ts`、`tests/agent/prompts.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/pi/models.ts

- **类型**：TypeScript module；113行。
- **作用**：共享Pi ModelRuntime和离线可用模型快照。
- **职责**：负责Pi model/tool SDK集成边界；不复制credential和Repository状态。
- **主要依赖**：`node:fs/promises`、`node:os`、`node:path`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`../domain/contracts.ts`。
- **被使用情况**：静态入站8处：`src/agent/engine.ts`、`src/agent/pi-session.ts`、`src/configuration/read.ts`、`src/http/api.ts`、`src/http/route-context.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/pi/tools.ts

- **类型**：TypeScript module；49行。
- **作用**：TypeBox解析Agent tool input并直调protocol client。
- **职责**：负责Pi model/tool SDK集成边界；不复制credential和Repository状态。
- **主要依赖**：`@earendil-works/pi-coding-agent`、`typebox/value`、`../capabilities/dms.ts`、`../capabilities/elasticsearch.ts`、`../capabilities/mysql.ts`、`../capabilities/nacos.ts`、`../capabilities/rabbitmq.ts`、`../capabilities/redis.ts`等13项。
- **被使用情况**：静态入站2处：`src/agent/pi-session.ts`、`tests/pi/tools.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

### Capability

#### src/capabilities/aliyun.ts

- **类型**：TypeScript module；52行。
- **作用**：Aliyun CLI私有profile和调用primitive。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`node:fs/promises`、`node:os`、`node:path`、`../tool-runtime.ts`、`../process.ts`。
- **被使用情况**：静态入站2处：`src/capabilities/dms.ts`、`src/capabilities/sls.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：独立外部协议边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不互相合并

#### src/capabilities/contracts.ts

- **类型**：TypeScript module；18行。
- **作用**：Capability结果、timeout和target共享primitive。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`../../issue-pilot.config.ts`。
- **被使用情况**：静态入站8处：`src/capabilities/dms.ts`、`src/capabilities/elasticsearch.ts`、`src/capabilities/mysql.ts`、`src/capabilities/nacos.ts`、`src/capabilities/rabbitmq.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/capabilities/dms.ts

- **类型**：TypeScript module；138行。
- **作用**：DMS只读SQL和CLI protocol client。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`../../issue-pilot.config.ts`、`../tool-runtime.ts`、`./aliyun.ts`、`./contracts.ts`、`./registry.ts`、`./sql.ts`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/dms.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：独立外部协议边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不互相合并

#### src/capabilities/elasticsearch.ts

- **类型**：TypeScript module；28行。
- **作用**：Elasticsearch只读HTTP client。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`./contracts.ts`、`./http-client.ts`、`./registry.ts`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/external-data.test.ts`。
- **问题**：P1：配置允许HTTP，Basic credential和查询结果的保密性依赖网络。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：独立Elasticsearch协议边界有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：不可信网络使用HTTPS；不要为未使用的证书模式提前增加通用TLS abstraction。

#### src/capabilities/http-client.ts

- **类型**：TypeScript module；31行。
- **作用**：有预算、拒绝redirect的HTTP读取primitive。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`../../issue-pilot.config.ts`。
- **被使用情况**：静态入站3处：`src/capabilities/elasticsearch.ts`、`src/capabilities/nacos.ts`、`src/capabilities/rabbitmq.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：独立外部协议边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不互相合并

#### src/capabilities/mysql.ts

- **类型**：TypeScript module；88行。
- **作用**：MySQL只读transaction和streaming client。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`mysql2`、`../../issue-pilot.config.ts`、`./contracts.ts`、`./registry.ts`、`./sql.ts`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/mysql.test.ts`。
- **问题**：P1：当前连接没有TLS选项，credential和结果只适合可信加密内网。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：独立MySQL流式读取边界有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：跨不可信网络前增加MySQL专用TLS配置和证书验收；不要抽跨协议TLS manager。

#### src/capabilities/nacos.ts

- **类型**：TypeScript module；82行。
- **作用**：Nacos登录及exact Data ID读取client。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`../../issue-pilot.config.ts`、`./contracts.ts`、`./http-client.ts`、`./registry.ts`、`/nacos/v1/auth/login`、`/nacos/v1/cs/configs`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/nacos.test.ts`。
- **问题**：P1：配置允许HTTP，启用账号密码时credential可能经明文网络传输。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：独立Nacos协议边界有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：不可信网络必须配置HTTPS并验证证书；是否强制HTTPS应由当前部署需求决定。

#### src/capabilities/rabbitmq.ts

- **类型**：TypeScript module；30行。
- **作用**：RabbitMQ management只读HTTP client。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`./contracts.ts`、`./http-client.ts`、`./registry.ts`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/external-data.test.ts`。
- **问题**：P1：Management API固定HTTP，Basic credential依赖可信内网防窃听。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：需要跨不可信网络时增加明确HTTPS配置并验证证书；不要静默自动升级协议。

#### src/capabilities/redis-worker.ts

- **类型**：TypeScript module；43行。
- **作用**：隔离node-redis连接、结果和OOM的Worker入口。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`node:worker_threads`、`redis`、`./contracts.ts`。
- **被使用情况**：静态入站1处：`src/capabilities/redis.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：独立外部协议边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不互相合并

#### src/capabilities/redis.ts

- **类型**：TypeScript module；74行。
- **作用**：Redis worker边界和命令构造。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`node:worker_threads`、`../../issue-pilot.config.ts`、`./contracts.ts`、`./registry.ts`、`./redis-worker.ts`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/external-data.test.ts`。
- **问题**：P1：当前Worker连接没有TLS选项，credential和结果只适合可信加密内网。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：Worker边界隔离完整RESP内存有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：跨不可信网络前增加Redis专用TLS配置；继续保留Worker内存隔离。

#### src/capabilities/registry.ts

- **类型**：TypeScript module；241行。
- **作用**：七类capability保存parser、tool schema和metadata。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`@earendil-works/pi-ai`、`typebox`、`../../issue-pilot.config.ts`、`../domain/contracts.ts`。
- **被使用情况**：静态入站11处：`src/capabilities/dms.ts`、`src/capabilities/elasticsearch.ts`、`src/capabilities/mysql.ts`、`src/capabilities/nacos.ts`、`src/capabilities/rabbitmq.ts`等。
- **问题**：P1：Nacos/Elasticsearch允许HTTP，Redis/MySQL/RabbitMQ模型也没有TLS字段；安全性依赖部署网络。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：Registry集中parser/schema/metadata有价值。
- **重复代码/校验**：存在9行shape解析相似代码；错误和边界语义不同，保留。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：将“仅可信加密内网”设为部署硬条件，或按实际需求逐协议加入显式TLS配置。

#### src/capabilities/sls.ts

- **类型**：TypeScript module；76行。
- **作用**：SLS时间窗、分页和CLI protocol client。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：`../../issue-pilot.config.ts`、`../tool-runtime.ts`、`./aliyun.ts`、`./contracts.ts`、`./registry.ts`。
- **被使用情况**：静态入站2处：`src/pi/tools.ts`、`tests/capabilities/sls.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：独立外部协议边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不互相合并

#### src/capabilities/sql.ts

- **类型**：TypeScript module；9行。
- **作用**：MySQL/DMS共用只读SQL lexical guard。
- **职责**：负责只读capability协议、验证或有界执行；不拥有Issue授权和浏览器DTO。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站2处：`src/capabilities/dms.ts`、`src/capabilities/mysql.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：独立外部协议边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不互相合并

### Domain、DB与Configuration

#### src/configuration/contracts.ts

- **类型**：TypeScript module；73行。
- **作用**：后端/Web共用的配置DTO和credential update类型。
- **职责**：负责配置DTO、脱敏或credential更新协议；不执行外部capability。
- **主要依赖**：`../domain/contracts.ts`。
- **被使用情况**：静态入站6处：`src/configuration/credentials.ts`、`src/configuration/read.ts`、`src/web/src/app/ConfigurationView.tsx`、`src/web/src/app/configuration-model.ts`、`src/web/src/data/client.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/configuration/credentials.ts

- **类型**：TypeScript module；68行。
- **作用**：配置脱敏及preserve/replace/clear合并。
- **职责**：负责配置DTO、脱敏或credential更新协议；不执行外部capability。
- **主要依赖**：`../capabilities/registry.ts`、`../domain/contracts.ts`、`./contracts.ts`。
- **被使用情况**：静态入站3处：`src/configuration/read.ts`、`src/http/service-configuration.ts`、`tests/configuration/credentials.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：必要secret边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：存在9行shape解析相似代码；错误和边界语义不同，保留。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留独立

#### src/configuration/read.ts

- **类型**：TypeScript module；98行。
- **作用**：Catalog和完整脱敏配置的SQLite投影。
- **职责**：负责配置DTO、脱敏或credential更新协议；不执行外部capability。
- **主要依赖**：`drizzle-orm`、`../db/client.ts`、`../db/schema.ts`、`../domain/contracts.ts`、`../pi/models.ts`、`./contracts.ts`、`./credentials.ts`。
- **被使用情况**：静态入站1处：`src/http/configuration-routes.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/db/bootstrap.ts

- **类型**：TypeScript module；72行。
- **作用**：打开数据库后的migration、恢复和环境同步。
- **职责**：负责SQLite连接、当前schema或启动迁移；不拥有Git和Web状态。
- **主要依赖**：`node:url`、`drizzle-orm`、`drizzle-orm/libsql/migrator`、`../../issue-pilot.config.ts`、`../domain/contracts.ts`、`./client.ts`、`./schema.ts`、`../../drizzle`。
- **被使用情况**：静态入站9处：`src/db/migrate.ts`、`src/http/api.ts`、`tests/agent/repository-preparation.test.ts`、`tests/db/bootstrap.test.ts`、`tests/workspace/deployment.test.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/db/client.ts

- **类型**：TypeScript module；25行。
- **作用**：libSQL/Drizzle连接、权限和SQLite pragma。
- **职责**：负责SQLite连接、当前schema或启动迁移；不拥有Git和Web状态。
- **主要依赖**：`node:fs`、`node:path`、`@libsql/client`、`drizzle-orm/libsql`、`../config.ts`、`./schema.ts`。
- **被使用情况**：静态入站18处：`src/agent/engine.ts`、`src/configuration/read.ts`、`src/db/bootstrap.ts`、`src/db/migrate.ts`、`src/http/attachment-store.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/db/migrate.ts

- **类型**：TypeScript module；9行。
- **作用**：Operator独立migration命令入口。
- **职责**：负责SQLite连接、当前schema或启动迁移；不拥有Git和Web状态。
- **主要依赖**：`./bootstrap.ts`、`./client.ts`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/db/schema.ts

- **类型**：TypeScript module；79行。
- **作用**：当前Drizzle数据库模型。
- **职责**：负责SQLite连接、当前schema或启动迁移；不拥有Git和Web状态。
- **主要依赖**：`node:crypto`、`drizzle-orm/sqlite-core`、`../domain/contracts.ts`。
- **被使用情况**：静态入站29处：`src/agent/engine.ts`、`src/configuration/read.ts`、`src/db/bootstrap.ts`、`src/db/client.ts`、`src/http/agent-routes.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/domain/contracts.ts

- **类型**：TypeScript module；103行。
- **作用**：业务枚举、Issue key、Deployment config和共享状态判断。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站31处：`src/agent/context.ts`、`src/agent/engine.ts`、`src/agent/footer.ts`、`src/agent/pi-session.ts`、`src/capabilities/registry.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

### HTTP

#### src/http/agent-routes.ts

- **类型**：TypeScript module；98行。
- **作用**：Agent消息、事件和重试HTTP routes。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`drizzle-orm`、`@earendil-works/pi-coding-agent`、`../../issue-pilot.config.ts`、`../agent/events.ts`、`../agent/footer.ts`、`../db/schema.ts`、`../domain/contracts.ts`、`../workspace/state.ts`等11项。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/api.ts

- **类型**：TypeScript module；185行。
- **作用**：Fastify装配、错误映射、启动和关闭生命周期。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`node:path`、`@fastify/multipart`、`fastify`、`../config.ts`、`../agent/engine.ts`、`../tool-runtime.ts`、`../agent/events.ts`、`../db/bootstrap.ts`等25项。
- **被使用情况**：静态入站5处：`src/http/production.ts`、`tests/http/api-startup.test.ts`、`tests/http/fixture.ts`、`tests/http/runtime-api.test.ts`、`tests/http/web.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/http/attachment-routes.ts

- **类型**：TypeScript module；32行。
- **作用**：附件完整性校验和下载route。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`node:crypto`、`node:fs/promises`、`drizzle-orm`、`../db/schema.ts`、`../workspace/state.ts`、`./attachment-store.ts`、`./input.ts`、`./route-context.ts`。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/attachment-store.ts

- **类型**：TypeScript module；113行。
- **作用**：附件写入、quarantine、rollback/finalize和安全路径。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`node:crypto`、`node:fs/promises`、`node:path`、`@fastify/multipart`、`../../issue-pilot.config.ts`、`../db/client.ts`、`../db/schema.ts`、`../workspace/state.ts`等9项。
- **被使用情况**：静态入站3处：`src/http/attachment-routes.ts`、`src/http/issue-routes.ts`、`tests/http/attachments.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/http/configuration-routes.ts

- **类型**：TypeScript module；85行。
- **作用**：Catalog/配置/Service写入routes。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`node:crypto`、`drizzle-orm`、`../configuration/read.ts`、`../db/schema.ts`、`./input.ts`、`./route-context.ts`、`./service-configuration.ts`。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/input.ts

- **类型**：TypeScript module；35行。
- **作用**：HTTP unknown输入的少量fail-fast解析器。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站11处：`src/http/agent-routes.ts`、`src/http/api.ts`、`src/http/attachment-routes.ts`、`src/http/attachment-store.ts`、`src/http/configuration-routes.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/http/issue-routes.ts

- **类型**：TypeScript module；283行。
- **作用**：Issue创建、编辑、列表、状态和评论routes。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`node:crypto`、`node:fs/promises`、`node:path`、`drizzle-orm`、`fastify`、`../../issue-pilot.config.ts`、`../agent/prompts.ts`、`../db/schema.ts`等15项。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/production.ts

- **类型**：TypeScript module；7行。
- **作用**：application镜像唯一生产入口。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`../config.ts`、`./api.ts`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/http/route-context.ts

- **类型**：TypeScript module；55行。
- **作用**：Route共享依赖、当前用户、Issue查找和reservation映射。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`drizzle-orm`、`fastify`、`../agent/engine.ts`、`../agent/events.ts`、`../db/client.ts`、`../db/schema.ts`、`../domain/contracts.ts`、`../pi/models.ts`等11项。
- **被使用情况**：静态入站7处：`src/http/agent-routes.ts`、`src/http/attachment-routes.ts`、`src/http/configuration-routes.ts`、`src/http/issue-routes.ts`、`src/http/source-browser-routes.ts`等。
- **问题**：P1（审计归属）：subject来自浏览器可选header，只校验是否为active user，不代表经过认证的actor。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：共享subject/Issue/reservation guard有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：若操作归属必须可信，由proxy派生并覆盖subject或在API验证身份；否则文档应明确它只是用户选择标签。

#### src/http/service-configuration.ts

- **类型**：TypeScript module；152行。
- **作用**：Service配置边界解析和事务写入。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`drizzle-orm`、`../capabilities/registry.ts`、`../configuration/credentials.ts`、`../db/client.ts`、`../db/schema.ts`、`../domain/contracts.ts`、`../pi/models.ts`、`./input.ts`。
- **被使用情况**：静态入站1处：`src/http/configuration-routes.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/http/source-browser-routes.ts

- **类型**：TypeScript module；65行。
- **作用**：Source tree/file/search/history/diff routes。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`fastify`、`./input.ts`、`./route-context.ts`。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/sse.ts

- **类型**：TypeScript module；107行。
- **作用**：SSE顺序、背压、预算和断连状态机。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站2处：`src/http/agent-routes.ts`、`tests/http/sse.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/http/user-routes.ts

- **类型**：TypeScript module；89行。
- **作用**：SQLite用户增改和启停routes。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`drizzle-orm`、`../db/schema.ts`、`./input.ts`、`./route-context.ts`。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/web-routes.ts

- **类型**：TypeScript module；45行。
- **作用**：静态Web/Workbench和SPA fallback。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`node:fs/promises`、`node:path`、`@fastify/static`、`fastify`。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

#### src/http/workspace-routes.ts

- **类型**：TypeScript module；45行。
- **作用**：Workspace stats、转换和release routes。
- **职责**：负责HTTP边界、route协调或transport状态；不重写Git、capability和workspace事实。
- **主要依赖**：`./input.ts`、`./route-context.ts`、`../workspace/lifecycle.ts`。
- **被使用情况**：静态入站1处：`src/http/api.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：按HTTP域拆分。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留域边界

### Web与Workbench

#### src/web/index.html

- **类型**：Web entry document；13行。
- **作用**：Vite应用入口HTML。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Vite multi-entry或浏览器直接加载。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/app/AgentPanel.test.ts

- **类型**：Automated test；379行。
- **作用**：web域的AgentPanel行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@earendil-works/pi-ai`、`@solidjs/testing-library`、`vitest`、`../../../../issue-pilot.config`、`../data/client`、`../test-setup`、`./AgentPanel`、`./conversation`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/AgentPanel.tsx

- **类型**：Solid/TypeScript UI；402行。
- **作用**：AgentPanel前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`@earendil-works/pi-ai`、`../../../../issue-pilot.config.ts`、`../data/client`、`../ui/icons`、`../ui/Markdown`、`./conversation`等10项。
- **被使用情况**：静态入站2处：`src/web/src/app/AgentPanel.test.ts`、`src/web/src/app/App.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/App.test.tsx

- **类型**：Automated test；521行。
- **作用**：App前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@solidjs/testing-library`、`vitest`、`../data/client`、`../../../../issue-pilot.config.ts`、`../test-setup`、`./App`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/App.tsx

- **类型**：Solid/TypeScript UI；180行。
- **作用**：App前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../data/client`、`./AgentPanel`、`./ApplicationResources`、`./ConfigurationView`、`./IssueQueue`、`./IssueWorkspace`等11项。
- **被使用情况**：静态入站2处：`src/web/src/app/App.test.tsx`、`src/web/src/main.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/ApplicationResources.test.tsx

- **类型**：Automated test；64行。
- **作用**：ApplicationResources前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@solidjs/testing-library`、`vitest`、`../data/client`、`./ApplicationResources`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/ApplicationResources.tsx

- **类型**：Solid/TypeScript UI；88行。
- **作用**：ApplicationResources前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`solid-js`、`../data/client`。
- **被使用情况**：静态入站6处：`src/web/src/app/App.tsx`、`src/web/src/app/ApplicationResources.test.tsx`、`src/web/src/app/ConfigurationView.tsx`、`src/web/src/app/IssueQueue.tsx`、`src/web/src/app/IssueWorkspace.tsx`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/AttachmentPreview.tsx

- **类型**：Solid/TypeScript UI；150行。
- **作用**：AttachmentPreview前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../ui/icons`、`../data/client`。
- **被使用情况**：静态入站1处：`src/web/src/app/IssueWorkspace.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/CodeBrowser.tsx

- **类型**：Solid/TypeScript UI；94行。
- **作用**：CodeBrowser前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../ui/icons`。
- **被使用情况**：静态入站1处：`src/web/src/app/App.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/ConfigurationView.tsx

- **类型**：Solid/TypeScript UI；356行。
- **作用**：ConfigurationView前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../../../../issue-pilot.config.ts`、`../../../configuration/contracts`、`../../../domain/contracts`、`../ui/icons`、`../data/client`、`../ui/Markdown`等11项。
- **被使用情况**：静态入站1处：`src/web/src/app/App.tsx`。
- **问题**：P2：7种capability JSX集中在超长单行，结构正确但人工diff和review成本偏高。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在额外service层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：只做多行格式化或小型同文件render函数；不要引入generic schema-form框架。

#### src/web/src/app/IssueForm.tsx

- **类型**：Solid/TypeScript UI；89行。
- **作用**：IssueForm前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../ui/icons`、`../ui/Markdown`、`../data/client`、`./model`。
- **被使用情况**：静态入站3处：`src/web/src/app/ConfigurationView.tsx`、`src/web/src/app/IssueQueue.tsx`、`src/web/src/app/IssueWorkspace.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/IssueQueue.tsx

- **类型**：Solid/TypeScript UI；187行。
- **作用**：IssueQueue前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../ui/icons`、`../data/client`、`./ApplicationResources`、`./IssueForm`、`./model`。
- **被使用情况**：静态入站1处：`src/web/src/app/App.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/IssueWorkspace.tsx

- **类型**：Solid/TypeScript UI；231行。
- **作用**：IssueWorkspace前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../../../../issue-pilot.config.ts`、`../ui/icons`、`../data/client`、`../ui/Markdown`、`./ApplicationResources`、`./AttachmentPreview`等10项。
- **被使用情况**：静态入站1处：`src/web/src/app/App.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/Statistics.tsx

- **类型**：Solid/TypeScript UI；157行。
- **作用**：Statistics前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../data/client`、`./model`。
- **被使用情况**：静态入站1处：`src/web/src/app/App.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/UserManagement.tsx

- **类型**：Solid/TypeScript UI；155行。
- **作用**：UserManagement前端功能组件。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@idoly/ant-design-solid`、`solid-js`、`../data/client`、`../ui/icons`、`./ApplicationResources`。
- **被使用情况**：静态入站1处：`src/web/src/app/App.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：用户功能边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留；不建通用页面框架

#### src/web/src/app/agent-stream.test.ts

- **类型**：Automated test；51行。
- **作用**：web域的agent-stream行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`vitest`、`./agent-stream`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/agent-stream.ts

- **类型**：TypeScript module；128行。
- **作用**：EventSource握手、重连和generation状态机。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`../data/client`、`./conversation`。
- **被使用情况**：静态入站2处：`src/web/src/app/AgentPanel.tsx`、`src/web/src/app/agent-stream.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/app/configuration-model.test.ts

- **类型**：Automated test；54行。
- **作用**：web域的configuration-model行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`vitest`、`../../../domain/contracts`、`./configuration-model`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/configuration-model.ts

- **类型**：TypeScript module；41行。
- **作用**：配置表单draft到credential update请求序列化。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`../../../domain/contracts`、`../../../configuration/contracts`。
- **被使用情况**：静态入站2处：`src/web/src/app/ConfigurationView.tsx`、`src/web/src/app/configuration-model.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/app/conversation.ts

- **类型**：TypeScript module；224行。
- **作用**：Pi事件到可见对话的纯状态投影。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@earendil-works/pi-ai`、`../data/client`。
- **被使用情况**：静态入站3处：`src/web/src/app/AgentPanel.test.ts`、`src/web/src/app/AgentPanel.tsx`、`src/web/src/app/agent-stream.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/app/model.test.ts

- **类型**：Automated test；18行。
- **作用**：web域的model行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`vitest`、`./model`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/model.ts

- **类型**：TypeScript module；52行。
- **作用**：Issue显示标签、时间和文件大小纯投影。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`../../../../issue-pilot.config.ts`、`../data/client`。
- **被使用情况**：静态入站5处：`src/web/src/app/IssueForm.tsx`、`src/web/src/app/IssueQueue.tsx`、`src/web/src/app/IssueWorkspace.tsx`、`src/web/src/app/Statistics.tsx`、`src/web/src/app/model.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/app/paste-editor.test.ts

- **类型**：Automated test；59行。
- **作用**：web域的paste-editor行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`vitest`、`./paste-editor`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/app/paste-editor.ts

- **类型**：TypeScript module；137行。
- **作用**：附件粘贴占位符的文本编辑算法。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站2处：`src/web/src/app/AgentPanel.tsx`、`src/web/src/app/paste-editor.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/app/styles.css

- **类型**：Stylesheet；756行。
- **作用**：对应前端界面样式。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/data/client.test.ts

- **类型**：Automated test；176行。
- **作用**：web域的client行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`vitest`、`./client`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/data/client.ts

- **类型**：TypeScript module；232行。
- **作用**：Web DTO、HTTP client和current-user header。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`../../../domain/contracts`、`../../../configuration/contracts`、`../../../agent/events`。
- **被使用情况**：静态入站24处：`src/web/src/app/AgentPanel.test.ts`、`src/web/src/app/AgentPanel.tsx`、`src/web/src/app/App.test.tsx`、`src/web/src/app/App.tsx`、`src/web/src/app/ApplicationResources.test.tsx`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/main.tsx

- **类型**：Solid/TypeScript UI；9行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@solidjs/web`、`./app/App`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/test-setup.ts

- **类型**：TypeScript module；31行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：静态入站2处：`src/web/src/app/AgentPanel.test.ts`、`src/web/src/app/App.test.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/ui/Markdown.test.tsx

- **类型**：Automated test；29行。
- **作用**：web域的Markdown行为回归测试。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`@solidjs/testing-library`、`vitest`、`./Markdown`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/ui/Markdown.tsx

- **类型**：Solid/TypeScript UI；36行。
- **作用**：主应用Markdown渲染、净化和缓存。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`dompurify`、`marked`、`solid-js`、`../../../../issue-pilot.config.ts`。
- **被使用情况**：静态入站5处：`src/web/src/app/AgentPanel.tsx`、`src/web/src/app/ConfigurationView.tsx`、`src/web/src/app/IssueForm.tsx`、`src/web/src/app/IssueWorkspace.tsx`、`src/web/src/ui/Markdown.test.tsx`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/ui/icons.tsx

- **类型**：Solid/TypeScript UI；86行。
- **作用**：lucide core IconNode到Solid组件的单一适配器。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：`lucide`、`@solidjs/web`、`solid-js`。
- **被使用情况**：静态入站8处：`src/web/src/app/AgentPanel.tsx`、`src/web/src/app/AttachmentPreview.tsx`、`src/web/src/app/CodeBrowser.tsx`、`src/web/src/app/ConfigurationView.tsx`、`src/web/src/app/IssueForm.tsx`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：必要Solid适配。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留单一adapter

#### src/web/src/ui/scrollbars.css

- **类型**：Stylesheet；43行。
- **作用**：对应前端界面样式。
- **职责**：负责浏览器状态、交互、DTO或视觉；不直接访问SQLite、Git或credential事实。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/extension-api.ts

- **类型**：TypeScript module；23行。
- **作用**：固定LocalProcess Workbench extension注册。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`@codingame/monaco-vscode-api/extensions`。
- **被使用情况**：静态入站4处：`src/web/src/vscode/main.ts`、`src/web/src/vscode/markdown-preview.ts`、`src/web/src/vscode/source-control.ts`、`src/web/src/vscode/source-search.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/extensions.d.ts

- **类型**：Type declaration；7行。
- **作用**：Vite虚拟extension模块类型声明。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/github-dark-default.LICENSE

- **类型**：Project configuration/resource；21行。
- **作用**：项目构建、忽略或运行配置。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/github-dark-default.json

- **类型**：Structured configuration/resource；651行。
- **作用**：构建、主题或包元数据。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/main.ts

- **类型**：TypeScript module；273行。
- **作用**：只读VS Code Workbench组合和布局命令。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`@codingame/monaco-vscode-markdown-language-features-default-extension`、`virtual:issue-pilot-material-icon-theme`、`@codingame/monaco-vscode-api`、`@codingame/monaco-vscode-configuration-service-override`、`@codingame/monaco-vscode-environment-service-override`、`@codingame/monaco-vscode-explorer-service-override`、`@codingame/monaco-vscode-extensions-service-override`、`@codingame/monaco-vscode-files-service-override`等32项。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/markdown-preview.test.ts

- **类型**：Automated test；102行。
- **作用**：markdown-preview Workbench集成模块。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`vitest`、`monaco-editor`、`./markdown-preview`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/vscode/markdown-preview.ts

- **类型**：TypeScript module；134行。
- **作用**：上游markdown.api.render到只读Preview Pane。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`dompurify`、`@codingame/monaco-vscode-api`、`@codingame/monaco-vscode-workbench-service-override`、`virtual:issue-pilot-markdown-preview-style`、`monaco-editor`、`./extension-api`。
- **被使用情况**：静态入站2处：`src/web/src/vscode/main.ts`、`src/web/src/vscode/markdown-preview.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/search-service.ts

- **类型**：TypeScript module；10行。
- **作用**：用上游SearchService阻止默认虚拟树遍历。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`@codingame/monaco-vscode-api`、`@codingame/monaco-vscode-search-service-override`、`@codingame/monaco-vscode-search-service-override/vscode/vs/workbench/services/search/common/searchService`。
- **被使用情况**：静态入站1处：`src/web/src/vscode/main.ts`。
- **问题**：P1：使用未由package exports承诺的SearchService深路径，升级Monaco VS Code时易断。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：存在但有价值：阻止默认虚拟树全量遍历。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：存在上游内部API依赖；当前必要，升级时替换。
- **无用代码**：不存在。
- **删除建议**：谨慎删除。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：锁定上游版本并保留定向测试；出现public hook后立即替换。

#### src/web/src/vscode/source-control.test.ts

- **类型**：Automated test；144行。
- **作用**：source-control Workbench集成模块。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`vitest`、`../data/client`、`./source-control`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/vscode/source-control.ts

- **类型**：TypeScript module；284行。
- **作用**：只读SCM Changes、history和revision diff。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`vscode`、`../data/client`、`./extension-api`。
- **被使用情况**：静态入站2处：`src/web/src/vscode/main.ts`、`src/web/src/vscode/source-control.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/source-file-system.test.ts

- **类型**：Automated test；97行。
- **作用**：source-file-system Workbench集成模块。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`vitest`、`../data/client`、`./source-file-system`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/vscode/source-file-system.ts

- **类型**：TypeScript module；157行。
- **作用**：Source API到VS Code只读filesystem。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`@codingame/monaco-vscode-files-service-override`、`monaco-editor`、`../data/client`。
- **被使用情况**：静态入站2处：`src/web/src/vscode/main.ts`、`src/web/src/vscode/source-file-system.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/source-search.test.ts

- **类型**：Automated test；82行。
- **作用**：source-search Workbench集成模块。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`vitest`、`../data/client`、`./source-search`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### src/web/src/vscode/source-search.ts

- **类型**：TypeScript module；87行。
- **作用**：VS Code text search到预算Source API。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`vscode`、`../data/client`、`./extension-api`。
- **被使用情况**：静态入站2处：`src/web/src/vscode/main.ts`、`src/web/src/vscode/source-search.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/workbench.css

- **类型**：Stylesheet；77行。
- **作用**：对应前端界面样式。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/src/vscode/workers.ts

- **类型**：TypeScript module；26行。
- **作用**：Monaco/Workbench worker工厂。
- **职责**：负责只读Workbench协议和VS Code service集成；不开放host写操作、Terminal或extension gallery。
- **主要依赖**：`@codingame/monaco-vscode-api/workers/extensionHost.worker?worker`、`@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url`、`@codingame/monaco-vscode-standalone-css-language-features/worker?worker`、`@codingame/monaco-vscode-standalone-html-language-features/worker?worker`、`@codingame/monaco-vscode-standalone-json-language-features/worker?worker`、`@codingame/monaco-vscode-standalone-typescript-language-features/worker?worker`、`@codingame/monaco-vscode-textmate-service-override/worker?worker`、`monaco-editor/esm/vs/editor/editor.worker?worker`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/tsconfig.json

- **类型**：Structured configuration/resource；17行。
- **作用**：构建、主题或包元数据。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由构建工具、资源注册或路径约定间接消费；已结合Knip结果复核。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：静态入站为0，但经构建资源、工具路径或外部约定复核后仍有消费。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/web/vite.config.ts

- **类型**：TypeScript module；146行。
- **作用**：双入口构建及theme/icon/markdown extension资源注册。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：`node:fs`、`node:module`、`node:path`、`vite`、`vite-plugin-solid`、`../../issue-pilot.config.ts`、`@codingame/monaco-vscode-api/extensions`。
- **被使用情况**：零静态入站但属于CLI、HTML、Vite、Worker或production约定入口，不是死代码。
- **问题**：P2：Workbench生产产物约46MB，包含上游7MB Markdown extension source map；首开和镜像体积成本较高。
- **设计评价**：需要优化。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：虚拟模块是构建边界，有价值。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：先测量实际传输/缓存；仅在能稳定排除未请求source map时裁剪，不复制上游extension。

#### src/web/vscode.html

- **类型**：Web entry document；13行。
- **作用**：Vite应用入口HTML。
- **职责**：负责提供项目级配置、入口或资源；不扩展到无关业务owner。
- **主要依赖**：无静态模块依赖，或由对应工具按文件约定读取。
- **被使用情况**：由Vite multi-entry或浏览器直接加载。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

### Workspace、Git与Source

#### src/workspace/deployment.ts

- **类型**：TypeScript module；42行。
- **作用**：Deployment Repository关系完整性和顺序解析。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`drizzle-orm`、`../db/client.ts`、`../db/schema.ts`。
- **被使用情况**：静态入站2处：`src/workspace/project.ts`、`tests/workspace/deployment.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/workspace/generated-directory.ts

- **类型**：TypeScript module；48行。
- **作用**：生成目录原子替换和rollback primitive。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:fs/promises`。
- **被使用情况**：静态入站3处：`src/workspace/project-wrappers.ts`、`src/workspace/runtime.ts`、`tests/workspace/generated-directory.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/workspace/git.ts

- **类型**：TypeScript module；388行。
- **作用**：bare store、fetch、checkout、worktree和批量rollback。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:child_process`、`node:crypto`、`node:fs/promises`、`node:path`、`node:util`、`../../issue-pilot.config.ts`、`../domain/contracts.ts`、`../serial.ts`等9项。
- **被使用情况**：静态入站7处：`src/http/issue-routes.ts`、`src/workspace/lifecycle.ts`、`src/workspace/project.ts`、`src/workspace/source-browser.ts`、`tests/agent/repository-preparation.test.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：大型但内聚的状态边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不按行数拆

#### src/workspace/lifecycle.ts

- **类型**：TypeScript module；491行。
- **作用**：Workspace深检、release/reopen、quota和maintenance。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:child_process`、`node:fs/promises`、`node:path`、`node:util`、`drizzle-orm`、`p-map`、`../../issue-pilot.config.ts`、`../agent/engine.ts`等15项。
- **被使用情况**：静态入站5处：`src/http/api.ts`、`src/http/issue-routes.ts`、`src/http/route-context.ts`、`src/http/workspace-routes.ts`、`tests/workspace/lifecycle.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：大型但内聚的状态边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不按行数拆

#### src/workspace/project-tools.ts

- **类型**：TypeScript module；309行。
- **作用**：Issue-scoped Unix socket Node/Maven broker。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:http`、`node:fs/promises`、`node:os`、`node:path`、`node:net`、`drizzle-orm`、`../../issue-pilot.config.ts`、`../tool-runtime.ts`等13项。
- **被使用情况**：静态入站2处：`src/http/api.ts`、`tests/workspace/project-tools.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/workspace/project-wrappers.ts

- **类型**：TypeScript module；66行。
- **作用**：生成固定node-project/maven-project客户端脚本。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:crypto`、`node:fs/promises`、`node:path`、`../../issue-pilot.config.ts`、`./generated-directory.ts`。
- **被使用情况**：静态入站3处：`src/workspace/project.ts`、`tests/workspace/project-tools.test.ts`、`tests/workspace/project-wrappers.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/workspace/project.ts

- **类型**：TypeScript module；396行。
- **作用**：Issue项目prepare、dev/read-only hydration和finalize。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`drizzle-orm`、`node:fs/promises`、`node:path`、`../../issue-pilot.config.ts`、`../db/client.ts`、`../db/schema.ts`、`../serial.ts`、`../domain/contracts.ts`等13项。
- **被使用情况**：静态入站5处：`src/agent/engine.ts`、`src/http/api.ts`、`src/workspace/lifecycle.ts`、`tests/workspace/lifecycle.test.ts`、`tests/workspace/read-only.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：大型但内聚的状态边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不按行数拆

#### src/workspace/runtime.ts

- **类型**：TypeScript module；89行。
- **作用**：Issue runtime链接原子生成和批量失败隔离。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:crypto`、`node:fs/promises`、`node:path`、`drizzle-orm`、`p-map`、`../db/client.ts`、`../db/schema.ts`、`../domain/contracts.ts`等10项。
- **被使用情况**：静态入站3处：`src/workspace/project.ts`、`tests/workspace/runtime.test.ts`、`tests/workspace/source-browser.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

#### src/workspace/source-browser.ts

- **类型**：TypeScript module；445行。
- **作用**：受控tree/file/search/history/diff服务端读取。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:fs/promises`、`node:path`、`drizzle-orm`、`../../issue-pilot.config.ts`、`../process.ts`、`../db/client.ts`、`../db/schema.ts`、`./git.ts`等9项。
- **被使用情况**：静态入站3处：`src/http/api.ts`、`src/http/route-context.ts`、`tests/workspace/source-browser.test.ts`。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：大型但内聚的状态边界。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留，不按行数拆

#### src/workspace/state.ts

- **类型**：TypeScript module；210行。
- **作用**：state路径、Repository持久状态分类和布局证据保护。
- **职责**：负责Git、runtime、Source或Workspace持久状态生命周期；不拥有HTTP DTO和Web交互。
- **主要依赖**：`node:child_process`、`node:fs/promises`、`node:path`、`node:util`、`p-map`、`../../issue-pilot.config.ts`、`../domain/contracts.ts`。
- **被使用情况**：静态入站23处：`src/agent/engine.ts`、`src/http/agent-routes.ts`、`src/http/api.ts`、`src/http/attachment-routes.ts`、`src/http/attachment-store.ts`等。
- **问题**：未发现独立正确性、安全或维护缺陷。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在无价值转发层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：保留原位

### Backend与Infra测试

#### tests/agent/context.test.ts

- **类型**：Automated test；34行。
- **作用**：agent域的context行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/agent/context.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/agent/engine.test.ts

- **类型**：Automated test；239行。
- **作用**：agent域的engine行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`../../src/agent/engine.ts`、`../../src/agent/events.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/agent/events.test.ts

- **类型**：Automated test；161行。
- **作用**：agent域的events行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`@earendil-works/pi-coding-agent`、`../../src/agent/events.ts`、`../../src/agent/footer.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/agent/pi-session.test.ts

- **类型**：Automated test；157行。
- **作用**：agent域的pi-session行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`../../src/agent/context.ts`等10项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/agent/prompts.test.ts

- **类型**：Automated test；35行。
- **作用**：agent域的prompts行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/agent/prompts.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/agent/repository-preparation.test.ts

- **类型**：Automated test；267行。
- **作用**：agent域的repository-preparation行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`、`drizzle-orm`等14项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/capabilities/dms.test.ts

- **类型**：Automated test；101行。
- **作用**：capabilities域的dms行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:path`、`node:test`、`../../issue-pilot.config.ts`、`../../src/tool-runtime.ts`、`../../src/capabilities/dms.ts`、`../../src/process.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/capabilities/external-data.test.ts

- **类型**：Automated test；200行。
- **作用**：capabilities域的external-data行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:http`、`node:net`、`node:os`、`node:path`、`node:test`、`../../src/capabilities/elasticsearch.ts`等11项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/capabilities/mysql.test.ts

- **类型**：Automated test；101行。
- **作用**：capabilities域的mysql行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:events`、`node:stream`、`node:test`、`mysql2`、`../../issue-pilot.config.ts`、`../../src/capabilities/mysql.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/capabilities/nacos.test.ts

- **类型**：Automated test；88行。
- **作用**：capabilities域的nacos行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:http`、`node:test`、`../../issue-pilot.config.ts`、`../../src/capabilities/nacos.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/capabilities/sls.test.ts

- **类型**：Automated test；75行。
- **作用**：capabilities域的sls行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:path`、`node:test`、`../../src/tool-runtime.ts`、`../../src/process.ts`、`../../src/capabilities/sls.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/configuration/credentials.test.ts

- **类型**：Automated test；48行。
- **作用**：configuration域的credentials行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/configuration/contracts.ts`、`../../src/configuration/credentials.ts`、`../../src/domain/contracts.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/db/bootstrap.test.ts

- **类型**：Automated test；111行。
- **作用**：db域的bootstrap行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`drizzle-orm`、`../../issue-pilot.config.ts`、`../../src/config.ts`等10项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/db/sqlite.test.ts

- **类型**：Automated test；211行。
- **作用**：db域的sqlite行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`drizzle-orm`、`drizzle-orm/libsql/migrator`、`../../src/db/client.ts`等10项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/domain/contracts.test.ts

- **类型**：Automated test；33行。
- **作用**：domain域的contracts行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/domain/contracts.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/domain/serial.test.ts

- **类型**：Automated test；59行。
- **作用**：domain域的serial行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/serial.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/api-startup.test.ts

- **类型**：Automated test；91行。
- **作用**：http域的api-startup行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:events`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`fastify`、`../../src/http/api.ts`等9项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/attachment-api.test.ts

- **类型**：Automated test；153行。
- **作用**：http域的attachment-api行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:crypto`、`node:fs/promises`、`node:path`、`node:test`、`../../src/db/client.ts`、`../../src/workspace/state.ts`、`./fixture.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/attachments.test.ts

- **类型**：Automated test；45行。
- **作用**：http域的attachments行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`../../src/http/attachment-store.ts`、`../../src/workspace/state.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/configuration-api.test.ts

- **类型**：Automated test；246行。
- **作用**：http域的configuration-api行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:sqlite`、`node:test`、`../../issue-pilot.config.ts`、`./fixture.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/fixture.ts

- **类型**：TypeScript module；141行。
- **作用**：http域的fixture行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`fastify`、`../../src/domain/contracts.ts`、`../../src/http/api.ts`。
- **被使用情况**：静态入站5处：`tests/http/attachment-api.test.ts`、`tests/http/configuration-api.test.ts`、`tests/http/issue-api.test.ts`、`tests/http/runtime-api.test.ts`、`tests/http/user-api.test.ts`。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/issue-api.test.ts

- **类型**：Automated test；216行。
- **作用**：http域的issue-api行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:path`、`node:test`、`drizzle-orm`、`../../src/db/client.ts`、`../../src/db/schema.ts`、`./fixture.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/runtime-api.test.ts

- **类型**：Automated test；68行。
- **作用**：http域的runtime-api行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`drizzle-orm`、`../../src/db/client.ts`、`../../src/db/schema.ts`、`../../src/http/api.ts`、`./fixture.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/service-configuration.test.ts

- **类型**：Automated test；36行。
- **作用**：http域的service-configuration行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/capabilities/registry.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/sse.test.ts

- **类型**：Automated test；121行。
- **作用**：http域的sse行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:events`、`node:test`、`../../src/http/sse.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/user-api.test.ts

- **类型**：Automated test；102行。
- **作用**：http域的user-api行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../issue-pilot.config.ts`、`./fixture.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/http/web.test.ts

- **类型**：Automated test；70行。
- **作用**：http域的web行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`../../src/http/api.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/infra/application.test.ts

- **类型**：Automated test；147行。
- **作用**：infra域的application行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/infra/playwright.test.ts

- **类型**：Automated test；58行。
- **作用**：infra域的playwright行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/pi/models.test.ts

- **类型**：Automated test；105行。
- **作用**：pi域的models行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`../../src/pi/models.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/pi/tools.test.ts

- **类型**：Automated test；40行。
- **作用**：pi域的tools行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../src/agent/context.ts`、`../../src/pi/tools.ts`、`../../src/tool-runtime.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/process/process.test.ts

- **类型**：Automated test；18行。
- **作用**：process域的process行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:test`、`../../issue-pilot.config.ts`、`../../src/process.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/tool-runtime.test.ts

- **类型**：Automated test；52行。
- **作用**：tool-runtime.test.ts域的tool-runtime行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:test`、`../src/process.ts`、`../src/tool-runtime.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/deployment.test.ts

- **类型**：Automated test；55行。
- **作用**：workspace域的deployment行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`drizzle-orm`、`../../src/db/bootstrap.ts`、`../../src/db/schema.ts`等9项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/generated-directory.test.ts

- **类型**：Automated test；77行。
- **作用**：workspace域的generated-directory行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`../../src/workspace/generated-directory.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/git.test.ts

- **类型**：Automated test；215行。
- **作用**：workspace域的git行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`、`../../src/workspace/git.ts`等9项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/lifecycle.test.ts

- **类型**：Automated test；691行。
- **作用**：workspace域的lifecycle行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:crypto`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`等16项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/project-tools.test.ts

- **类型**：Automated test；155行。
- **作用**：workspace域的project-tools行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`、`drizzle-orm`等15项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/project-wrappers.test.ts

- **类型**：Automated test；36行。
- **作用**：workspace域的project-wrappers行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`../../src/workspace/project-wrappers.ts`、`../../src/workspace/state.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/read-only.test.ts

- **类型**：Automated test；159行。
- **作用**：workspace域的read-only行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`、`drizzle-orm`等12项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/runtime.test.ts

- **类型**：Automated test；75行。
- **作用**：workspace域的runtime行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`../../src/workspace/runtime.ts`、`../../src/workspace/state.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/source-browser.test.ts

- **类型**：Automated test；125行。
- **作用**：workspace域的source-browser行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`drizzle-orm`、`../../src/process.ts`、`../../src/db/bootstrap.ts`等12项。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

#### tests/workspace/state.test.ts

- **类型**：Automated test；166行。
- **作用**：workspace域的state行为回归测试。
- **职责**：负责验证对应owner的成功、失败和恢复行为；不提供production能力。
- **主要依赖**：`node:assert/strict`、`node:child_process`、`node:fs/promises`、`node:os`、`node:path`、`node:test`、`node:util`、`../../src/workspace/state.ts`。
- **被使用情况**：由Node test/Vitest测试发现规则调用。
- **问题**：问题：无独立production风险；重复fixture是隔离测试成本。
- **设计评价**：合理。
- **过度设计**：否。 当前结构对应真实owner、协议、状态或工具入口。
- **中间层**：不存在production中间层。
- **重复代码/校验**：未发现应抽取的重复代码或重复校验。
- **兼容代码**：未发现历史接口、旧数据或旧配置自动兼容逻辑。
- **无用代码**：不存在。
- **删除建议**：保留。
- **合并建议**：不建议仅为减少文件数合并；合并必须保持当前owner和failure semantics。
- **优化方案**：与owner同步维护；不为减少测试行数抽共享业务状态。

## 审查方法与限制

使用Git tracked文件清单、TypeScript/ES import图、Madge、Knip、jscpd、TypeScript typecheck、全量测试、production build、npm audit和人工边界复核。静态工具对HTML、Worker、CLI、Vite virtual module和外部文件约定存在误报，报告已逐项按实际入口修正。未对真实DMS/SLS/MySQL/Redis/RabbitMQ/Nacos/Elasticsearch执行生产查询，也未将新镜像切换到真实容器。
