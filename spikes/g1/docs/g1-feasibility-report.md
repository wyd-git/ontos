# Ontology Kernel G1 可行性报告

- 日期：2026-08-13
- 决策：**GO — 进入 G2 Kernel 实现**
- 含义：高风险核心架构已获得可执行证据；不表示产品、生产安全或运维体系已经完成
- 冻结实现指纹：`sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1`

## 1. 判定矩阵

| Spike | 结果 | 关键证据 |
|---|---|---|
| A：通用 Query/Index | PASS | 100k/1m；30 分钟、20 RPS、36k 请求、0 错误；10 类端到端 P95 27.1–42.5 ms；无领域 SQL |
| B：Base + Overlay | PASS | 冲突/Catch-up/故障恢复通过；100k/1m 全量激活 19.77 秒；20 次 Cutover P95 408.5 ms |
| C：Policy 一致性 | PASS | 7 个入口、38 次 DB 执行、42 条审计；Search/Aggregate/Link 结果一致；无字段/数量/日志旁路 |
| D：第二领域 Package | PASS | 两个不同领域包不修改 Core；安装、兼容升级、阻断破坏性变更、回滚和历史 Handler Pin 通过 |

按照执行章程，A–D 全部 PASS，因此 G1 从 Conditional Go 转为 Go。详细证据见 [A](../evidence/spike-a-summary.md)、[B](../evidence/spike-b-summary.md)、[C](../evidence/spike-c-summary.md)、[D](../evidence/spike-d-summary.md) 和[最终证据清单](../evidence/final-evidence-manifest.md)。

## 2. 这次验证实际改变了什么

验证不是把既定方案跑绿。20 次全规模 Cutover 首轮 P95 为 1.768 秒，超过 1 秒门槛。门槛没有修改；实现改为只更新业务版本、生命周期或冲突状态真实变化的 `object_heads`。随后重新执行正确性、全规模和切换分布，最终 P95 为 408.5 ms、最大 414.3 ms。

审查还消除了两个安全/一致性风险：

1. Link Traversal 不再拥有测试用默认允许策略，Gateway 和 Compiler 都要求显式 Link Policy，缺失即拒绝；
2. Traversal 与 Search 一样只返回 Page Size 行，用第 N+1 行判断 `hasNextPage`，不再把哨兵行泄露给调用者。

修正后的 36 项单元测试全部通过；测试原始结果 SHA-256 为 `11320d1a965adfe86ec735593cd35ff047892c4cee504dd406f066389448b971`。

## 3. 已证实的实现路径

```text
Definitions / Package Revision
        ↓ publish
Schema Registry + Index Plan
        ↓ snapshot
Immutable Base + Immutable Overlay
        ↓ recoverable worker
Invisible Staging Current Projection
        ↓ catch-up + atomic pointer switch
Active Current Projection
        ↓ explicit Policy Gateway
Search / Aggregate / 1–2 Hop Traversal / Action Target
```

必须冻结为 G2 约束的决策：

- Query 只读 Active Current Projection，不在请求时动态拼接来源与历史 Overlay；
- Base/Overlay 是事实，Current/Conflict/Index 是可重建产物；
- 全量物化由带状态、租约和幂等重试的 Worker 编排，数据库过程只做小型 Catch-up；
- 所有入口经过一个 fail-closed Policy Gateway；Handler 不获得裸数据库连接；
- Package Revision、Manifest 和 Handler Digest 不可变，升级与回滚都创建新 Revision；
- Builder 只能为明确声明的查询字段生成索引；不能自动索引全部 JSON Property；
- 旧 Generation 必须有保留和 GC 预算，否则物理数据与索引会随发布线性增长；
- Timestamp 在写入边界规范化为固定 UTC 表示，或在 G2 Schema 冻结前选定受控类型化列。

## 4. G1 没有证明什么

以下仍是 G2/G3 的工程工作，不能引用本报告声称已经完成：

- HTTP API、OpenAPI/SDK 生成、OIDC/OAuth2、Secret 管理；
- 完整 Action Preflight/Apply、Mutation Plan、ChangeSet、Outbox 单事务与外部副作用交付；
- 持久化 Job Queue、租约/心跳、限流、取消、孤儿 Staging GC；
- Builder、Object Explorer、自动 List/Detail/Form 和 Conflict UI；
- 备份恢复、HA、升级演练、监控告警和生产容量规划；
- 多租户、多区域、跨区域一致性；
- 1m Objects / 5m Links、复杂图算法或高并发生产峰值；
- 完整 Data Pipeline、Automation 和 AI Agent 模块。

本轮只在一台 Apple M4/16GB 主机、单 PostgreSQL 16.14 容器、单区域语义下验证。20 RPS 是 G1 固定负载，不是产品容量上限或生产 SLA。

## 5. G2 下一步

按 [G2 实现准入约束](g2-implementation-readiness.md) 开始第一条生产垂直切片：

```text
Draft Definitions → Immutable Release
→ Snapshot + Mapping → Recoverable Materialization
→ Policy-aware Query/Traversal
→ Action Preflight/Apply
→ Overlay + ChangeSet + Outbox
→ Audit/Activity Readback
```

建议先做六周工程里程碑，仍使用 EntityA–E 与两个 Package Fixture，直到同一个垂直切片完全通过；不要先建设行业页面、自由低代码设计器、AI Agent 或大量 Connector。完整可用 Kernel 仍按 4–6 人、6–8 个月估算。
