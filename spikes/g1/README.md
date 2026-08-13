# Ontology Kernel G1 Spikes

这是 Ontology Kernel PRD 的 G1 可行性验证工程，不是生产实现，也不依赖工作区中的任何现有实验项目。

G1 最终结论为 **GO — 进入 G2 Kernel 实现**。这表示 A–D 高风险架构门禁已通过，不表示产品已经可上线。完整结论见 [G1 可行性报告](docs/g1-feasibility-report.md)，下一阶段约束见 [G2 实现准入](docs/g2-implementation-readiness.md)。

验证范围：

- Spike A：通用对象查询、索引和有限 Query AST；
- Spike B：Base Snapshot、Overlay、冲突和原子切换；
- Spike C：同一 Policy 在不同入口的一致性；
- Spike D：两个结构不同的领域包不修改核心引擎。

## 原则

1. 四个 Spike 共用同一对象身份、Query、Policy 和 Action 数据模型。
2. 使用固定种子生成 100k Objects / 1m Links，基准结果可复现。
3. 只验证会改变 Go/No-Go 判断的技术风险，不建设产品 UI。
4. 所有通过结论必须附命令、环境、原始指标和查询计划。
5. Spike 代码不能出现报销或其他现有实验项目的领域特例。

## 目录

```text
spikes/g1/
├── docs/                 # 技术任务书与决策
├── evidence/             # 运行证据模板；大体积原始结果不提交
├── packages/             # Spike D 的两个领域包
├── scripts/              # 可重复执行入口
├── sql/                  # PostgreSQL Schema、Fixture 和验证 SQL
├── src/                  # Query/Policy/Overlay/Package 原型
└── test/                 # 纯逻辑与数据库集成测试
```

## 本地前置条件

- Node.js 22 或更高；
- PostgreSQL 16 或更高，或 Docker；
- `psql` 命令行工具。

默认本地数据库 URL：

```text
postgresql://ontology_spike:ontology_spike@127.0.0.1:55432/ontology_spike
```

可通过 `ONTOLOGY_SPIKE_DATABASE_URL` 覆盖。该凭据只用于本机一次性 Spike 容器，不得用于任何共享环境。

## 命令

```bash
npm test
npm run packages:validate
npm run db:up
npm run db:init
npm run spike:a
npm run spike:a:index-cost
npm run spike:a:sustained
npm run spike:b
npm run spike:b:scale
npm run spike:b:cutover
npm run spike:c
npm run spike:d
npm run db:down
```

`db:down` 默认保留数据库 Volume，避免误删证据。确需清空时使用单独的显式 reset 流程。

全部 Gate 可用一个入口重现：

```bash
sh scripts/run-g1-gates.sh
```

该脚本会两次重建且仅重建专用的 `ontology_spike` 数据库数据：第一次验证冲突与故障注入，第二次生成干净的 100k Objects / 1m Links 规模证据。默认持续负载时长为 1,800 秒，可用任务专用变量 `G1_SUSTAINED_SECONDS` 覆盖。

## 实现边界

这个仓库已包含可执行的 Query Compiler、Base/Overlay Materializer、Policy Gateway 和 Package Release Store，但仍是 G1 技术验证，不是可部署产品。未包含 HTTP API、OIDC、生产任务队列、管理 UI、备份恢复和多租户隔离。

## Gate

详细通过标准见 [G1 执行章程](docs/g1-execution-charter.md)。任何单项失败都不会被解释为“基本通过”；应记录失败原因、修改假设后重跑，或给出 No-Go。
