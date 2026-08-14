# G2-00-13 Foundation 集成 Gate 验收记录

- 结论：**PASS（G2-00 Foundation）**
- 执行日期：2026-08-14
- 分支：`agent/g2-00-13-clean-room`
- Clean-room Commit：`7c4aa88d20d45c8be1e77f86d472602c5b571f59`
- 起始 Main Commit：`5cf94fbe201730227e9b6e9789d7f522f7a453ef`
- 工具：Node.js 24.18.0 / npm 11.16.0 / Docker 29.6.1 / Docker Compose 5.2.0
- 环境：macOS arm64；远端最终 Gate 使用 GitHub `ubuntu-24.04`

本记录对应 [G2-00-13 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-13执行集成-gate-并冻结证据)。最终文档提交由 PR Head 和 GitHub Artifact 记录，避免在被提交文件中写入自身 Hash。

## 1. Clean-room 执行路径

使用 HTTPS 从公开的 `wyd-git/ontos` 重新浅克隆目标分支到新的临时目录，不复制当前工作树。执行前确认：

- `git status --porcelain=v1` 无输出；
- Head 精确为 `7c4aa88d20d45c8be1e77f86d472602c5b571f59`；
- 根目录不存在 `node_modules`、`generated` 或 `.env`；
- Node/npm 精确为 24.18.0/11.16.0。

正式顺序为：

```text
npm ci
npm run env:reset
npm run verify
npm run env:reset
```

首次探索性地在 `npm ci` 前执行 `env:reset`，因为环境工具尚未安装 `@aws-sdk/client-s3` 而明确失败；没有把失败尝试计为证据。它确认了文档必须把 bootstrap 放在所有环境命令前。完成 `npm ci` 后，前置 Reset 只删除固定 Compose 项目 `ontos-g2-local` 的三个测试卷；`verify` 从空卷创建服务并执行 Smoke；末尾 `env:down` 删除容器和网络；最终 Reset 再删除本轮三个测试卷。没有使用全局 Docker prune，也没有触碰其他项目数据。

## 2. 验收映射

| G2-00-13 条件                                     | 实现与执行证据                                                                                           | 结果 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- |
| clean checkout 无个人隐藏配置                     | 新 HTTPS Clone；无工作树改动/依赖/生成物/私有 `.env`；Manifest `cleanCheckout=true`                      | PASS |
| ADR-007～012 Accepted 且有可执行证据              | `security/g2-00-evidence-policy.json` 冻结 6 个 ADR/Evidence 对；机器逐项读取状态                        | PASS |
| Contract、DB、OIDC/S3/OTEL、testkit、架构、Secret | 单一 `npm run verify` 的 16/16 Gate；203/203 Unit；真实 PostgreSQL 16.14                                 | PASS |
| 无 DB-01、业务 Endpoint 或页面                    | 仅 3 个 Foundation Package、1 个 DB-00 Migration、唯一 `schema_migrations` 表；Apps/UI 均为 0            | PASS |
| Evidence Manifest 完整                            | Commit、Clean、命令、环境、16 项结果、Artifact/Fixture Digest、Owner 与 5 个未关闭风险                   | PASS |
| Owner/容量与日历重算                              | [Owner/容量矩阵](../delivery/g2-owner-capacity-matrix.md)：1 条有效通道；G2-01～05 改为顺序 14–22 工程周 | PASS |
| 独立 Reviewer                                     | [专项红队与 Intended-vs-Implemented](../reviews/g2-00-13-foundation-red-team.md)独立于实现运行，结论 Go  | PASS |

## 3. Clean-room 机器结果

```text
Foundation Gate                    PASS — 16/16
unit                               PASS — 203/203
contract-golden-diff               PASS — 11 Foundation / 16 Error / 30 Golden
architecture-dependency            PASS — 3 Packages / 20 Source Files
testkit-provenance                 PASS — 47 Inputs / 6 Groups
secret-private-key                 PASS — 255 Tracked Text Files / 0 Findings
foundation-scope-evidence          PASS — 6 ADR / 12 Evidence / 0 App / 0 UI
license-sbom-vulnerability         PASS — 135 Packages / 138 Components / 0 Vulnerabilities
postgres-integration               PASS — server_version_num 160014 / Role Escalation Blocked
production-boundary up/smoke/down  PASS — PostgreSQL / OIDC / S3 / OTEL
total                              29.248 seconds
```

Manifest 结论为 `PASS / CLEAN_ROOM_PASS`，`dirty=false`，Commit 与 Clone Head 一致。运行结束后 `git status` 仍为空；Compose 项目容器为 0，最终 Reset 后项目卷也为 0。

## 4. Evidence Manifest 与稳定输入

| 对象                                | SHA-256 / 值                                                              |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `foundation-evidence-manifest.json` | `2b7541d26df07d032f99247db524658acda3c95c7cc93c4cef59d10994ebb160`        |
| `report.json`                       | `05883223d3b26dac494b2bc37ae8a3658c70ca72943c00e5a8247fa1cf86f763`        |
| `foundation-acceptance.json`        | `236ed5b5bd9d9d7b26090c50b4e551d1cd8b1db2dac9973cc9ac0810bdf281f7`        |
| `package-lock.json`                 | `adf64704cd210786030acf7591820b5a3304d00d471c2a9b38cc17f2b215244c`        |
| Testkit Fixture                     | `sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1` |
| PostgreSQL Image                    | `postgres:16.14-bookworm@sha256:64154d0b...8efa8`                         |

CycloneDX Serial/Timestamp 每次运行变化，因此不把单次 SBOM 文件 Hash 当源码身份；Manifest 固定本次 Artifact Hash，稳定输入另由 Lockfile 与 Fixture Digest 标识。最终 PR Head 的 GitHub Hosted Runner 会重新生成独立 Artifact，远端结果而不是本地文件复制决定是否可合并。

## 5. Shipping Artifact 映射

- Architecture：PRD、实现蓝图、ADR-007～012 和各模块 Architecture 文档已经形成权威索引；
- Permission/Trust Flow：当前没有业务用户流程或 Endpoint；已存在的数据库角色、OIDC Smoke、Policy Epoch 与 Handler Host 信任边界均有负向测试，不创建虚假的页面流程文档；
- Variables/Secrets：本地公开样例只服务 loopback 容器，生产模式拒绝样例凭据；Secret Scanner 扫描全部 Git 跟踪文本；
- Tests：16 项 Gate 和 12 份阶段 Evidence 区分现有证据与后续 G2-01～09 风险；
- Conditional Surfaces：当前没有生产邮件、Cron、SEO 页面或嵌入式 AI Automation，因此不创建空文档制造完成感。

## 6. 结论边界

G2-00 Foundation 可以从干净环境重复建立并共同验证，范围、决策、合同、权限、环境、testkit、供应链和合并保护均有可执行证据，因此 G2-00 总 Gate 为 **PASS**。

这不是可供用户使用的产品，也不证明 DB-01、Materialization、Query、Action、页面、备份恢复或生产安全已经完成。合并本任务后唯一允许的下一步是建立 G2-01 Metadata 任务包；不能直接跳到 DB-02、UI 或 Action。
