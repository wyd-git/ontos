# ADR-014 Materialization 事务、DDL Executor 与 Overlay Seam 红队

- 日期：2026-08-15
- 审查对象：[ADR-014](../architecture/adr/014-materialization-transaction-ddl-overlay-boundary.md)
- 方法：先 Steelman 每个承重主张，再按 Impact × Likelihood 排序攻击；优先选择能最低成本证伪的实验
- 结论：G2-02-01 PASS with downstream non-negotiables；未触发停止条件，但不能宣称完整生产实现

## 1. 结论先说

这套方案在 G2-02-01 的范围内可行：PostgreSQL 16 确实允许一个隔离的受信 Executor 用 Owner 身份执行 Concurrent Index DDL，同时保持 API/Worker/Ops 非 Owner；R1/A0 不需要改写；zero-overlay 可以诚实 fail closed；全局锁顺序可以扩展而不破坏现有 Publish。

但它的安全性依赖四个后续必须落地的条件：正式 Plan 不可变约束、Inventory Scanner/Revision 协调、真实 PostgreSQL Cutover 行锁，以及启用 Action 时强制替换 zero-overlay Provider。任何一个被后续任务省略，都可能让当前 PASS 失效。

## 2. 承重主张逐项攻击

### 主张 A：独立 DDL Executor 能隔离 Owner 权限

**Steelman**：PostgreSQL 的 Concurrent Index DDL 需要表 Owner 能力。把它放进无公网入口、短生命周期、只接受 Plan ID 的部署进程，比给 Worker Owner 权限更符合最小权限；真实登录负测已经证明三类 Runtime 身份无法 DDL 或切 Owner。

**攻击**：Executor 最终仍能 `SET ROLE migration_owner`。如果其长期凭据泄漏、执行主机可被业务请求利用，攻击者拥有的不只是索引权限，而是所有正式表的 Owner 能力。Plan-only Parser 不能把一个已泄漏的数据库口令变安全。

**当前证据**：CLI 不接受 SQL/URL/多余参数；API/Worker 源码不引用专用环境变量；Executor Login 为 `NOINHERIT` 非 Superuser；Runtime 登录负测拒绝 Owner；子进程输出不泄漏 URL/口令。

**剩余要求**：部署时必须有独立 Network Policy/Service Account、短期 Secret、轮换和受限启动权限。若实现把该连接串放进 API/Worker Pod、共享连接池或通用 Job Payload，立即触发 G2-02 Kill Criterion。

### 主张 B：规范 Plan + Catalog 双向核验足以让动态索引幂等

**Steelman**：Plan Digest 绑定 Action、Inventory Revision、ADR-008 名称/签名、固定表、Recipe、Property 与 Predicate；Catalog 核验不仅看 Comment，还看实际表、Access Method、Key、Collation、Opclass、Sort、Predicate、Valid/Ready。因此同名异定义不会被误复用。

**攻击**：PostgreSQL 不把所有索引语义都放在 `pg_get_indexdef` 的字符串里。Minor Version、Collation Provider、Extension Opclass 或新 Recipe 可能使规范化器误判；只信 Comment 又会允许定义漂移。

**当前证据**：第一次 Spike 已实际发现 Collation 不在 Key 文本中，并改为读 `indcollation`/`indclass`/`indoption`；同名一键异定义索引被保留并稳定拒绝。

**剩余要求**：G2-02-09 每增加一种 Recipe，都必须增加一组真实 PostgreSQL 16 Create/Reuse/Mismatch/Invalid/Drop 向量，不能复用 `BTREE_TEXT` 的字符串判断。升级 PostgreSQL 或 Collation Provider 前复跑 Catalog Golden Evidence。

### 主张 C：单调锁 + 三 Revision 能阻止 Publish/Refresh/Cutover/GC 静默覆盖

**Steelman**：Project 锁提供总入口；Channel 被纳入 Cutover；Object Type 同域稳定排序；Control/State/Inventory 分别保护 Pointer、Root 和物理库存。纯状态 Harness 已证明双 Refresh、Publish 对 Refresh、GC 对 Cutover 的陈旧计划都失败。

