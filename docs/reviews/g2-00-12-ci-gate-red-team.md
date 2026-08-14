# Red-Team：G2-00-12 强制 CI 与供应链 Gate

结论：**No-Go（仅被 GitHub 私有仓库套餐阻塞）**。本地唯一入口和远端 `ubuntu-24.04` 已真实执行全部 15 个 Gate，Contract、越层依赖、角色越权和 Secret 四类故意失败输入均能被检测，远端 Artifact 已下载复验。但当前 GitHub Free 私有仓库无法启用 Branch Protection 或 Repository Ruleset，因此还不能满足“不可绕过合并”验收。

## Top Kill-Assumptions（按优先级）

### 1. 本地与 CI 真的只有一套执行语义（已关闭，97）

- **Claim：** 本地和 GitHub Actions 执行相同安装、检查、Integration 与 Smoke 路径。
- **Fails if：** Workflow 自己重新排列命令、跳过 Docker Gate，或本地 `verify` 只是快速检查别名。
- **Kill criterion：** Workflow 出现 `npm run verify` 之外的 Gate 命令，或 Runner 中任一必跑项缺失。
- **处理：** `.github/workflows/foundation-ci.yml` 只调用 `npm run verify`；`tools/ci/run.ts` 是唯一编排器并列出 15 个 Gate。**CLOSED**。

### 2. 供应链失败不会被“为了可用性”静默放过（已关闭，95）

- **Claim：** License、SBOM、漏洞和网络/响应错误均有明确失败语义。
- **Fails if：** `npm audit` 非零被无条件忽略、未知 Severity 继续 PASS、Waiver 可模糊匹配或永久有效。
- **Kill criterion：** High/Critical、未知响应、过期/过宽 Waiver 或未批准 License 任一仍返回 PASS。
- **处理：** High/Critical 默认阻断；网络/非 JSON/缺元数据 Fail Closed；Waiver 精确匹配 Package、Severity、Advisory URL 且最长 30 天。License 仅允许冻结 SPDX 集。负面测试覆盖 High、Moderate、精确 Waiver、过期 Waiver、坏响应、缺失和未批准 License。**CLOSED**。

### 3. Secret Scanner 不是只会发现写给测试看的字符串（已关闭，93）

- **Claim：** Scanner 覆盖 Git 跟踪文本文件，不泄露发现值，并允许精确的公开本地样例。
- **Fails if：** 私钥 Header、GitHub/AWS/Google/Slack Token 或长 Secret Assignment 可绕过；Allowlist 按路径/前缀放宽；报告回显值。
- **Kill criterion：** 重组的 Private Key Header、真实形态 Token 或样例值变体没有 Finding，或 Finding 包含原值。
- **处理：** 高置信格式与 Assignment 双层检测；公开样例只以精确 SHA-256 Allowlist；报告只有 Rule、Path、Line。正常仓库扫描 0 Finding，三类故意失败稳定命中且不回显。**CLOSED**。

### 4. “真实 PostgreSQL”不会退化为 Mock 或只测成功路径（已关闭，92）

- **Claim：** CI 在固定 PostgreSQL 16 镜像执行 DB-00，且证明 Runtime → Owner 越权会阻断。
- **Fails if：** 测试只检查 SQL 文本、角色负面测试不改变真实 Membership，或实际数据库版本没有进入报告。
- **Kill criterion：** 临时 `GRANT migration_owner TO api_runtime` 后角色 Gate 仍 PASS。
- **处理：** Integration 在一次性容器执行真实 Grant，确认 `assertFormalRoles` 失败后 Revoke 并复验；输出实际 `server_version_num=160014` 进入机器报告。**CLOSED**。

### 5. 失败证据与清理不会被成功摘要掩盖（已关闭，90）

