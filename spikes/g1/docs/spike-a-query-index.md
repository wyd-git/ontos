# Spike A：通用 Query 与索引

## 假设

有限 Query AST、Current Projection 和按 Ontology 元数据生成的索引，可以在单 PostgreSQL 实例上支撑 V1 基线，而不需要领域专用 SQL。

## 实现范围

- 类型化 `eq/ne/lt/lte/gt/gte/in/isNull/contains/prefix/containsAny`；
- `and/or/not`，深度与 Predicate 数限制；
- 一个业务排序字段 + Primary Key Tie-breaker；
- Keyset Cursor；
- `count/sum/avg/min/max` 与单字段 Group；
- 一跳、两跳 Link Traversal；
- Object Policy Predicate 在 SQL 前注入；
- Property allow/mask/deny；
- 按属性元数据生成索引计划。

## 数据

五类对象各 20,000 条，共 100,000：

- `EntityA`：关系密集，含 enum、timestamp、boolean；
- `EntityB`：数值密集，含 decimal、region；
- `EntityC`：文本搜索；
- `EntityD`：高/低选择性组合；
- `EntityE`：用于两跳目标。

Links 共 1,000,000 条，分布包含高基数节点，防止只验证均匀理想数据。

## Query Corpus

至少包含：

1. Primary Key Get；
2. enum + timestamp 过滤排序；
3. region Policy + 状态过滤；
4. prefix/contains；
5. numeric range；
6. 一跳分页；
7. 两跳受限展开；
8. Policy 后 count；
9. 单 enum Group；
10. 不可查询 Property 拒绝；
11. SQL Injection Payload 拒绝；
12. Cursor Context 改变拒绝。

## 指标

- Get P95 < 300 ms；
- 常用列表 P95 < 1 s；
- 一跳 P95 < 300 ms；
- 两跳 P95 < 1.5 s；
- Aggregate P95 < 2 s；
- 30 分钟混合负载错误率 < 0.1%；
- 未解释的全表扫描为 0。

## 交付物

- Query AST Compiler 与单元测试；
- Schema Registry Fixture；
- PostgreSQL Schema 与生成索引；
- 固定 Query Corpus；
- Benchmark Runner；
- 原始 Explain/Timing；
- 索引存储和写入放大报告；
- PASS/FAIL 结论。

## 失败判定

- 需要为 EntityA–E 编写不同查询代码；
- Policy 只能在应用层后过滤；
- JSONB 单一索引无法达标，而元数据生成索引仍不可控；
- 两跳查询无法用复杂度限制稳定运行；
- 达标依赖远超目标部署边界的硬件。
