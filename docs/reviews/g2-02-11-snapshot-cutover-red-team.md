# G2-02-11 Snapshot Group Cutover Red Team

- 日期：2026-08-16
- 方法：钢人化承重主张，再按影响 × 出错可能性 × 最低测试成本排序
- 结论：**G2-02-11 Cutover 能力可 PASS；只放行 G2-02-12。生产 Worker/Admin HTTP 组合与 clean-room 仍是 G2-02-13/14 的必须停止项。**

## Top Kill-Assumptions（按优先级）

### 1. 100k Head 不会进入最终锁事务

- **Claim：** Cutover 事务仅重验受控事实并 CAS 移动指针，不会因 Object 数量线性增长。
- **钢人：** Prepare 已构建完整不可变 Head Set，Commit 只锁当前/候选 Set 与一条 Project Pointer。
- **Fails if：** Commit 仍扫描、复制或更新 100k Head，导致锁持有超过 5 秒。
- **Evidence：** 独立 8C16G 上 100k/1m 从空数据层构建，Preparation 生成 100k Head，最终 Commit 207.474 ms；20 次稳态重试 P95 83.991 ms、max 85.732 ms。
- **Kill criterion：** P95 ≥ 1s 或 max ≥ 5s 立即 FAIL，必须减少事务内工作，不允许放宽锁超时。
- **Cheapest test：** 同一 100k Head Set 上单独计时 Prepare 与 Commit，并记录 Commit SQL 结果。
- **状态：CLOSED。** 首版逐 Head UPDATE 实际超过 9 分钟，本关已因该反例改为不可变 Head Set + O(1) Pointer CAS。

### 2. 任一 SQL 边界失败都不会留下半套新代

- **Claim：** Activation、Member、Head、Serving、Channel、生命周期和 Revision 只会全旧或全新。
- **钢人：** 所有可见状态都在同一 PostgreSQL 事务中写入，Preparation/Head Set 即使留存也不可见。
- **Fails if：** 某个 Pointer 在事务外写入，或某个失败点回滚不完整。
- **Evidence：** 在 `after_locks/activations/heads/serving_heads/channels/lifecycle/revisions/result` 八个 SQL 边界注入真实异常，逐次比较全量 Activation、Member、Head、Serving、Channel、Snapshot、Generation、Job 和序号快照，全部不变。
- **Kill criterion：** 任一失败快照不同或 Resolver 可见混合 Member 立即 FAIL。
- **Cheapest test：** 每个写阶段后 `RAISE XX000`，在独立连接中对比事务前后 JSON 快照。
- **状态：CLOSED。**

### 3. 并发 Refresh/Publish 不会静默覆盖胜者

- **Claim：** 双 Refresh、Refresh 对 R3 Publish、陈旧 Head/Inventory/Certificate 都稳定冲突。
- **钢人：** Project Control、Head Set、Inventory、Serving Head 和 Channel 都在锁内使用期望值 CAS，Certificate 从动态 Current View 重验。
- **Fails if：** 两个 Preparation 可连续提交，或 Publish 改变 Channel 后旧 Refresh 仍移动 Pointer。
- **Evidence：** 两个真实 Pool 并发提交仅一个成功；另一个返回稳定 concurrent-modification。在 Prepare 后 Publish R3，旧 Commit 被拒绝，重新 Prepare 后才可提交。
- **Kill criterion：** 双胜者、后者静默覆盖或陈旧证书可提交任一出现即 FAIL。
- **Cheapest test：** 从同一 control/head/inventory Revision 准备两份计划并 `Promise.allSettled` 提交。
- **状态：CLOSED。**

### 4. Head Version 表示业务变化，而不是物理重建次数

- **Claim：** 纯 Provenance/Index 重建不会让下游误以为业务对象变更。
- **钢人：** 语义 Digest 只绑定 Base 值、生命周期和当前可见 Link，Generation/Provenance/Index 身份不参与。
- **Fails if：** 相同业务值的新 Generation 使 Version+1，或 Link/生命周期真改变却不加版本。
- **Evidence：** v3 纯重建只重指向新 Generation，Digest/Version 不变；v4 业务值与生命周期改变使相应 Head 加版本；1m Link 容量向量证明链接邻接集参与 Digest。
- **Kill criterion：** 纯重建增版本或可见业务改变不增版本即 FAIL。
- **Cheapest test：** 克隆一份 Current 只改 Generation/Provenance，再只改一个值/生命周期对比 Head。
- **状态：CLOSED。**

### 5. 受信函数不会变成 Runtime 的任意 Pointer 写入器

- **Claim：** API 只能提交受限身份、期望 Revision 和幂等 Key，不能提交 Activation Member、Head Set、Generation 列表或 SQL。
- **钢人：** Prepare 和 Commit 都由服务器重读 Plan/Certificate/Inventory/Current；新 Head Set 表、内部候选和 Fault 函数对 Runtime 全部撤权。
- **Fails if：** API/Worker/Ops 可读写 Head Set/Pointer/候选表，或可调用带 Fault Point 的内部 Commit。
- **Evidence：** 真实 `api_runtime`、`worker_runtime`、`read_only_ops` 登录对 Head View/Set/Version/Pointer 的读写均返回 PostgreSQL `42501`；API 仅有公开 Prepare/Commit EXECUTE。
- **Kill criterion：** 任一 Runtime Role 能越过公开函数写指针、写 Head 或调用内部 Fault 入口即 FAIL。
- **Cheapest test：** 以三个真实 Login 分别 SELECT/UPDATE 新表，并尝试 `SET ROLE migration_owner`。
- **状态：CLOSED。**

## What's Well-Reasoned

- 长 Prepare 与短 Commit 的分离通过真实容量反例驱动，不是只有图上的“短事务”。
- Activation/Member 不可变与当前 Pointer 分离，使响应丢失、历史证据和 GC Root 都有稳定身份。
- 多个受支持 Release 可同时生成完整 Activation，但只有 Prepare 时真正拥有 Channel 的 Release 可移动它，避免多 Release 遍历自相冲突。

## What I Couldn't Assess

- G2-03 真实 Query Resolver 尚未存在；本关用直接解析 Activation/Member/Head 的真库 Harness 证明原子性，G2-03 必须复跑同一向量。
- G2-02 仍无真实 PostgreSQL Overlay 写路径；当前只证明 zero-overlay 生产 fail-closed 和对抗 Port 的 W0/W1 协议。
- `worker:start` 的全阶段生产组合与 Admin HTTP 尚未完成；G2-02-13 不完成该接缝就不得进入 clean-room PASS。

## 决策

五个 Cutover 承重假设均有真实反例或容量证据，首版长事务缺陷已在本关改为 Head Set Pointer CAS，未触发架构停止条件。放行 **G2-02-12 Generation/Index mark-plan-commit GC**；GC 若无法完整扫描所有 Root，必须 Candidate 为空，不允许以“当前指针外”代替负面证明。
