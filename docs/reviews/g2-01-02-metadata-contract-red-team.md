# Red-Team：G2-01-02 Metadata 合同与兼容 Gate

- 日期：2026-08-14
- 审查对象：Metadata v1 Schema、Runtime Parser、Catalog、Golden Fixture、Registry、Digest 与 Compatibility Gate
- 方法：Steelman → Fails if → Cheapest Test → Intended-vs-Implemented
- 结论：**Go**。三个实际偏差已在冻结前修正；DB、HTTP 与业务兼容算法仍由后续任务补证。

## Top Kill-Assumptions

### 1. JSON Schema PASS 等于可发布（风险分 96，已关闭）

- **Claim：** Schema 与 Runtime Parser 足以阻止不合法 Metadata 进入 VALIDATED/READY。
- **Steelman：** Schema 适合可移植结构验证，Runtime 适合 Primary Key 引用、报告汇总与确定性排序等跨字段语义；强行把两者混成一个会降低可审计性。
- **Fails if：** 系统只调用 Schema；或把 Schema 接受的语义矛盾对象当成 Parser 漂移并删除 Runtime 规则。
- **Cheapest test：** `valid=true + error issue`、不存在的 Primary Key 引用、错误 Pin Order 三个 Schema-accept/Runtime-reject 向量；再故意给 Schema 增加 Parser 不认识的可选字段，agreement 必须失败。
- **处理：** 明确两层验证都必跑；36 个 Fixture 标记结构/语义处置；agreement 逐项校验 Schema 可表达部分。**CLOSED**。

### 2. Package 与直接 Resource 路径会形成两套 Family 判断（风险分 94，已关闭）

- **Claim：** 未有 Validator 的 Family 无论从哪个入口都不能进入 VALIDATED/READY。
- **Steelman：** 单一 Registry 能按 Gate 增量激活 Family，避免 Package Adapter 把 Deferred 内容当作不透明 JSON 放行。
- **Fails if：** Package Expander 自己维护 Switch；或 Manifest 能携带 Deferred Entry 就被误认为内容可发布。
- **Cheapest test：** 两个入口遍历 8 个 Deferred Family，必须得到相同 `CAPABILITY_NOT_ACTIVE` 和 Freeze Gate；未知 Family 必须得到 `RESOURCE_FAMILY_UNKNOWN`。
- **处理：** 两个公开入口共同委托 `parsePublishableResourceContent`；10 个 Registry Entry、2 Active/8 Deferred 由 Gate 固定。**CLOSED**。

### 3. Digest 前像存在自引用或跨运行时漂移（风险分 92，已关闭）

- **Claim：** 相同 Metadata 在不同 JSON Key 顺序/空白下得到相同 Digest。
- **Steelman：** 合同层输出规范 UTF-8 前像，基础设施只负责 SHA-256，可以同时保持浏览器/Node/Worker 可移植性。
- **Fails if：** Manifest 把自身 `manifestDigest` 包进前像；浮点/负零在不同序列化器中改变；Object Key 使用隐式 Locale 排序；调用方各自删除不同字段。
- **Cheapest test：** 重排嵌套 Key 与 JSON 空白后比较 SHA-256；改变业务值必须变化；只改变 `manifestDigest` 不变化；负零/Unsafe Integer/Undefined 拒绝。
- **处理：** 新增统一 Canonicalizer 与 Manifest 专用前像函数，排序规则和字段排除写入治理文档。**CLOSED**。

### 4. 当前字段“看起来完整”，却违反 PRD 或过早冻结（风险分 90，已关闭）

