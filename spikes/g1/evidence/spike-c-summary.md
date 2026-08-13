# Spike C 最终证据摘要

- 判定：PASS
- 基线：100,000 Active Objects、1,000,000 Active Links
- 入口：Object API、SDK、Function Context、Action Target、Export、Automation、AI Tool

## 结果

- 7 个入口共用同一 Policy Gateway
- 38 次真实数据库执行；42 条脱敏审计事件
- Search、Aggregate、Traversal 在全部入口结果一致
- Row Predicate 进入 SQL；EAST Actor 聚合 5,000，Service Actor 聚合 20,000
- Mask 返回非业务 `null`；Deny 字段不可选择、过滤或聚合
- 猜测不可见 Object ID 无法绕过 Action Target Policy
- Link Policy 必须显式解析，缺失时 fail closed
- Delegation 使用 Service 与 User 的交集
- 撤权生效延迟 0.115 ms（本 Spike 不使用正向缓存）
- Audit 不含原始敏感值或被拒字段名

未提交原始路径：`raw/2026-08-13T054133.049Z-spike-c/result.json`
SHA-256：`45f6c7bdbfef31372fbdd0bf918e53337efae7f474e9fd17c30996e84dcfe155`

结论：统一 Policy 路径可行。G2 不得向 Adapter、Function 或 Handler 暴露裸数据库连接；若引入 Policy 正向缓存，必须重跑撤权门禁。
