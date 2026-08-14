# Red-Team：G2-00-11 正式 Testkit 与 G1 资产迁移

结论：**Go（仅限 G2-00-11 正式测试资产与本地 Gate）**。G1 的可复用输入已经与一次性运行时代码分离；固定种子生成器、来源/目标摘要、语义向量和依赖禁线均有可执行证据。生产实现是否正确消费这些 Vector、远端 CI 是否不可绕过，分别属于后续实现任务和 G2-00-12，不因本任务通过而宣称完成。

## Top Kill-Assumptions（按优先级）

### 1. 正式 Workspace 真的无法绕回 Spike（已关闭，96）

- **Claim：** `packages/testkit` 是复制后的正式资产，任何 `apps/packages` 都不能运行时依赖 `spikes/g1`。
- **Steelman：** 架构策略已有 `testkit` Layer，生产 Layer 不能依赖它；新增 Forbidden Repository Root 可阻断直接相对导入。
- **Fails if：** 检查器只扫描 `src/`，让根入口或其他源码目录绕过；或通过 `file:../../spikes/g1` 的 Manifest 依赖绕过源码 Import 检查。
- **Evidence to get this week：** 在 `src/index.ts`、包根 `index.ts` 和 `package.json` 各加入一个故意违规 Fixture。
- **Kill criterion：** 任一违规输入仍返回 Architecture PASS。
- **Cheapest test：** 一个临时 Workspace、一个 G1 相对 Import 和一个 `file:` Dependency。
- **处理：** 首轮红队确认原检查范围存在这两个缺口；现扫描整个 Workspace（排除生成/构建目录），同时解析 `file:`/`link:` 依赖。两类负面 Fixture 均被稳定拒绝。**CLOSED**。

### 2. Provenance 不只是“来源有 Hash、正式副本可随便漂移”（已关闭，94）

- **Claim：** 每组资产都能证明从哪个冻结 G1 输入迁来，并明确所有转换。
- **Steelman：** Catalog 记录整体指纹、分组指纹、单文件 Hash、正式 Target 和 Intentional Transform。
- **Fails if：** 审计只重算 G1 Source，而 Query/Overlay/Policy/兼容性 Target 被静默改写仍然 PASS。
- **Evidence to get this week：** 对每个 Source 和正式 Target 重算 SHA-256；对两套 Manifest 额外做 JSON 语义等价比较。
- **Kill criterion：** 任一 Source/Target 改字节或改路径后审计仍通过，或正式 Manifest 与 G1 语义不同。
- **Cheapest test：** 路径+字节 Fingerprint 负面测试，加一次 Catalog Audit。
- **处理：** 首轮实现只冻结 Source；红队后给每个 Target 增加 SHA-256 并纳入 Audit，两包再做 JSON 等价核验。**CLOSED**。

### 3. 100k/1m 不是把百万行藏进仓库或内存（已关闭，91）

- **Claim：** 一个固定 Seed 同时支持快速小数据和 100k Object / 1m Link 基准数据。
- **Steelman：** Generator 是纯 Iterable，标识和属性公式固定，不需要数据库或文件输出。
- **Fails if：** Benchmark API 先构造百万元素数组、需要本地 PostgreSQL，或把生成结果写入 Git。
- **Evidence to get this week：** 完整遍历两个 Preset，核对首尾、计数和 Small Digest，并扫描正式 Fixture 体积与本地配置字符串。
- **Kill criterion：** 计数不精确、相同输入摘要不同、必须连接外部服务，或提交大文件。
- **Cheapest test：** 在 Node Test 内流式计数 100k/1m，不保存集合。
- **处理：** 全量流式遍历通过；全仓 Verify 并发场景约 0.56 秒完成该测试，正式 Fixture 总量受 512 KiB 上限保护，`generated/` 已由 Git Ignore 排除。**CLOSED**。

### 4. “迁移 Vector”没有偷偷迁移 G1 实现，也没有丢掉关键语义（已关闭，88）

