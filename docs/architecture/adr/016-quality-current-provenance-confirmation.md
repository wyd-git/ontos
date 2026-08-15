# ADR-016：Quality-owned Current、Provenance 与确认边界

- 状态：Accepted for G2-02-07
- 日期：2026-08-16
- Owner：Runtime / Data Quality
- 依赖：[ADR-008](008-shared-projection-index-capacity.md)、[ADR-009](009-public-value-codec.md)、[ADR-014](014-materialization-transaction-ddl-overlay-boundary.md)、[ADR-015](015-permanent-object-identity-attempt-owned-base.md)
- 决策范围：不可见 Generation 内的 Current、Object Head Candidate、质量报告、Rejected Row Artifact、最小 Property Provenance 与 Row-count Owner Confirmation

## 1. 决策结论

G2-02-07 采用“Base 先成为不可变但不可服务的事实，Quality 再原子产生候选派生事实”的顺序。`runtime.object_current`、`runtime.link_current`、Object Head Candidate、Property Provenance、Materialization Report 与 Rejected Row Set 只能由一个固定的受控数据库函数一次提交。失败、阈值超限或不完整 Provenance 不产生可供后续 Index/READY 使用的候选集合。

Generation 创建时不再伪造最终 Report。`report_id/report_digest` 在 `building` 状态允许为空；Quality 结束时只能从空值一次绑定到一个不可变 Report。Generation 进入 `ready` 前，数据库必须证明：

1. Quality Binding 为 `passed` 或仍有效的 `confirmed`；
2. Object Current 的每个 Property 都有完整 Provenance；
3. Current/Base 行数与 Report 接受行数一致；
4. zero-overlay 证明完整且为零；
5. 后续任务拥有的 Index、Measurement 与 Certificate 条件仍满足。

本任务只实现前四项的事实和守卫，不提前把 Generation 推进到 `ready`，也不切换 Activation/Serving Head。

## 2. 为什么不能沿用当前占位写法

0007 为了冻结最终 Generation 合同，要求插入 Generation 时已经存在 Report；真实生产顺序却是先创建 Job/Generation，再扫描、Mapping、Base，最后才能计算 Report。预先插入一个 `passed/0 rows` Report 会让失败数据拥有虚假的质量事实，也无法在 Report 不可变的前提下修正。

因此 0012 只向前修复绑定时序：历史非空绑定保持不变，新 Build 可空，受控函数执行一次 late binding。旧 Migration 不修改、不重写 Hash。

另外，0008 的 Property Provenance 每个 Property 只有一个 `input_column_ordinal`，无法表达 concat 的多个输入或 constant 的零输入。0012 将 Provenance 主键扩展到来源项，并用 `source_kind=column|constant` 明确二者；不会把常量伪造成列 0。

## 3. 质量判定

Mapping Revision 的不可变内容是阈值权威来源，Worker 请求不能覆盖：

- `PRIMARY_KEY_NULL`、`PRIMARY_KEY_DUPLICATE`、`REQUIRED_PROPERTY_INVALID`、`REQUIRED_LINK_DANGLING` 任一非零即 `failed`；
- `OPTIONAL_PROPERTY_INVALID` 和 `OPTIONAL_LINK_DANGLING` 分别按 `count × 10000 <= totalRows × configuredBasisPoints` 判断，默认 Fixture 为 10 basis points（0.1%）；超过即 `failed`；
- optional 错误始终整行 Rejected，不写业务 `null`；
- 一个物理行只选择一个稳定主 Reason，避免 Report 的原因计数大于 Rejected Row 数；优先级为 PK、required Property、required Link、optional Property、optional Link；
- 只在没有其他失败原因时检查 Row-count 变化。首个 Snapshot 无历史基线；后续以不可变前序 Report 的 `total_rows` 为基线。

Link Mapping 增加可选 `linkDanglingDisposition=required|optional`。缺省为 `required`，旧 Mapping 的规范 Plan 形状与 Digest 保持不变；只有显式 `optional` 才进入 Plan Digest。数据库从已发布 Mapping Revision 读取该语义，不接受 Worker 临时选择。

## 4. Rejected Row 与错误样本

Rejected Row Artifact 使用版本化受管对象，内容为按 `(fileId,rowNumber,reasonCode,fingerprint)` 稳定排序的 NDJSON。每行只包含：File ID、Row Number、Reason、不可逆 Fingerprint 和通用列分类；不包含输入值、完整 Primary Key、列名、SQL、对象 Key 或 Token。

