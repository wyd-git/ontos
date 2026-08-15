# ADR-014：Materialization 事务、Projection DDL Executor 与 Overlay Seam

- 状态：Accepted for G2-02-01；只冻结架构与代表性 Spike，不表示 DB-02 或完整 Materialization 已实现
- 实现状态：状态/Overlay/锁 Harness 与代表性 `BTREE_TEXT` PostgreSQL 16 DDL Spike 已通过；正式表、全部 Index Recipe、真实 Cutover 与 Overlay Store 仍由后续拥有任务实现
- 日期：2026-08-15
- Owner：Tech Lead / Database / Security
- 上游：ADR-007、ADR-008、ADR-009、ADR-010、ADR-013 与 G2-02 可执行任务包
- 决策范围：逻辑 DB-02 表责任、事实/控制边界、Cutover/GC 锁与 CAS、动态索引信任边界、zero-overlay 生产限制及未来 Delta 协议
- 可执行证据：`tools/materialization-control-plane/`、`tools/runtime-activation/`
- 不在范围：本任务不创建 DB-02 业务表，不实现 Snapshot/Mapping 合同、Materializer、真实 Overlay Store、Query 或 Action

## 1. 决策结论

G2-02 采用“长构建在不可见 Staging，短事务只重验并切 Pointer”的物化模型。Snapshot 扫描、Mapping、Base/Current 构建、索引 DDL、容量测量和 Overlay Catch-up 都不能进入 Publish/Cutover 事务。短事务只消费已经持久化、带 Digest 和 Revision 的受信事实。

本 ADR 固定五条不能降级的边界：

1. DB-01 已发布的 R1/A0 是历史事实。首个 Runtime Member 只能通过新 Release R2 与新 A1 加入；Refresh 只能为同一不可变 Runtime Plan 创建 A2。
2. 正式表继续由 `migration_owner` 创建和拥有。API、Worker、Ops 不拥有表、不能 DDL、不能 `SET ROLE migration_owner`，也不能获得 DDL Executor 凭据。
3. 动态索引由独立的、短生命周期、部署级 Projection DDL Executor 执行。它只接受已持久化 Plan ID，不接受 SQL、任意表名、任意表达式或客户端凭据。
4. Publish、Refresh/Cutover 与 GC 使用同一全局锁顺序，并分别用 `control_revision`、`state_revision`、`inventory_revision` 拒绝陈旧计划；不存在最后写入者获胜。
5. G2-02 生产环境只有受信 Provider 证明 Overlay 库存完整且 `W0=W1=0` 才允许 Cutover。Unknown、非零、Provider 缺失或失败全部 fail closed。非零重放只作为未来 G2-04 Adapter 的可执行协议证据。

以上任一项若需要把 Owner/Migration 凭据放进 API/Worker、需要执行请求提供的 SQL，或需要修改 R1/A0 才能实现，本任务判定 FAIL，不能开始 G2-02-02/03。

## 2. 逻辑 DB-02 与单一 Migration 历史

“DB-02”是产品蓝图中的逻辑波次，不是第二个数据库、第二个迁移目录或第二本账。唯一权威账本仍是：

```text
migrations/db-00/0001 ... 0006   已发布 DB-00/DB-01 历史，不移动、不改名、不改 Hash
migrations/db-00/0007+           逻辑 DB-02 只向前 Migration
ontos_migration.schema_migrations 唯一应用账本
```

G2-02-01 只冻结列级责任和权限边界，不创建 `0007`。G2-02-03 才用真实 Migration 落表，并同时验证空库、停在 0006 的库、并发 Runner 与故障后 Roll Forward。

蓝图曾把通用 Job 与 GC 放在 DB-04，但 G2-02 自身已经依赖 Lease/Fencing/Kill-Resume 与 Staging 清理。因此 G2-02 前移 Materialization 必需的 Job、Attempt、Checkpoint、受限 Error Sample、GC Run/Plan 子集。未来 DB-03/04 只能扩展 Job Kind、Outbox、Audit 和 Root Provider，不能替换这套表或另建队列。

## 3. 表责任、Owner 与事实/控制边界

### 3.1 不可变事实与受控状态

