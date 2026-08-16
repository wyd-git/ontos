# ADR-019：Generation / Index Mark-Plan-Commit GC

- 状态：Accepted for G2-02-12
- 日期：2026-08-17
- Owner：Platform / Database
- 依赖：[ADR-007](007-runtime-activation-serving-head.md)、[ADR-008](008-shared-projection-index-capacity.md)、[ADR-018](018-immutable-head-set-snapshot-group-cutover.md)
- 决策范围：Generation、Head Set、Attempt Staging、Orphan Upload 与动态 Index 的保守回收

## 1. 决策结论

G2-02 的回收采用 **Inventory → Mark → Immutable Plan → Batched Commit**，而不是“不是当前代就删除”。只有服务器能够同时证明库存完整、所有已激活 Root Provider 完整、保留期已结束、候选未被任何可解析状态引用时，才创建可提交计划。

GC 保留核心审计事实，以 Collection Marker 表示已回收；只删除不可见派生行和精确版本对象。任何缺失测量、缺失分类、缺失索引库存、Provider 缺失/失败/版本不符、Root 或 Revision 改变都 fail closed。

## 2. Root 与计划陈旧性

当前激活的 Root Provider 覆盖：

- Channel 与所有受支持 Release Serving Head；
- queued/running/retry_wait Job；
- 当前不可变 Head Set 和 preparing/prepared Cutover；
- 所有历史 Activation Member。

Preflight Token、Query Lease、Investigation Hold、历史 Action/Changeset/Artifact 在对应能力尚未上线时登记为 `INACTIVE`，不能静默当作“扫描为空”。未来启用任一能力时，必须先提供版本匹配的完整扫描，否则 Candidate 为空。

每个 Project 有单调 `root_revision`。所有可能增加、移除或改变 Root 的事务都取得与 GC/DDL 相同的 Project Advisory Lock 并推进 Revision。即使一个临时 Root 在两次检查之间先加入再移除，旧计划也不能因最终集合相同而复活。

## 3. 保留与负面证明

- 活动 Root、历史 Activation、当前/在建 Head Set 和 Active Attempt 为 `PROTECTED`；
- 每个 Member 最近两个成功非活动 Generation 为 `RETAINED`；
- Generation 保留期硬下限 7 天；Attempt Staging 与 Orphan Upload 使用独立 1 天下限；
- Ready Index 只有在全部非候选 Generation 都不再需要其物理签名时才可成为 Candidate；
- Inventory 必须逐项绑定实际字节。物理删除后立即把项目测量标为 incomplete，下一计划必须重新扫描。

Application 计算可读的 Candidate/Retained/Protected 原因和 Digest；PostgreSQL 在持久化时逐项对照权威实时库存、字节和 Provider 扫描，并在每个提交批次前重新验证 Root、Revision、生命周期、反向引用和保留窗。

## 4. 提交、故障与恢复

关系数据按固定顺序小批提交：

```text
ORPHAN_UPLOAD
→ HEAD_SET
→ PROVENANCE
→ CURRENT
→ BASE
→ REPORT
→ ATTEMPT
→ GENERATION
→ INDEX_REQUEST
→ DONE
```

不使用 `CASCADE`。每批是独立 PostgreSQL 事务，并写不可变 Batch Event；进程或连接在批次中断时，该批全回滚，重试从已提交边界继续。即使提交成功但响应丢失，Collection Marker、计划 Entry 和 DDL Request 仍使重试幂等。

对象存储回收只能删除服务器从 Upload Session 固定出的 `object_key + object_version`。删除成功但确认丢失时只会重试同一版本，GC 接口不能提交任意 Key。

## 5. Index Drop 边界

只有 GC 计划可以创建 `DROP` DDL Request；普通 Index Plan 仍只能创建索引。独立 DDL Executor 在执行前取得 Project Advisory Lock，重新验证：

- Request 绑定相同 GC Plan 与 Plan Digest；
- Root、State/Inventory Revision 和 Provider Registry 仍匹配；
- 物理签名仍为零引用 Candidate；
- PostgreSQL Catalog 中的对象、Schema、表、列和索引定义仍对应登记 Recipe。

`DROP INDEX CONCURRENTLY` 失败或 Executor 被杀不会把 Inventory 标记为 retired；重试会先读 Catalog，已物理删除则安全确认，仍存在则重试删除。

## 6. 权限与后续所有权

- API Runtime 只能读取受限 GC View、调用受控 Dry-run/Commit 函数；Worker 与 Ops 无删除或 DDL 权限。
- Migration Owner 保有结构所有权；Projection DDL Executor 继续使用独立登录。
- G2-02-13 负责把服务接入真实 OIDC/ManagementAuthorizer Admin HTTP，并增加 HTTP 输入、跨 Project、错误脱敏和统一 CI 证据。
- G2-02-14 负责从独立 Clone 与空持久卷复跑 S3/OIDC/API/Worker/DDL/GC 全链路。本 ADR 不把 Repository Harness 宣称为最终生产闭环。
