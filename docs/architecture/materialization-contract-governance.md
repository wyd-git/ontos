# Materialization v1 合同与兼容性治理

- 状态：Frozen for G2-02-02
- Owner：Contracts / Data Runtime
- 范围：Snapshot Schema、Mapping、Snapshot/Group、Job/Report、Generation、Runtime Plan/Activation、Compatibility Certificate、Index Capacity 与 GC Plan

## 1. 权威资产

G2-02 的数据运行合同不以数据库 `jsonb`、Worker 私有类型、HTTP DTO 或页面表单为权威。机器可执行资产为：

- `packages/contracts/src/materialization.ts`：严格 Runtime Parser、状态机、规范 Digest 前像和稳定错误族；
- `packages/contracts/schemas/materialization.schema.json`：Materialization v1 JSON Schema；
- `packages/contracts/src/resource-family-registry.ts`：直接 Resource 与 Package 共用的 Family Registry；
- `packages/contracts/catalog.json`：12 个顶层合同的 Owner、冻结状态及 Materialization 模块清单；
- `packages/contracts/fixtures/materialization-golden.json`：Object/Link、组合 Group、质量结果和安全负例；
- `tools/contracts/baseline/materialization.v1.schema.json`：首次冻结的不可随意改写基线；
- `tools/contracts/check-materialization.ts`：Schema、Runtime、Catalog、Fixture、Registry 与 Baseline 的统一 Gate；
- `tools/contracts/materialization-runtime-schema-agreement.ts`：逐字段核对 Schema 与 Parser，防止两套合同静默漂移。

`@ontos/contracts` 仍是纯合同层，不读取文件、对象存储、数据库、网络或凭据，也不实现值转换。实际 String/Integer/Decimal/Date/Timestamp/Enum/JSON 与 Primary Key 编码由 `@ontos/value-codec` 的 `pk1` 合同拥有；Mapping 只固定引用版本，不能复制 Codec。

## 2. 冻结的能力边界

本 Gate 激活 `snapshot_schema` 和 `mapping` 两个 Resource Family。它们与 `object_type`、`link_type` 一样，直接 Resource 路径和 Package 展开路径最终都经过同一个 Registry 和 Parser。`policy`、Function、Action、View 等 Family 仍未激活。

Snapshot Schema v1 只允许：

- 显式、有序且名称唯一的列；
- 固定 `csv_utf8`、必须存在 Header；
- Foundation 已登记的 Property Value Type 及受限 Enum/Decimal/String 选项。

Mapping v1 只允许单输入逐行确定性 AST：

- `column`、`constant`、`cast`、`concat`；
- Object Primary Key Expression；
- Link 两端 Object Key Mapping；
- Required/Optional Null 策略和显式质量阈值；
- 每个需要转换或编码的节点固定引用 `pk1`。

Parser 不接受 Raw SQL、脚本/代码、Join、Window、Aggregate、未激活 Function、任意路径、外部 Endpoint、Bucket/URL、Credential 或 Schema 推断开关。Dataset Snapshot 只能保存平台签发的 `managedArtifactId`、内容摘要、字节数和行数，不能保存用户路径或 Presigned URL。

## 3. 顶层合同

冻结 12 个顶层合同：

1. `SnapshotSchemaDefinition`
2. `MappingDefinition`
3. `DatasetSnapshot`
4. `SnapshotGroup`
5. `MaterializationJob`
6. `MaterializationReport`
7. `Generation`
8. `RuntimeMemberPlan`
9. `RuntimeActivation`
10. `CompatibilityCertificate`
11. `IndexCapacity`
12. `GcPlan`

所有 Object 都拒绝未知字段；ID、Digest、时间、整数和版本使用 Foundation 的严格格式。JSON Schema 负责可表达的结构约束，Runtime Parser 继续负责跨字段语义，例如：

