# Red-Team：G2-02 Materialization 可执行任务包

- 日期：2026-08-15
- 审查对象：[G2-02 Materialization 可执行任务包](../delivery/g2-02-materialization-task-pack.md)
- 方法：Steelman → Fails if → 本周证据 → Kill Criterion → Cheapest Test
- 结论：**Go for G2-02-01 only**；当前只放行事务/DDL/Overlay ADR 与真实 PostgreSQL Spike，不允许跳过 01 直接建 DB-02 业务表

## 排序方法

本审查按 `影响 × 错误可能性 × 最低成本验证价值` 排序。最高风险不是“CSV 能不能读取”，而是会迫使系统重写权限、历史 Activation、恢复模型或原子切换的承重假设。可以晚补的格式与页面不进入 Top Kill-Assumptions。

## Top Kill-Assumptions

### 1. Dynamic Index 可以在不给 API/Worker Owner 权限的情况下安全自动化

**Claim**

系统可以为 Published Property Index Plan 执行 `CREATE/DROP INDEX CONCURRENTLY`，同时保持 `api_runtime`/`worker_runtime` 无 DDL、无 `migration_owner` Membership，并且不接受客户端 Raw SQL。

**Steelman**

ADR-008 已把 Index Plan 限制为有限 Recipe、稳定签名、Revision Predicate 和预算；DDL 可以由独立受信部署执行器消费服务器持久化的 Plan，而不必给业务 Runtime 提权。索引建立在 Publish/Cutover 事务外，失败只阻断 READY，不污染活动代。

**Fails if**

PostgreSQL 16 最终要求常驻 Worker 持有表 Owner/Migration Credential；执行器必须接受调用方提供的 SQL/Identifier；Concurrent DDL 中断后无法判断已有 Index 是否符合 Plan；或执行器的权限范围等同于 API 可任意修改 Schema。

**Evidence to get first**

用与 DB-00 相同角色模型，在真实 PostgreSQL 16 上建立一张共享投影 Fixture：编译固定 Plan、创建/中断/重放/核验/删除 Concurrent Index；分别用 API/Worker/Ops 身份尝试 DDL、调用计划外对象、同名不同定义和 Secret 读取。

**Kill criterion**

只要可行方案需要把 Owner/Migration Secret 注入 API/Worker、开放任意 SQL/Identifier、在 Cutover 事务内跑 DDL，或无法对中断后的 Catalog 状态 fail closed，就停止 G2-02，不先建 Object/Current 表。

**Cheapest test**

G2-02-01 的单表 PostgreSQL Spike，不接 S3、Mapping 或业务 API。

**Decision**

这是当前最高风险。任务包已把它前移到 01，并规定失败阻断 02/03；该边界未通过前，“Index Plan 可落地”只是假设。

### 2. G2-01 的零成员 A0 可以只向前扩展为真实成员 Activation

**Claim**

DB-02 可以保留 R1/A0 和既有 Migration Hash，通过新 R2 Runtime Plan、Generation、Activation Member 和 A1 加入首个数据成员；之后 R2/A2 只做数据 Refresh。

**Steelman**

G2-01 已把 Metadata Pins、Runtime Plan、Activation 和 Serving Head 分开，并有纯状态 Harness 覆盖 `R1/A0 → R2/A1 → R2/A2`。数据库只需为未来 Activation 增加 Member 关系和最终一致约束，不需要改变历史事实。

**Fails if**

现有 `member_count=0`、Activation Digest、复合外键或 Publish Transaction 只能通过 UPDATE A0/R1、重写 0002～0006、伪造空 Generation、让同 Release Refresh 改 Member Plan，或在多行插入期间产生可提交的不一致状态来放宽。

**Evidence to get first**

先在停于 0006 且预置真实 R1/A0/Channel/Serving Head 的数据库运行候选 0007；随后创建 R2 Plan、READY Generation、A1 Members，并在每个 SQL 边界故障注入。比较 A0/R1/账本的逐列与 Digest 快照。

**Kill criterion**

需要修改历史 Migration/Release/Activation，或任一已提交状态能出现 Member Count/Digest、Release、Generation、Project 不一致时，停止 DB-02，先修订 ADR-007/013 与 Migration 方案。

**Cheapest test**

G2-02-01 纯状态 Harness + G2-02-03 的单成员 PostgreSQL Migration 薄切片，不需要完整 CSV。

**Decision**

