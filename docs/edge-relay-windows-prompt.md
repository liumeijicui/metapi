# 边缘转发子项目（Edge Relay CLI）实施提示词 — Windows 本地版

> 用途：把这份文档交给**本地（Windows）环境里的编码助手**，或你自己照着做，在**本仓库内**
> 新增一个「只做转发」的独立子项目。文档写清了目标、设计取舍、逐文件改动、验收命令和
> 必须避开的坑，照做即可，不需要重新调研。
>
> 本文是**内部工程提示词**，不是面向用户的产品文档，不需要进 VitePress 侧边栏。
>
> 所有路径与行号基于当前 `main` 分支。动手前先 `git log --oneline -3` 核对基线，
> 如果行号对不上，以代码为准（本文所有结论都给了可复现的搜索方式）。

---

## 0. 目标与交付物

**一句话目标**：在仓库内新增 `src/server/edge/` —— 一个类似 CLI 的独立子项目（自己的入口、
自己的 `.env`、自己的数据目录、自己的端口），**复用主服务现成的转发代码**
（`proxy-core` / `transformers` / `tokenRouter` / `upstreamRequestBuilder` / `routes/proxy/*`），
只对外提供 **`/v1` 转发** + **一个只读状态接口** + **从服务器拉取配置**，
**不启动任何定时任务或后台任务**。

**交付物**

1. `src/server/edge/` 子项目（目录结构见 §3.2）。
2. `package.json` 增加 2 个脚本：`edge`（tsx 直跑）、`edge:start`（跑编译产物）。
3. 静态边界测试 `src/server/edge/edgeBoundary.architecture.test.ts`（§5.1），
   用代码**锁死**「边缘入口永不引入调度器」这条约束。
4. `docs/change-log.md` 顶部新增一条（编号见 §11）。
5. **不改**主服务行为：`src/server/index.ts` 与 `dist/server/index.js` 的启动路径、部署方式全部保持原样。

**为什么要做**（一句话）：服务器上行只有 ~500 KB/s，大上下文请求的「首字节」被**上传请求体**的
时间拖掉好几秒；让请求体从**本机**出口上传，这几秒就消失了。而转发之外的活（签到 / 重登 /
采集 / 备份）必须留在服务器，所以本地实例**只做转发**。

---

## 1. 为什么用「独立子项目」而不是给主入口加开关

需求原话：*「在项目目录下建个类似 cli 的子项目，看能不能引用原先的代码，然后只做转发部分」*。

| 维度 | 给 `index.ts` 加 `edgeMode` 开关 | **独立子项目（采用）** |
| --- | --- | --- |
| 误启调度器 | 靠一个 `if` 包住 20 多行启动代码，将来新增调度器很容易漏进去 | **静态边界**：新入口根本不 `import` 那些模块，漏不掉（§5.1 还加测试锁死） |
| 主服务回归 | 每次改动都可能波及线上 | 主入口一行不改 |
| 运行面隔离 | 和主服务共用 `.env` / 端口 / 数据目录，容易误连服务器库 | 自带 `.env.edge` + 端口 `30086` + `DATA_DIR=./data-edge` |
| 构建成本 | — | **零**：同一个 `tsconfig.server.json`，`npm run build:server` 自动一起编译 |
| 代码重复 | 无 | 无（同一份代码，只换入口） |

**关键判断**：这不是「复制一份转发代码」，而是「在**同一份代码**上换一个入口」。
转发链路约 **3.5 万行**，重写等于把所有坑重踩一遍，且两边会永久漂移，坚决不要。

---

## 2. 可行性结论（已在本仓库静态验证过，别重复调研）

从 `src/server/routes/proxy/router.ts` 出发做了一遍 import 图遍历（含全部传递依赖）：

- 可达模块 **264 个**。其中（均不含 `*.test.ts`）：
  - `src/server/proxy-core`：**49 文件 / 11,169 行**
  - `src/server/transformers`：**76 文件 / 19,109 行**
  - `src/server/services/tokenRouter.ts`：**3,904 行**
  - `src/server/services/upstreamRequestBuilder.ts`：**943 行**
- **这些模块在 import 期没有任何副作用**：全图没有顶层「裸调用」语句，没有模块级
  `setInterval` / `setTimeout`。唯一的 import 期副作用是
  `src/server/db/index.ts:1476` 的 `let activeDb: AppDb = initDb();`（打开数据库连接，属预期行为）。
- 所有定时/后台任务的启动点**集中在** `src/server/index.ts:281`–`:312`，全是显式调用。

> **结论**：只要新入口不 `import` 那些 `start*` 模块，就不会有任何后台任务。
> 这就是整个方案成立的地基。动手前建议自己重跑一遍这个检查（§9.2 给了脚本）。

**已知的「静态可达但不会被调用」的模块**：转发路径会传递 import 到
`services/assistedLogin/*`、`services/oauth/*`、`services/linuxdoSession/*`。
它们顶层同样无副作用，**转发路径里没有任何调用点**（全仓 `createManagedBrowser` 只有一个调用点：
`src/server/services/assistedLogin/sessionService.ts:229`）。所以边缘实例**不会自己拉起浏览器**。

**顺带一个必须知道的降级行为**：`services/cloudflareClearance.ts` 被 `platforms/newApi.ts` 引入，
属于转发路径可达。它的 `runRefresh()` 第一件事是取 `assistedLoginSessions.get('linuxdo')`，
取不到就直接失败返回（`src/server/services/cloudflareClearance.ts:129`–`:131`：
`Linux.do 辅助登录会话未注册，无法过 Cloudflare 验证`）。
⇒ 本地遇到有 Cloudflare 盾的站点会「拿不到 clearance → 403 / 挑战页」，**这是预期**，别试图在本地过盾。

---

## 3. 目录与构建布局

### 3.1 三个方案，选 A

**方案 A（采用）：`src/server/edge/`**
- 编译：`tsconfig.server.json` 的 `rootDir` 是 `src/server`、`include` 是 `src/server/**/*.ts`
  （见 `tsconfig.server.json`），所以新目录**自动被编译**到 `dist/server/edge/`，**零配置改动**。
- 类型检查：`npm run typecheck:server` 自动覆盖新代码。
- 导入：同工程内相对导入（`../proxy-core/...`），不需要任何路径别名。
- 部署：`dist/server/index.js` 的产物路径完全不变。

**方案 B（不采用）：根目录 `packages/edge-relay/` + npm workspaces + TS project references**
需要 (a) 把仓库改造成 workspaces，(b) 给 `src/server` 打开 `composite: true` 并产出 `.d.ts`，
(c) 重排 `build:server` 的输出路径 —— 而现网部署依赖 `dist/server/index.js`。
单人本地用不值这个代价。只有将来要**单独发布**这个子项目时才考虑。