| 范围      | 事实记录（创建后内容不可改）                                                                                                                  | 允许受控变化的记录                                                                       | 禁止做法                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `meta`    | Release Runtime Member Plan、Activation Member                                                                                                | Release/Activation 生命周期、Channel、Serving Head                                       | Refresh 改 Release Plan；回写 A0               |
| `runtime` | Snapshot/File/Group Version、Generation 内容与摘要、Certificate、Object Identity 映射、Object/Link Base、Provenance、Report、Index Plan/Entry | Snapshot/Generation 生命周期、Object Head、Inventory/Measurement Revision、Approval 状态 | Staging 被查询解析；Action 原地改 Base         |
| `ops`     | Job 请求身份、Attempt 历史、Checkpoint 摘要、GC Plan 输入摘要、DDL Plan 不可变字段                                                            | Lease/Fencing/Heartbeat、Job/GC/DDL 状态与受限结果码                                     | 旧 Fencing Token 写入；保存 Raw SQL 或敏感原值 |

“不可变”不等于永远没有状态列；事实内容与绑定关系不可更新，生命周期只能按合同向前迁移。终态记录不复活，修复通过新事实或更高版本 Migration 完成。

### 3.2 角色边界

| 身份                    | 允许                                                                       | 明确禁止                                                             |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `api_runtime` 登录      | 管理 Use Case 所需的显式表/列权限或受控函数                                | DDL、Raw SQL 计划、表 Owner、Migration 账本、DDL Secret、`SET ROLE`  |
| `worker_runtime` 登录   | Lease/Fencing 下写自己 Job 进度与不可见 Staging                            | Serving Head 任意写、DDL、Owner 切换、DDL Secret、Migration 账本     |
| `read_only_ops` 登录    | 脱敏状态 View                                                              | Plan 原始字段、业务数据写入、DDL、Owner 切换、Secret                 |
| Migration Runner        | 连接后显式 `SET ROLE migration_owner`，执行版本化 Migration                | 业务请求处理                                                         |
| Projection DDL Executor | 读取一个持久化规范 Plan；短时 `SET ROLE migration_owner`；只生成白名单 DDL | HTTP/业务入口、任意 SQL/Identifier、发布事务、复用 API/Worker 连接池 |

PostgreSQL 16 的 `CREATE INDEX CONCURRENTLY` 需要目标表 Owner 能力，且不能在普通事务块内执行。在保持所有正式对象由 `migration_owner` 拥有的前提下，不能把它安全授予 `worker_runtime`。因此 Executor 是与 Migration Runner 同等级的受信部署过程，不是“更高权限 Worker”。

Executor 的生产登录必须是 `NOINHERIT`、`NOSUPERUSER`、`NOCREATEDB`、`NOCREATEROLE`、`NOREPLICATION`、`NOBYPASSRLS`，仅作为 `migration_owner` 的受控成员；凭据由部署 Secret 注入并短期轮换。它没有公网入口，进程退出后销毁连接。Spike 可以创建同属性的临时测试登录，但不能把测试口令写入仓库、日志或 Evidence。

## 4. Runtime Plan 与 Activation 事务

### 4.1 历史兼容路径

```text
R1: metadata pins + empty runtime plan + A0(empty)
  -> R2: immutable first-member runtime plan + A1(first members)
  -> R2: same plan + A2(refreshed generations)
  -> concurrent R3 publish uses the same project control CAS
```

- R1 Manifest、Pins、Plan、A0 和 A0 Digest 永远不改；
- R2 的 Plan 在 Stage 时由 Release Pins 派生并封存；A1/A2 的 Member Key 集合必须与它完全相等；
- A2 只能替换 Plan 中已有 Snapshot Group 的 Generation，不能增删 Member 或改变 Schema/Mapping Revision；
- 历史 A1 保留原成员与摘要；新 Query 只通过已切换的 Activation 看到 A2；
- 并发 R3 Publish 若先提交，R2 Refresh 的旧 `control_revision` 必须冲突并重做，不能把 Channel 拉回 R2。

### 4.2 事务外准备

构建方在 Cutover 前完成并持久化：

1. 完整 Snapshot Group、Runtime Plan 和候选 Activation；
2. READY Generation、Compatibility Certificate、内容 Digest 与测量；
3. Index Plan 与实际物理库存的双向核验；
4. 最新容量准入结果；
5. Overlay W0 后 Delta 重放结果与 W1 证明；
6. `expected_control_revision`、`expected_state_revision`、`expected_inventory_revision` 与期望旧 Pointer。

