# Ontos

Ontos 是 **Ontology Kernel** 的正式主仓库。目标是在不复制 Palantir 完整产品面的前提下，实现一个可生产化、可跨领域复用的 Object / Link / Function / Action / Policy Kernel。

当前状态：

- G1 技术可行性验证：**PASS**；
- G2 生产实现蓝图：**已完成，待红队冻结**；
- 正式产品实现：**尚未开始**；
- 下一 Gate：**G2-00 Foundation**。

## 权威文档

| 文档 | 作用 |
|---|---|
| [产品需求文档](docs/product/ontology-kernel-prd.md) | P0/P1/P2 范围、产品语义和 AC-01～AC-10 |
| [生产实现蓝图](docs/product/ontology-kernel-implementation-blueprint.md) | 工程结构、模块、数据、事务、状态机和 Gate |
| [G1 可行性报告](spikes/g1/docs/g1-feasibility-report.md) | 已验证结论、性能和限制 |
| [G1 架构决策](spikes/g1/docs/architecture-decisions.md) | G2 不可违反的存储、查询、Policy 和 Package 决策 |
| [G2 实现准入](spikes/g1/docs/g2-implementation-readiness.md) | 第一条生产纵向切片及退出条件 |

文档之间冲突时，先按版本和状态判断；仍无法判断则停止实现并用 ADR 明确，不在代码中自行选择语义。

## 仓库结构

```text
ontos/
├── docs/                       # 产品、架构、交付和运行文档
│   └── product/                # PRD 与生产实现蓝图
├── spikes/
│   └── g1/                     # G1 可复现代码、测试和精简证据
├── apps/                       # G2-00 后建立：API/Worker/Handler Host/Web/CLI
├── packages/                   # G2-00 后建立：Kernel 模块与公共合同
├── migrations/                 # G2-00 后建立：前向数据库迁移
└── deploy/                     # G2-00 后建立：本地与单区域部署
```

现在不存在的正式工程目录不会为了“看起来完整”而提前放空文件；它们在对应任务进入开发并具备 Owner、合同和验收时创建。

## 范围边界

- 当前产品范围是 PRD 的 P0 Kernel Alpha，不是 Palantir Foundry/Gotham/AIP 的完整复制品。
- Data Connections/Pipeline、Durable Automation、AI、Marketplace、多租户和多区域属于后续范围。
- `spikes/g1` 只复用算法、SQL 结论、Fixture 和测试向量，不直接作为生产代码上线。
- 旧实验项目不进入本仓库，也不作为产品架构前提。
- 第二领域只能通过 Manifest、Definition、Handler 和 View 扩展，不能修改 Kernel 核心分支。

## 工作方式

1. PRD 与蓝图定义意图；ADR 冻结实现决策。
2. 每项工作使用 Why–What–Acceptance，并标明依赖、测试和 Gate 证据。
3. Runtime 新入口必须通过同一 Policy 测试向量。
4. 文档要求与实现代码在每个 Gate 进行 Intended-vs-Implemented 核验。
5. 只有可复现的测试、性能、故障和恢复证据可以使 Gate 通过。

后续改动使用短生命周期分支和 Pull Request；`main` 只保留已经通过对应检查的基线。

## G1 本地复现

```bash
cd spikes/g1
npm test
npm run packages:validate
npm run db:up
npm run db:init
sh scripts/run-g1-gates.sh
```

前置条件和完整命令见 [G1 README](spikes/g1/README.md)。100k Objects / 1m Links 的完整持续负载会消耗较长时间，不应作为每次普通提交的快速检查。

## 安全与生成物

这是私有仓库，但仍按可公开审计的标准管理：

- 不提交 `.env`、Token、私钥、生产连接串或真实业务数据；
- G1 的 `evidence/raw/` 可能包含主机环境信息，默认不提交；
- 可评审结论进入精简 Evidence Summary，并记录内容 Hash；
- 示例数据库凭据只能绑定本机一次性容器，不能用于共享环境。
