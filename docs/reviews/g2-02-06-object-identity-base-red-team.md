# G2-02-06 Object Identity + Base Red Team

- 日期：2026-08-15
- 方法：先将本项钢人化为“确定 Mapping 与未来 Current/Activation 之间唯一的永久身份和不可变 Base 层”，再攻击身份分裂、半代可见、旧 Worker 越权、Link 假端点、Digest 重放污染、错误泄密、Migration 破坏性和容量夸大
- 结论：**G2-02-06 可 PASS；只放行 G2-02-07。Current/Quality/Provenance、真实 Worker 进程、Index/100k+1m、Cutover、GC 和 clean-room 仍为 OPEN**

## 1. 同一业务键在重试或并发 Worker 下分裂为多个 RID

**攻击**：如果 RID 包含 Snapshot、Generation、行号、当前 Release 或先到 Worker，Refresh 会把同一业务对象复制成多个对象。只做先查后写也会有竞态。

**证据**：权威唯一键只有 Project + Object Type Resource + `pk1` Canonical PK。`INSERT ... ON CONFLICT DO NOTHING` 由 PostgreSQL 唯一索引串行化创建，然后权威回读。真实测试让 Worker 1 保持未提交身份事务，Worker 2 同时解析同 Key；提交后两者 RID 相同且只有一行。失败 Attempt 与重试 Attempt 的 10k Object 也只有 10k Distinct RID。

**结论**：CLOSED。

## 2. 失败 Attempt 的半成品被计为完整 Base

**攻击**：批次直接写 Base，或提升只信用应用声称的行数，会在 Kill/断网后暴露半个 Generation。

**证据**：所有构建行先绑定 Attempt/Fencing/Generation 写入 `ops` Staging。首个 10k Object Attempt 写完后强制过期，`runtime.object_base` 仍为 0。新 Worker 接管后，旧 Token 调用 Promote 稳定返回 Fenced。DB 从权威 Batch 表复算行数和 Stage Digest，整代写 Base 与 Stage promoted 同事务。

**结论**：CLOSED for Base promotion。Serving 可见性仍必须经 G2-02-07/10/11。

## 3. 确定重试被 Job 级 Digest Unique 误杀或混入旧 Attempt

**攻击**：如果相同 Batch Digest 在整个 Job 只能出现一次，正确重试无法重放；如果只按 Digest 复用行，新 Attempt 可能误读旧 Owner 的 Staging。

**证据**：0011 把 Digest Unique 改为 Project + Attempt + Digest，并以 Project + Attempt + Batch Sequence 绑定每个 Stage Batch。重试产生相同 Batch Digest 但不同 Attempt-owned 行；提升只查当前 Attempt。同 Attempt 中序号、Digest、行数或 Stage Binding 任一不同都冲突。

**结论**：CLOSED。

## 4. Link 用“同 Project 的任意 RID”伪造端点

**攻击**：只外键到 `(project, rid)` 不能阻止 Customer Link 指向 Asset RID；旧 Schema 确实存在此缺口。

**证据**：0011 将 Source/Target Object Type Resource 持久到 Link Base/Current，历史回填后改为类型化 Identity 复合 FK。写 Staging 还会比对 Link Revision 的 `link_source` / `link_target` Dependency Edge 与精确 Endpoint Revision。真实错 Type 返回稳定错误。

**结论**：CLOSED。

## 5. Dangling Link 为了让批次通过而创建假 Object

**攻击**：把 Lookup Miss 转成 Identity Create 会永久污染命名空间，也无法实现 required/optional 质量规则。

**证据**：Link 路径只调用 `lookup_object_identities`，不调用 Resolve/Create。Miss 返回行号、`source|target` 位置和哈希指纹，不返回 PK。负测前后 Identity 数不变。

**结论**：CLOSED for candidate handoff。质量阈值、Artifact 和 Report 仍 OPEN to G2-02-07。

## 6. 普通错误通过 `cause` 泄露 SQL 或 Canonical PK

**攻击**：只脱敏 `message`/JSON 不够；日志器常会递归展开 `Error.cause`。

**证据**：最终复审实际找到了这个缺口。Application 公开 Error 现在不附带 Repository/Parser 原 Cause；PostgreSQL Adapter 只映射稳定 Code。测试用含 `INSERT` 和完整秘密 PK 的底层 Error 攻击，检查 Message、JSON 和 `cause` 都无泄露。

**结论**：CLOSED after real rework。

## 7. `SECURITY DEFINER` 成为绕过 Lease/类型约束的 Owner 通道

**攻击**：Worker 虽没有表权限，但宽松 Definer 函数等价于 Owner 直写。可变 `search_path` 还可用同名对象劫持。