任何网络、对象存储、DDL、CSV 读取或用户代码都不允许出现在 Cutover 事务中。

### 4.3 短 Cutover 事务

事务按第 5 节顺序获取锁，然后：

1. 比较三个期望 Revision，并重验目标 Project/Release/Group/Generation/Activation；
2. 重验全部 Generation READY、证书仍有效、Index/Measurement Inventory 完整且容量未失效；
3. 重验 Overlay Provider 证明与候选 Head 的条件更新；
4. 插入不可变 Activation/Member（若尚未由同一用例准备）；
5. 切换对应 Release Serving Head；仅当 Channel 仍指向该 Release 的期望旧 Activation 时同步切 Channel；
6. 递增 `control_revision` 和 `state_revision`，写受限审计事实并提交。

任何一步失败整笔回滚，旧 Activation 继续服务。事务重试必须重新读取事实和规划，不能只重放最后一条 UPDATE。

## 5. 全局锁顺序与 CAS

所有可能同时触碰发布、物化和回收控制记录的事务，先按下列域排序；同一域内按稳定二进制 ID/规范 Key 升序：

```text
PROJECT_CONTROL
  -> RELEASE_CHANNEL
  -> RELEASE
  -> RELEASE_PINS
  -> SNAPSHOT_GROUP
  -> OBJECT_TYPE_CUTOVER
  -> GENERATION_INVENTORY
  -> SERVING_HEADS
```

标准事务计划：

| 操作                         | 获取的锁（保持全局相对顺序）                                             | CAS                                                          |
| ---------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Definition Publish           | Project、Channel、Release、Pins、Serving Heads                           | `control_revision`，提交时同时推进 `state_revision`          |
| Data Refresh / Group Cutover | Project、Channel、Snapshot Group、Object Types、Inventory、Serving Heads | `control_revision` + `state_revision` + `inventory_revision` |
| GC Commit                    | Project、Inventory；候选行按稳定键                                       | `state_revision` + `inventory_revision`，并做反向引用重验    |
| Index DDL                    | 不进入上述事务；按 Index Name 取得独立 session advisory lock             | DDL Plan Digest + `inventory_revision`                       |

锁顺序允许跳过不需要的域，不允许逆序、重复域或同域无序锁。Cutover 必须包含 Channel 锁，因为 Refresh 可能同步移动活动 Channel；ADR-013 原三锁计划在该写集合上不完整，本 ADR 显式修正。

三个 Revision 的语义不可互换：

- `control_revision`：Channel、Serving Head、Release Publish/Retire 等可服务 Pointer 的项目级序列；
- `state_revision`：任何 GC Root、Pointer 或可回收生命周期变化的项目级序列；
- `inventory_revision`：Generation、物理行、Index、Measurement 与相关容量库存的项目级序列。

Cutover 会推进 control/state，但若没有改变物理库存，不伪造 inventory 增量。Index 创建/删除或 Generation 物理库存变化推进 inventory/state。GC Plan 必须同时绑定 state 与 inventory；Revision 快速拒绝不能替代事务内反向引用检查。

## 6. Projection DDL Executor 协议

### 6.1 输入与持久化计划

Executor 的唯一命令输入是严格 UUID `plan_id`；数据库连接只来自专用环境变量。计划表保存结构化字段，不保存 DDL 文本：

- Plan/Project ID、Action（`CREATE`/`DROP`）、不可变 Plan Digest；
- 目标固定为 `runtime.object_current`；
- ADR-008 规范 Index Name、Object Type Resource/Revision ID、Physical Signature；
- 白名单 Recipe 与结构化 Key/Predicate；
- 计划绑定的 `inventory_revision`、Drop 引用计数和状态；
- Attempt Count、稳定 Result Code、完成后 Catalog 摘要。

Plan Digest 对全部不可变字段做版本化 Canonical JSON + SHA-256。Executor 读取后自行重算，未知字段、未知 Recipe、非法 UUID/Index Name、Digest 不一致或 Inventory 陈旧均在执行 DDL 前 fail closed。

