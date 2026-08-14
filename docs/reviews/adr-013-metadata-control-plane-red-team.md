# Red-Team：ADR-013 Metadata 控制面

- 日期：2026-08-14
- 审查对象：[ADR-013](../architecture/adr/013-metadata-release-package-control-plane.md)
- 方法：Steelman → Attack → Evidence → Kill Criterion → Cheapest Test
- 结论：**Go for G2-01-02**；真实数据库原子性仍是 G2-01-03 的阻断条件

## 1. 空 Activation 真的能无损进入 DB-02 吗

**Steelman**：Activation 是某个 Release Runtime Plan 的一次可服务实例。空 Plan 的合法集合就是空 Member，不需要假 Snapshot。

**Attack**：最初任务包写成同一个 R1 从空 A0 加入首 Member A1，这会原地改变不可变 Runtime Plan；如果照此建表，DB-02 只能重写 R1/A0 或偷偷把 Metadata Pin 当 Runtime Pin。

**Evidence**：审计在编码前发现该歧义，修订 ADR-007、任务包和红队声明。Runtime Harness 现执行 `R1/A0(empty) → R2/A1(first member) → R2/A2(refresh) ↔ R3 publish`，断言 R1/A0 和 R2 Plan/Manifest 不变。

**Kill Criterion**：DB-02 若要求更新历史 Release/Activation、用 Refresh 改 Plan 或让 G2-01 等待 Materializer，则停止 DB-01/02，重新设计 Pin 和 Activation。

**Decision**：原 Claim 被证伪后已修正；修正模型通过，保留 Go。

## 2. Package Active Pointer 会不会先于 Release 暴露

**Steelman**：Installation Change 先 Pending，唯一激活点复用 Release Publish，能把 Package 和 Runtime 观察统一到一个事务。

**Attack**：常见实现会在 Install/Upgrade 创建时直接更新 `current_package_revision_id`，或者 Publish 只切 Channel，导致 API 和 Runtime 各自看到一半新状态。

**Evidence**：状态模型把 Installation 稳定身份与不可变 Change 分开；在 Release、Serving Head、Channel、Installation/Epoch 五个边界逐一抛错，原状态每次完全不变。成功后旧 Active Change、Installation、Release 和 Channel 一次切换；重复相同 Publish 为 No-op。

**Kill Criterion**：G2-01-08/09 的任一 SQL 故障能留下 Active Package 对应非 Channel Release，立即停止 Package API。

**Decision**：Harness 关闭语义风险；数据库风险转交 G2-01-03/08。

## 3. Publish 与 Snapshot Cutover 会不会形成死锁或倒拨

**Steelman**：统一 Project 控制 CAS 先拒绝陈旧计划；事务按全局锁序取得各自子集，可以串行化控制面切换。

**Attack**：Publish 若先锁 Release 再锁 Project，Refresh 若先锁 Serving Head 再锁 Project，即使各自测试通过，生产并发也会死锁；重试还可能把 Channel 倒拨。

**Evidence**：全局顺序固定为 Project → Channel → Release → Pins → Snapshot Group → Serving Heads；Publish 和 Cutover 两个计划都通过单调性断言，逆序反例稳定失败。ADR-007 已有 Refresh/Publish CAS 竞态和不倒拨场景。

**Kill Criterion**：G2-01-03/08 的真实 SQL 需要逆序锁、无界重试或在锁内等待 Worker，停止发布实现。

**Decision**：设计可行，但真实 PostgreSQL 锁图仍 OPEN。

## 4. 最小 RBAC 会不会成为 G2-03 的授权旁路

**Steelman**：Metadata 管理角色与对象数据策略职责不同；统一 Authorizer Port 可以先提供最小控制面，再由 G2-03 Gateway 组合。

**Attack**：若 Use Case 接收 JWT Claims 或 Endpoint 手写 Owner/Editor 判断，未来 Object Policy 无法统一 Epoch、审计和撤权。Resource Binding 若取并集还能把 Viewer 提升为 Editor。

**Evidence**：可执行边界严格拒绝额外 Token/Claim 字段；身份 Principal 必须与请求相同；角色矩阵集中定义；Resource Binding 与 Project Permission 取交集；Executor/Auditor 无隐式管理权限。Binding 替换和 Epoch 同事务模拟，旧行不可复活。

**Kill Criterion**：G2-01-10 任何生产 Use Case 读取原 JWT/Claims、接受测试身份 Header 或绕开统一 Authorizer，则 Admin API 不得合并。

**Decision**：当前 seam 成立；真实 OIDC/HTTP 与多进程撤权仍由 G2-01-04/10 和 ADR-012 验证。

## 5. 纯状态模型是否给出虚假的数据库信心

**Steelman**：先用纯模型冻结不变量和故障预期，可以在写 Migration 前廉价发现产品语义错误。

**Attack**：`structuredClone` 天然原子，不能证明 PostgreSQL FK、列权限、MVCC、连接中断、Trigger、Deadlock 或 Migration Roll Forward。若把 Harness PASS 写成 DB PASS，会错误放行生产表。

**Evidence**：ADR-013 明确本项不创建 DB-01；表矩阵只是 G2-01-03 输入。Evidence 将所有数据库结果标为 OPEN，并要求非 Owner 负测和真实故障注入。

**Kill Criterion**：G2-01-03 未在 PostgreSQL 16 证明全部或全部不变、Published 不可变和 Runtime 最小权限，却继续进入 Repository/API，则撤销 Go。

**Decision**：Go 只放行 G2-01-02 合同冻结；不放行数据库完成声明。

## What's Well-Reasoned

1. Release Publish 是唯一激活协调点，避免 Package、Metadata 和 Runtime 出现多个“当前”。
2. 两类 Pin 的区分让 metadata-only Release 与未来数据运行时都能保持历史不变。
3. Pending Change 与 Active Installation 分离，失败和 Rollback 都可只向前追加事实。
4. 全局锁序同时覆盖当前 Publish 和未来 Cutover，没有把 DB-02 并发留成空白。
5. 明确 Harness 与数据库证据的边界，避免把类型和内存原子性冒充生产保证。

## What I Couldn't Assess

- 尚无 DB-01 SQL，无法验证复合 FK、部分唯一索引、列级 Grant 和不可变 Trigger 是否完整。
- 尚无真实并发连接，无法评估锁等待、Deadlock Retry 和连接取消。
- 尚无 G2-01 Resource 合同，不能评估 Validator/Dependency Extractor 的字段完备性。
- 尚无 HTTP/OIDC Adapter，不能证明所有入口都建立可信 Foundation Identity。
- 尚无 Package 展开器，不能证明 deferred Resource Family 无法进入 READY。

因此结论是 **Go for G2-01-02**，不是 G2-01 完成，也不是 DB-01 Production Ready。
