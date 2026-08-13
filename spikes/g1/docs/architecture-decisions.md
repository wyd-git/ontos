# G1 架构决策记录

本文档只记录已经通过可执行验证的决策。它们是后续 Kernel 实现的边界，不代表产品已完成。

## ADR-01：查询只面向 Current Projection

- 状态：Accepted for Kernel V1。
- 决策：Object Query 和 Link Traversal 只读活动 Generation 的 `object_current` / `link_current`，不在请求时动态拼接外部数据源。
- 理由：有限 AST、类型化参数、Policy Predicate 和按元数据生成的索引在 100k Objects / 1m Active Links 上达到交互延迟。
- 结果：查询延迟可预测，但非活动 Generation 的保留时间会直接影响索引容量，必须定义 GC 策略。G1 中六个元数据二级索引使 100k 对象批量写入的中位耗时约放大 4.31×，所以 Builder 必须显式限制可查询/可搜索字段，不得为每个 Property 自动建索引。

## ADR-02：Base 与 Overlay 是事实，Current Projection 可重建

- 状态：Accepted for Kernel V1。
- 决策：Base Snapshot 和 Overlay Operation 不可变；Current Projection、Conflict 和索引是可重建产物。
- 理由：同属性变化、异属性合并、来源删除、身份碰撞、Clear/Remove Override 和 Tombstone/Restore 需要明确而不是 Last-write-wins 语义。
- 结果：存储量增加，但业务写回不会被来源刷新静默覆盖。

## ADR-03：全量物化由 Worker 编排，数据库过程只做 Catch-up

- 状态：Accepted for Kernel V1。
- 决策：Materializer Worker 用幂等分阶段事务生成不可见的 Staging；数据库过程只处理 Cutover Lock 内的小型 `W0..W1` 受影响对象集。
- 理由：PostgreSQL 对“整代”与“几个受影响对象”使用同一存储过程时会出现泛化计划抖动。分离后冷执行从 30–46 秒稳定到秒级。
- 结果：Worker 必须具有重试、心跳、状态机和孤儿 Staging GC；不得把全量重建重新放回一个长事务。
- 切换约束：`object_heads` 只更新业务版本、生命周期或冲突状态真实变化的行。无条件重写 100k Heads 的 20 次 Cutover P95 为 1.768 秒；条件更新后最终 P95 为 408.5 毫秒。

## ADR-04：Policy Gateway 是唯一运行入口

- 状态：Accepted for Kernel V1。
- 决策：Object API、SDK、Function、Action Target、Export、Automation 和 AI Tool Adapter 共用同一 Gateway；Row Predicate 进入 SQL，Property Mask/Deny 在编译和返回阶段双重执行。
- 理由：任何入口各自做过滤都会产生计数、Link、错误和日志旁路。
- 结果：Handler 和 Adapter 不得获得裸数据库连接。V1 若增加 Policy 正向缓存，必须重跑 5 秒撤权 Gate。
- Fail-closed：Object Policy Resolver 与 Link Policy Resolver 都是 Gateway 必选依赖；缺失 Link Policy 不允许退化为默认可见。

## ADR-05：Package 发布不原地修改

- 状态：Accepted for Kernel V1。
- 决策：Manifest、Action Definition 和 Handler Digest 按 Release Revision 不可变保留；升级和回滚都创建新 Revision。
- 理由：历史 Action 必须能解析到执行时的原 Handler，回滚不能改写历史。
- 结果：需要 Artifact 保留和容量策略；Package 不得携带 Raw SQL、Kernel Migration、自定义 Endpoint 或 Query Operator。

## ADR-06：Timestamp 在边界处规范化

- 状态：Accepted with a G2 implementation choice。
- 决策：进入 Current Projection 的 Timestamp 必须先转为 UTC、六位小数秒、固定宽度 RFC 3339 形式；Query Compiler 使用相同规范化。G2 可选择继续索引该规范文本，或在 Projection 中增加受控的类型化列。
- 理由：PostgreSQL 不允许直接为 `json text → timestamptz` 的非 IMMUTABLE 转换建表达式索引；未规范化的文本比较又不具备时间顺序语义。
- 结果：Snapshot Mapping 和 Action Mutation Validator 必须拒绝未规范化的 Timestamp。这项选择必须在 G2 数据库 Schema 冻结前完成，不能留给查询层猜测。