**证据**：函数固定 `search_path=pg_catalog`，参数不接受 SQL/表名。Stage/Promote 每次重验 Job/Attempt/Fencing/DB Clock Lease、Generation 绑定、Snapshot/File、Mapping 和 Link Dependency。API/Ops 无 Execute；Worker 可 Execute 但无 Raw DML。真实 LOGIN 负测覆盖新增全部 Base/Staging 表和 Promote/Lookup 函数。

**结论**：CLOSED for G2-02-06。Project-scoped Worker 凭据/RLS 仍属于部署与租户纵深防御，不在本 Gate 宣称已实现。

## 8. 前向 Migration 回填被不可变 Trigger 拦截或留下半 Schema

**攻击**：给历史 Link 加 NOT NULL 类型列必须回填，但 Statement-level Immutable Trigger 连 0 行 UPDATE 也会拒绝。手工停 Trigger 若不在原子 Migration 中会破坏不可变边界。

**证据**：首次真实升级确实被 Trigger 拦截。修正后 0011 只在 Runner 管理的同一事务内停用指定 Trigger、回填、加约束、重启 Trigger。全链升级、重跑 no-op、并发 Runner 和在 0011 末尾注入故障的整版本回滚均通过。

**结论**：CLOSED。

## 9. 10k/100k 小样本被夸大为 100k/1m 生产 SLO

**攻击**：线性外推没有包含 Current、Index、质量、S3 网络、Cutover 和 GC；数据宽度/基数变化也会改变 Index/WAL。

**证据**：薄切片记录原始行数、批次、分阶段时间、Node RSS、WAL、Object/Link/Identity Heap+Index 和失败 Staging 总字节。结论只是当前主阶段线性外推约 7:50、有继续实现余量，而不是正式 SLO PASS。完整 100k/1m 被明确保留给 G2-02-09/14。

**结论**：CLOSED for honest gate claim；formal SLO remains OPEN。

## 10. “从上传到 Base”其实跳过了真实字节解析

**攻击**：直接构造 `MappingAcceptedObjectRow` 可以让 Base 测试通过，但 CSV 字节、Schema、Mapping 和 Sink 背压的接缝仍未证明。

**证据**：初始容量 Harness 存在该问题，最终改为生成实际 UTF-8 CSV 字节流，执行同一 Managed CSV Scanner、冻结 Mapping Compiler/Executor，并在 5,000 行 Sink 水位等待 PostgreSQL Base 批次。G2-02-04 另有真实 S3 Exact Version 读回证据。

**结论**：CLOSED for byte-stream-to-Base composition。同一场景的远程 S3 + OIDC/HTTP + Worker 总耗时仍 OPEN to G2-02-13/14，Evidence 已显式限定。

## 11. 排序后的失败模式

| 排名 | 失败模式                      | 影响 | 可能性 | 当前处理                                                               |
| ---: | ----------------------------- | ---: | -----: | ---------------------------------------------------------------------- |
|    1 | 旧 Attempt/半代被提升         |    5 |      4 | Attempt staging + DB fencing + atomic promotion，CLOSED                |
|    2 | 同 Key 并发分裂 RID           |    5 |      4 | DB unique serialization + real two-worker test，CLOSED                 |
|    3 | Link 错 Type/假 Identity      |    5 |      4 | typed endpoint FK + dependency validation + lookup-only，CLOSED        |
|    4 | Digest 重放混入旧 Attempt     |    5 |      3 | Attempt-scoped batches + DB digest recount，CLOSED                     |
|    5 | Error cause 泄露 SQL/PK       |    5 |      3 | strip cause + direct negative test，CLOSED                             |
|    6 | Definer 函数等价 Owner 旁路   |    5 |      3 | fixed search path + binding rechecks + login matrix，CLOSED            |
|    7 | Migration 回填破坏不可变事实  |    5 |      3 | one forward transaction + injected rollback，CLOSED                    |
|    8 | 10k/100k 被夸大为完整 SLO     |    4 |      4 | raw metrics + explicit non-claim + future full gates，CLOSED for claim |
|    9 | 失败 Staging 长期占用磁盘     |    4 |      4 | measured and retained intentionally；OPEN to G2-02-12 GC               |
|   10 | Dangling 质量证据在重启后丢失 |    4 |      3 | deterministic replay available；persistence/report OPEN to G2-02-07    |

## 12. 放行结论

未发现需要改变 PRD 或 G2-02 产品目标的停止条件。已实现的 Identity/Base 层能作为 G2-02-07 的真实输入，不需要领域表、第二套 Key 或手工清理才能重试。

放行范围只是 **G2-02-07 Staging Current + Quality + Provenance**。不允许跳到 Query/UI，也不允许将已提升 Base 直接暴露给应用账号代替 Current/Activation。
