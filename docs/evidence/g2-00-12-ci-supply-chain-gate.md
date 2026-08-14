# G2-00-12 强制 CI 与供应链 Gate 验收记录

- 结论：**LOCAL PASS / REMOTE PENDING**
- 执行日期：2026-08-14
- 分支：`agent/g2-00-12-ci-gates`
- 起始 Commit：`8204f6e0eb8abf5681e82f7d11fcd7a7bf98809f`
- 工具：Node.js 24.18.0 / npm 11.16.0 / Docker 29.6.1 / Docker Compose 5.2.0
- 环境：macOS arm64；远端环境固定 `ubuntu-24.04`

本记录对应 [G2-00-12 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-12建立强制-ci-与架构-gate)。最终实现 Commit 由 PR Head 记录，避免提交文件引用自身 Hash。

## 1. 验收映射

| WWA 声明                                 | 实现证据                                            | 本地执行证据                                                      | 结果    |
| ---------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| 全部必跑项                               | 单一 `tools/ci/run.ts`，15 个顺序 Gate              | 15/15 PASS，32.473 秒                                             | PASS    |
| Secret、License Manifest、SBOM、漏洞策略 | 两个 Scanner/Generator 与三个机器 Policy            | 236 个跟踪文本文件、135 个外部包、138 个 SBOM Component、0 漏洞   | PASS    |
| 四类故意失败 Fixture                     | Contract、Architecture、Role、Secret Negative Tests | 196 Unit 全绿；真实 Role Escalation 输出 `blocked`                | PASS    |
| 本地/CI 同脚本                           | `npm run verify` 是本地和 Workflow 唯一入口         | Workflow 不维护第二套 Gate 命令                                   | PASS    |
| 机器报告和摘要                           | `report.json`、`summary.md`、六个子 Artifact        | Commit/Dirty、版本、PostgreSQL、Fixture/Lock Hash、逐步耗时均存在 | PASS    |
| 分支保护与紧急绕过审计                   | Strict Required Check 与无常驻 Bypass 设计          | 等待首个远端 Check 后配置并复查                                   | PENDING |

## 2. 本地完整 Gate

```text
npm run verify

Foundation Gate                 PASS
lockfile-install                PASS
format / lint / typecheck       PASS
unit                            PASS — 196/196
contract-golden-diff            PASS — 11 Foundation / 16 Stable Error / 30 Golden
architecture-dependency         PASS — 3 Packages / 20 Source Files
testkit-provenance              PASS — 47 Inputs / 6 Groups / sha256:dff360...aa1
secret-private-key              PASS — 236 Tracked Text Files / 0 Findings
license-sbom-vulnerability      PASS — 135 Packages / 138 Components / 0 Vulnerabilities
postgres-integration            PASS — server_version_num 160014 / Role Escalation Blocked
production-boundary up/smoke/down PASS — PostgreSQL / OIDC / S3 / OTEL
total                           32.473 seconds
```

Environment Down 删除本项目容器和 Network，保留项目 Volume；没有使用 `env:reset` 或删除个人数据。

## 3. Artifact 与输入摘要

本地报告记录：

```text
package-lock.json
  adf64704cd210786030acf7591820b5a3304d00d471c2a9b38cc17f2b215244c
testkit source fixture
  sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1
licenses.json
  e64300f57c2dd51ffc3e3fb1db45fc086ad406c0aa3de8f71d64a31bf88dedd6
npm-audit.json
  942b11243cc1c7ce965a9e284a3afe5aa5821741a4da260d47b4c2d27915aa61
secret-scan.json
  58b8f06c52108a21dba4f107ee8455740138f900ecd57e79b147ae880217c677
vulnerability-report.json
  10f65c94439f9acefa54710fd3abf0c7028bb34318111c1ba8f41d20e31e4e5b
```

CycloneDX 文档包含随机 Serial/Timestamp，因此只把每次运行摘要作为 Artifact 身份，不把它误称为跨运行稳定的源码摘要。

## 4. 失败能力证明

- Contract：删除属性、Required 新增、类型、约束、枚举和未知字段策略变化均返回 Breaking；
- Architecture：Contract → Runtime、Domain → Adapter、Production → Testkit、Workspace → G1 和依赖环均阻断；
- Role：真实 PostgreSQL 临时执行 `GRANT migration_owner TO api_runtime`，Role Gate 必须失败；Revoke 后复验恢复；
- Secret：运行时重组 Private Key Header 与 GitHub Token，Scanner 同时命中高置信和 Assignment 规则，报告不含原值；精确公开样例 Hash 可通过，任意变体阻断；
- Supply Chain：High 阻断、Moderate 报告、精确有效 Waiver 通过，过期/坏响应/未批准 License 均 Fail Closed。

## 5. 安全与分支策略

- GitHub Actions 事件只有 `pull_request` 与 Main Push，不使用 `pull_request_target`；
- `GITHUB_TOKEN` 只有 `contents: read`，Checkout 不持久化凭据；
- 官方 Actions 固定完整 Commit SHA；
- Artifact 使用 `always()` 上传，失败也保留机器证据；
- Main 最终要求 Strict `Foundation Gate`，禁止 Force Push/Delete，Admin Enforced，无常驻 Bypass Actor；
- 紧急绕过必须同时存在 GitHub Security Log 与仓库 Incident Record，随后恢复保护并补跑 Gate。

## 6. Red-Team 与剩余条件

[专项审查](../reviews/g2-00-12-ci-gate-red-team.md)已经关闭本地/CI 命令分叉、漏洞静默忽略、Secret 回显、假数据库和失败清理五类高风险假设，并补齐总报告 Artifact 计数。

升级为最终 **PASS** 前仍需：远端 `Foundation Gate` 通过、Artifact 可下载、Main Protection 配置并经 API 复查。G2-00-13 的 clean-room 复验仍是独立后续 Gate，本记录不宣称整个 G2-00 完成。