方案有较强上游证据，但数据库约束尚未证明。任务包已禁止新 Migration 目录和历史重写，并把 A0→A1 提升为 DB-02 首个退出条件。

### 3. 持久 Job 能在任意阶段 Kill/Resume 而不重复事实或激活

**Claim**

同一 Materialization Job 可在 SCAN 到 ACTIVATE 任意阶段崩溃，通过 Lease Fencing、Attempt Ownership 和完整 Checkpoint 恢复，最终结果与一次完成相同。

**Steelman**

ADR-010 已证明 Job/Lease 状态语义；Generation/Staging 天然提供不可见输出边界。只要每个阶段先完成并校验输出再提交 Checkpoint，旧 Worker 不能越过 Fencing，重试可以复用身份而不复用半成品。

**Fails if**

Checkpoint 记录成功但输出尚未完整；新 Worker 无法区分旧 Attempt 的半成品；Lease 过期后的旧 Worker仍能标 READY/ACTIVATE；响应丢失产生第二个 Activation；或任何恢复都要求人工 DELETE/改 Pointer。

**Evidence to get early**

在完整 Mapping 前先做真实 `QUEUED → LEASED → one staged batch → CHECKPOINT` 薄切片：双 Worker 抢占、Lease 过期、旧 Fencing 写入、Checkpoint 前后 Kill 和新 Worker 接管。完整阶段矩阵仍在 G2-02-08/14 执行。

**Kill criterion**

只要旧 Owner 能写入、Checkpoint 与输出不能同事务/可验证地绑定，或重试会产生双 READY/双 Activation，就停止扩展格式和 Mapping，先重做 Job/Attempt/Staging 身份。

**Cheapest test**

G2-02-03 加一个最小数据库 Lease/Checkpoint Smoke；不等待 G2-02-08 才第一次验证真实 Fencing。

**Decision**

初稿把完整 Worker 放在 08 是合理依赖，但第一次真实恢复证据过晚。Required Revision 是把双 Worker + 单 Checkpoint Smoke 前移到 03，同时保留 08 的全阶段进程级矩阵。

### 4. 共享投影在新增正式约束后仍能满足 100k/1m 与容量包络

**Claim**

使用共享 Object/Link Base/Current、永久 Identity、Provenance、质量报告和类型化索引后，100k Objects/1m Links Materialization 仍可在 30 分钟内完成，Project Peak 不超过 12 GiB，Cutover 仍保持短事务。

**Steelman**

G1 在相同数量级已得到约 497 MiB 单代归一基线和 19.77 秒原型激活；ADR-008 已采用 150% 预留、Source Forecast/实测取大、有限索引和一个 data-bearing Project。30 分钟相比 G1 原型留有较大生产化余量。

**Fails if**

正式复合外键/唯一约束、Provenance、Rejected Rows、WAL、二次索引或 Node Mapping 把写入/空间放大到超过 SLO/硬上限；只有按类型建表、移除约束、把整个文件装入内存或把 DDL 放进 Cutover 才能通过。

**Evidence to get early**

G2-02-06 先跑 10k Object/100k Link，记录吞吐/WAL/Heap/Index/Node Heap 并保守外推；G2-02-09 在 Cutover 前跑完整 100k/1m，完成后用 Catalog 实测重新准入。

**Kill criterion**

完整基准超过 30 分钟、Peak 超 12 GiB，或需要领域表/无界索引/删除安全约束才能通过时，停止 Cutover/API；先优化 COPY、批次和有限 Index Plan，仍失败则收窄支持包络并正式修 ADR。

**Cheapest test**

固定 1:10 Corpus 的 10k/100k 薄切片 + 线性/非线性指标，不用等全 API 完成。

**Decision**

G1 证明方向，不证明正式实现。任务包已把 10k 检查放在 06、完整性能 Gate 放在 09 而非最终 14 才发现，并规定失败阻断 Cutover。

### 5. Overlay 延后到 G2-04 不会让 G2-02 的 Cutover 证据失真

**Claim**

G2-02 可以在不创建 Action/Overlay 表的情况下完成 Base 原子切换，同时冻结未来 W0/W1 接口；生产只允许受信 zero-overlay，非零场景用对抗 Port 验证算法并在 G2-04 复跑真实集成。

**Steelman**

