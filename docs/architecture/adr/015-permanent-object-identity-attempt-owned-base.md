# ADR-015：永久 Object Identity 与 Attempt 隔离的不可变 Base

- 状态：Accepted for G2-02-06
- 日期：2026-08-15
- Owner：Runtime / Database / Security
- 上游：ADR-008、ADR-009、ADR-010、ADR-014、G2-02-04 Managed CSV Ingress 与 G2-02-05 Deterministic Mapping
- 实现：`@ontos/materialization-application`、`@ontos/materialization-postgres`、`migrations/db-00/0011_object_identity_base_staging.sql`
- 不在范围：Current Projection、质量报告、Rejected Row Artifact、Worker 进程循环、Index、Cutover、Serving Head 与 GC

## 1. 决策结论

G2-02-06 将“业务对象的永久身份”与“某次 Snapshot 的 Base 事实”分开：

1. Object RID 只由 `(project, object type resource, canonical primary key)` 决定它是否已存在。首次解析在数据库唯一约束下原子创建 RID，后续 Snapshot、Generation、Release、Worker 或 Attempt 都不能改变它。
2. Object/Link Base 是按 Generation 保存的 append-only 事实。同一 RID 可以在多代 Base 中拥有不同值，但旧代不被原地覆盖。
3. 批次先写入绑定 `Attempt + fencing token + Generation` 的不可见 Staging。只有当前 Lease Owner 可以用完整行数和 Stage Digest 在一个短事务中提升整个 Generation Base。
4. Link 只查找已有 Object Identity，不为悬空端点创建假对象。Source/Target 必须同时匹配 Project、Object Type Resource 和已发布的 Endpoint Revision，并与 Link Revision 的类型化依赖边一致。
5. API、Worker 和只读运维账号都不获得 Base 直写权限。Worker 只能调用固定参数、固定 SQL 的 `SECURITY DEFINER` 函数；函数在每批和提升时重验 Lease、Fencing、Generation、Snapshot/File 与 Revision 绑定。

## 2. 身份模型

`runtime.object_identities` 是永久命名空间，不是当前快照。它的业务唯一键为：

```text
project_id
+ object_type_resource_id
+ canonical_primary_key (pk1, COLLATE "C", 1..1024 UTF-8 bytes)
---------------------------------------------------------------
= one permanent object_rid
```

Object Type 使用 Resource 身份而不是 Revision 身份，因此兼容的 Type Revision 前移不会创建新对象。Project 和 Type Resource 仍是边界，相同 Canonical PK 在不同 Project/Type 中得到不同 RID。

`runtime.resolve_or_create_object_identities` 使用服务端校验后的 Candidate UUID 尝试插入，对业务唯一键 `ON CONFLICT DO NOTHING`，然后从权威表回读 RID。两个真实 Worker 并发解析同一新 Key 时，未提交事务会在唯一索引上排队，两者最终读到同一 RID。Candidate UUID 不是可重算的业务 ID；一旦权威行存在，它不再参与结果。

Identity 可以在后续 Base 批次失败时保留。这是可接受的永久命名事实，但不会因此成为可服务 Object；Current/Activation 只能解析已通过后续 Gate 的 Generation。

## 3. Attempt-owned Staging 与提升

### 3.1 批次

- 每批最多 5,000 行，输入顺序不影响规范 Digest。
- Object 批次在 Repository 写入前拒绝同 Type 的 Canonical PK 碰撞。
- Object Value Digest 绑定 Target Revision、Canonical PK 和带 `valueCodecVersion` 的类型化 Properties。
- Link Value Digest 绑定 Link Revision、两端 Type Resource/Revision 和 RID。Link RID 由 Project、Generation、Link Type 与两端 RID 的 SHA-256 前像确定性生成。
- Batch Digest 同时绑定 Generation、Snapshot/File、Mapping Revision、批次序号和行结果。重试 Attempt 可以重现相同 Digest，但同一 Attempt 中的序号/Digest 不能改写。

### 3.2 隔离与可见性

`ops.materialization_generation_stages`、`ops.materialization_generation_stage_batches`、`ops.object_base_staging` 和 `ops.link_base_staging` 全部带 Attempt Ownership。旧 Attempt 超时后：