- **Claim：** Query、Overlay/Conflict、Policy、Package Compatibility 的价值是输入/期望，而不是 G1 Compiler、Gateway、Reference Model 或 Release Store。
- **Steelman：** JSON Vector 只保存 Operation、Input、Expected、Error Code 和参考阈值，未来生产实现可以独立消费。
- **Fails if：** Testkit 为了运行 Vector 直接 Import G1 实现；或迁移后缺少 G1 已冻结的主要案例族。
- **Evidence to get this week：** 对照 G1 测试名和 Query Corpus，核对 10 Query、9 Overlay、8 Policy、8 Compatibility Case 及两个完整领域包。
- **Kill criterion：** Testkit Runtime 出现 `spikes/g1` Import，或任一主要案例族没有正式 ID/Expected。
- **Cheapest test：** 资产加载和 Case ID 断言，加架构禁线。
- **处理：** Testkit 仅从自身 Fixture URL 读取 JSON；Compiler/Gateway/Reference Model/Release Store 均未迁移，主要案例族完整保留。**CLOSED**。

### 5. Testkit 不会反向变成生产依赖（已关闭，85）

- **Claim：** Testkit 可以依赖被测正式模块，但生产 App/Application/Domain/Contract/Adapter 不能依赖 Testkit。
- **Steelman：** Layer 允许方向由单一机器策略定义，既检查 Manifest，也检查源码 Import。
- **Fails if：** 生产模块声明 `@ontos/testkit` 后仍可通过，导致 Fixture/Node 文件读取进入 Runtime Bundle。
- **Evidence to get this week：** 一个 Application → Testkit 的故意失败 Workspace。
- **Kill criterion：** 该依赖未产生 `WORKSPACE_LAYER_VIOLATION`。
- **Cheapest test：** 现有 Architecture Negative Fixture。
- **处理：** 负面 Fixture 稳定失败，正式 Testkit 自身无任何 Runtime Package Dependency。**CLOSED**。

## Intended vs. Implemented

| 文档化意图                                       | 实现证据                                                                                           | 越界主体 / 受影响边界               | 结论 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------- | ---- |
| 固定 Seed 生成 Small 与 100k/1m，且不提交大数据  | `packages/testkit/src/generator.ts:37-138`；`testkit.test.ts:57-158`；`.gitignore` 的 `generated/` | 测试作者 / 内存、仓库体积和可复现性 | PASS |
| 两包各有 5/5/3/2/2 正式资源                      | 两个 `fixtures/packages/*.v1.json`；`testkit.test.ts:10-20`                                        | Package 作者 / 后续 Runtime 通用性  | PASS |
| 每组记录 G1 来源、冻结指纹和转换                 | `fixtures/provenance.json`；`tools/testkit/provenance.ts:37-130`                                   | 资产维护者 / 来源真实性与语义漂移   | PASS |
| Testkit 不导入 G1 实现                           | `assets.ts:19-55` 只读取正式 Fixture；`policy.json:38`                                             | Testkit 代码 / Spike 一次性边界     | PASS |
| 所有 `apps/packages` 不能导入或文件依赖 G1       | `check-workspace.ts:236-343`；负面测试 `check-workspace.test.ts:247-280`                           | 生产模块 / 运行时供应链             | PASS |
| 测试不依赖 G1 Evidence、个人路径、端口或示例密码 | `testkit.test.ts:133-158`；Testkit `package.json` 无 Runtime Dependency                            | 本地/CI 执行者 / 隐藏状态           | PASS |
| G1 冻结指纹可独立复验                            | `provenance.ts:34-119`；`provenance.test.ts`                                                       | 迁移维护者 / 47 个冻结输入          | PASS |

没有发现仍未关闭、且属于 G2-00-11 范围的 Intended-vs-Implemented 偏差。

## What's Well-Reasoned

- 把“测试输入”和“参考实现”分开，使未来生产代码必须独立实现语义，而不是把 Spike 包装成产品。
- 生成器使用 Iterable，把 1.1m 条容量数据变成可重复计算，而不是仓库 Artifact；小数据 Digest 又能快速发现公式漂移。
- Source、Group、Target 三层摘要加 Intentional Transform，能区分 G1 来源变化、正式资产变化和有意重写。
- 依赖禁线放在已有架构检查中，不额外维护一套只针对 Testkit 的扫描器。

## What I Couldn't Assess

- 这些 Vector 尚未绑定到未来 Query、Overlay、Policy 和 Package 生产实现；对应模块出现时必须把正式 Vector 接入其 Contract/Integration Test，Owner：各 Runtime 模块 Owner。
- G1 延迟阈值只作为参考元数据，不能直接成为不同 CI 机器的阻断预算；正式性能预算在容量/性能 Gate 以目标环境证据确定。
- G2-00-12 尚未把 Testkit/Architecture/Provenance 设为远端分支保护 Required Check；当前结论只覆盖本地可执行 Gate。
