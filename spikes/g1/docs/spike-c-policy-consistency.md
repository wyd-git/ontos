# Spike C：Policy 跨入口一致性

## 假设

Resource/Object/Property/Link/Action Policy 可以由一个 Policy Gateway 统一执行，UI、API、SDK、Function、Action 与未来 Tool Adapter 不需要各自实现过滤。

## Actor Fixture

- `actor_all`：可查看全部对象和 Property；
- `actor_region_east`：只可查看 `region=EAST`；
- `actor_masked`：可见对象，但 `sensitiveCode` 为 deny、`amount` 为 mask；
- `service_reader`：只读服务身份；
- `delegated_east`：Service 与 `actor_region_east` 权限交集。

## 入口

- Object Get/Search/Aggregate；
- Link Traversal；
- SDK Adapter；
- Function Context；
- Action Target Loader；
- Export Adapter Harness；
- Automation Adapter Harness；
- AI Tool Adapter Harness。

这些入口必须调用同一个 Gateway；Harness 只模拟协议，不实现后续 Automation/AI 产品。

## 泄露测试

- 猜测 Primary Key/objectRid；
- 用 deny Property 过滤、排序或分组；
- 通过 Aggregate 推断不可见对象；
- 通过 Link 数量推断不可见目标；
- 通过错误 Detail、Mutation Preview 和日志泄露；
- On-behalf-of 被 Service 权限扩大；
- Policy Cache 在撤权后继续放行；
- Prompt/Tool Fixture 出现受限字段。

## 通过条件

- 共享向量在所有入口 100% 同结果；
- Object Policy 出现在 SQL Query Plan 之前；
- deny Property 不出现在响应实例、日志或工具结果；
- mask Property 不可用于客户端过滤/排序/聚合；
- Action 无法修改不可见目标；
- 权限变更最迟 5 秒生效；
- 无特殊“内部 UI 绕过”入口。

## 交付物

- Policy AST 与 Compiler；
- Policy Gateway；
- 入口 Adapter Harness；
- 共享正反例向量；
- 日志捕获与泄露扫描；
- PASS/FAIL 结论。
