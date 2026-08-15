# G2-02-07 Quality Current + Provenance Red Team

- 日期：2026-08-16
- 方法：先将本项钢人化为“Base 与未来 READY/Activation 之间唯一的质量、Current 和来源证据层”，再攻击半代可见、optional 静默 null、永久 Identity 误判 Link、伪造 Report/血缘、坏行泄密、过期 Owner 确认、跨 Project Candidate 和证据夸大
- 结论：**G2-02-07 可 PASS；只放行 G2-02-08。Worker Kill/Resume、Index/容量、Certificate、Cutover、GC、HTTP 与总验收仍为 OPEN**

## 1. 部分 Current 被普通 Resolver 当成活动代

**攻击**：一边复制 Base 一边读 Current，或让 Serving Resolver 直接读 `building` Generation，会向用户暴露半个 Snapshot。

**证据**：Current、Provenance、Report、Binding 和 Candidate 在受控 Finalize 边界中生成/绑定。Candidate Reader 只向 Worker 开放精确 `building + quality-qualified` 读取；普通 Serving 仍只经 Serving Head → Activation → READY/ACTIVE Generation。测试前后旧 Activation Digest 不变。

**结论**：CLOSED for G2-02-07。真正切换仍 OPEN to G2-02-11。

## 2. 把 Base 直接当 Current，忽略未知 Overlay

**攻击**：G2-04 尚未有真实 Overlay Store，若默认为空，未来 Action 将被 Refresh 静默覆盖。

**证据**：Quality Service 在任何准备写之前读取版本化 Overlay Inventory。Provider 缺失、状态未知或行数非零都返回 `ZERO_OVERLAY_REQUIRED`，Repository 调用次数为零。READY 守卫另要求 Binding 的 zero-overlay 证明为 0。

**结论**：CLOSED for Base-only production path。非零 Overlay 集成仍 OPEN to G2-04。

## 3. optional Property 错误被写成业务 null

**攻击**：为了让质量阈值通过，将转换失败的单个值写为 null，会让一行的其他 Property 假装有效。

**证据**：Observation 以物理行为单位排除 Base→Current。真库 1,000 行/1 个 optional 失败恰好通过 0.1% 阈值，但只生成 999 行 Current 和 Provenance，不存在部分行。

**结论**：CLOSED。

## 4. 被拒 Object 的永久 RID 让 required Link 误通过

**攻击**：Object Identity 是永久的；如果 Link 只检查 Identity，已被当前质量拒绝的 Object 仍会被当作端点。

**证据**：Link 二次解析精确 Snapshot Group Version 内、正确 Object Revision、Quality-qualified Object Current，不以 Identity 存在代替可见性。真库证明 RID 仍存在但 required Link 产生 `REQUIRED_LINK_DANGLING`、Current=0 且 Generation failed。

**结论**：CLOSED。

## 5. Provenance 只写一列或伪造常量来源

**攻击**：旧表每 Property 只有一个 Column Ordinal；concat 会丢来源，constant 可能被伪造为“列 0”。更危险的是 Worker 可以提交与 Mapping 无关的列。

**证据**：0012 将主键扩为 Property + Source Index，显式区分 `column|constant`。Application 从已编译 Plan 产生 Primary Key 及普通 Property 的多来源模板；DB 向已发布 Object Type/Mapping/Snapshot Schema 核对 Property 和列 Ordinal。10k/100k 真实 Mapping→Base 路径曾暴露小 Fixture 漏掉 Primary Key Provenance 的缺口，最终是补齐 `orderId` 来源而不是删掉 Property。错列负测失败，缺失任一 Current Property 血缘阻断 READY。

**结论**：CLOSED for minimal provenance。完整转换 DAG 不在 G2-02 范围。

## 6. Worker 伪造 Report、Digest 或接受行数

**攻击**：若 Finalize 只保存 Application JSON，被篡改的 `passed`、原因计数或 Digest 可以让坏代进 READY。

**证据**：数据库从 Observation/Current/Provenance/不可变 Mapping 重算阈值、原因聚合、样本顺序和全部 Digest。Generation late binding 只能从全空到一个终值。READY 时再比对 Report accepted rows 与实际 Current count。

**结论**：CLOSED。跨进程响应丢失重试由 G2-02-08 继续验证。

## 7. Rejected Row 中泄露值、PK、列名或无界占满磁盘

**攻击**：错误诊断很容易记录原始行，或为了保存全部坏行把 Node Heap/对象存储打满。

