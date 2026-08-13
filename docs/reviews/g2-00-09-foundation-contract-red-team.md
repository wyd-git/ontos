# Red-Team：G2-00-09 Foundation Contract 与兼容性 Gate

结论：**Conditional Go**。G2-00-09 的合同内容和本地自动门禁可进入集成验证；受保护 CI、基线 Owner 审批和真实 API 脱敏仍分别属于 G2-00-12 与 G2-05，不能因本任务通过而宣称已经具备完整发布保护。

## Top Kill-Assumptions（按优先级）

### 1. Foundation ID 与已批准的持久化模型一致（已关闭，95）

- **Claim：** Foundation ID 可以直接成为后续 Metadata、Materialization、Action 和 Event 的共同 Wire 编码。
- **Steelman：** 使用统一、不透明的应用生成 ID 能避免模块自定义格式，也不向客户端泄漏数据库键。
- **Fails if：** 合同选择的 ID 算法与蓝图 §4.2 的应用生成 UUID 冲突，导致 G2-01 建表前必须立即破坏 v1。
- **Evidence to get this week：** 对照蓝图 ID 决策与 Schema/Parser/Golden Fixture。
- **Kill criterion：** Foundation 仍使用前缀 ULID、数据库自增 ID，或客户端可以从 ID 解析类型/时间。
- **Cheapest test：** UUID 正例和大写非规范拒绝向量。
- **处理：** 初版红队确实发现前缀 ULID 与蓝图冲突；已改为规范小写 UUID，Correlation ID 单独建模。`foundation.test.ts` 验证不透明 UUID。**CLOSED**。

### 2. Schema 通过等于真实 Runtime 入口能接收（已关闭，92）

- **Claim：** 兼容 Diff 允许的可选字段增加可以按 Server/Reader 先行顺序落地。
- **Steelman：** Schema Diff、Golden Fixture 和 Parser 测试使用同一个合同目录，能尽早暴露漂移。
- **Fails if：** 开发者只更新 JSON Schema，Runtime Parser 仍使用旧精确字段集合；Diff 报兼容，但生产写入全部拒绝新字段。
- **Evidence to get this week：** 故意向 Schema 增加 Parser 未知的可选字段，合同 Gate 必须失败。
- **Kill criterion：** 该变异仍通过 `npm run check:contracts`。
- **Cheapest test：** `optionalButParserForgotIt` 单字段变异。
- **处理：** 新增 Runtime/Schema agreement Gate，核对字段集合、Required、Reference、Pattern、Length、Enum 和关键限制；对应变异测试通过。**CLOSED**。

### 3. 稳定错误分类不只是 JSON 清单（已关闭，90）

- **Claim：** 客户端可以稳定依赖核心 Error Code、Category 和 Retryable。
- **Steelman：** 16 个 PRD 核心错误已经有机器目录与删除/语义变化 Diff。
- **Fails if：** Runtime Producer 能发送 `RATE_LIMITED + internal + retryable=false` 一类与目录矛盾的 Envelope，客户端动作随入口漂移。
- **Evidence to get this week：** 对每个核心错误比较 JSON 目录与 Runtime 表，并尝试解析矛盾分类。
- **Kill criterion：** 已知核心 Code 能以另一 Category/Retryable 通过 Parser。
- **Cheapest test：** 构造一个错误分类矛盾的 `RATE_LIMITED`。
- **处理：** Runtime 现在对 16 个已知核心 Code 强制稳定分类，Gate 同时比较 Runtime 与 JSON 的 HTTP Status/Category/Retryable；未知模块 Code 仍可按 Envelope 规则扩展。**CLOSED**。

### 4. 自动 Diff 不能通过“同时改基线”被绕开（待 G2-00-12，84）

- **Claim：** 破坏性变化会在合并前被自动拦截。
- **Steelman：** 当前 Diff 能阻止删除、改名、必填增加、类型/Reference/Pattern/Format/Enum 变化、限制收紧和未知字段策略变化，并有故意失败测试。
- **Fails if：** 同一个 PR 同时修改 Current 和 Baseline，或跳过本地 `verify`；本地工具无法区分授权主版本升级和规避检查。
- **Evidence to get this week：** G2-00-12 建立 Contracts Owner 审批、受保护 CI、基线路径审查规则与故意失败流水线。
- **Kill criterion：** 无 Owner/ADR/迁移计划的 v1 基线改写可以直接合并。
- **Cheapest test：** 在测试分支同时改 Current/Baseline，确认分支保护仍要求 Contracts Owner。
- **处理：** 治理文档已禁止日常改基线，并明确 G2-00-12 Owner；本任务尚无远端强制 CI 权限。**OPEN，Owner：Platform / Quality + Contracts，Gate：G2-00-12**。