Application 用数据库 keyset 分页执行两遍：第一遍计算精确字节数与 SHA-256，第二遍流式上传，因此不把全部坏行读入 Node Heap。数据库 Finalize 重算观察数量和 Digest 绑定；事务失败时上传版本成为显式 Orphan，由 G2-02-12 的 Artifact Root/GC 回收，不能被报告引用。

普通 Report 最多保存 50 个稳定排序样本。单项只有固定宽度 ID、行号、Reason、Fingerprint 与分类，总字节自然有界；完整坏行集合只在受管 Artifact 中。

## 5. Current、Link 与 Head Candidate

zero-overlay 生产路径中 Current 的业务值逐字节等于已接受 Base：

- Object Current 复制 Object Base 的 RID、Canonical PK、Properties 与 Base Value Digest；
- Link Current 复制 Link Base，但必须再次证明 Source/Target RID 存在于同 Project、同 Snapshot Group Version、正确 Object Revision 且 Quality 已通过的 Object Current；
- 因 Object Row 被 Rejected 而缺失的端点按 Link Mapping 的 required/optional 语义产生 Dangling Reason，不能因为永久 Identity 仍存在就误判为可见；
- Object Head Candidate 按 Generation 保存 previous/candidate Digest 与 Version，不修改活动 `runtime.object_heads`。真正 CAS 更新归 G2-02-11。

Object Member 必须先完成 Quality，Link Member 缺少端点候选时返回可重试的 dependency-incomplete，而不是生成假 Identity 或把 Link 静默丢弃。

## 6. Row-count Owner Confirmation

超过 Mapping 的 Row-count 变化阈值时，Report 为 `awaiting_confirmation`，Current/Provenance 可以留在不可见 Generation，Quality Binding 不具备 READY 资格。

确认只能由统一 Authorizer 判定为 `release.publish` 的 Project Owner 发起。不可变 Confirmation 绑定：Actor Principal、Project、Generation、Snapshot/Report Digest、观察/基线行数、阈值、Project Publication Sequence、决定、有效期与 Confirmation Digest。

确认时数据库重新读取这些事实。Report/Snapshot/Generation/阈值改变、Project Publication Sequence 推进、Actor 禁用或过期后，旧确认稳定拒绝。接受使 Binding 从 `awaiting_confirmation` 到 `confirmed`；拒绝使 Binding/Generation 失败。Report 本身保持不可变，不把事后决定伪装成原始验证结果。

## 7. 可见性与权限

- API、Worker、Ops 均不能直接 INSERT/UPDATE/DELETE Current、Report、Provenance、Candidate 或 Confirmation；
- Worker 只能在实时 Lease/Fencing 下写质量观察并调用固定 Finalize；
- API 只能通过 Owner-authorized Confirmation 用例调用固定确认函数；
- Candidate Reader 必须带完整 `(project,generation,resource,revision)` 和有界游标，只对 Quality-qualified 的 building Generation 返回；
- 普通 Serving Resolver 仍只从 Release Serving Head → Activation → READY/ACTIVE Generation 解析，不读取 Candidate Reader；
- 所有安全定义函数固定 `search_path=pg_catalog`，公开错误只使用稳定 Code，不保留原 SQL/Cause。

## 8. 停止条件与后续所有权

出现下列任一情况，本任务 FAIL：需要 API/Worker 直写 Runtime 表；需要把坏值保存到普通错误；Link 无法区分 required/optional；Provenance 无法覆盖多输入/常量；或 building Generation 能被普通 Resolver 返回。

G2-02-08 接管跨进程 Kill/Resume 与新 Attempt 重放；G2-02-09 接管 Index/Measurement；G2-02-10 接管 Compatibility Certificate；G2-02-11 接管 Head/Activation 原子 Cutover；G2-02-12 接管失败 Staging 和 Orphan Artifact GC。本 ADR 不把这些后续条件标成已完成。

## 9. 实现结果

Migration `0012` 和正式 Application/PostgreSQL/Object Storage Adapter 已按本决策落地。真实 PostgreSQL 16 验证覆盖了 pass/fail/awaiting-confirmation、阈值边界、Rejected Object 导致的 required Link dangling、完整 Provenance、Candidate 隔离与索引路径、Owner 接受/拒绝、过期 Publication Sequence 和并发发布锁。真实版本化 S3-compatible Storage 验证了 Rejected JSONL 的精确 Version/Media Type/读回边界。

详细 Acceptance 对照、返工和非结论见 [G2-02-07 Evidence](../../evidence/g2-02-07-quality-current-provenance.md) 与 [G2-02-07 Red Team](../../reviews/g2-02-07-quality-current-red-team.md)。
