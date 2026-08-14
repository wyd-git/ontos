# 本地生产边界等价环境运行手册

## 1. 前置条件

- 仓库锁定的 Node.js 24.18.0 与 npm 11.16.0；
- Docker Engine 兼容 Compose v2/Compose 5；
- 本机端口 `15432`、`18080`、`18333`、`19090`、`13133`、`14318`、`18888` 未被占用。

所有命令在仓库根目录执行。首次启动需要下载固定 digest 镜像，后续启动复用本机缓存。

## 2. 标准流程

```bash
npm run env:up
npm run env:smoke
npm run env:down
```

`env:up` 先验证配置，再启动依赖，最后逐一验证 PostgreSQL runtime 连接、S3 Bucket、OIDC discovery、OIDC management health 和 Collector health；任一探针在 180 秒内未就绪即失败。

`env:smoke` 依次验证：

1. 通过 client credentials 获取 OIDC access token，并通过远程 JWKS 验证签名、issuer 和 audience；
2. 对临时 S3 Object 执行写、读、内容断言和删除，并证明错误凭据被拒绝；
3. 以 `ontos_smoke_runtime` 读写探针表，并证明 `SET ROLE ontos_smoke_owner` 与 `CREATE SCHEMA` 被拒绝；
4. 发送一条 OTLP/HTTP Trace，并证明 Collector accepted-span 指标增加。

Smoke 会清理临时数据库行和 S3 Object，不输出凭据。

## 3. 生命周期命令

| 命令                  | 容器   | 网络   | 项目卷   | 用途                                    |
| --------------------- | ------ | ------ | -------- | --------------------------------------- |
| `npm run env:status`  | 不改变 | 不改变 | 不改变   | 显示 Compose 状态并执行一次协议探活     |
| `npm run env:restart` | 重启   | 保留   | **保留** | 验证持久化重启；不重跑一次性 guard 容器 |
| `npm run env:stop`    | 停止   | 保留   | **保留** | 暂停资源，之后可 `env:up`               |
| `npm run env:down`    | 删除   | 删除   | **保留** | 正常关闭环境，之后可恢复既有数据        |
| `npm run env:reset`   | 删除   | 删除   | **删除** | 完全清空，仅限固定项目卷；不可恢复      |

`env:reset` 不接受项目名、Compose 文件或额外 Docker 参数。其精确计划由单测覆盖，固定项目名为 `ontos-g2-local`，不会执行全局 volume prune，也不会枚举或删除其他项目卷。

## 4. 本机端点

| 能力                       | 端点                                        |
| -------------------------- | ------------------------------------------- |
| PostgreSQL                 | `127.0.0.1:15432`                           |
| OIDC issuer                | `http://127.0.0.1:18080/realms/ontos-local` |
| Keycloak management health | `http://127.0.0.1:19090/health/ready`       |
| S3                         | `http://127.0.0.1:18333`                    |
| OTLP/HTTP traces           | `http://127.0.0.1:14318/v1/traces`          |
| Collector health           | `http://127.0.0.1:13133/`                   |
| Collector metrics          | `http://127.0.0.1:18888/metrics`            |

端口不绑定局域网地址。提交的凭据位于 `deploy/local/.env.example`，只适用于这些 loopback 容器。

## 5. Clean-state 验证

以下序列覆盖完全清空、空卷初始化、协议闭环与持久化重启：

```bash
npm run env:reset
npm run env:up
npm run env:smoke
npm run env:restart
npm run env:smoke
npm run env:down
```

`env:reset` 是破坏性操作，运行前必须确认目标确为本仓库的本地测试环境。

## 6. Production 防误用验证

配置验证函数的单测会把提交的示例配置切换为 `production` 并断言失败。以下隔离项目可以验证整栈启动路径；预期 `up` 非零退出，`ps --all` 显示 guard 为 `Exited (1)`，其余四个服务保持 `Created`、从未启动：

```bash
ONTOS_ENVIRONMENT=production docker compose \
  --project-name ontos-g2-production-negative \
  --env-file deploy/local/.env.example \
  --file deploy/local/compose.yaml \
  up --detach
```

该负向测试会创建三个空项目卷。检查状态后，用相同项目名和文件执行 `down --volumes --remove-orphans` 清理。不要把 `.env.example` 改名后用于共享或生产环境。该 Compose 文件的受支持入口拒绝任何非 `local` 模式；刻意使用 `--no-deps`、覆盖 Entrypoint 或修改文件属于显式运维绕过，不在此守卫的承诺内。

## 6.1 G2-00 clean-room 顺序

新 Checkout 没有 `node_modules` 时，必须先 Bootstrap，再执行环境命令。`env:reset` 会加载与 Smoke 共用的环境模块，因此不支持在 `npm ci` 前运行。

```bash
npm ci
npm run env:reset
npm run verify
npm run env:reset
```

前置 Reset 证明 PostgreSQL、S3 和 OIDC 不复用旧项目卷；`verify` 自己执行完整安装、DB-00、Integration 和 `up → smoke → down`；末尾 Reset 删除本次新建的三个项目卷。两个 Reset 都只允许固定 Compose 项目 `ontos-g2-local`，会不可恢复地删除其中的本地测试数据，不得替换为全局 `docker volume prune`。

只有 `generated/ci-report/foundation-evidence-manifest.json` 同时为 `PASS`、`CLEAN_ROOM_PASS`、`cleanCheckout=true` 且 Commit 等于 Clone Head，才是 G2-00 clean-room 证据。普通脏工作树运行最多得到 `WORKTREE_PASS`。

## 7. 故障定位

先运行 `npm run env:status`。如果启动失败，读取固定项目日志：

```bash
docker compose \
  --project-name ontos-g2-local \
  --env-file deploy/local/.env.example \
  --file deploy/local/compose.yaml \
  logs --tail 200 postgres s3 oidc telemetry config-guard
```

不要通过删除未知 Docker 卷、关闭其他服务或改用个人云凭据来绕过故障。确认是本项目一次性数据损坏时，才运行 `npm run env:reset`。
