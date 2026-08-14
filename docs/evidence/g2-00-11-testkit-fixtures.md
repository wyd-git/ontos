# G2-00-11 正式 Testkit 与 G1 迁移 Gate 验收记录

- 结论：**PASS（仅限 G2-00-11 正式测试资产与本地 Gate）**
- 执行日期：2026-08-14
- 分支：`agent/g2-00-11-testkit-fixtures`
- 起始 Commit：`5a7fde861bef2cc8fca374470e5b644b9bb57ac7`
- 工具：Node.js 24.18.0 / npm 11.16.0 / TypeScript 6.0.3
- 环境：macOS 26.5.2（Build 25F84）arm64

本记录对应 [G2-00-11 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-11迁移-g1-fixture生成器和测试向量到-testkit)。最终实现 Commit 由 PR Head 记录，避免在被提交文件中写入自身 Commit Hash。

## 1. 验收映射

| WWA 声明                                                           | 实现证据                                                                               | 执行证据                                                          | 结果 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---- |
| 固定 Seed 生成小型集与 100k Object / 1m Link，不提交大文件         | `DATASET_PRESETS`、纯 Iterable Generator、Small Digest、Fixture 动态体积扫描           | Small 50/100；Benchmark 100,000/1,000,000；流式首尾与计数测试通过 | PASS |
| 两包各至少 5 Object Types、5 Links、3 Actions、2 Policies、2 Views | `fixtures/packages/commerce.v1.json`、`work-management.v1.json`                        | 两包资源计数均为 5/5/3/2/2；与 G1 Source JSON 语义等价            | PASS |
| 每组记录来源、原冻结指纹和有意转换                                 | `fixtures/provenance.json` 的 6 个 Group、Source/Target SHA-256、Transform             | 6 个 Group Digest、11 个 Source 记录和 7 个正式 Target 全部复验   | PASS |
| Testkit 不运行时导入 G1，Fixture/Vector 正式复制                   | `@ontos/testkit` 只导入 Node 内建并读取自身 Fixture；无 Runtime Dependency             | Architecture PASS；Asset Loader 和 8 个 Testkit 专项测试通过      | PASS |
| 生产 `apps/packages` 不能导入 G1                                   | `forbiddenRepositoryImportRoots`；全 Workspace Import 与 `file:/link:` Dependency 检查 | `src`、包根和 `file:` 三种故意违规均产生阻断错误                  | PASS |
| 测试无 G1 Evidence、个人路径、固定端口和示例密码依赖               | Testkit Fixture 扫描；Generator/Loader 无数据库、网络或 Evidence 读取                  | 7 个正式资产动态扫描通过；全 Testkit 在纯 Node 中完成             | PASS |
| G1 原始冻结指纹可独立复验                                          | 与 G1 原脚本同构的 path+NUL+bytes+NUL Audit                                            | 47 文件，`sha256:dff360...aa1`，6 个 Group 全部 PASS              | PASS |

## 2. 冻结资产与协议

### 2.1 正式 Testkit

- Workspace：`@ontos/testkit`，Layer 为 `testkit`，无 Runtime Package Dependency；
- Package Fixture：Commerce 与 Work Management，JSON 语义与 G1 源一致；
- Query Corpus：10 个 Search/Aggregate/Traversal Case，G1 阈值仅为参考元数据；
- Overlay/Conflict：9 个 Case，覆盖同/异属性基线变化、Source Removed、Clear/Remove Override、Tombstone/Restore、Identity Collision、Catch-up 和 Provenance-only Change；
- Policy：8 个 Case，覆盖 Delegation Intersection、七入口一致性、Deny/Mask Sanitizer、Action Target、Traversal、Link Denial 和 Pagination；
- Package Compatibility：8 个 Case，覆盖可空新增、PK/删除、Raw SQL、历史 Pin/Rollback、Breaking 拒绝、多资源 Breaking、Handler Digest 和双领域 Runtime Bridge。

### 2.2 生成协议

- 默认 Seed：`seed-20260813`；
- Small：50 Objects / 100 Links；Digest `sha256:c880db0bcab4a4bacff483928f3e6b6d58ade6cca4833c9220b5e3632f8d89f9`；
- Benchmark：100,000 Objects / 1,000,000 Links；完整流式遍历，不创建数组或输出文件；
- 默认 Seed 保持 G1 的 ID、状态、时间、金额、区域、Tag 和 Link 端点公式；额外 Seed 通过稳定 SHA-256 Offset 生成另一组可重复数据。