- **Claim：** Fail Fast 不等于缺失报告；已启动环境一定 Teardown。
- **Fails if：** 失败后的 Gate 从报告消失、旧 Artifact 被误当本次输出、Smoke 失败留下容器，或输出尾部泄露 Secret。
- **Kill criterion：** 任一未执行 Gate 没有 `SKIPPED`，输出目录没有每次清空，或 Environment Failure 不触发 `finally` Teardown。
- **处理：** 每次先清空 `generated/ci-report`；所有 Gate 固定产生 PASS/FAIL/SKIPPED；Environment 一经触达即保证 Down；报告输出做 Credential/Token Redaction。**CLOSED**。

### 6. GitHub 检查不能被普通合并绕过（外部阻塞，98）

- **Claim：** Main 要求最新的 `Foundation Gate`，禁止 Force Push/Delete，管理员同样受保护。
- **Fails if：** Check 名不稳定、Protection 未启用、管理员可直接 Push，或常驻 Bypass Actor 存在。
- **Kill criterion：** GitHub API 查询的 Main Protection 与冻结策略不一致，或未通过 Check 仍能合并。
- **处理：** Workflow Check 已固定命名，远端 15/15 PASS 且 Artifact 已复验。但 `GET branches/main/protection` 和 `GET repos/.../rulesets` 均返回 HTTP 403：当前私有仓库需升级 GitHub Pro（或转公开）才能启用。**BLOCKED — Owner: Repository Owner**。

## Intended vs. Implemented

| 文档化意图                                                                         | 实现与执行证据                                                                                 | 结论    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| Lockfile、Format、Lint、Type、Unit、Contract、Architecture、PostgreSQL、Smoke 必跑 | `tools/ci/run.ts` 的 15 个 Gate；完整本地报告 15/15 PASS                                       | PASS    |
| Secret、License、SBOM、漏洞分级且不静默忽略                                        | `tools/ci/secret-scan.ts`、`supply-chain.ts`、三个 `security/*-policy.json`                    | PASS    |
| 四类故意失败 Fixture                                                               | Contract Breaking Tests、Architecture Negative Workspace、真实 Role Grant、Secret 重组 Fixture | PASS    |
| 本地与 CI 同脚本                                                                   | `package.json#verify` 与 Workflow 唯一命令均为同一入口                                         | PASS    |
| 报告含 Commit、版本、DB、Fixture Hash、耗时与 Artifact                             | `generated/ci-report/report.json`；审查发现并补齐 Artifact 顶层计数                            | PASS    |
| Required Check、紧急绕过可审计                                                     | Check 已远端 PASS；Protection/Ruleset 被当前 GitHub Free 私有仓库套餐拒绝                      | BLOCKED |

首轮 Intended-vs-Implemented 审查实际发现：总报告只有 Artifact Hash/Bytes，计数只藏在子报告。现已加入 `artifactCounts`，把 Secret 扫描文件/Finding、License Package、SBOM Component/Dependency 和 Vulnerability Finding 统一提升到总报告。

## Residual Risks

- npm Advisory Service 不可用时 Gate 会 Fail Closed，可能降低合并可用性，但不会降低安全语义；Owner：Platform / Quality。
- GitHub 托管 Runner 首次完整运行为 2 分 6 秒，30 分钟 Timeout 有充足余量；仍不能用删除真实 Smoke 应对短期波动。
- 本地 Scanner 按设计只扫描 Git 跟踪文件；未跟踪草稿不是发布候选，提交后的 PR CI 会扫描它。提交前仍需先 Stage 再执行一次 Secret Gate。
- G2-00-13 仍需在 clean checkout 证明没有个人缓存、已有 Docker Volume 或工作树状态依赖。

## 最终 Go 条件

1. 保持仓库私有的推荐路径：Repository Owner 升级 GitHub Pro；或由 Owner 明确批准转为公开仓库；
2. Main Protection 通过 GitHub API 复查为 Strict Required Check、禁止 Force/Delete、Admin Enforced、无常驻 Bypass；
3. Evidence 把 Protection 状态从 BLOCKED 更新为 PASS，随后才能合并 PR #14 并启动 G2-00-13。
