# G1 可行性验证执行章程

- 对应 PRD：`docs/product/ontology-kernel-prd.md` 第 27 节
- 状态：Executable
- 时间盒：3–5 周
- 目标：回答是否可以进入 Kernel 全面实现，而不是展示功能 Demo

## 1. 统一验证对象

所有 Spike 使用相同的 Kernel Core Contract：

```text
Resource Definition
→ Active Base Snapshot
→ Immutable Overlay Operations
→ Current Projection
→ Policy-aware Query
→ Planned Action Mutation
```

不得为某个 Spike 创建第二套对象表、身份模型或权限入口。

## 2. 固定环境

第一轮参考环境：

- PostgreSQL 16；
- 单实例、单区域语义；
- Node.js 22 原型；
- 5 个 Object Types；
- 100,000 个 Current Objects；
- 1,000,000 条 Current Links；
- 固定随机种子 `20260813`；
- 3 个 Actor Policy Context。

最终报告必须记录 CPU、内存、磁盘、PostgreSQL 参数、容器版本和 Git/内容 Hash。

## 3. 统一证据

每次有效运行必须保存：

- `environment.json`；
- `command.txt`；
- `result.json`；
- Query Spike 的 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`；
- 测试输出；
- Schema/Fixture Hash；
- 结论：PASS、FAIL 或 INVALID；
- 异常与偏差说明。

只保存人工摘录的平均数不构成证据。

## 4. 通过矩阵

| Spike | 必须回答 | 硬门槛 |
|---|---|---|
| A | 通用 AST 与按元数据生成索引是否达到交互性能 | 100k/1m 基线；核心 P95 达标；无领域 SQL |
| B | Base 刷新是否保留 Overlay 且原子切换 | 无静默覆盖；High-watermark Catch-up；全部冲突可追溯 |
| C | Policy 是否真正在所有入口统一 | 相同测试向量 100% 一致；无字段/数量/日志泄露 |
| D | 核心抽象是否跨领域 | 第二包不修改 Query/Action/Policy Core |

## 5. 执行顺序

1. 先固定 Schema、类型语义、对象身份和 Fixture。
2. A 与 B 并行验证读路径和状态模型。
3. C 复用 A 的编译器和 B 的对象状态，不再建旁路。
4. D 通过 Manifest 安装两个包，并重复 A–C 的最小用例。
5. 汇总失败，不在报告阶段调整阈值。

## 6. 无效结果

出现以下任一情况，本轮结果标记 INVALID，不能用于 Go：

- 数据量低于门槛却外推结论；
- 使用现有实验项目的专用表或 API；
- 基准没有预热说明或并发说明；
- Policy 只在返回结果后过滤；
- Base/Overlay 测试跳过并发写入；
- 第二领域通过修改核心条件分支实现；
- 失败用例被删除而不是解释。

## 7. 决策规则

- A–D 全部 PASS：G1 Go。
- 任一项 FAIL 但存在明确、有限的架构修正：修正后完整重跑受影响项。
- 任一项依赖领域特例、安全旁路或不可接受的运维复杂度：G1 No-Go。
- 未获取足够证据：保持 Conditional Go，不得进入全面实现。