- 已写 Staging 保持不可变，便于审计和后续 GC；
- 旧 Fencing Token 无法再写批次或提升；
- 新 Attempt 用相同输入重放时复用已有永久 RID，但写入自己的 Staging；
- 在提升前 `runtime.object_base` / `runtime.link_base` 仍为空，不存在半个 Generation。

### 3.3 原子提升

Application 将已接收的 Batch Receipt 按序号排序，复算 `base-stage-v1` Digest 和接受行数。数据库再独立复算批次数、行数和 Stage Digest，并在同一事务中：

1. 锁定 Attempt-owned Generation Stage；
2. 重验 Job 仍为 running、Attempt/Token 仍当前、Lease 未过期、Generation 仍为 building；
3. 验证 Staging 实际行数与预期相等；
4. 整代 `INSERT ... SELECT` 到不可变 Base；
5. 将该 Stage 标记为 promoted。

事务失败则 Base 和 Stage 状态一起回滚。响应丢失或 Worker 连接池重启后，使用同一 Digest 重放返回 `reused=true`；不同 Digest/行数则 fail closed。

## 4. Link 端点语义

Link 不能只验证“某 RID 在同 Project 存在”。Migration 0011 向 `runtime.link_base` 和 `runtime.link_current` 前向增加 Source/Target Object Type Resource，对历史行从永久 Identity 回填，然后改为复合外键。新 Link 写入同时要求：

- 两端 Identity 属于同 Project 和指定 Object Type Resource；
- Endpoint Revision 存在且是可用 Object Type Revision；
- Link Revision 的 `link_source` / `link_target` Dependency Edge 精确指向该 Endpoint Revision。

查找不到时 Application 返回只含行号、缺失端点位置和不可逆指纹的 Dangling Candidate。它不包含原 PK，也不调用 Identity Create。required/optional 阈值、Rejected Row Artifact 与 Report 属于 G2-02-07。

## 5. 权限和错误边界

| 身份              | 允许                                                         | 禁止                                                           |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| `api_runtime`     | 读管理面 Generation 状态                                     | 读或改 Base/Staging；调用 Identity/Stage/Promote 函数          |
| `worker_runtime`  | 读自身构建所需 Staging；调用受控 Identity/Stage/Promote 函数 | 直接 INSERT/UPDATE/DELETE Base、Identity 或 Staging；DDL/Owner |
| `read_only_ops`   | 读脱敏运维 View                                              | 读 Raw Base/Identity/Staging；调用 Worker 函数                 |
| `migration_owner` | 受控 Migration 和故障修复                                    | 作为 API/Worker 常驻凭据                                       |

Application 只暴露稳定 `MaterializationBaseErrorCode`。PostgreSQL Message、SQL、Canonical PK 和底层 `cause` 不附在公开错误对象上，避免深度日志器绕过普通序列化脱敏。

## 6. 容量决策

首个真实数据薄切片选择 5,000 行受控 JSONB 批次，未在本 Gate 引入 PostgreSQL `COPY`。实测 10k Object + 100k Link 的逻辑数据在约 47 秒内完成 CSV Scan、Mapping、失败 Object Attempt 重放、Identity、Staging 和 Base 提升，不触发立即切换到 COPY 的停止条件。

这个结果只是 G2-02-06 薄切片，不是 100k/1m 正式 SLO 结论。G2-02-09 必须在加入 Current 和 Index 后跑完数据；G2-02-14 还要在 clean-room HTTP/S3/Worker/Cutover 闭环重复。若完整数据不能接近 30 分钟基线，再优先评估 `COPY`/索引延后/批次大小，不把性能问题推给 Cutover。

## 7. 迁移与后续兼容

- 0011 是 0001～0010 之后的只向前 Migration，不改名、不重算、不回写 Ledger。
- Link 端点回填只在 Migration 事务内临时停用两张历史表的不可变 Trigger，回填和约束任一失败则整个版本回滚。
- 失败 Attempt Staging 的保留与删除顺序归 G2-02-12 GC；本 Gate 不用即时物理删除伪装幂等。
- G2-02-07 只能消费已提升的完整 Base 和明确 Dangling/Rejected 输出，不得让查询绕过 Current/Activation 直读 Base。