### 5. Error Details 安全边界不会被误当成完整脱敏（待真实 API，76）

- **Claim：** Error Envelope 不会把 Stack、SQL、Secret、Token 或原始依赖错误暴露给客户端。
- **Steelman：** Producer 使用精确字段集合，`details` 有 16 KiB/深度/节点限制、无原型不可变克隆，并且顶层 `stack` 被拒绝。
- **Fails if：** API Producer 把敏感值放进合法的 `details` Key；结构 Parser 不理解业务敏感度，无法自行执行 Policy/Redaction。
- **Evidence to get this week：** 第一个 G2-05 API Producer 的敏感异常、Policy Mask 和日志/响应分离测试。
- **Kill criterion：** Secret、Token、SQL、路径或 Stack 能通过任一真实 API 响应到达客户端。
- **Cheapest test：** 向真实 Adapter 注入带 Secret 的依赖异常并检查 HTTP Body 与日志。
- **处理：** 合同治理明确结构限制不等于脱敏；当前尚无业务 API，不能伪造已完成证据。**OPEN，Owner：API / Security，Gate：G2-05**。

## Intended vs. Implemented

| 验收意图                                                              | 实现证据                                                                                                                                         | 结论                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 冻结 Foundation 共同合同                                              | `packages/contracts/src/`、Foundation Schema、Catalog、错误码目录；Value Codec 绑定 ADR-009                                                      | PASS                          |
| 写入拒绝未知字段，读取策略明确                                        | Object Schema `additionalProperties=false`；Runtime 精确字段；Error Consumer Reader 忽略新增响应字段；治理 §3                                    | PASS                          |
| 每类有合法/边界/拒绝 Fixture                                          | 11 类 Foundation 中 10 类使用 30 个 Fixture；Value Codec 使用原有 positive/invalid/PK/order/collision 向量并由 Gate 校验存在                     | PASS                          |
| 自动阻止删除/改名/收紧，允许已定义增加                                | Schema Diff、Error Catalog Diff 与 7 个兼容性测试；Runtime/Schema 漂移变异测试                                                                   | PASS（远端强制留到 G2-00-12） |
| Query/Snapshot/Action/Event 有 Owner、不变量和最晚 Gate，不假冻结字段 | Catalog 中 5 个合同族均为 `fieldsFrozen=false`，最晚 G2-01～04；治理 §4                                                                          | PASS                          |
| 合同包无 HTTP/DB/React/云 SDK 和数据库列                              | `@ontos/contracts` 无 Runtime Dependency；架构策略对 Contracts 的 Workspace/External Dependency 与 Import allowlist 均为空；公共字段无数据库列名 | PASS                          |

审查中修复了三项会使“测试通过但后续无法落地”的偏差：ID 算法与蓝图冲突、Schema/Runtime 双轨漂移、核心错误分类只登记不执行。没有发现需要退回重做 Foundation 边界的未关闭问题。

## What's Well-Reasoned

- 两层渐进冻结成立：只冻结已有跨模块依据的 Foundation，模块字段保留 Owner/Gate/不变量，避免把猜测变成永久兼容负担。
- 合同包保持纯边界层，Property Value Codec 复用 ADR-009 资产而不制造第二份编码实现。
- 自定义 Schema Gate 只接受已实现的关键字；出现新关键字会失败，不会静默假装已验证。
- Error Producer 严格、Consumer 对响应新增字段宽容的分离，给出了可执行的滚动发布顺序。

## What I Couldn't Assess

- 没有业务 Endpoint，因此无法验证 HTTP Framework 是否在所有入口调用 Parser，也无法验证真实错误脱敏；这属于 G2-05。
- 没有受保护 CI 与 Contracts CODEOWNER，因此当前只能证明本地 Gate 有效，不能证明所有 PR 都无法绕过；这属于 G2-00-12。
- 没有跨版本部署样本；v2 只有在出现第一个真实破坏性需求时才能验证双读、支持窗和迁移退出条件。
