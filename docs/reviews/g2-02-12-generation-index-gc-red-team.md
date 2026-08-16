# G2-02-12 Generation / Index GC Red Team

- 日期：2026-08-17
- 方法：钢人化承重主张，再按影响 × 出错可能性 × 最低测试成本排序
- 结论：**G2-02-12 GC 能力可 PASS；只放行 G2-02-13。Admin HTTP 与 clean-room 仍是必须停止项。**

## Top Kill-Assumptions（按优先级）

### 1. 计划创建后不会漏掉后来出现过的 Root

- **Claim：** 任一支持窗、Job、Head、Cutover 或 Activation 引用变化都会使旧计划永久陈旧。
- **钢人：** Commit 在每批前重算 Root Digest 并检查 State/Inventory Revision。
- **Fails if：** Root 在两次检查之间加入又移除，最终 Digest 回到原值，旧计划错误复活。
- **Evidence：** Root 写 Trigger 在共享 Project Advisory Lock 下单调推进 `root_revision`；真库测试插入 queued Job Root、验证 stale、再取消 Job 后验证同一计划仍 stale。
- **Kill criterion：** 任一 Root 曾变化后旧计划仍可提交即 FAIL。
- **Cheapest test：** 计划后插入并删除同一临时 Job，再重试首批 Commit。
- **状态：CLOSED。** 该反例推动了 Root Epoch 实现。

### 2. “完整扫描”不是调用方声称的空集合

- **Claim：** 已激活 Provider 缺失、失败或版本错误时不会删除任何 Candidate。
- **钢人：** Registry 显式标记 ACTIVE/INACTIVE，计划绑定 Provider Registry Digest 和各 Scan Digest。
- **Fails if：** 调用方可提交格式正确但内容为空的 COMPLETE Scan，或新能力启用后沿用旧计划。
- **Evidence：** PostgreSQL 持久化逐字段对照实时 Provider View；临时启用无实现的 Query Lease Provider 后返回 `PROVIDER_MISSING` 且 Candidate=0；Registry 变化使旧计划 stale。
- **Kill criterion：** ACTIVE Provider 无实时匹配 Scan 仍生成或执行计划即 FAIL。
- **Cheapest test：** 将一个 INACTIVE Provider 切为 ACTIVE，不增加实现，执行 Dry-run/Commit。
- **状态：CLOSED。** 历史 Activation 也已作为正式 ACTIVE Provider 加入。

### 3. Kill/响应丢失不会造成半批删除或重复事实

- **Claim：** 每个关系批次全有或全无，重试与一次完成相同。
- **钢人：** 数据删除、Collection Marker、Entry 进度、Revision 和 Batch Event 在一个事务中提交。
- **Fails if：** Node 被杀后服务端事务仍在后台提交，Harness 却误把它当回滚；或重试再次改变事实。
- **Evidence：** Harness 在 Batch Event 上持锁，等待数据已变更后 SIGKILL Node，并显式终止 PostgreSQL Backend，再比较进度不变；释放故障后重复相同批次直至收敛。另有提交结果重放覆盖“服务端成功、响应丢失”。
- **Kill criterion：** 任一 Kill 点出现半批状态、双 Marker、悬空引用或人工修库即 FAIL。
- **Cheapest test：** 对每个实际产生变化的 Phase 复用同一阻塞/终止脚本。
- **状态：CLOSED。** 首版仅 Kill 客户端的证据不足，已改进 Harness。

### 4. Index Drop 不会与新引用或错误 Catalog 竞态

- **Claim：** 只有完整零引用证明能够物理删除登记 Index。
- **钢人：** Request 绑定 GC Plan/Digest；DDL Executor 取得共享 Project Lock，并重验 Root、Revision、反向引用与 Catalog Recipe。
- **Fails if：** Drop 与 Cutover/Job 新引用并发，或登记 Name 指向另一对象时仍执行。
- **Evidence：** 错误 Catalog/Definition 拒绝；所有 DROP 都来自 GC Request；首个 DROP SIGKILL/断连后重试，失败不标 retired，最终 Catalog 与 Inventory 一致。
- **Kill criterion：** 非 GC Request 可 DROP、引用中的签名被删、错误对象被删或失败后误标完成任一出现即 FAIL。
- **Cheapest test：** 在执行前改变 Root/Inventory 或替换 Catalog 定义，确认 Request stale/failed 且对象保留。
- **状态：CLOSED。**

### 5. 回收后的容量总账不会虚假变绿

- **Claim：** 部分 GC 不会把旧测量当作新的物理事实。
- **钢人：** 每个有物理影响的批次都会推进 Inventory Revision。
- **Fails if：** 删除后仍保留 `measurement_complete=true`，下一计划或容量准入复用陈旧字节。
- **Evidence：** 关系批次和 DDL Drop 都把测量标为 incomplete；真库测试确认未重扫时后续 Dry-run 全量阻断。
- **Kill criterion：** 任一物理变化后可用旧测量创建新计划即 FAIL。
- **Cheapest test：** 完成一个删除批次，立即调用 Dry-run，不执行 Scanner。
- **状态：CLOSED。**

## What's Well-Reasoned

- 核心事实保留、派生行回收和 Collection Marker 分离，使审计、幂等与历史引用不依赖已删除大表行。
- 对象存储用服务器固定的精确 Version 删除，确认丢失只重试同一不可变目标。
- 历史 Activation 选择“全部保护”虽然保守，但在 G2-02 尚无显式历史保留产品策略时不会冒险破坏可审计解析。

## What I Couldn't Assess

- G2-02-13 尚未接入真实 OIDC/ManagementAuthorizer HTTP，因此还不能证明 Owner/Editor/Viewer 的 GC 接口权限与跨 Project 同形拒绝。
- 本关对象存储使用协议 Port；真实 S3 Versioning、API/Worker/DDL 进程组合要在 G2-02-14 clean-room 复跑。
- 真实 Query Lease/Action/Investigation Provider 尚未上线；它们当前显式 INACTIVE，未来启用时必须先实现 Provider 并重跑本 Gate。

## 决策

五个承重假设均有真实 PostgreSQL、进程故障或 Catalog 证据，发现的瞬态 Root、历史 Activation、伪空扫描、Kill 证据和容量测量缺口都已在本关关闭。放行 **G2-02-13 Admin API、Testkit 与统一 CI Gate**；在真实 HTTP 授权和统一机器证据完成前，不得开始 clean-room PASS。
