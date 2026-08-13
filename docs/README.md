# 文档索引与权威顺序

本目录保存 Ontology Kernel 的产品意图、架构决策、实施任务、Gate 证据和运行说明。

## 当前权威文档

1. [Ontology Kernel PRD](product/ontology-kernel-prd.md)：产品能力、范围、语义和最终验收。
2. [G2 生产实现蓝图](product/ontology-kernel-implementation-blueprint.md)：从 PRD 到工程的实现约束。
3. [G2 蓝图红队审查](reviews/g2-blueprint-red-team.md)：承重假设、验证、Kill Criteria 和 Conditional Go 结论。
4. [G2-00 Foundation 任务包](delivery/g2-00-foundation-task-pack.md)：当前唯一获准执行的 Gate 清单。
5. [G2 工具链基线](architecture/toolchain-baseline.md)与 [Monorepo 依赖边界](architecture/dependency-boundaries.md)：G2-00-01 的已接受工程约束。
6. [本地生产边界架构](architecture/local-production-boundaries.md)与 [运行手册](operations/local-production-boundary-environment.md)：G2-00-02 的协议、信任和生命周期边界。
7. `architecture/adr/`：编码前逐项冻结的实现决策；只有 Accepted ADR 可以覆盖蓝图中的建议性技术选择，不能静默改变 PRD 产品语义。
8. `delivery/`：任务、依赖、Gate 状态与风险；不能反向扩大 PRD 范围。
9. `evidence/`：可复现的 Gate 报告；当前记录包括 [G2-00-01](evidence/g2-00-01-toolchain-boundaries.md) 与 [G2-00-02](evidence/g2-00-02-local-production-boundaries.md) 验收记录，证据不等于新的产品需求。

## 计划目录

```text
docs/
├── product/                    # PRD、蓝图和正式范围变更
├── reviews/                    # 红队、可行性和专项评审
├── architecture/adr/           # ADR-007 起
├── delivery/                   # G2 Backlog、状态、风险和决策日志
├── api/                        # OpenAPI 使用与版本兼容说明
├── operations/                 # 部署、备份、恢复、GC 和事件处置
├── security/                   # 权限、信任边界、Secret 和专项测试
└── evidence/                   # G2 及之后的 Gate 证据
```

目录在出现第一个真实文档时创建，避免空目录制造虚假的完成感。

## 变更规则

- PRD 范围变化必须说明 P0/P1/P2 影响和验收变化。
- 架构偏离蓝图必须新增 ADR，并说明迁移、兼容、运维和回退/向前恢复影响。
- 文档内的待办不能当作已经实现；实现状态只由代码、测试和 Gate Evidence 决定。
- 每个 Gate 执行 Intended-vs-Implemented 核验，逐条引用文档声明与代码/测试证据。