**方案 C（备选，不推荐）：根目录 `edge/` + 独立 `tsconfig.edge.json`（`rootDir: "."`）**
会把整个 `src/server` 重新编译到 `dist/edge/src/server/...`（重复产物、路径变深）。
只有必须把子项目物理移出 `src/server` 时才这么做。

> ⚠️ **不要把 `edge/` 放进 `src/server/proxy-core/` 或 `src/server/transformers/`**：
> `scripts/dev/repo-drift-check.ts` 对这两个目录有额外规则
> （`:105` transformers 禁 import `routes/proxy/*`；`:122` proxy-core import `routes/proxy/*`
> 属「已登记债务、不许增长」）。放在 `src/server/edge/` 不会触发任何规则。

### 3.2 目标目录结构

```
src/server/edge/
├── main.ts                            # 入口：校验闸门 → 初始化库 → 拉配置 → 挂最小路由 → listen
├── edgeEnv.ts                         # METAPI_EDGE_* 环境变量解析与校验（含「拒绝共用默认数据目录」）
├── configSync.ts                      # 从服务器拉 accounts + preferences，灌进本地库
├── localSettingsPolicy.ts             # 本地必须「覆盖 / 忽略 / 同步」的 settings 清单
├── statusRoutes.ts                    # GET /api/edge/status（只读，不回传任何令牌）
├── edgeBoundary.architecture.test.ts  # 静态边界测试（§5.1）
└── README.md                          # 子项目说明：怎么跑、怎么接客户端、怎么排错
```

`package.json` 新增脚本（放在 `scripts` 里 `start` 附近）：

```json
"edge": "tsx src/server/edge/main.ts",
"edge:start": "node dist/server/edge/main.js",
```

> `edge` 用 `tsx` 直跑源码（`tsx` 已是 devDependency，见 `package.json`，`scripts/dev/run-server.ts`
> 也是同一套路）；`edge:start` 跑 `npm run build:server` 的产物，二者行为一致，按喜好选。

---

## 4. 子项目的运行面：要什么、明确不要什么

### 4.1 必须复用（**不要重写**）

| 关注点 | 复用对象 | 位置 |
| --- | --- | --- |
| Fastify 实例选项（含 `bodyLimit`） | `buildFastifyOptions()` | `src/server/config.ts:206`（默认 20MB，`DEFAULT_REQUEST_BODY_LIMIT` 在 `:5`） |
| 管理令牌鉴权 | `authMiddleware` | `src/server/middleware/auth.ts`（`/api/*` 用） |
| 下游 `sk-` 鉴权 | `proxyAuthMiddleware` → `authorizeDownstreamToken` | `src/server/middleware/auth.ts:128`、`:154`；`src/server/services/downstreamApiKeyService.ts:418` |
| 转发路由（chat / messages / responses / models / embeddings / search / files / rerank / images / videos / gemini） | `proxyRoutes` | `src/server/routes/proxy/router.ts:15`，由 `src/server/index.ts:251` 注册 |
| 选路 | `services/tokenRouter.ts`（含 1500ms 缓存，见 `:1097`/`:1099`/`:1100`） | — |
| 协议转换 / 请求构造 | `proxy-core/*`、`transformers/*`、`services/upstreamRequestBuilder.ts` | — |
| 运行时库初始化 | `ensureRuntimeDatabaseReady()` | `src/server/runtimeDatabaseBootstrap.ts:24` |
| 兼容列迁移（写日志要用） | `db/index.ts` 的 `ensureSiteCompatibilityColumns` / `ensureRouteGroupingCompatibilityColumns` / `ensureProxyFileCompatibilityColumns` / `ensureProxyLogStreamTimingColumns` / `ensureProxyLogClientColumns` / `ensureProxyLogDownstreamApiKeyIdColumn` / `ensureProxyLogBillingDetailsColumn` | 与 `src/server/index.ts:189`–`:194`、`:204` 一致 |
| settings 热加载（纯赋值） | `applyRuntimeSettings()` | `src/server/runtimeSettingsHydration.ts:41`（**不含任何调度器调用**，已核对） |
| 路由重建 | `routeRefreshWorkflow.rebuildRoutesOnly()` | `src/server/services/routeRefreshWorkflow.ts:8` |
| 配置导入 | `importBackup()` | `src/server/services/backupService.ts:1870` |
| 缓存失效 | `invalidateTokenRouterCache()` / `invalidateSiteProxyCache()` | `services/tokenRouter.ts:1255`、`services/siteProxy.ts:469` |

### 4.2 明确**不许** import / 调用（= 防双跑清单）

`src/server/index.ts` 在 `:281`–`:312` 启动的这一串，**一个都不许出现在边缘代码里**：

| 模块 | 启动点 |
| --- | --- |
| `services/checkinScheduler.js`（`startScheduler`） | `index.ts:281` |
| `services/backupService.js` 的 `reloadBackupWebdavScheduler` | `index.ts:282`（定义 `backupService.ts:2066`） |
| `services/siteAnnouncementPollingService.js` | `index.ts:296` |
| `services/modelAvailabilityProbeService.js` | `index.ts:297` |
| `services/modelMonitorService.js` | `index.ts:298` |
| `services/xapiKeyService.js` | `index.ts:299` |
| `services/channelRecoveryProbeService.js` | `index.ts:300` |
| `services/sub2apiRefreshScheduler.js` | `index.ts:301` |
| `services/assistedLogin/watchers.js` | `index.ts:302` |
| `services/updateCenterPollingService.js` | `index.ts:303` |
| `services/usageAggregationService.js` | `index.ts:304` |
| `services/adminSnapshotWarmService.js` | `index.ts:305` |
| `services/oauth/localCallbackServer.js` | `index.ts:307` |
| `services/proxyLogRetentionService.js` / `services/proxyFileRetentionService.js` | `index.ts:311`–`:312` |
| `services/managedBrowserReaper.js`（`reapStrandedManagedBrowsersAndWait`） | `index.ts:334` |

> **注意一个细节**：`importBackup()` 本身和 `reloadBackupWebdavScheduler()` 在**同一个文件**
> （`services/backupService.ts`）。ESM 是模块级加载，`import { importBackup } from '../services/backupService.js'`
> 会把整个模块的顶层代码执行一遍 —— 已核实该文件顶层只有变量声明与常量（无副作用），
> 所以**可以**这样 import。要禁的是「**调用** `reloadBackupWebdavScheduler`」。

### 4.3 可选（第一阶段不做）

- 静态前端（`fastifyStatic` + SPA fallback，`index.ts:257`–`:278`）：边缘只需要 `/v1`，不需要页面。
  如果你希望在本地也能点开一个 UI，**改成让本地浏览器直接打开服务器地址**，不要在边缘实例里托管前端。
- `/api/edge/*` 之外的任何管理接口：配置编辑统一在服务器做（§6.6）。