G2-02-01 Spike 只实现并证明一个 ADR-008 严格 B-tree Recipe；其余 B-tree/Unique/Trigram/Array Recipe 由 G2-02-09 在同一协议上增加。Spike 不是允许通用 SQL 的后门。

### 6.2 执行与双向核验

每个 Plan 的顺序为：

1. 用普通权限读取并校验 Plan，记录 `RUNNING` Attempt；
2. 取得由规范 Index Name 派生的 session advisory lock；拿不到则稳定返回 `DDL_INDEX_BUSY`；
3. 再读 Plan 与 Inventory Revision，防止等待期间变陈旧；
4. 显式 `SET ROLE migration_owner`，设置固定 `search_path=pg_catalog`；
5. 查询 `pg_catalog` 双向核验 Schema/Table、Access Method、Unique、Key 数/表达式、Predicate、Valid/Ready 和 Physical Signature Comment；
6. 只从已验证结构字段生成参数不可替代部分已穷举的白名单 SQL，Identifier 使用安全引用，不拼接客户端片段；
7. 在事务块外执行 `CREATE INDEX CONCURRENTLY` 或 `DROP INDEX CONCURRENTLY`；
8. 再次核验 Catalog，写稳定结果并释放锁。

同名且定义完全一致的有效索引返回 `REUSED`。同名但任一结构或签名不同返回 `DDL_INDEX_DEFINITION_MISMATCH`，不得删除或覆盖。CREATE 中断留下的同定义 invalid Index 可以先安全 `DROP INDEX CONCURRENTLY` 再重建；不同定义的 invalid Index 仍 fail closed。DROP 只有引用计数为零且实际定义完全匹配才允许；索引不存在视为幂等成功。

### 6.3 Kill、重放与错误面

进程被终止时，PostgreSQL 会释放 session advisory lock；Plan 可能停在 `RUNNING`，这不是成功。相同 Plan ID 重放会从 Catalog 事实恢复：不存在则创建，完整存在则复用，同定义 invalid 则修复，不同定义则拒绝。

公开结果只包含 Plan ID、稳定 Code、Attempt 和脱敏 Catalog Digest。不得输出连接串、口令、Raw SQL、Properties、Primary Key、完整 PostgreSQL Query 或任意 Secret。未知数据库错误统一包装为稳定失败，并把敏感细节仅留在受限数据库诊断通道；本 Spike 不假装已经实现完整运维审计。

## 7. Overlay Inventory 与 Delta Reader Seam

### 7.1 版本化 Port

`OverlayInventoryPort` 返回一个受信、项目与 Snapshot Group 绑定的证明：Provider ID/Version、Complete、Watermark、Delta Count 和 Digest。`OverlayDeltaReader` 只按同一 Group 读取严格区间 `(W0, W1]`，并返回单调、无缺口、无重复、绑定期望旧 Head Digest 的 Delta。

Provider 结果属于负面证明：“没有 Overlay”只有在 Provider 已注册、版本匹配、扫描完整并经服务器签名/绑定时才成立。调用方提交的 `overlayCount=0` 没有可信度。

### 7.2 G2-02 生产 Adapter

G2-02 没有真实 Overlay 表。生产 Adapter 固定：

- Provider 是内建 zero-overlay Provider，版本已登记；
- W0 和锁内 W1 都必须等于 0，Count 为 0，Complete 为 true；
- 任意 Unknown、非零、版本不匹配、Provider 缺失/超时/错误，返回 `OVERLAY_INVENTORY_UNAVAILABLE` 或 `OVERLAY_NON_ZERO`；
- 失败时不切任何 Pointer，不把“表不存在”解释为“自然为空”。

### 7.3 对抗 Adapter 与未来 G2-04

对抗 Adapter 用于证明算法，而不是宣称真实 Overlay 已集成：

1. 读取完整 W0，构建候选 Base/Current；
2. 在 W0 后允许注入 Delta；读取 W1；
3. 严格重放 `(W0, W1]`，按 Watermark + Delta ID 排序；
4. 每个 Delta 只有在候选 Head Digest 等于 `expected_before_digest` 时更新，业务内容不变时不增加 Head Version；
5. 缺口、重复、越界、错误 Group、条件失败或 Provider 故障使整次 Catch-up 失败；
6. Cutover 锁内重验 W1/证明，之后才切 Pointer。