**证据**：普通 Report 最多 50 个固定字段样本。完整集只含位置、稳定 Reason、不可逆 Fingerprint 和通用分类；两遍 keyset 流式不累积数组，超过 256 MiB 在上传前停止。S3 Adapter 固定 Key/Media Type/Version。

**结论**：CLOSED for bounded creation。上传后 DB 失败的 Orphan 回收仍 OPEN to G2-02-12。

## 8. 过期 Owner 确认在并发 Publish 时穿过

**攻击**：Application 先读 Publication Sequence，另一事务发布新 Release，确认函数仍使用旧 Scope 提交，会让旧 Owner/旧上下文生效。

**证据**：决定绑定 Actor、Snapshot/Report Digest、观察/基线行数、阈值、Publication Sequence、Decision 和有效期。DB 自身重查 active Owner。最终复审发现先读后锁的并发窗口，已改为确认与 Publish 都锁同一 `meta.projects` 行；真库 lock-timeout 负测和 Sequence 推进负测均通过。

**结论**：CLOSED after rework。

## 9. Candidate Reader 跨 Project/Generation 泄漏或全表扫描

**攻击**：只传 Resource ID 或只用 Generation ID，可能读到其他 Project/旧代。在大表上如果无精确索引前缀，将在后续 1m 数据时退化。

**证据**：函数参数和 WHERE 同时绑定 Project、Generation、Resource、Revision，限制 1～1000 并用 RID keyset。跨 Project 真实 LOGIN 调用稳定拒绝。`EXPLAIN` 在 `enable_seqscan=off` 时仍找到 Index Scan，不存在只能 Seq Scan 的查询形状。

**结论**：CLOSED for access path shape。正式 100k/1m 延迟仍 OPEN to G2-02-09/14。

## 10. 把 Integration Harness 夸大为完整生产闭环

**攻击**：数据库和 S3 单独通过不等于真实 Worker 可恢复，更不等于 READY/Cutover/Query 或 30 分钟 SLO。

**证据**：Evidence 将本项限定为“不可见的 Current + Quality + Provenance”，逐项标记 08 Worker、09 Index/Capacity、10 Certificate、11 Cutover、12 GC、13 HTTP 和 14 Clean-room 为 OPEN。没有提前将 Generation 标 READY 或创建新 Activation。

**结论**：CLOSED for honest claim。

## 11. 排序后的失败模式

| 排名 | 失败模式                             | 影响 | 可能性 | 当前处理                                            |
| ---: | ------------------------------------ | ---: | -----: | --------------------------------------------------- |
|    1 | 半代 Current 进入 Serving            |    5 |      4 | Candidate/Serving 边界 + 旧 Activation 不变，CLOSED |
|    2 | required Link 被永久 Identity 误放行 |    5 |      4 | 精确同代 Object Current 解析，CLOSED                |
|    3 | optional 错误静默写 null             |    5 |      4 | 整行 Rejected + 0.1% 边界真库测试，CLOSED           |
|    4 | 伪造 Report/Digest/接受行数          |    5 |      3 | DB 重算 + late-binding/READY guard，CLOSED          |
|    5 | 过期确认穿过并发 Publish             |    5 |      3 | Project 共享行锁 + 事实重查，CLOSED after rework    |
|    6 | 坏行泄密或无界占用                   |    5 |      3 | 脱敏固定字段 + 两遍流式 + 硬上限，CLOSED            |
|    7 | Provenance 丢多列/伪造列             |    4 |      4 | 有序来源项 + Schema/Mapping 核对，CLOSED            |
|    8 | Base 在 Overlay 未知时当 Current     |    5 |      3 | zero-overlay fail closed，CLOSED for current scope  |
|    9 | Candidate 跨项目或全表扫描           |    5 |      3 | 精确谓词/RBAC/keyset/index path，CLOSED             |
|   10 | Orphan Rejected Artifact 长期占盘    |    4 |      4 | 显式保留；OPEN to G2-02-12 GC                       |

## 12. 放行结论

未发现需要修改 PRD、改变 G2-02 产品目标或提前引入 Query/UI 的停止条件。已实现的 Current/Quality/Provenance 可作为独立 Worker 的真实阶段输出，不需要手工改表或绕过质量门禁。

放行范围只是 **G2-02-08 PostgreSQL Job/Lease Worker + Kill/Resume**。不得将 Candidate Reader 当 Query API，也不得在 Index/Certificate/Cutover Gate 之前暴露 Current。