**攻击**：当前还没有 DB-02 正式行和真实 PostgreSQL Cutover Repository。代码中的数组顺序不能自动保证未来 SQL 按同样顺序锁行；DDL 发生在事务外，Inventory 扫描和状态更新若没有明确的“不完整”状态，会让 Cutover 在 DDL 与测量之间看到半真库存。

**当前证据**：锁计划机器拒绝逆序；G2-01 既有 Publish 测试保持通过；Runtime 模型让 Pointer 变化同时推进 State Revision；DDL Plan 对陈旧 Inventory fail closed。

**剩余要求**：G2-02-03 落 Inventory/Plan 不可变与不完整状态，G2-02-11 用两个/多个真实连接复跑逆序、双 Refresh、Publish/Refresh、GC/Cutover 和 DDL/Inventory 交错。没有真实事务证据不得把状态 Harness 写成数据库原子性。

### 主张 D：zero-overlay 生产限制不会给未来 Action 留数据丢失缝隙

**Steelman**：当前产品没有 Overlay 表，与其假装完整 AC-03，不如只接受登记 Provider 的完整零证明；Unknown、非零、失败都不激活。对抗 Adapter 预先冻结 W0/W1 与 Head CAS，使 G2-04 有可接入协议。

**攻击**：内建 Zero Provider 本质上是“平台声明当前能力没有 Overlay”，不是扫描真实 Overlay 表。如果未来 Action 被启用但 Provider Registry 没同步升级，系统仍可能返回零并覆盖 Action 结果。

**当前证据**：生产模式只认固定 Provider ID/Version 和稳定 0/0；未知/非零/故障全部拒绝；W0 后 Delta、缺口、重复/冲突与业务 No-op Head Version 已测。

**剩余要求**：Capability Registry 必须把“Action/Overlay 已激活”与“zero Provider 禁用”做成同一发布不变量。G2-04 必须接真实 Store 并复跑非零并发 Catch-up；不能只替换一个 Adapter 名称。

### 主张 E：Plan 重放能覆盖 Executor 被杀的全部结果

**Steelman**：Plan 先标 `RUNNING`，DDL 用 session Advisory Lock；进程死亡后锁随连接释放。PostgreSQL 可能中止、留下 Invalid，或在客户端死亡后仍完成；重放以 Catalog 而非进程本地状态为准，正好覆盖这三种结果。

**攻击**：Spike Plan 表的不可变字段目前只有 Digest 校验，没有 Trigger；受信 Owner 可以在 claim/reload 与 DDL 之间改行。Plan 完成与 Inventory Revision 更新也尚未作为一个正式状态机落库。

**当前证据**：Kill 后 Plan 保持 `RUNNING`，重放得到 Create 或 Reuse 并最终成功；同 Plan、Stale、Mismatch、Referenced Drop 均有真实证据。

**剩余要求**：G2-02-03 必须让 Plan Immutable Fields 在数据库层不可更新；G2-02-09 固定 Scanner 完成/Inventory Revision 前移协议。若普通 API/Worker 能更新 Plan Digest、Identifier、Predicate 或完成状态，本主张失效。

### 主张 F：R1/A0 与单一 Migration 账本可以无重写地扩展

**Steelman**：Runtime Plan 为空是合法事实。新 Release R2 携带首 Member，A1/A2 都是新 Activation；0007+ 在同一目录/账本增加结构，因此无需改旧 Hash 或伪造 Generation。

**攻击**：状态模型通过不代表 0007 的 FK/Trigger 能同时兼容零成员旧行与非零新行。若数据库只用一个粗糙 `member_count > 0` 约束，升级会破坏 A0 或允许 Torn Member 集合。

**当前证据**：状态 Harness 逐项比较 R1 Manifest/Pins/A0 与 R2 Plan/A1；本工作项没有修改 0001～0006，也没有提前创建第二账本。

