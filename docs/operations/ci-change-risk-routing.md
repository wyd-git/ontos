# CI 变更风险路由运行手册

## 1. 目标

`Foundation Gate` 保持为 main 的唯一 Required Check。普通 Markdown 使用快速路径；高风险 Draft PR 先运行不能合并的 `Foundation Preflight`，转为 Ready 后再运行完整 `Foundation Gate`。路由只减少开发迭代中的重复 100k/1m 验收，不改变数据库、Identity、Policy、Worker、权限、供应链和最终资格 Gate。

## 2. 路由结果

| 结果        | 典型输入                                                                             | 预期耗时       | 合并语义                                                    |
| ----------- | ------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------- |
| `fast-docs` | `README.md`，以及 `docs/` 下非 `architecture/adr`、`evidence`、`reviews` 的 Markdown | 1～3 分钟      | Ready 后可满足文档 Required Check；不产生新 Clean-room 结论 |
| `preflight` | 可信 Draft PR 中除快速文档外的变更，且 Base/Head/Diff 完整                           | 约 6～10 分钟  | Check 名为 `Foundation Preflight`，不可合并、不可关闭 G2    |
| `full`      | Ready 高风险 PR、main 高风险 Push、定时/手动/本地默认，或任何分类不可信情况          | 约 30～50 分钟 | Check 名为 `Foundation Gate`，重生完整资格与 Clean-room     |

`fast-docs` 仍执行：

1. `npm ci` 与固定 Node/npm 版本；
2. 全仓 Prettier；
3. 所有跟踪 Markdown 的本地链接存在性检查；
4. 全部 Unit Test，包括风险路由的故意绕过向量；
5. 全仓 Secret/Private Key Scan。

`preflight` 执行完整 Profile 中除以下四项外的 40 道 Gate：

1. `materialization-clean-room`；
2. 依赖该运行产物的 `g2-03-07-query-evidence`；
3. 依赖该运行产物的 `materialization-scope-evidence`；
4. 依赖同一 100k/1m PostgreSQL Spike Artifact 的 `g2-03-01-architecture-evidence`。

它仍覆盖 Lint、TypeScript、全部 Unit、合同生成、Query Compiler 单元与边界测试、容量薄切片、真实 PostgreSQL Migration/回滚/RLS、Runtime OIDC/DPoP/双进程 Replay、Query Lease/GC、Worker/DDL、Metadata Clean-room、供应链和生产边界 Smoke。缺失的四项只允许由 Ready PR 的完整 Gate 补齐。

## 3. 必定完整 Gate 的变更

以下任一情况即使 PR 标记为 Draft，也必定 Fail Closed 为 `full`：

- Base/Head 缺失、SHA 非完整小写 40 位、Diff 失败、空 Diff 或输出超上限；
- GitHub 事件不是受信 `pull_request`，或者 `draft` 值不是精确的 `true`；
- 每日定时和手动 Workflow。

代码、Migration、Workflow、证据策略和 ADR 等高风险路径在可信 Draft 中只能降为 `preflight`，不能降为 `fast-docs`。路由器不接受 `force-fast`、Label、PR 正文、分支名或作者输入。

## 4. 如何查看结果

GitHub Job Summary 顶部显示 `Profile`、选择原因和 Changed File 数。Artifact 中至少有：

- `change-risk.json`：Base/Head、完整路径、触发完整 Gate 的路径和原因；
- `report.json` / `summary.md`：实际执行的 Gate、耗时、测试数和失败点；
- `fast-docs-evidence.json`：仅快速 Profile 产生，资格最高为 `FAST_DOCS_PASS`；
- `preflight-evidence.json`：仅预检产生，资格最高为 `PREFLIGHT_PASS`，且 `closesG2Gate=false`；
- `foundation-evidence-manifest.json`、`metadata-evidence-manifest.json`、`materialization-evidence-manifest.json` 与 `g2-03-01`～`g2-03-07` Manifest：只有完整 Profile 产生。

如果一个预期 Draft 预检显示 `full`，先查 Base/Head、事件和 `fullGateFiles`；这是保守结果，不应通过放宽路径来“修复”。如果一个 Ready 高风险 PR 显示 `preflight` 或 `fast-docs`，立即停止合并，将分类器、Workflow 和该 PR Diff 作为 CI 安全事件审查。

## 5. 如何强制完整验收

- 本地：不设置 `ONTOS_CI_BASE_SHA` / `ONTOS_CI_HEAD_SHA`，直接执行 `npm run verify`；
- GitHub：手动触发 `Foundation CI`；
- 定时：每日 18:00 UTC（上海时间次日 02:00）自动完整执行。

本地 `npm run verify:preflight` 只能产生非资格工作树报告，建议在干净 Commit/Worktree 上使用；代码显式禁止在 GitHub Actions 中使用该参数。GitHub Draft/Ready 路由只读取 Workflow 注入的事件对象，不允许用手动输入强制 `preflight` 或 `fast-docs`。需要调整路由时，必须连同故意绕过测试一起修改，且 PR 转为 Ready 后仍必定跑 `full`。

## 6. 已知边界

- 风险路由判断“文件是否可以影响运行时”，不判断文档观点是否正确；人工评审仍需要对 PRD/架构内容负责。
- 外部依赖或基础镜像可能在两次代码变更之间发生问题；每日完整 Gate 承担这一检测责任。
- `fast-docs` 不是 G2 阶段关闭证据；任何 Gate PASS 声明仍要求对应的完整、Commit-bound Manifest。
- `preflight` 也不是 G2 阶段关闭证据；Draft PR 本身不可合并，分支保护所需的 `Foundation Gate` 只在 Ready 后出现。
- 第一版优化不复用 PR Artifact，也不缩短 main、定时或手动全量运行；main 重复验收优化必须另行证明 Tree/Manifest 绑定后才能启用。

## 7. 上线后快速路径核对清单

第一次上线以及以后每次修改路由规则时，使用一个只改本运行手册的独立 PR 做端到端核对：

1. `change-risk.json` 的 `profile` 必须为 `fast-docs`，且 `changedFiles` 只包含预期 Markdown；
2. 报告必须且只能执行六项快速 Gate，不能出现 Materialization、PostgreSQL 或生产环境启动步骤；
3. `fast-docs-evidence.json` 必须为 `FAST_DOCS_PASS`，并绑定该 PR Head Commit；
4. Artifact 不得包含新生成的 Foundation、Metadata 或 Materialization Clean-room Manifest；
5. 同一 PR 若混入代码、ADR、Evidence、Review、Workflow 或机器策略，路由测试必须证明结果立刻变为 `full`。

只有以上五项同时成立，才能把快速路径视为已完成真实 GitHub 验证；本地单元测试不能替代这次远端事件上下文验证。

## 8. Draft → Ready 预检核对清单

每次修改预检规则时，用一个包含代码或机器策略的 Draft PR 验证：

1. Draft Check 名称必须为 `Foundation Preflight`，Profile 为 `preflight`，只能运行 40 项；
2. Artifact 必须有 `preflight-evidence.json=PREFLIGHT_PASS`、`closesG2Gate=false`，且不得出现任何新的 G2 Clean-room Manifest；
3. main 的 Required Check `Foundation Gate` 必须仍为缺失，Draft 也必须保持不可合并；
4. 转为 Ready 后必须在同一 Head 上新建 `Foundation Gate`，Profile 为 `full`，运行完整 44 项；
5. 只有完整 Manifest 全部绑定当前 clean checkout 后才允许合并；再次转为 Draft 必须恢复 `Foundation Preflight`，再次 Ready 必须重跑 full。