G2-04 接入真实 Overlay Store 后必须替换生产 Adapter、复跑非零并发 Catch-up 与完整 Action/Conflict 验收，才能移除 zero-overlay 限制。G2-02 Evidence 只能表述为“Base 生产原子性 + Overlay 协议/算法证据”。

## 8. 恢复与向前修复

| 故障                       | 可观察状态                                  | 恢复                                                        |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Stage/Build 进程终止       | 旧 Activation 服务；Attempt/Staging 非终态  | 新 Attempt 以 Fencing + Checkpoint 接管                     |
| Index Executor 终止        | Plan `RUNNING` 或 Catalog invalid/complete  | 同 Plan 重放并以 Catalog 为准恢复                           |
| Cutover 任一步失败         | 所有 Pointer 与 Revision 保持旧值           | 重新读取、重验并生成新计划                                  |
| Publish/Refresh 并发       | 后提交者 CAS 冲突                           | 基于新 Pointer 重做；不覆盖先提交者                         |
| GC 与 Cutover 并发         | Project 锁串行；旧 state/inventory CAS 失效 | GC 重新扫描，Candidate 先置空                               |
| Migration 已发布后发现错误 | 已应用 Hash 保持不变                        | 增加更高版本 Migration；不 Down、不改旧文件                 |
| 已激活内容语义错误         | 历史 Release/Activation 不改                | 新 Snapshot/Generation/Activation 或新 Release Roll Forward |

## 9. 被拒绝的方案

| 方案                             | 拒绝原因                                                       |
| -------------------------------- | -------------------------------------------------------------- |
| Worker 直接执行动态 DDL          | 必须获得表 Owner 能力，越过 Lease/Fencing 的业务边界           |
| API 提交 SQL 给 Executor         | 无法证明 Identifier/表达式/Predicate 受 Index Plan 约束        |
| 为每个 Object Type 创建 Owner/表 | 破坏共享投影与有限 Catalog 设计，运维成本随用户定义增长        |
| 在 Cutover 事务中建索引          | Concurrent DDL 不能在普通事务块运行，且会把短事务变成长事务    |
| Refresh 不锁 Channel             | 并发 Publish 后可能把 Channel 拉回旧 Release 或产生静默覆盖    |
| 仅靠 `control_revision` 保护 GC  | 不能感知 Hold/Job/Inventory 等非 Pointer 引用变化              |
| Overlay 表尚不存在就视为零       | 缺失 Provider 不是完整负面证明，会给未来 Action 留数据丢失缝隙 |
| 首 Member 写回 R1/A0             | 修改已发布历史，破坏 Release/Activation 不可变性               |
| 建第二本 DB-02 Migration 账      | 无法对已应用 0001～0006 做统一缺号、Hash 和领先检查            |

## 10. G2-02-01 接受证据

本文的接受条件与证据如下：

- 状态 Harness 重跑 R1/A0 → R2/A1 → R2/A2 与并发 R3，并逐项比较历史 Pins/Plan/Activation；
- 锁 Harness 拒绝逆序，证明双 Refresh、Publish 对 Refresh、GC 对 Cutover 无静默覆盖；
- Overlay Harness 覆盖 zero、unknown、non-zero、W0 后注入、Provider 故障与 Head 条件失败；
- 真实 PostgreSQL 16 证明规范 Plan Create/Reuse/Verify/Drop Concurrent Index；
- 真实非 Owner API/Worker/Ops 登录证明不能 DDL、不能读写 DDL Plan、不能 `SET ROLE migration_owner`；
- Kill Executor 后同 Plan 重放成功；同名异定义与陈旧 Plan 稳定 fail closed；
- Boundary 检查证明 API/Worker 源码和配置不导入 Executor Secret、Owner 身份或 Raw SQL 入口；
- Evidence 将每条意图映射到具体测试，并记录尚未由 Spike 证明的 Recipe、真实 Overlay 与生产 Secret 轮换限制。

上述证据已在 [G2-02-01 Evidence](../../evidence/g2-02-01-materialization-architecture.md) 中逐项通过，并经 [专项红队](../../reviews/adr-014-materialization-architecture-red-team.md) 复核。任一安全停止条件后续被触发时，必须重新打开本文并停止下游任务，而不是把失败包装成部分通过。