- **Claim：** G2-01 冻结的是 Object/Property/Link 可落地核心，不提前拥有 Mapping/Policy/View。
- **Steelman：** 后续资源族通过新 Revision/Release 增量加入，历史 Published Revision 不变；这比现在猜测引用结构更安全。
- **Fails if：** 为了形式完整提前加入 Mapping/Policy/View 字段；把 PRD 允许继承的 Property Classification 误做必填；允许 Primary Key Property `unique=false`；或 Metadata 的 Primary Key 类型/大小写规则与 Foundation `pk1` Codec 不一致。
- **Cheapest test：** 对照 PRD §11.1～11.3、ADR-009 与任务包渐进冻结表；Property 省略 Classification 必须合法；String 缺失 `caseSensitive` 必须拒绝；Primary Key 的 Nullable/Unique/非稳定类型反例必须拒绝，Foundation 支持的 Stable Scalar 必须接受；Deferred 字段不得出现在 Schema。
- **处理：** 审查实际发现 Classification 误必填、Primary Key 未强制 Unique、只允许 String/Integer 且 String 没有 Case Rule 四个偏差，均已修正；Mapping/Policy/View 保持 Deferred。**CLOSED**。

### 5. “零成员 Activation”被误实现为“空 Metadata Release”（风险分 84，已关闭）

- **Claim：** G2-01 可以发布无业务数据 Generation 的正式 Release。
- **Steelman：** Release Pin 是 Metadata 定义集合，Activation Member 是 Runtime Projection 集合，两者属于不同平面。
- **Fails if：** Release Manifest 允许空 Pin 并以此证明零成员；后续 DB-02 才发现 Release 从未绑定任何 Metadata Revision。
- **Cheapest test：** 空 `pins` 在 Schema 和 Runtime 同时拒绝；一个 Metadata Pin + 零 Runtime Member 的状态 Proof 继续由 G2-01-01 保留。
- **处理：** Release Manifest `pins.minItems=1`；文档明确区分 Metadata Pin 与 Runtime Member。**CLOSED**。

## Intended-vs-Implemented

| Intended                                | Implemented                                                         | 反例/证据                                                                  | 结果 |
| --------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---- |
| 12 类 Metadata 合同版本化、严格未知字段 | Metadata Schema + 12 Runtime Parser + Catalog                       | 每类合法/边界/拒绝 Fixture；嵌套未知字段拒绝                               | PASS |
| Object/Property/Link 核心字段真实可用   | PK/Title/Search/Sort、Property 类型/查询声明、Link 两端/Cardinality | 错误 PK、查询引用、Decimal/JSON、Cardinality 反例                          | PASS |
| 两条入口由单一 Family Registry 控制     | Direct/Package 两入口共同委托 Registry                              | 8 Deferred × 2 入口 + Unknown 反例                                         | PASS |
| Schema、Parser、Baseline 不静默漂移     | Agreement + Compatibility Diff                                      | Optional Addition、删除、Required、Type、Enum、Bounds、Unknown Policy 变异 | PASS |
| Digest 对无语义表示变化稳定             | Canonical JSON + Manifest Preimage                                  | Key/Whitespace/Self Digest/Invalid Number 反例                             | PASS |
| 后续 Family 不假冻结                    | Catalog 只有 Metadata Family `fieldsFrozen=true`                    | 其他 4 Deferred Contract Family 仍为 false                                 | PASS |
| 合同层可移植                            | `@ontos/contracts` 零 Runtime Dependency/Node Import                | Architecture Gate                                                          | PASS |

## What I Couldn't Assess

- DB-01 还未实现，无法证明 Published Revision 的数据库不可变、API Name 不复用、Foreign Key 与 Runtime Role 最小权限；Owner 为 G2-01-03。
- 当前只冻结 Report Envelope，尚未实现 Dependency Extractor 和 Object/Link 业务兼容算法；Owner 为 G2-01-06/07。
- Registry 已提供两个合同入口，但真实 Package Expander/Release Validator 尚未实现；G2-01-08/09 必须证明所有写路径实际调用，不能以本纯合同测试代替入口覆盖。
- SHA-256 Adapter 尚未接入 Store，当前证明的是规范前像与测试 Hash；持久 Digest 比对由 G2-01-05/08/09 完成。
- HTTP/OIDC/管理授权执行尚未实现；Role Binding 只是合同，不代表 Endpoint 已安全。Owner 为 G2-01-04/10。
