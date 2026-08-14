# G2-01-12 Clean-room Metadata 总验收记录

- 结论：**PASS（G2-01-12 Clean-room Metadata 总验收）**
- 执行日期：2026-08-15
- 分支：`agent/g2-01-12-clean-room`
- 起始 Commit：`314728416c28abedc3d9f514b152186300f8183f`
- 工具：Node.js 24.18.0 / npm 11.16.0 / Docker 29.6.1 / Docker Compose 5.2.0 / PostgreSQL 16.14

本记录对应 [G2-01-12 WWA](../delivery/g2-01-metadata-task-pack.md#g2-01-12执行-clean-room-metadata-总验收)。结论只覆盖 G2-01 Metadata 控制面，不将 DB-02、Materialization、Query、Policy Runtime、Action、UI 或 SDK 包装成已完成能力。

## 1. 连续生产链路

`tools/metadata-clean-room/postgres-http-clean-room.test.ts` 不使用内存 Store 或直接调用 Application Service，而是启动临时 OIDC Provider、全新 PostgreSQL 16.14 容器和真实 Admin HTTP Server，从空库连续执行 24 个场景步骤：

```text
Empty DB + DB-00/DB-01 migrations
→ invalid OIDC rejected before Principal creation
→ Project + Owner Binding
→ Editor / Viewer role bindings
→ Resource + Draft Revision
→ Viewer write and Resource elevation rejected
→ Editor validation succeeds but publish is rejected
→ Owner Release validate / stage / publish
→ SQL fault injected at Channel switch; old pointer and candidate snapshot unchanged
→ compatible child Revision publishes after fault removal
→ breaking and conditional child Revisions remain blocked
→ Work + Commerce Package install
→ compatible Commerce upgrade
→ breaking Commerce upgrade rejected without Release/pointer change
→ rollback creates and publishes a new Release
→ API restart
→ second migration run is a no-op
→ historical hashes and runtime DB restrictions rechecked
```

## 2. Release 与故障语义

- 首个 compatible Release 从 Draft 走完 Validate / Stage / Publish，并创建零成员 Runtime Activation、Serving Head 和 Channel Pointer。
- 通过 PostgreSQL Trigger 在 `release_channels` 更新点注入 SQL 故障；HTTP 返回稳定可重试错误，而 Release、Revision、Activation、Serving Head 和 Channel 全部保持故障前快照。
- 移除故障后对同一 Release 重试成功；旧 Pointer 只在完整事务成功时切换。
- required Property 新增被判定为 breaking；indexed nullable Property 新增被判定为 conditional 且因 Materialization 未就绪而阻断。

## 3. Package 完整链路

两个 Package 都由冻结 G1 来源确定性派生，再经生产 Parser 和 Digest 完整性校验：

- `fixture.work` 和 `fixture.commerce` 安装均创建新 Release 并发布；
- Commerce 的 compatible Upgrade 通过新 Release 切换 Installation；
- breaking Upgrade 返回 `accepted=false`，不创建 Release，不改 Active Package Revision 或 Channel Pointer；
- Rollback 复制历史 Package Pins，创建并发布一个新 Release，没有直接指回旧 Activation。

## 4. 不可变与恢复

验收对已发布 Revision Content/Digest、Release Manifest/Pins 和 Package Manifest/Digest 做确定性 SHA-256。以下四个时点的分类 Hash 和组合 Hash 必须完全相同：

1. Rollback 之前；
2. Rollback 之后；
3. API 进程重启之后；
4. 第二次 Migration 之后。

Independent clean checkout 运行的组合 Hash 为 `sha256:8910a88ffbecad776782d9654086bdf22a8baf98a18dd462da1d5f6c4dc0faed`，四个时点一致。每次运行会产生新的不透明实体 ID，所以不要求跨运行 Hash 相同；要求的是同一运行在 Rollback、Restart 和二次 Migration 边界前后不变。

## 5. 安全与最小权限

- 错误 Audience 的 OIDC Token 在 Principal 映射前被拒绝；
- Project Viewer 即使持有 Resource Owner Binding 也不能扩权写入；
- Editor 可编辑/校验，但不能 Publish；
- 无权 Resource 与不存在 Resource 对外返回同类结果，不泄漏元数据；
- API 数据库连接实际为 `api_runtime`，`SET ROLE migration_owner` 与 Migration Ledger 访问均失败。

## 6. 证据绑定

`npm run verify` 现在包含独立 `metadata-clean-room` Gate。`metadata-evidence-manifest.json` 除原有 Commit、Clean/Dirty、环境、PostgreSQL、Lock/Migration/Contract/Fixture Digest、每个 Gate、Test Count、Owner 和风险外，还内嵌本次 24 步 Clean-room Artifact；缺 Artifact 或 Artifact 非 PASS 时即使同名 Gate 显示成功，Manifest 也必须 FAIL。

## 7. 可复现执行

首次实现工作树预验为 22/22 Gate、294 Tests、36,686 ms，Manifest 因存在未提交变更正确标记 `WORKTREE_PASS`。随后对实现 Commit `307ba085244b1c949fab5624867c5acecb94c64d` 执行了独立全新 Clone：初始没有 `.env`、`node_modules`、`generated` 或未跟踪文件，先执行锁文件安装与固定 Compose 卷 Reset，再使用唯一命令运行完整 Gate：

```text
npm ci            PASS — Node 24.18.0 / npm 11.16.0 / 0 vulnerabilities
npm run env:reset PASS — only ontos-g2-local test volumes removed
npm run verify    PASS — 22/22 Gate / 294 Tests / 38,888 ms
npm run env:reset PASS — 0 project containers / 3 project volumes removed
```

Independent Manifest 为 `PASS / CLEAN_ROOM_PASS / cleanCheckout=true`，Commit 等于 Clone Head，PostgreSQL `server_version_num=160014`，Artifact 摘要为：

```text
metadata-clean-room.json       sha256:2d291f6bbfefde6bdabaa4c92d2116ffd5edd0bf68c5149da5ba53ccca60c643
metadata-evidence-manifest.json sha256:be23105e188c5dc9814acd43e94f82bcd483c7b9213df2285fd55311dc44c32a
report.json                     sha256:6765670803d25f3e730107a4b11680e2c5704f544347ec80ae3516a08bcd5c18
```

运行后 Clone 的 Git 状态仍为 clean。人类可读文档不尝试嵌入自身最终 Commit；合并前的最终 Head 由同一脚本重跑并在生成 Manifest/GitHub Required Check 中绑定，避免自引用 Commit 导致无穷文档提交。

## 8. 未关闭边界

Evidence Manifest 保留 4 项有 Owner 的风险：OIDC/JWKS 运维依赖、Principal 发现/邀请 UX、生产 Backup/PITR/HA，以及 DB-02 加入 Materialization 时对历史身份不可变的要求。它们不阻断 G2-01，但不能从 Manifest 删除或被描述为已完成。
