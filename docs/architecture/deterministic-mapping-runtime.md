# 确定性 Mapping 编译与流式执行

- 状态：G2-02-05 implementation boundary
- Owner：Data Runtime / Contracts
- 前置：G2-02-02 Mapping/Snapshot Schema 合同、G2-02-04 Managed CSV Ingress、ADR-009 `pk1`

## 1. 本 Gate 的边界

G2-02-05 只负责把一个已注册 Snapshot 的 CSV 行解释成确定性 Object 候选或 Link Identity Lookup。它不创建 RID、不写 Object/Link Base、不建立 Current、不判定 Dangling Link，也不改变 Activation。上述职责从 G2-02-06 开始。

实现位于 `@ontos/materialization-domain`：

- Managed CSV Reader 在完成 G2-02-04 物理校验的同一状态机中逐行解码，不另造第二套 CSV 语义；
- Mapping Compiler 再次运行冻结合同 Parser，并把列、目标 Property、Object PK 与 Link Endpoint Revision 解析成无函数、无 SQL 的规范 Plan；
- Row Evaluator 只执行 `column`、`constant`、`cast`、`concat`；
- 所有公共值和 Primary Key 都调用 `@ontos/value-codec`，数据库不参与输入转换。

## 2. 绑定与 Plan Digest

Compiler 输入必须同时提供不可变 Revision 绑定及其内容 Digest：Mapping、Snapshot Schema、Target Definition；Link 还必须提供两端 Object Type 的 Resource/Revision/Digest。Compiler 重新计算内容 Digest并逐项相等校验，同时验证 Mapping 内的 Schema/Target/Endpoint ID 与这些绑定完全一致。

Plan 固定包含：

- `mapping-compiler-v1`；
- Mapping Revision ID/Digest；
- Input Schema Revision ID/Digest；
- Target Resource/Revision/Definition Digest；
- `mapping-v1` 与 `pk1`；
- 已解析列序号、Value Descriptor、Property Mapping、Object PK 或 Link Endpoint Key；
- 冻结的质量规则；每个非空 Base Property 必须有且只有一个显式 Mapping；
- 排除 `planDigest` 自身后的规范 SHA-256 Digest。

相同不可变输入必须跨进程产生逐字节相同 Plan。Display Name、数据库读取顺序、Worker ID、时间和随机数均不进入 Plan。

## 3. 值与 null 语义

- CSV 空字段解释为 `null`；常量 `""` 仍是显式空字符串。
- 非空 CSV 字段先按 Snapshot Schema Descriptor 经公共 Codec 解析；Boolean 只接受 `true`/`false`，JSON 与 `string[]` 只接受严格 JSON 文本。
- 不同 Value Type 之间必须出现显式 `cast`。Decimal/Enum Cast 必须从最终目标 Descriptor 获得 precision/scale 或 code list，禁止无 Schema 的宽松转换。
- `concat` 只连接已成为 string 的输入；任何输入为 null 时结果为 null。
- Object `primaryKeyExpression` 独占 Primary Key Property，先产出规范 Property Value，再用 `pk1` 生成 `canonicalPrimaryKey`。
- Link 只产出两端 `{objectTypeResourceId, objectTypeRevisionId, canonicalPrimaryKey}`，API/Display Name 不参与身份。

## 4. 流、错误与内存

Reader 每次最多保存一个受 `maximumRecordBytes` 约束的解码行，并等待 Row Consumer 完成后继续。Executor 同样一次只保存当前行、当前事件、固定大小聚合 Map 和链式 Stream Digest；不保存所有 PK、结果或错误。

Sink 拒绝事件时 Execution 立即进入不可继续的终态并返回稳定错误；不能在下游未接收一行后继续推进后续行。

Rejected Row 只包含有界行号、稳定 Materialization Reason、Mapping Code、可选 Codec Code，以及仅在非敏感、非 PK/Endpoint 情况下允许的单一列名。原值、完整 PK、JSON 内容、Secret、分类为 confidential/restricted 的列名不进入普通错误。

Mapped Stream Digest 使用固定 `mapping-stream-chain-v1` 前像，把 Source Content Digest、Plan Digest 和每个按源顺序产生的 accepted/rejected 事件链式绑定。Sink 有背压；同一 Source/Plan 重放必须得到相同事件顺序、计数、聚合和最终 Digest。

## 5. 停止条件

- 若 Reader/Executor 在 100k Object 或 1m Link 的受限 Heap 进程中随行数线性增长，停止进入 G2-02-06并先修复批次/Reader；
- 若目标类型只能依赖 PostgreSQL/DuckDB 隐式 Cast 才能通过，拒绝该 Mapping，不放宽 Codec；
- 若 G2-02-06 无法直接以本 Gate 的 Canonical PK/Identity Lookup 写入身份仓储，只修改本 Gate 的显式版本化输出，不并行建立第二解释层。