---

## 5. 防双跑（这是本需求的核心，单独一章）

三层防护，缺一不可。

### 5.1 第一层：静态边界（把约束写成测试）

`AGENTS.md` 要求「新增边界模块要配架构测试」。本仓库已有同类实现可参照：
`scripts/dev/repo-drift-check.ts`（规则定义在 `:105` 起）。

新增 `src/server/edge/edgeBoundary.architecture.test.ts`，断言三件事：

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EDGE_DIR = 'src/server/edge';

/** 边缘入口绝不允许引入的模块（= index.ts:281-312 的调度器 + 会拉浏览器的模块）。 */
const FORBIDDEN = [
  'checkinScheduler',
  'managedBrowserReaper',
  'siteAnnouncementPollingService',
  'modelAvailabilityProbeService',
  'modelMonitorService',
  'xapiKeyService',
  'channelRecoveryProbeService',
  'sub2apiRefreshScheduler',
  'assistedLogin/watchers',
  'updateCenterPollingService',
  'usageAggregationService',
  'adminSnapshotWarmService',
  'oauth/localCallbackServer',
  'proxyLogRetentionService',
  'proxyFileRetentionService',
  'reloadBackupWebdavScheduler',
];

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listSourceFiles(full);
    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

describe('edge relay boundary', () => {
  it('边缘子项目不得引入任何调度器/后台任务模块', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(EDGE_DIR)) {
      if (file.endsWith('.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN) {
        if (source.includes(forbidden)) offenders.push(`${file} -> ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('主服务入口不得引入边缘子项目', () => {
    const indexSource = readFileSync('src/server/index.ts', 'utf8');
    expect(indexSource.includes("'./edge/")).toBe(false);
  });
});
```

`FORBIDDEN` 里刻意用「子串匹配」而不是精确 import 路径 —— 这样别名、相对路径、动态
`import()` 都能覆盖到；`reloadBackupWebdavScheduler` 是**函数名**匹配，防止有人图省事直接调。

### 5.2 第二层：运行闸门（进不来、也跑不到服务器库上）

`edgeEnv.ts` + `main.ts` 开头做三件事，任一不满足就**打印原因并 `process.exit(1)`**：

1. `METAPI_EDGE_MODE` 必须是 `1/true/yes/on`。防止有人把边缘入口当主服务启动。
2. `DATA_DIR` 必须显式指定，且**不等于默认值 `./data`**（默认值见 `src/server/config.ts:67`
   `const dataDir = env.DATA_DIR || './data';`）。
   再算一次绝对路径，如果它等于主服务数据目录（或该目录下已存在 `hub.db` 且带主服务标记），直接拒绝启动。
   启动日志里**打印数据目录的绝对路径**，方便肉眼确认。
3. 端口必须是 `30086`（或至少 != 主服务端口），`HOST` 必须是 `127.0.0.1`。
   注意 `HOST` 的默认值是 `0.0.0.0`（`src/server/config.ts:62` 定义 `parseListenHost`，`:118` 使用），
   不显式设置就是**局域网裸奔**，你所有上游密钥都在这个端口后面。

> 建议在本地数据目录里落一个 `edge-instance.json` 标记（含 `role: 'edge'`、`createdAt`）。
> 这样「误把 DATA_DIR 指向 `./data`」时可以用标记文件再兜一层。

### 5.3 第三层：**不要**复用这两个服务器侧实现

这两条非常容易踩，因为它们看起来「最省事」：

1. **不要复用 `POST /api/settings/backup/import` 这条路由做本地同步。**
   服务器那条路由在导入到 `backup_webdav_config_v1` 时会调用
   `reloadBackupWebdavScheduler()`（`src/server/routes/api/settings.ts:1873`，另一条 webdav 导入路由在 `:1952`），
   边缘实例一旦触发就会去传 WebDAV 备份、污染服务器备份。
   ⇒ 边缘**直接调服务函数 `importBackup()`**，并且用自己写的「安全应用」逻辑处理 settings。
2. **不要复用 `applyImportedSettingToRuntime()`**（`src/server/routes/api/settings.ts:335`）。
   它在 `checkin_cron` / `checkin_schedule_mode` / `checkin_interval_hours` 三个分支里会调
   `updateCheckinSchedule(...)`（`:340`、`:351`、`:362`）—— 那正是**签到调度器**。
   ⇒ 边缘只用 `applyRuntimeSettings()`（`runtimeSettingsHydration.ts:41`，纯赋值，无调度器）。

### 5.4 证明「真的没跑」的验收方式

- 启动后观察 ≥3 分钟：日志里不得出现任何签到 / 余额 / 采集 / 公告 / 浏览器关键字。
- 本地库 `checkin_logs` 必须**始终为空**，`accounts.last_checkin_at` 不应被本地实例改动。
- `/api/edge/status` 里回报 `startedSchedulers: []`（见 §7.2）。

---

## 6. 配置同步设计

### 6.1 拉哪两份

| 用途 | 请求 | 说明 |
| --- | --- | --- |
| 账号/站点/路由 | `GET {server}/api/settings/backup/export?type=accounts` | 路由 `src/server/routes/api/settings.ts:1852`，`type` 只接受 `all/accounts/preferences`（`:1853`–`:1856`） |
| 设置项 | `GET {server}/api/settings/backup/export?type=preferences` | 同一路由；内容 = 除 `auth_token` / `db_type` / `db_url` / `db_ssl` 外的全部 settings |

认证：`Authorization: Bearer {服务器的 AUTH_TOKEN}`（本地实例自己的 `AUTH_TOKEN` 是另一把，见 §7.1）。

- `accounts` 段包含 **10 张表**（`exportAccountsSection()`，`src/server/services/backupService.ts:1300`，
  返回结构 `:1336`）：`sites`、`siteApiEndpoints`、`accounts`、`accountTokens`、`tokenRoutes`、
  `routeChannels`、`routeGroupSources`、`siteDisabledModels`、`manualModels`、`downstreamApiKeys`。
- `preferences` 段由 `exportPreferencesSection()` 产出，排除项见 `EXCLUDED_SETTING_KEYS`
  （`src/server/services/backupService.ts:234`）。

⚠️ **为什么必须也拉 `preferences`**：转发**行为**受一堆 settings 影响 —— `payload_rules`、
`proxy_error_keywords`、`proxy_empty_content_fail_enabled`、`global_blocked_brands`、
`global_allowed_models`、`disable_cross_protocol_fallback`、
`responses_compact_fallback_to_responses_enabled`、`codex_upstream_websocket_enabled`、
`codex_header_defaults`、`routing_weights`、`proxy_first_byte_timeout_sec`、
`token_router_failure_cooldown_max_sec`、`proxy_session_channel_concurrency_limit`、
`model_availability_probe_enabled` …（完整清单看 `applyRuntimeSettings()`
`src/server/runtimeSettingsHydration.ts:41` 的实现）。
**只拉 accounts 会让本地用默认值跑，行为和服务器不一致** —— 这是最容易「转发看起来通、结果答案/重试
行为不一样」的原因。

### 6.2 本地必须覆盖 / 忽略的 settings

在 `localSettingsPolicy.ts` 里写死三张清单：

| 分类 | key | 本地处理 | 原因 |
| --- | --- | --- | --- |
| **覆盖** | `system_proxy_url` | 强制设为本地值（默认**空字符串**） | 服务器那份是 `http://127.0.0.1:7890`，本地照抄会 `ECONNREFUSED`。注意它不只是 `config.systemProxyUrl`，还被 `src/server/services/siteProxy.ts:195` 从 **settings 表**直接读 |
| **忽略** | `backup_webdav_config_v1` | 不写入本地 | 服务器备份配置；边缘不跑备份调度器 |
| **忽略** | `checkin_cron` / `checkin_schedule_mode` / `checkin_interval_hours` / `balance_refresh_cron` | 可写入但不生效 | 边缘不启调度器；写进去无害，但别误以为本地会签到 |
| **忽略** | `log_cleanup_*` / `update_center_*` | 同上 | 同上 |
| **忽略** | 通知类（`webhook_*` / `bark_*` / `serverchan_*` / `telegram_*` / `smtp_*`） | 同上 | 边缘不发通知 |
| **同步** | 其余全部 | 正常写入 | 影响转发行为，必须与服务器一致 |

`auth_token` / `db_type` / `db_url` / `db_ssl` 本来就不在导出里（`EXCLUDED_SETTING_KEYS`），
本地靠环境变量/`.env.edge` 决定，正好。

### 6.3 重复同步的安全性（**必须理解这一段**）

`importAccountsSection()`（`src/server/services/backupService.ts:1527`）**不是 upsert，是清空重建**：

1. 先抓本地运行态快照 `collectCurrentRuntimeStateSnapshot()`（`:1528`）；
2. 然后在事务里 `delete` 掉 `proxyLogs` / `routeChannels` / `routeGroupSources` / `tokenRoutes` /
   `tokenModelAvailability` / `modelAvailability` / `accountTokens` / `accounts` / `sites`
   （`:1536`–`:1546`）；
3. 再按导出的数据重建，并把快照里的**本地** `proxyLogs` / `checkinLogs` / 通道计数 / 可用性
   按身份键重新插回（`:1662` 起的通道运行态、`:1785` 起的 `runtimeState.proxyLogs`、最后 `checkinLogs`）。

由此得到三条硬结论：

- ✅ 反复同步**不会**丢本地的转发日志和通道健康度（有回插机制）。
- ❌ **本地自己新建的 site / account / route 会在下次同步时被抹掉** ⇒ 本地库只能当**镜像**，
  配置改动一律在服务器上做（见 §6.6）。
- ⚠️ 每次同步是「全表重写 + 全量回插」，行数多了（几万条 `proxy_logs`）会明显变慢
  ⇒ **必须做变更去抖**：对 `accounts` 段做规范化哈希（`JSON.stringify` 前按 key 排序、
  剔除 `timestamp` 之类易变字段），哈希没变就跳过导入，只更新 `lastCheckedAt`。

### 6.4 导入之后必须让缓存失效

```ts
import { invalidateTokenRouterCache } from '../services/tokenRouter.js';
import { invalidateSiteProxyCache } from '../services/siteProxy.js';
import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';

invalidateTokenRouterCache();   // services/tokenRouter.ts:1255
invalidateSiteProxyCache();     // services/siteProxy.ts:469
await routeRefreshWorkflow.rebuildRoutesOnly();   // services/routeRefreshWorkflow.ts:8
```

选路本身有 1500ms 缓存（`tokenRouter.ts:1097`/`:1099`，值来自 `config.tokenRouterCacheTtlMs`，
默认见 `src/server/config.ts:129`），加上同步间隔，服务器改配置后本地最长「1.5s + 一个同步周期」生效。

### 6.5 同步时序与失败策略

- 启动时同步一次；成功后按 `edgeConfigSyncIntervalMs`（默认 **5 分钟**）循环。
- **单飞**：同一时刻只允许一次同步（用 `syncInFlight: Promise | null` 复用进行中的那次），
  慢的同步不会堆积。
- 失败**绝不退出进程**：保留本地旧配置继续服务，把错误暴露到 `/api/edge/status`。
- 定时器 `unref()`，别让它挡着进程退出。

### 6.6 配置编辑放服务器，本地只读 + 定时拉取

用户诉求是「本机只用转发和转发配置功能」。为避免双向同步冲突：**本地页面的配置编辑直连服务器地址**
（浏览器打开服务器 UI 即可），本地实例**只做只读同步**。

> 如果确实要在本地改完再推回服务器，作为**第二阶段**再做（用服务器现成的
> `PUT/POST /api/model-forward-rules`、`/api/downstream-keys` 等接口）。
> 第一阶段不要碰，先把转发跑通。

---

## 7. 实施步骤

### 阶段 A：搭骨架

1. 新建 §3.2 的目录与空文件。
2. `package.json` 加 `edge` / `edge:start` 两个脚本。
3. 写 `src/server/edge/README.md`：怎么配 `.env.edge`、怎么启动、怎么给客户端改 `base_url`、
   出问题先看哪三个地方（`/api/edge/status`、日志里的数据目录绝对路径、`proxy_logs` 行数）。

### 阶段 B：`edgeEnv.ts`（闸门）

```ts
import { config } from '../config.js';
import { resolve } from 'node:path';

export type EdgeEnv = {
  configSourceUrl: string;
  configSourceToken: string;
  syncIntervalMs: number;
  dataDirAbsolute: string;
};

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/** 校验所有边缘模式前提；不满足就抛出带原因的错误，由 main.ts 退出。 */
export function readEdgeEnv(env: NodeJS.ProcessEnv = process.env): EdgeEnv {
  if (!parseBoolean(env.METAPI_EDGE_MODE)) {
    throw new Error('METAPI_EDGE_MODE 未开启：这个入口只用于边缘转发，不能当主服务启动。');
  }

  const rawDataDir = (env.DATA_DIR || '').trim();
  if (!rawDataDir) {
    throw new Error('必须显式设置 DATA_DIR（例如 ./data-edge），避免和主服务共用数据目录。');
  }
  const dataDirAbsolute = resolve(rawDataDir);
  if (dataDirAbsolute === resolve('./data')) {
    throw new Error('DATA_DIR 不能是默认的 ./data，那是主服务的数据目录。');
  }

  if ((env.HOST || '') !== '127.0.0.1') {
    throw new Error('HOST 必须是 127.0.0.1，否则同局域网可以直接访问你的转发端口。');
  }

  return {
    configSourceUrl: (env.METAPI_EDGE_CONFIG_SOURCE_URL || '').trim().replace(/\/+$/, ''),
    configSourceToken: (env.METAPI_EDGE_CONFIG_SOURCE_TOKEN || '').trim(),
    syncIntervalMs: Math.max(30_000, Number(env.METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS || 5 * 60_000)),
    dataDirAbsolute,
  };
}

export function describeEdgeRuntime(edge: EdgeEnv) {
  const port = config.port;
  return { port, dataDir: edge.dataDirAbsolute, configSource: edge.configSourceUrl };
}
```

> 这些 `METAPI_EDGE_*` 变量**不要**塞进 `src/server/config.ts`：那是主服务的共享配置文件，
> 少改一行就少一份回归风险。（如果确实需要 `config.edgeMode` 给共享代码用，再单独评估。）

### 阶段 C：`main.ts`（入口）

按下面顺序，**不要多也不要少**：

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { buildFastifyOptions, config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { isPublicApiRoute } from '../desktop.js';
import { proxyRoutes } from '../routes/proxy/router.js';
import {
  db,
  ensureProxyFileCompatibilityColumns,
  ensureProxyLogBillingDetailsColumn,
  ensureProxyLogClientColumns,
  ensureProxyLogDownstreamApiKeyIdColumn,
  ensureProxyLogStreamTimingColumns,
  ensureRouteGroupingCompatibilityColumns,
  ensureSiteCompatibilityColumns,
  runtimeDbDialect,
  schema,
} from '../db/index.js';
import { ensureRuntimeDatabaseReady } from '../runtimeDatabaseBootstrap.js';
import { applyRuntimeSettings } from '../runtimeSettingsHydration.js';
import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';
import { readEdgeEnv } from './edgeEnv.js';
import { startEdgeConfigSync, stopEdgeConfigSync, syncEdgeConfig } from './configSync.js';
import { edgeStatusRoutes } from './statusRoutes.js';

const edge = readEdgeEnv();

// 1) 运行时库（边缘自己的 DATA_DIR）
await ensureRuntimeDatabaseReady({
  dialect: runtimeDbDialect,
  connectionString: config.dbUrl,
  ssl: config.dbSsl,
});

// 2) 兼容列：写日志要用（对齐 src/server/index.ts:189-194、:204）
await ensureSiteCompatibilityColumns();
await ensureRouteGroupingCompatibilityColumns();
await ensureProxyFileCompatibilityColumns();
await ensureProxyLogStreamTimingColumns();
await ensureProxyLogClientColumns();
await ensureProxyLogDownstreamApiKeyIdColumn();
await ensureProxyLogBillingDetailsColumn();

// 3) 设置项热加载（纯赋值，不含调度器）
const rows = await db.select().from(schema.settings).all();
applyRuntimeSettings(new Map(rows.map((row) => [row.key, String(row.value)])));

// 4) 首次拉配置（失败不退出）
await syncEdgeConfig();

// 5) 重建路由
await routeRefreshWorkflow.rebuildRoutesOnly();

// 6) 最小 HTTP 面：/api/edge/*  +  /v1/*
const app = Fastify(buildFastifyOptions(config));
await app.register(cors);
app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/') && !isPublicApiRoute(request.url)) {
    await authMiddleware(request, reply);
  }
});
await app.register(edgeStatusRoutes);
await app.register(proxyRoutes);

app.addHook('onClose', async () => {
  stopEdgeConfigSync();
});

await app.listen({ port: config.port, host: config.listenHost });
startEdgeConfigSync();
console.log(`[edge] 数据目录: ${edge.dataDirAbsolute}`);
console.log('[edge] 已启动的调度器: 无（本进程只做转发）');
```

**不要**做的事：`registerDesktopRoutes`（不需要）、`fastifyStatic`（不托管前端）、
`repairStoredCreatedAtValues` / `migrateSiteApiKeysToAccounts` / `ensureDefaultSitesSeeded`
（都是主服务的初始化逻辑，会把本地镜像库灌进默认站点）、`reapStrandedManagedBrowsersAndWait`。

### 阶段 D：`configSync.ts`

骨架（按你的 `edgeEnv` 实际命名调整）：

```ts
import { createHash } from 'node:crypto';
import { importBackup } from '../services/backupService.js';
import { invalidateTokenRouterCache } from '../services/tokenRouter.js';
import { invalidateSiteProxyCache } from '../services/siteProxy.js';
import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';
import { readEdgeEnv } from './edgeEnv.js';
import { applyLocalSettingsPolicy } from './localSettingsPolicy.js';

const edge = readEdgeEnv();

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<SyncResult> | null = null;
let lastSyncAt: string | null = null;
let lastSyncError: string | null = null;
let lastAccountsHash: string | null = null;

export type SyncResult = { ok: true; imported: boolean; at: string } | { ok: false; message: string };

export function syncEdgeConfig(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchSection(type: 'accounts' | 'preferences'): Promise<unknown> {
  const response = await fetch(`${edge.configSourceUrl}/api/settings/backup/export?type=${type}`, {
    headers: { authorization: `Bearer ${edge.configSourceToken}` },
  });
  if (!response.ok) throw new Error(`配置源 ${type} 返回 HTTP ${response.status}`);
  return await response.json();
}

/** 稳定序列化：递归排序对象 key，并剔除易变字段（timestamp 之类）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'timestamp' && key !== 'exportedAt')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

function stableAccountsHash(section: unknown): string {
  return createHash('sha256').update(stableStringify(section)).digest('hex');
}

async function runSync(): Promise<SyncResult> {
  if (!edge.configSourceUrl) return { ok: false, message: '未配置 METAPI_EDGE_CONFIG_SOURCE_URL' };
  try {
    const accounts = await fetchSection('accounts');

    const hash = stableAccountsHash(accounts);
    if (hash === lastAccountsHash) {
      lastSyncAt = new Date().toISOString();
      lastSyncError = null;
      return { ok: true, imported: false, at: lastSyncAt };
    }

    const preferences = await fetchSection('preferences');
    // 导出接口直接返回裸 BackupV2，没有 { success, data } 包装。
    await importBackup(accounts as Parameters<typeof importBackup>[0]);
    await applyLocalSettingsPolicy(preferences as Parameters<typeof importBackup>[0]);

    invalidateTokenRouterCache();
    invalidateSiteProxyCache();
    await routeRefreshWorkflow.rebuildRoutesOnly();

    lastAccountsHash = hash;
    lastSyncAt = new Date().toISOString();
    lastSyncError = null;
    return { ok: true, imported: true, at: lastSyncAt };
  } catch (error) {
    lastSyncError = (error as Error)?.message || 'unknown error';
    return { ok: false, message: lastSyncError };
  }
}

export function startEdgeConfigSync(): void {
  timer = setInterval(() => { void syncEdgeConfig(); }, edge.syncIntervalMs);
  timer.unref?.();
}

export function stopEdgeConfigSync(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function getEdgeConfigSyncState() {
  return { lastSyncAt, lastSyncError, intervalMs: edge.syncIntervalMs };
}
```

> **务必先用 curl / 浏览器实测一次**这两个导出接口，确认响应形状：
> `exportBackup()`（`backupService.ts:1387`）是**直接返回 `BackupV2` 作为响应体**，
> 服务器路由也是 `return await exportBackup(type)`（`settings.ts:1858`），**没有** `{ success, data }` 包装。
> 这是最容易搞错的一处，按实际形状取。

### 阶段 E：`localSettingsPolicy.ts`

职责：把 `preferences` 段写进本地 settings 表，但按 §6.2 的三张清单处理：

- **覆盖**：写完后再写一次 `system_proxy_url`（本地值，默认 `''`），确保覆盖同步来的服务器值。
- **忽略**：`backup_webdav_config_v1` 等直接跳过，**不要**写本地。
- **同步**：其余原样写入。

写完后**再** `applyRuntimeSettings(最终 settings map)` 一次，让 `config` 反映本地值
（顺序很重要：先落库、再热加载，否则热加载到的是服务器那份代理地址）。

### 阶段 F：`statusRoutes.ts`

`GET /api/edge/status`（走 `authMiddleware`，即需要本地 `AUTH_TOKEN`）返回：

```ts
{
  edgeMode: true,
  startedSchedulers: [],            // 恒为空数组，作为「没跑调度器」的显式证据
  dataDir: '/abs/path/to/data-edge',
  port: 30086,
  configSource: { url: '...', hasToken: true },   // 不回传令牌明文
  intervalMs: 300000,
  lastSyncAt: '2026-10-08T…',
  lastSyncError: null,
  onlyForwarding: true,
}
```

**绝不回传**任何令牌、密钥、账号凭据。

---

## 8. Windows 前置环境

### 8.1 必装

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| **Node.js** | **必须 ≥ 25.0.0** | `package.json:24` 的 `engines`；`.nvmrc` = `25.0.0`；CI 用 `NODE_VERSION: 25`（`.github/workflows/ci.yml:23`）。低于 25 会在安装/运行阶段报错 |
| Node 版本管理器 | 任选 | 推荐 `fnm` 或 `nvm-windows`（`nvm use 25`） |
| **Git** | 任意较新版 | 需要在 PATH 里 |
| **Visual Studio Build Tools 2022** | 勾选「使用 C++ 的桌面开发」 | `better-sqlite3` / `sharp` 是原生模块，没有预编译产物时要现场编译 |
| Python 3 | 3.10+ | `node-gyp` 依赖；安装时勾选「Add to PATH」 |

```powershell
node -v          # 必须是 v25.x.x
npm -v
git --version
python --version
```

### 8.2 克隆与安装

```powershell
git clone https://github.com/liumeijicui/metapi.git
cd metapi
npm ci
```

> 仓库里同时有 `package-lock.json` 和 `pnpm-lock.yaml`。**用 `npm ci`**（CI 也是 npm：
> `.github/workflows/ci.yml:66` 的 `cache: npm` + `:69` 的 `npm ci`）。不要用 pnpm，
> 否则原生模块的安装路径与 CI 不一致。

### 8.3 原生模块（最常见的报错来源）

启动时报 `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` 不匹配
（`src/server/nativeModuleGuard.ts` 专门处理这类错误，`scripts/dev/run-server.ts` 会自动尝试重建），
或 `sharp` 报「找不到 win32-x64 二进制」时：

```powershell
npm rebuild better-sqlite3
npm rebuild sharp
```

绝大多数情况下 `npm ci` 会下到预编译产物；只有 Node 版本很新、预编译还没跟上时才需要重建
（此时用到 VS Build Tools + Python）。

### 8.4 自检

```powershell
npm run typecheck:server
npm run typecheck:desktop
npm run repo:drift-check
```

> 类型门分开跑，**不要**裸跑 `tsc -p tsconfig.json`（会把测试文件一起检，很慢且容易被无关项卡住）。

---

## 9. `.env.edge` 与客户端接入

### 9.1 `.env.edge`（放在仓库根，**不要提交**）

```ini
HOST=127.0.0.1
PORT=30086
DATA_DIR=./data-edge

METAPI_EDGE_MODE=1
METAPI_EDGE_CONFIG_SOURCE_URL=https://你的服务器域名
METAPI_EDGE_CONFIG_SOURCE_TOKEN=服务器的AUTH_TOKEN
METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS=300000

# 本地实例自己的管理令牌（和服务器那把无关；只用于 /api/edge/status 等管理接口）
AUTH_TOKEN=本地随便一把长随机串

# 与服务器保持一致（加密账号里 relogin 密文用；边缘不做重登，但保持一致最省事）
ACCOUNT_CREDENTIAL_SECRET=和服务器一致的值
```

启动（`config.ts:1` 是 `import 'dotenv/config'`，默认读 `./.env`；
用 `DOTENV_CONFIG_PATH` 指向 `.env.edge`，或直接把它复制成 `.env`）：

```powershell
$env:DOTENV_CONFIG_PATH=".env.edge"; npm run edge
```

⚠️ `ACCOUNT_CREDENTIAL_SECRET` 不一致的后果：`decryptAccountPassword()` 返回 `null`
（`src/server/services/accountCredentialService.ts:26`）。它只影响 `relogin` 密码密文、
导入会话 cookie（见 `accountCredentialService.ts:12`/`:26` 的调用点），边缘模式不做重登，
所以**不是致命项**，但保持一致可以少一类怪问题。`accounts.access_token` 本身是明文存储，不受影响。

### 9.2 客户端怎么接

下游密钥（`downstream_api_keys`）会随 `type=accounts` 一起拉下来，所以**本地实例接受和服务器同一把
`sk-...` 密钥**（`authorizeDownstreamToken` 按 key 字符串匹配，`services/downstreamApiKeyService.ts:418`）。
Codex / CC Switch 只需要改 `base_url`：

```
http://127.0.0.1:30086/v1
```

> 提醒：本地镜像里的 `usedCost` / `usedRequests` 是**独立累计**的。如果某把 key 在服务器上设了
> `maxCost`，本地累计不会同步回服务器，两边各自算各自的额度。

### 9.3 大请求分流（建议）

因为耗时差**只随请求体大小增长**，普通请求走服务器完全够用：

- 把**只有大上下文**的客户端（比如会涨到 200k tokens 的 Codex）指向 `http://127.0.0.1:30086/v1`；
- 其余客户端继续用服务器地址。

这样即使本地实例挂了或配置没同步上，也只影响一个客户端。

---

## 10. 验收标准（逐条执行，全部通过才算完成）

### 10.1 类型与边界

```powershell
npm run typecheck:server
npx vitest run src/server/edge/edgeBoundary.architecture.test.ts
npm run repo:drift-check
```

### 10.2 启动与闸门

```powershell
npm run build:server
$env:DOTENV_CONFIG_PATH=".env.edge"; npm run edge
```

预期：
- 日志打印数据目录的**绝对路径**，且以 `data-edge` 结尾；
- 日志里**没有** `[Scheduler]`、没有 `reaped ... stranded managed browser`；
- 故意去掉 `METAPI_EDGE_MODE` 再启动一次，必须**报错退出**（闸门有效）。

### 10.3 调度器确实没跑

观察 3 分钟；然后查本地库：

```powershell
node -e "const D=require('better-sqlite3');const d=new D('./data-edge/hub.db',{readonly:true});console.log('proxy_logs',d.prepare('SELECT COUNT(*) c FROM proxy_logs').get().c,'checkin_logs',d.prepare('SELECT COUNT(*) c FROM checkin_logs').get().c)"
```

`checkin_logs` 必须为 **0**。

### 10.4 配置拉下来了

```powershell
curl.exe -sS http://127.0.0.1:30086/api/edge/status -H "Authorization: Bearer <本地AUTH_TOKEN>"
```

应看到 `edgeMode: true`、`startedSchedulers: []`、`lastSyncAt` 是最近时间、`lastSyncError: null`。
再确认本地库里有路由与下游密钥：

```powershell
node -e "const D=require('better-sqlite3');const d=new D('./data-edge/hub.db',{readonly:true});console.log('routes',d.prepare('SELECT COUNT(*) c FROM token_routes').get().c,'channels',d.prepare('SELECT COUNT(*) c FROM route_channels').get().c,'keys',d.prepare('SELECT COUNT(*) c FROM downstream_api_keys').get().c)"
```

再直接查 `settings` 表确认本地策略生效：

```powershell
node -e "const D=require('better-sqlite3');const d=new D('./data-edge/hub.db',{readonly:true});console.log(d.prepare(\"SELECT key,value FROM settings WHERE key IN ('system_proxy_url','backup_webdav_config_v1')\").all())"
```

`system_proxy_url` 必须是空串（或你本地实际的代理），且**不能**是 `http://127.0.0.1:7890`。

### 10.5 转发真的通，而且走本地出口

用**服务器的同一把下游密钥**打本地：

```powershell
curl.exe -sS -o NUL -w "status=%{http_code} ttfb=%{time_starttransfer}s total=%{time_total}s`n" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer sk-你的下游密钥" `
  -d '{"model":"gpt-6-astra","stream":false,"max_tokens":16,"messages":[{"role":"user","content":"reply ok"}]}' `
  http://127.0.0.1:30086/v1/chat/completions
```

预期 `status=200`，且本地 `proxy_logs` 新增一条（证明请求确实由本地实例处理）。

### 10.6 效果对比

同一份大上下文请求各跑一次，比首字节（`-d` 用同一个大 body 文件、`--data-binary "@big.json"`）：

```powershell
curl.exe -sS -o NUL -w "local  ttfb=%{time_starttransfer}s total=%{time_total}s`n" ... http://127.0.0.1:30086/v1/chat/completions
curl.exe -sS -o NUL -w "server ttfb=%{time_starttransfer}s total=%{time_total}s`n" ... https://你的服务器/v1/chat/completions
```

预期本地明显更快，差值 ≈「服务器上行传这个 body 的时间」（按 ~200 KB/s 估算）。

### 10.7 回归

```powershell
npx vitest run src/server/services/backupService src/server/services/tokenRouter src/server/routes/proxy
npm run repo:drift-check
```

> 全量 `npm test` 已知有 5 个与业务无关的环境性失败（见 `docs/change-log.md` 第 83 条的验证段），
> 只要没多出新失败就算通过。

---

## 11. 提交要求

- 遵循仓库根 `AGENTS.md`：中文回复、改动尽量小且聚焦、不夹带无关清理。
- 在 `docs/change-log.md` **顶部**新增一条（编号接当前最大号 +1，当前最大是 **83**，所以是 **84**），
  格式照抄现有条目：类型 / 需求来源 / 背景 / 根因或设计 / 改动 / 验证 / 主要文件 / 状态。
  必须写清三件事：
  1. **为什么复用同一份代码**（3.5 万行转发链路 + 避免永久漂移）；
  2. **为什么关掉全部调度器**（签到对 agentrouter 这类站就是一次退出重登，两边同时跑会互踢会话并触发限流）；
  3. **静态验证结论**（264 模块 import 图无顶层副作用、调度器集中在 `index.ts:281`–`:312`）。
- 类型门 + 边界测试 + `repo:drift-check` 全过再提交。
- **不要**把任何令牌、密钥、真实站点凭据写进文档或提交历史；`.env.edge` 不要提交（确认 `.gitignore`）。

---

## 12. 必须避开的坑（逐条核对）

1. **import 任何 `start*` 调度器** —— 最危险的一条（清单见 §4.2）。
2. **复用 `POST /api/settings/backup/import` 路由做同步** —— 会 `reloadBackupWebdavScheduler()`
   （`settings.ts:1873`），边缘会去传 WebDAV 备份。用服务函数 `importBackup()`。
3. **复用 `applyImportedSettingToRuntime()`** —— `settings.ts:340`/`:351`/`:362` 会 `updateCheckinSchedule()`，
   即签到调度器。边缘只用 `applyRuntimeSettings()`。
4. **`system_proxy_url` 照抄服务器** —— 服务器是 `http://127.0.0.1:7890`，本地照抄必然 `ECONNREFUSED`；
   而且它被 `siteProxy.ts:195` 从 settings 表直接读，只改 `config` 不够。
5. **把本地库当权威** —— 同步是清空重建（`backupService.ts:1536`–`:1546`），本地自建的 site/account/route
   下次同步就没了；本地库只能是镜像。
6. **同步不做去抖** —— 全表重写 + 全量回插，日志多了会拖慢整个进程。
7. **导入后忘了失效缓存** —— 必须 `invalidateTokenRouterCache()` + `invalidateSiteProxyCache()` + `rebuildRoutesOnly()`。
8. **`HOST` 忘了设成 `127.0.0.1`** —— 默认是 `0.0.0.0`（`config.ts:62`/`:118`），等于把你的全部上游密钥
   暴露到局域网。
9. **`DATA_DIR` 与主服务共用** —— 会污染/损坏线上数据；中间件闸门里直接拒绝默认 `./data`。
10. **连服务器的 SQLite** —— SQLite 的 WAL 在网络盘（SMB/NFS）上会锁坏或直接损坏文件。本地必须用自己的库。
11. **Node 低于 25** —— 原生模块与语法都可能出问题。
12. **用 pnpm** —— 与 CI 不一致，用 `npm ci`。
13. **想在本地过 Cloudflare 盾** —— `cf_clearance` 绑定出口 IP + UA，服务器上过的盾在本地必然失效；
    而且 `runRefresh()` 在本地没有辅助登录会话时直接失败（`cloudflareClearance.ts:129`），
    不会替你拉起浏览器。有盾的站点就不要参与本地分流。
14. **忘了 `SITES_REQUIRING_SYSTEM_PROXY`** —— `src/server/services/siteProfiles.ts:22` 里的
    **10 个域名**（`happycoding.xyz`、`anyrouter.top`、`welfare.darkforger.com`、`sub2api.remixjc.cn`、
    `kunyou.asia`、`cloudcode-pa.googleapis.com`、`chinahk.qzz.io`、`motomoto.lol`、`agentrouter.org`、
    `github.com`）在服务器上是靠本地 Clash 出去的。本地要么能直连、要么自己配代理，
    否则表现为「超时 / 意外断流」。
15. **把 `edge/` 放进 `proxy-core/` 或 `transformers/`** —— 会触发 `repo-drift-check.ts:105`/`:122` 的规则。
16. **在本地放 OAuth 账号**（codex / gemini 这类 plan 账号） —— `sharedSurface.ts:358` 的
    `refreshOauthAccessTokenSingleflight` 会刷新令牌并写**本地库**，服务器不知道，服务器那份会过期。
    边缘模式建议只用普通 API Key 账号。

---

## 13. 常见故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动即报 `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` | 原生模块与 Node 版本不匹配 | `npm rebuild better-sqlite3`，并确认 Node 是 25 |
| 报 `Cannot find module '.../sharp-win32-x64'` | `sharp` 预编译没装好 | `npm rebuild sharp`；纯服务端跑可以先忽略（只有打包图标才用它） |
| 进程直接退出并提示 `METAPI_EDGE_MODE 未开启` | 闸门生效 | 确认用 `.env.edge` 启动（`dotenv/config` 读的是 `DOTENV_CONFIG_PATH`） |
| 退出并提示 `DATA_DIR 不能是默认的 ./data` | 忘配 `DATA_DIR` | 设 `DATA_DIR=./data-edge` |
| `fetch failed` / `ECONNREFUSED 127.0.0.1:7890` | 本地照抄了服务器的 `system_proxy_url` | 按 §6.2 **覆盖**为本地值 |
| `/api/edge/status` 返回 `lastSyncError: 配置源 accounts 返回 HTTP 401` | `METAPI_EDGE_CONFIG_SOURCE_TOKEN` 不是服务器的 `AUTH_TOKEN` | 换成服务器管理令牌 |
| 本地 `/v1` 返回 401 | 下游密钥没拉到 | 查 `downstream_api_keys` 行数（§10.4）；确认导出的是 `type=accounts` |
| 某站 403 `Just a moment...` | `cf_clearance` 绑定服务器出口 IP（坑 13） | 该站不参与本地分流 |
| 请求超时 / 中途断流 | 站点在 `SITES_REQUIRING_SYSTEM_PROXY` 里（坑 14） | 本地配代理，或该站走服务器 |
| 改完服务器配置本地不生效 | 选路缓存 1500ms + 同步间隔 5 分钟 | 等等，或重启本地实例 |
| 同步很慢、CPU 高 | 没做变更去抖（坑 6） | 加 `accounts` 段哈希比对 |
| 本地库里站点/账号莫名消失 | 你在本地新建过配置（坑 5） | 配置一律改在服务器上 |

---

## 14. 事实清单（快速索引）

| 事实 | 位置 |
| --- | --- |
| Node 版本要求 ≥ 25 | `package.json:24`、`.nvmrc` |
| 包管理器 = npm | `.github/workflows/ci.yml:23`（`NODE_VERSION: 25`）、`:66`（`cache: npm`）、`:69`（`npm ci`） |
| 调度器启动点（边缘一律不许 import） | `src/server/index.ts:281`–`:312`、`:334` |
| 主服务初始化顺序（边缘的裁剪依据） | `src/server/index.ts:152`、`:189`–`:194`、`:197`、`:204`–`:209` |
| `/v1` 路由注册 | `src/server/index.ts:251` → `src/server/routes/proxy/router.ts:15` |
| `buildFastifyOptions()`（含 bodyLimit 20MB） | `src/server/config.ts:206`、`:5` |
| `DATA_DIR` 默认值 / `HOST` 默认值 / 端口 | `src/server/config.ts:67`、`:62`+`:118`、`:117` |
| 选路缓存 1500ms | `src/server/config.ts:129`、`services/tokenRouter.ts:1097`/`:1099`/`:1100`；失效函数 `:1255` |
| 站点代理缓存失效 | `services/siteProxy.ts:469`；`system_proxy_url` 读取点 `:195` |
| 出口 IP 绑定的盾 | `services/cloudflareClearance.ts:129`（无会话直接失败）、`:165` |
| 需系统代理的 10 个域名 | `services/siteProfiles.ts:22` |
| 配置导出/导入路由 | `src/server/routes/api/settings.ts:1852`、`:1861`（webdav 导入在 `:1949`） |
| 导出内容（10 张表） | `services/backupService.ts:1300`、返回结构 `:1336`、`exportBackup()` `:1387` |
| 导入实现（清空重建 + 运行态回插） | `services/backupService.ts:1870`、`importAccountsSection()` `:1527`、删除清单 `:1536`–`:1546` |
| 设置排除清单 | `services/backupService.ts:234`（`EXCLUDED_SETTING_KEYS`） |
| settings 热加载（纯赋值） | `src/server/runtimeSettingsHydration.ts:41` |
| 会触发签到调度器的「危险」应用函数 | `src/server/routes/api/settings.ts:335`、`:340`、`:351`、`:362` |
| `/v1` 鉴权链 | `middleware/auth.ts:128`/`:154` → `services/downstreamApiKeyService.ts:418` |
| 凭据加密密钥派生 | `services/accountCredentialService.ts:8`（`ACCOUNT_CREDENTIAL_SECRET` → `AUTH_TOKEN` → 默认值） |
| OAuth 令牌刷新会写库 | `proxy-core/surfaces/sharedSurface.ts:358` |
| 原生模块重建守卫 | `src/server/nativeModuleGuard.ts`、`scripts/dev/run-server.ts` |
| 依赖方向规则（drift check） | `scripts/dev/repo-drift-check.ts:105`（transformers）、`:122`（proxy-core） |
| 桌面端默认端口 4000 / 连远程服务端开关 | `src/desktop/runtime.ts:26`、`src/desktop/main.ts:69` |