**剩余要求**：G2-02-03 必须从真实停在 0006 且预置 A0 的数据库升级，逐列/Digest 比较 A0，并故障注入 A1 Member 集合事务。任一历史更新即停止。

## 3. 排序后的失败模式

评分：Impact/Likelihood 为 1（低）～5（高）；Cheapness 为 1（昂贵）～5（便宜）。优先验证高影响、高概率且便宜的项。

| 排名 | 失败模式                                             | Impact | Likelihood | Cheapness | 当前处理 / 下次证伪点                                   |
| ---: | ---------------------------------------------------- | -----: | ---------: | --------: | ------------------------------------------------------- |
|    1 | Executor 凭据进入 API/Worker 或共享 Secret           |      5 |          3 |         5 | 源码/登录 Gate 已挡；部署 Gate 复核 Network/Secret      |
|    2 | 正式 Plan 可变或 Inventory 在 DDL 后仍被误判完整     |      5 |          3 |         4 | G2-02-03 Trigger/状态；G2-02-09 Scanner/Revision        |
|    3 | 未来真实 SQL 未按冻结顺序锁 Channel/Object/Inventory |      5 |          3 |         3 | G2-02-11 多连接 PostgreSQL 故障注入                     |
|    4 | Action 启用后 zero Provider 仍可通过                 |      5 |          3 |         4 | G2-04 Capability Registry + 非零 Catch-up Gate          |
|    5 | 其他 Index Recipe 被错误套用文本 B-tree 核验         |      4 |          4 |         5 | G2-02-09 每 Recipe 独立 Catalog 向量                    |
|    6 | 0007 Migration 为兼容 A0 而偷偷回写历史              |      5 |          2 |         5 | G2-02-03 预置 A0 升级前后逐列/Digest 比较               |
|    7 | 客户端 Kill 与后端 DDL 完成竞态被当作失败或重复执行  |      4 |          3 |         4 | 当前 Catalog replay 已覆盖 Complete/Abort；再补 Invalid |
|    8 | PostgreSQL/Collation 升级造成 Catalog 误判           |      3 |          2 |         4 | 固定镜像已测；升级前复跑 Golden Catalog                 |

## 4. 已尝试证伪且没有推翻的主张

- 三类 Runtime 登录都无法读取/写入 DDL Plan、执行 DDL 或切换 Owner；
- CLI 输入 Raw SQL/额外 URL 时拒绝且不回显 Marker；
- 同名异定义索引不会被删除或覆盖；
- 陈旧 Plan 不创建索引；有引用的 Drop 不删除索引；
- Executor 被强杀后，Plan 不伪装成功，同一 Plan 可恢复；
- R3 Publish 先提交后，R2 Refresh 旧 CAS 失败；重试只更新 R2 Serving Head，不把 Channel 拉回；
- GC Plan 在 Cutover 后因 State Revision 变化失败；
- zero-overlay 的 Unknown、Non-zero、Provider Failure 和 Delta Conflict 全部 fail closed。

## 5. 放行与停止条件

当前三个硬停止条件均未触发：

1. 不需要把 `migration_owner`/表 Owner 凭据放进 API 或 Worker；
2. Executor 不需要接受任意 SQL；
3. 首 Member 不需要修改 R1/A0。

因此 G2-02-01 可以 PASS，ADR-014 可以 Accepted，并只放行下一个顺序任务 G2-02-02。

以下任一情况在后续出现时必须重新打开 ADR-014，而不是局部绕过：

- API/Worker 获得 Executor Secret、Owner Membership 或通用 DDL RPC；
- Plan 表允许普通 Runtime 身份修改不可变字段；
- Cutover 在 Inventory Unknown/DDL Running/Overlay Unknown 时继续；
- 0007+ Migration 更新任何已发布 R1/A0/Pin/Manifest；
- Action/Overlay 能力启用后仍使用 zero Provider；
- 新 Recipe 没有真实 Catalog 双向核验与 Kill/Replay 证据。
