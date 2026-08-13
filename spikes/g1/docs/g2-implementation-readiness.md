# G2 Kernel 实现准入约束

G1 的作用是判断架构是否值得实现，不是把 Spike 直接上线。G2 必须从冻结的 Kernel Contract 重新建立生产代码，可复用算法和测试向量，不应复制 Spike 的进程管理和本地凭据做法。

## 1. G2 准入条件

- G1 A–D 的最终证据均为 PASS；
- Object Identity、Base/Overlay、Generation Pointer、Query AST、Policy Context 和 Package Revision 合同冻结；
- 接受 [G1 架构决策](architecture-decisions.md) 中的存储、GC、索引与 Worker 复杂度；
- 明确 G2 仍是单组织、单租户、单 PostgreSQL 区域语义。

## 2. 第一个生产垂直切片

第一个里程碑只做一条无领域特例的闭环：

```text
Create Draft Definitions
→ Publish immutable Release
→ Register Snapshot + Mapping
→ Materialize Staging Generation
→ Atomic Activate
→ Policy-aware Search / Traverse
→ Action Preflight / Apply
→ Overlay + ChangeSet + Outbox
→ Audit and Activity readback
```

测试数据继续使用 EntityA–E 与两个 Package Fixture，不引入报销、CRM 或其他真实业务特例。

## 3. 实现顺序

1. **Contracts 与 Release Store**：定义不可变 Revision、兼容性规则、数据库 Migration 和 API Error Contract。
2. **Materialization Control Plane**：持久化 Job 状态机、租约/心跳、幂等重试、错误样本脱敏、Staging GC 和 Group Cutover。
3. **Query + Policy Runtime**：将 G1 AST 与 Gateway 改造为稳定库，增加真实连接池、Cursor 生成、超时、取消和查询配额。
4. **Action Transaction Pipeline**：实现 Preflight、Expected Version、Mutation Plan 验证、Overlay/ChangeSet/Outbox 单事务和幂等键。
5. **Protocol Layer**：HTTP Object/Link/Action API、OIDC/OAuth2、Service Identity 和 SDK 生成；所有入口只调用 Policy Gateway。
6. **Operations**：指标、Trace、审计、备份/恢复演练、Generation 保留和索引容量预算。

## 4. 前六周建议里程碑

| 周 | 可验收结果 |
|---|---|
| 1 | Contract、ADR、数据库 Migration、CI 与确定性 Fixture |
| 2 | Definition/Release API 和兼容性检查 |
| 3 | 可恢复 Materialization Job 与 Staging Report |
| 4 | Search/Get/Traversal + Policy Gateway 端到端 |
| 5 | Action Preflight/Apply + ChangeSet/Outbox 原子性 |
| 6 | 同一合成环境安装两包，重跑 G1 性能与泄露向量 |

这六周不等于完成产品。完整 Kernel Internal Beta 仍应使用 PRD 中 4–6 人、6–8 个月的规划约束。

## 5. 明确延后

- 可视化 Ontology Builder 的高级布局；
- 大量预制 Connector 和复杂 Data Pipeline Designer；
- AI Agent/Assistant 产品面；
- 三跳以上图遍历、通用 GraphQL 和任意 SQL；
- 多租户计费、Marketplace 和跨区域强一致。

## 6. G2 第一里程碑的退出条件

- 两个 Package 在不改核心的情况下完成发布、物化、查询、Link 和 Action 闭环；
- 事务故障注入不产生部分 Overlay、ChangeSet 或 Outbox；
- 真实 HTTP/SDK/Function/Action/Export 入口重跑同一 Policy 向量为 100% 一致；
- 100k/1m 基线上的 G1 性能门槛仍通过；
- 备份恢复演练能恢复 Release Pointer、Base/Overlay 和历史 Action Revision。
