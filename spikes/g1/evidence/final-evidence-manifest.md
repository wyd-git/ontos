# G1 最终证据清单

实现内容指纹（47 个可执行输入文件）：

`sha256:dff360ddb4c6683ab0481eb6d3d5f122aea6ad4e8039c51e57634ba894bd4aa1`

| Gate | 原始文件 | SHA-256 |
|---|---|---|
| 30 分钟持续查询 | `raw/2026-08-13T050251.190Z-spike-a-sustained/result.json` | `4ed89e89aa70ae60297c4c38a03ee39c779dd197b2564a3667619228985a0573` |
| 持续查询语料 | `raw/2026-08-13T050251.190Z-spike-a-sustained/query-corpus.json` | `5ef3055eb15ec63a8fb46a16a6d947ab32b42d5631f6fe9bd1703dee01b55288` |
| Fail-closed 修复后查询语料 | `raw/2026-08-13T054943.000Z-query-corpus-final/query-corpus.json` | `99beff2b26fc68d861188094c05e416bffbab3dc2e71d3a5cbb35e12a04a2f33` |
| Query/EXPLAIN | `raw/2026-08-13T054249.807Z-spike-a/result.json` | `5c2acc585e7dc041ff3e90b53283a53a98a34f9f234c6cab5f64c994e2f299ea` |
| Index cost | `raw/2026-08-13T054109.171Z-spike-a-index-cost/result.json` | `7b39f705e61d1b7d97bc0fb3d2acb5b546de61d4a473585007fc5eb452730201` |
| Overlay correctness/recovery | `raw/2026-08-13T053859.836Z-spike-b/result.json` | `e684c9cdd1368a3b6eae825bb3779d917edb96e8ddfa8acfad87eb8bf3ed5041` |
| 100k/1m materialization | `raw/2026-08-13T053946.392Z-spike-b-scale/result.json` | `ac9a5d4c82cdb3f69f2442f0fcf498194f01de03ca4502f74c56ec5e4e1a12b6` |
| Cutover final | `raw/2026-08-13T054016.798Z-spike-b-cutover/result.json` | `1331d191ca8e3150c4e9b9bec7461fbc3909c6130cab63d840206e652d43a5f9` |
| Policy consistency | `raw/2026-08-13T054133.049Z-spike-c/result.json` | `45f6c7bdbfef31372fbdd0bf918e53337efae7f474e9fd17c30996e84dcfe155` |
| Domain Package | `raw/2026-08-13T054211.246Z-spike-d/result.json` | `3bed5abf314a0e7742308db416f641fdda847db267d4d557200829546bb69a3f` |
| Final unit tests | `raw/2026-08-13T054747.162Z-unit-tests/result.json` | `11320d1a965adfe86ec735593cd35ff047892c4cee504dd406f066389448b971` |
| Final environment | `raw/2026-08-13T054802.769Z-environment/environment.json` | `15ee2a437b2ce77a7d487e5dbff61afd1be404f4f008779f6d505141f56f7e49` |

原始目录被 `.gitignore` 排除，避免大体积计划文件和重复结果进入源码提交；本清单与四份摘要保留稳定索引和结果哈希。独立 Spike 目录未初始化为 Git 仓库，所以 `gitRevision=null`，内容指纹是本轮冻结标识。
