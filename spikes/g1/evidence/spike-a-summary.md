# Spike A 最终证据摘要

- 判定：PASS
- 基线：100,000 Active Objects、1,000,000 Active Links
- 查询语料：10 类通用 AST；Primary Key、属性过滤/排序、Policy Predicate、前缀/包含、数组、聚合、一跳和两跳

## 持续负载

- 运行：1,800 秒，目标 20 RPS
- 请求：36,000 成功 / 36,000，错误率 0
- 实际吞吐：20.0001 RPS
- 客户端端到端 P95：27.124–42.487 ms
- 客户端模式：每次请求新建一个本地 `psql` 进程和连接，未使用连接池
- 未提交原始路径：`raw/2026-08-13T050251.190Z-spike-a-sustained/result.json`
- SHA-256：`4ed89e89aa70ae60297c4c38a03ee39c779dd197b2564a3667619228985a0573`

持续运行之后，Traversal 改为必须显式提供 Link Policy。修改前后的 SQL、参数与参数类型执行摘要均为 `8d909ca1510e040ee040af98932d21d4f9d08a45433b1abe9d90f9bb07cb3681`，所以性能运行对应相同的数据库工作负载；安全语义由最终单元和 Spike C 另行验证。

- 未提交修复后语料路径：`raw/2026-08-13T054943.000Z-query-corpus-final/query-corpus.json`
- SHA-256：`99beff2b26fc68d861188094c05e416bffbab3dc2e71d3a5cbb35e12a04a2f33`
- 修复后 Compiler Output Digest：`81f2d8091f7edc12a8d92375642b77fd0f842fe0fd3f28693ff3887c3c814f62`

## 查询计划采样

- PostgreSQL 内部 P95：0.060–3.759 ms
- 所有 10 类查询均通过阈值
- 无无法解释的 Sequential Scan
- 每类保存 15 次样本及 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
- 未提交原始路径：`raw/2026-08-13T054249.807Z-spike-a/result.json`
- SHA-256：`5c2acc585e7dc041ff3e90b53283a53a98a34f9f234c6cab5f64c994e2f299ea`

## 索引成本

- 物理 200,000 Object rows：Heap 113,131,520 bytes；Indexes 151,117,824 bytes
- 物理 2,000,000 Link rows：Heap 233,906,176 bytes；Indexes 544,129,024 bytes
- 100k 写入中位数：Identity-only 387.298 ms；Metadata-indexed 1,384.235 ms
- 写入时间比：3.574×
- 未提交原始路径：`raw/2026-08-13T054109.171Z-spike-a-index-cost/result.json`
- SHA-256：`7b39f705e61d1b7d97bc0fb3d2acb5b546de61d4a473585007fc5eb452730201`

结论不是“可以给所有 Property 建索引”，而是有限 Query AST + 由元数据显式选择索引可行。G2 必须限制 `filterable/sortable/searchable` 字段并实现旧 Generation GC。