### 2.3 Provenance 与禁线

- G1 整体：47 个可执行输入，`sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1`；
- 六组：Generator、Packages、Query、Overlay、Policy、Compatibility；
- 每组同时冻结 Source、Group、正式 Target 和 Intentional Transform；
- Architecture Checker 扫描整个 Workspace 源文件，排除 `node_modules/dist/build/coverage/generated`，并拒绝相对/绝对/`file:` Import 与 `file:/link:` Manifest Dependency 指向 `spikes/g1`；
- Production Layer 继续不能依赖 `@ontos/testkit`。

## 3. Red-Team 与 Intended-vs-Implemented

[专项审查](../reviews/g2-00-11-testkit-red-team.md)在 PASS 前实际发现并修正：

1. 初版 G1 禁线只扫描 `src/`，包根入口可绕过；现扫描整个 Workspace；
2. 初版没有拦截 `file:../../spikes/g1` Manifest Dependency；现解析并阻断 `file:`/`link:` Repository Dependency；
3. 初版 Provenance 只冻结 Source，正式 Target 可静默漂移；现每个 Target 都有 SHA-256，两个 Manifest 另做 JSON 语义等价核验；
4. 初版大文件/本地配置检查只遍历写死的资产列表；现递归扫描 Fixture 目录，并固定正式资产数量和总体积上限。

审查后没有仍未关闭、且属于 G2-00-11 范围的 Intended-vs-Implemented 偏差。

仍开放但不阻断本任务：

- 后续生产模块消费这些 Vector 的 Contract/Integration 接线：Owner 为对应 Runtime 模块 Owner，随模块实现验收；
- 远端 Required Check、分支保护和 CI Artifact：Owner 为 Platform / Quality，Gate 为 G2-00-12；
- 不同执行环境的正式性能阻断预算：Owner 为 Runtime / Quality，在容量与性能 Gate 冻结。

## 4. 可复现执行

### 4.1 全仓 Gate

```text
nvm use 24.18.0
npm run verify

check:toolchain            PASS — node 24.18.0 / npm 11.16.0
format:check               PASS
lint                       PASS
typecheck                  PASS
test:unit                  PASS — 189/189
check:architecture         PASS — 3 packages / 20 source files
check:contracts            PASS — 11 Foundation / 16 stable error codes / 5 deferred families / 30 Golden cases
check:testkit-provenance   PASS — 47 G1 inputs / 6 migrated groups / sha256:dff360...aa1
```

### 4.2 专项与故意失败 Gate

```text
npm run test:testkit
PASS — 8/8

node --test tools/architecture/check-workspace.test.ts
PASS — 12/12
```

Architecture Negative Fixtures 明确证明：Production → Testkit、`src` → G1、包根 → G1、Manifest `file:` → G1 均不可通过。

### 4.3 冻结摘要

```text
dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1  G1 executable inputs (47 files)
c880db0bcab4a4bacff483928f3e6b6d58ade6cca4833c9220b5e3632f8d89f9  Small generated dataset
adf64704cd210786030acf7591820b5a3304d00d471c2a9b38cc17f2b215244c  package-lock.json
38784e3b561d8dc1e51f8dffabb9a5d96c19bd5ccc4e533bb2b72054bd75ac46  tools/architecture/policy.json
```

单个 Source、Group 与正式 Target 摘要保存在 `packages/testkit/fixtures/provenance.json`。任何生成公式、正式 Fixture/Vector、来源记录或禁线策略变化都必须更新 Catalog、测试和本 Evidence。

## 5. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-12～13 仍未完成。
- Testkit 提供正式输入和期望，不实现 Query Compiler、Overlay Engine、Policy Gateway、Package Release Store 或任何业务 Runtime。
- G1 的 Compose、SQL 执行器、固定端口、数据库账号、性能报告和原始 Evidence 没有进入正式 Testkit。
- G1 参考延迟不是跨机器 SLO，当前不宣称生产性能达标。
- 本地 Gate 尚未等于不可绕过的远端分支保护；该接线属于 G2-00-12。