- Snapshot File 汇总必须与 Snapshot 总字节/总行数完全相等，且求和不能越过安全整数；
- Group、Runtime Plan 和 Activation Member 按 `memberKey` 确定性排序且不能重复；
- Job 不能时间倒流，Queued 不能伪造进度，Checkpoint 不能领先当前 Stage；
- Report 的 Accepted + Rejected 必须等于 Total，致命原因不能标记 Passed/Awaiting，错误样本必须对应聚合原因；
- 同一个 Snapshot Group 的 Activation Member 不能混用 Group Version；
- Capacity 的硬上限不能通过审批绕过，Projected Peak 不能低于实测或预留；
- GC Candidate 必须有序、唯一，并绑定 State/Inventory Revision 与 Protected Root Digest。

## 4. 状态、幂等与 Digest

Snapshot、Snapshot Group、Job、Generation、Runtime Activation 和 GC Plan 都有闭合状态集合及显式合法边；未知边和终态复活返回 `CONTRACT_STATE_TRANSITION_INVALID`。同状态重放允许作为幂等确认，但不能改变不可变事实。

Materialization Idempotency 前像恰好包含：

- `contentDigest`
- `mappingRevisionId`
- `targetMemberKey`
- `runtimePlanDigest`
- 固定 `idempotencyVersion`

Display Name、上传时间、数据库读取顺序和其他客户端附加字段不是“被忽略”，而是被严格拒绝，因此不能意外污染或绕过幂等身份。

每个规范 Digest 函数都先运行对应 Parser，再删除明确列出的自引用 Digest 与生命周期元数据。Object Key 顺序不改变前像；Mapping Revision、Snapshot/Group Version、Runtime/Index Plan、Generation Member 或其他业务事实改变时前像必须改变。Baseline 和 mutation tests 阻止字段、Enum、Required、未知字段策略与边界静默变化。

## 5. Compatibility Certificate 信任边界

Compatibility Certificate 固定 `issuer=materialization-compatibility-verifier`，并绑定：

- Generation ID/Digest；
- 目标 Release、Member Key 与 Target Revision；
- Snapshot Group/Version 与 Snapshot Schema Revision/Digest；
- Mapping Revision/Digest；
- Index Plan、Runtime Plan、Validator Version 与 Evidence Digest。

合同没有 `compatible: true` 字段。客户端、Package 或数据库 Row 不能靠提交布尔值自证兼容；后续应用层只能保存服务器验证器签发且 Digest 可重算的证书。

## 6. 质量与稳定错误

Report 原因码冻结为 Primary Key Null/Duplicate、Required/Optional Property Invalid、Required/Optional Link Dangling 和 Row Count Confirmation Required。Required/Primary Key/Required Link 门槛固定为零；Optional 失败进入 Rejected Row，不降级成业务 `null`。

模块同时冻结 11 个操作错误码，包括 Snapshot 内容/Schema、Mapping、幂等冲突、验证/确认、Lease Fencing、Generation 兼容、Runtime Plan、容量硬上限和陈旧 GC Plan。HTTP 状态与公开 DTO 尚未在 G2-02-02 冻结；后续 Admin API 只能映射这些稳定语义，不能重新定义它们。

## 7. 兼容和发布顺序

- 删除/改名字段、增加必填、类型/Ref/Const/Pattern/Format/Closed Enum 变化、收紧约束或放宽未知字段策略均为 Breaking；
- 新独立 Definition 或可选字段是 Schema 层 Compatible finding，但只有 Runtime Parser、所有 Reader 与 Fixture 先部署后，Writer 才能产生；
- 未知 `schemaVersion`、`contractVersion`、`mappingVersion` 或 Codec Version 一律 fail closed；
- Baseline 仅能在首次冻结或有 ADR/迁移/双读计划的新主版本建立，不能与候选同步改写来“修绿”测试。

## 8. 本 Gate 没有宣称的能力

G2-02-02 只冻结并验证跨模块合同。它没有创建 DB-02 表、Migration、S3 上传、CSV Reader、Materializer、Worker Lease、Index Executor 生产部署、Cutover、GC 执行或 HTTP Endpoint。下一步 G2-02-03 必须把这些合同映射到连续 `0007+` Migration、Trigger 和最小权限，并用真实 PostgreSQL 16 证明不可变/Fencing 边界；不得把“合同可解析”冒充“数据闭环已经运行”。
