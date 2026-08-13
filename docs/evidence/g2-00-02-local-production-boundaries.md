# G2-00-02 本地生产边界等价环境验收记录

- 结论：**PASS（仅限 G2-00-02）**
- 执行日期：2026-08-13
- 分支：`agent/g2-00-02-local-production-boundaries`
- 环境：Docker Desktop Engine 29.6.1 / Linux aarch64（macOS arm64 host）
- 工具：Node.js 24.18.0 / npm 11.16.0

本记录对应 [G2-00-02 WWA](../delivery/g2-00-foundation-task-pack.md#g2-00-02建立本地生产边界等价环境)。最终实现 Commit 由 Draft PR head 记录，避免在被哈希的 Commit 中写入自身哈希。

## 1. 验收映射

| WWA 声明                                                | 实现证据                                                            | 执行证据                                                                    | 结果 |
| ------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---- |
| 空状态用一个入口启动、探活和关闭全部依赖                | `deploy/local/compose.yaml`、`tools/local-env/compose.ts`、运行手册 | `env:reset → env:up` 从 0 个项目卷重建；5 个协议探针通过；`env:down` 可关闭 | PASS |
| Token、issuer/audience、临时 Object、非 owner DB、Trace | `tools/local-env/smoke.ts`                                          | 两轮 `env:smoke` 全通过；Trace accepted-span delta 均为 1                   | PASS |
| 无个人登录、共享云账号或手工生产 Secret                 | 固定本地 Keycloak Realm、SeaweedFS Bucket 与公开 Fixture 配置       | 冷启动期间没有浏览器、云连接或人工输入                                      | PASS |
| arm64 与 amd64 使用相同版本及兼容镜像                   | Compose 中版本 + manifest-list digest 固定                          | `imagetools inspect` 确认 5 个镜像均含 linux/arm64 与 linux/amd64           | PASS |
| 持久化重启与完全清空分离，清空严格限项目卷              | `compose-plan.ts` 与 `compose-plan.test.ts`                         | reset 只删除 3 个 `ontos-g2-local_*` 卷；restart 后第二轮 smoke 通过        | PASS |
| 示例配置不可用于生产                                    | `config.ts`、`config.test.ts`、Compose `config-guard` 依赖          | 隔离 production 整栈启动非零退出；四个依赖停在 `Created`；主项目仍健康      | PASS |

## 2. Clean-state 与协议闭环

第一次尝试暴露了 Docker Desktop 对绑定挂载初始化 shell 的执行差异：PostgreSQL 基础集群创建后，shell shebang 被容器以 `Permission denied` 拒绝，受限角色未创建。修复为纯 SQL 初始化文件后，执行固定项目清空并从空卷重建；该问题没有通过手工补角色掩盖。

修复后的 `npm run env:up`：

```text
PASS PostgreSQL: ready
PASS S3: ready
PASS OIDC discovery: ready
PASS OIDC health: ready
PASS OpenTelemetry: ready
Local production-boundary dependencies are ready.
```

`npm run env:smoke`：

```text
PASS OIDC token signature, issuer, and audience
PASS S3 temporary object write, read, delete, and invalid-credential denial
PASS PostgreSQL non-owner access and privilege denial
PASS OpenTelemetry OTLP trace ingestion
postgres.role = ontos_smoke_runtime
postgres.ownerEscalationDenied = true
telemetry.acceptedSpanDelta = 1
```

随后执行 `npm run env:restart`，五项健康探针和完整 Smoke 再次通过。第二条 Trace 使用新的 trace ID，Collector accepted-span delta 仍为 1。

最终执行 `npm run env:down` 后，项目容器与网络均不存在，三个 `ontos-g2-local_*` 卷仍保留；这与前述 `env:reset` 的删卷结果形成实际而非仅文档上的生命周期区分。

## 3. 清空范围证据

`npm run env:reset` 生成的命令被单测锁定为固定项目、固定 env 文件和固定 Compose 文件的 `down --volumes --remove-orphans`。实际只移除：

```text
ontos-g2-local_postgres-data
ontos-g2-local_keycloak-data
ontos-g2-local_seaweed-data
ontos-g2-local_default network
ontos-g2-local project containers
```

未执行 `docker volume prune`，未接收用户提供的项目名、路径、glob 或额外参数。

## 4. Production 负面证据

以 `ONTOS_ENVIRONMENT=production` 启动隔离 Compose 项目 `ontos-g2-production-negative`，退出码为 1：

```text
Production configuration refuses public sample credentials:
ONTOS_POSTGRES_SUPERUSER_PASSWORD, ONTOS_DB_RUNTIME_PASSWORD,
ONTOS_OIDC_CLIENT_SECRET, ONTOS_OIDC_ADMIN_PASSWORD,
ONTOS_S3_ACCESS_KEY_ID, ONTOS_S3_SECRET_ACCESS_KEY.
```

状态检查证明 `config-guard` 为 `Exited (1)`，PostgreSQL、S3、OIDC 和 Collector 全部停在 `Created`，没有一个依赖进程实际启动。随后只删除该负向项目的容器、网络与三个空卷。主项目此前的一次性 guard 负向探针后执行 `env:status`，四个长期服务保持运行，五项健康探针仍为 PASS。

## 5. 运行版本与架构

arm64 容器内版本读数：

```text
PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1)
SeaweedFS 4.41 de34a1a87 linux arm64
Keycloak 26.7.1 / OpenJDK 21.0.12 / Linux aarch64
otelcol-contrib 0.158.0
```

Compose 的 5 个镜像 manifest-list digest 和双平台结果记录在 [本地生产边界架构](../architecture/local-production-boundaries.md#2-版本与跨架构基线)。这证明镜像可选择两个平台，不等于已在本次 arm64 主机上执行 amd64 性能或行为认证；CI 后续必须在真实 amd64 runner 复跑同一 `env:up` 与 `env:smoke`。

## 6. 静态验证

```text
typecheck: PASS
lint: PASS
unit: 19 passed, 0 failed
architecture: PASS
```

本任务新增依赖均固定确切版本；clean `npm ci` 成功并审计为 0 vulnerabilities。执行前后 `package-lock.json` SHA-256 均为：

```text
ba4cbd3bbf67bbba84d3511adea067180d1baf625e461c0973a7d5ebae145d45
```

## 7. Intended-vs-Implemented 审查

逐条从 G2-00-02 WWA 反查 Compose、配置守卫、生命周期计划和 Smoke 执行路径，发现并关闭一项证据偏差：

- **文档原意：** production 模式使用示例凭据时，依赖不得启动。
- **原证据：** 只单独运行了 `config-guard`；这能证明验证函数失败，不能证明四个依赖受启动依赖约束。
- **补强：** 使用独立项目执行完整 Compose `up`，确认 guard 退出 1，其他四个服务全部停在 `Created`。同时将“Compose 不能绕过”的过强措辞收窄为受支持、dependency-aware 启动；明确 `--no-deps`、Entrypoint 覆盖或篡改文件属于操作者显式绕过。
- **状态：** CLOSED；未发现仍开放且跨越凭据、数据库 owner、项目卷或外部协议边界的文档/实现偏差。

## 8. 明确不宣称

- 本记录不是 G2-00 Foundation 总 Gate PASS；G2-00-03～13 尚未完成。
- Keycloak `start-dev`、H2、SeaweedFS `mini`、单节点 PostgreSQL 和 debug exporter 不可作为生产部署模板。
- 探针表只属于 G2-00-02 环境验证，不是正式业务 Schema，也不替代 G2-00-10 Migration/Role 工作。
- 本任务没有实现 Kernel API、Repository、业务对象、Policy、页面、生产连接池、备份或高可用。
- arm64 已真实运行；amd64 当前证据是同一 digest 的平台兼容性，实际 CI 执行属于 G2-00-12。