Action/Overlay 明确由 G2-04 拥有，提前创建会扩大范围并冻结未实现语义。一个版本化 Inventory/Delta Port 加 fail-closed zero Adapter 可以使 G2-02 不丢未知写入，同时避免声称不存在的生产能力。G1 已证明 W0/W1 算法方向。

**Fails if**

生产 Adapter 把“没有表/Provider”解释为零；Cutover 代码把 Base-only 作为特殊捷径而未来无法插入 Catch-up；对抗 Port 不能覆盖真实锁/排序/Head 更新；或 G2-02 Evidence 直接宣称 AC-03/完整 Overlay 集成通过。

**Evidence to get early**

在 G2-02-01 状态 Harness 中分别运行 certified-zero、unknown、Provider failure、non-zero、W0 后注入和重复 Delta；检查只有 certified-zero 可进入生产激活，所有其他生产状态保持旧 Pointer。

**Kill criterion**

若缺失 Provider 能被当成空、非零 Overlay 仍可激活、W0/W1 算法必须等 Action 表出现后重写 Cutover Transaction，或 Evidence 无法区分 Production/Port，就停止 Refresh。

**Cheapest test**

纯 Port/状态 Harness，不创建 DB-03 表。

**Decision**

边界可行，但证据必须诚实分层。任务包已把生产限制、对抗证据和 G2-04 复跑义务写入范围、任务 01/07/11/14 与总 Gate。

## What's Well-Reasoned

以下部分经攻击后仍成立：

1. **先 CSV，再补格式**：格式不是承重风险；先用唯一生产格式把恢复、原子性、容量和权限做实，比并行支持 NDJSON/Parquet 更可控。
2. **Base/Current/Identity 分离**：永久 RID、不可变 Base 和按 Generation 隔离的 Current 能同时支持历史追溯、Refresh 与后续 Overlay，不需要领域表。
3. **Release Plan 与数据 Refresh 分离**：首成员必须新 Release，同 Plan Refresh 只换 Generation，避免历史 Release 定义漂移。
4. **完整库存才准入/GC**：把 Serving、Recent、Protected、Staging、Orphan 与 Index 全计入，是在有限硬上限内保持 90 天支持与安全回收的必要条件。
5. **真实边界总验收**：OIDC、S3、PostgreSQL、API、Worker、DDL Executor 和进程级 Kill 是 Materialization 的最低生产证据，不能被内存 Repository 或截图替代。

## What I Couldn't Assess Yet

- 尚无 Projection DDL Executor 实现，无法确认最终凭据形态、部署触发和 Concurrent DDL 取消/恢复细节；必须由 G2-02-01 先证明。
- 尚无 DB-02 列级 Schema，不能判断所有复合外键、Deferred Constraint、分区/批次与 Vacuum 成本；G2-02-03/06 补证。
- 尚无真实 CSV/DuckDB/Node Mapping 基准，无法确认内存和 WAL 是否线性；G2-02-06/09 补证。
- 尚无 PostgreSQL Overlay Store，因此 W0/W1 只能是算法/Port 证据；G2-04 仍是不可取消的集成 Gate。
- 7–11 工程周是单通道风险范围，不是承诺；DDL/A0 薄切片和 10k/100k 数据薄切片后必须根据实测重估。

## Required revisions resolution

1. **已写回**：G2-02-01 首先执行真实 PostgreSQL Concurrent DDL/最小权限 Spike；失败阻断 Contracts 与 DB-02。
2. **已写回**：G2-02-01/03 固定单一 0001+ Migration 历史和 `R1/A0 → R2/A1` 前向兼容 Gate，禁止历史重写。
3. **已写回**：G2-02-03 增加双 Worker、Lease 过期、旧 Fencing 和单 Checkpoint 的最小真实 Smoke；完整恢复矩阵仍归 08/14。
4. **已写回**：G2-02-06 的 10k/100k 早期数据薄切片与 G2-02-09 的完整 100k/1m 基准在 Cutover 前执行。
5. **已写回**：任务包区分 Production-boundary、Adversarial-port 和 Deferred Integration，不宣称 G2-02 已完成 AC-03。
6. **已写回**：单通道容量由旧 4–6 周改为 7–11 周，并设置两次强制实测校准。

六项修订均已落地，因此结论为 **Go for G2-02-01 only**。它只批准 ADR-014、状态 Harness 与 PostgreSQL DDL Spike；G2-02-02/03 仍必须等待 01 PASS，后续任务不能把“任务包已完成”理解为“Materialization 已实现”。
