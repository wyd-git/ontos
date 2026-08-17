# CI 变更风险路由运行手册

## 1. 目标

`Foundation Gate` 保持为 main 的唯一 Required Check，但不再让普通 Markdown 变更每次重跑约 35～45 分钟的 Materialization Clean-room。路由只减少与运行时无关的重复验收，不改变数据库、Identity、Policy、Worker、权限、供应链和 CI 自身的完整 Gate。

## 2. 路由结果

| 结果        | 典型输入                                                                             | 预期耗时    | 合并语义                               |
| ----------- | ------------------------------------------------------------------------------------ | ----------- | -------------------------------------- |
| `fast-docs` | `README.md`，以及 `docs/` 下非 `architecture/adr`、`evidence`、`reviews` 的 Markdown | 1～3 分钟   | 允许合并文档；不产生新 Clean-room 结论 |
| `full`      | 除上述路径外的任何变更，或分类不可信                                                 | 35～45 分钟 | 重生完整 G2-00/01/02 验收与 Clean-room |

`fast-docs` 仍执行：

1. `npm ci` 与固定 Node/npm 版本；
2. 全仓 Prettier；
3. 所有跟踪 Markdown 的本地链接存在性检查；
4. 全部 Unit Test，包括风险路由的故意绕过向量；
5. 全仓 Secret/Private Key Scan。

## 3. 必定完整 Gate 的变更

以下任一情况必定为 `full`：

- `apps/`、`packages/`、`tools/`、`migrations/`、`deploy/` 或任何可执行代码；
- `package.json`、`package-lock.json`、Workflow、Secret/证据机器策略；
- ADR、Gate Evidence、Review/Red-team 结论；
- 图片、JSON、Schema、Fixture 等非 Markdown 资产；
- 文档与代码混合变更；
- 重命名的任一端不属于快速路径；
- Base/Head 缺失、SHA 非完整小写 40 位、Diff 失败、空 Diff 或输出超上限；
- 每日定时和手动 Workflow。

路由器不接受 `force-fast`、Label、PR 正文、分支名或作者输入。

## 4. 如何查看结果

GitHub Job Summary 顶部显示 `Profile`、选择原因和 Changed File 数。Artifact 中至少有：

- `change-risk.json`：Base/Head、完整路径、触发完整 Gate 的路径和原因；
- `report.json` / `summary.md`：实际执行的 Gate、耗时、测试数和失败点；
- `fast-docs-evidence.json`：仅快速 Profile 产生，资格最高为 `FAST_DOCS_PASS`；
- `foundation-evidence-manifest.json`、`metadata-evidence-manifest.json`、`materialization-evidence-manifest.json`：只有完整 Profile 产生。

如果一个预期快速的 PR 显示 `full`，先查 `fullGateFiles`；这是保守结果，不应通过放宽路径来“修复”。如果一个高风险 PR 显示 `fast-docs`，立即停止合并，将分类器、Workflow 和该 PR Diff 作为 CI 安全事件审查。

## 5. 如何强制完整验收

- 本地：不设置 `ONTOS_CI_BASE_SHA` / `ONTOS_CI_HEAD_SHA`，直接执行 `npm run verify`；
- GitHub：手动触发 `Foundation CI`；
- 定时：每日 18:00 UTC（上海时间次日 02:00）自动完整执行。

不允许用手动输入强制 `fast-docs`。需要调整允许路径时，必须连同故意绕过测试一起修改，而该修改自身必定跑 `full`。

## 6. 已知边界

- 风险路由判断“文件是否可以影响运行时”，不判断文档观点是否正确；人工评审仍需要对 PRD/架构内容负责。
- 外部依赖或基础镜像可能在两次代码变更之间发生问题；每日完整 Gate 承担这一检测责任。
- `fast-docs` 不是 G2 阶段关闭证据；任何 Gate PASS 声明仍要求对应的完整、Commit-bound Manifest。
