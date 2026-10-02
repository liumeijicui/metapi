### 1. 每个站点独立最大并发

- **类型**：功能实现
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：允许每个站点单独设置最大并发；`0` 表示不限制；不同站点的请求不能共享同一个并发计数器。
- **实现范围**：
  - 数据库 `sites.max_concurrency` 字段，默认值为 `0`，同步更新 schema contract 和各数据库启动产物。
  - 站点创建、更新 API 支持 `maxConcurrency`，接受 `0-100000` 的整数，并拒绝越界或非整数值。
  - 站点管理页面增加最大并发输入框和表格列，保存后可以看到每个站点自己的限制值。
  - 代理请求通过站点级 lease/队列控制并发；达到上限时只等待当前站点，不阻塞其他站点。
- **主要文件**：
  - `src/server/db/schema.ts`
  - `src/server/routes/api/sites.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/siteApiEndpointService.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/web/pages/Sites.tsx`
  - `src/web/pages/helpers/sitesEditor.ts`
- **验证**：
  - `src/server/routes/api/sites.api-endpoints.test.ts` 覆盖创建、更新和越界校验。
  - `src/server/services/proxyChannelCoordinator.test.ts` 覆盖同站点排队、不同站点隔离和 `0` 不限流。
  - 本地页面实际显示 `concurrency-site` 的最大并发为 `1`，其他站点显示“不限制”。
- **状态**：已完成并在当前本地服务中运行。

### 2. Rerank 代理接口

- **类型**：功能实现
- **需求来源**：[GitHub Issue #591](https://github.com/cita-777/metapi/issues/591)
- **目标**：新增 `POST /v1/rerank`，复用现有的鉴权、模型路由、站点 API 地址池、重试、用量解析、计费和代理日志链路。
- **实现范围**：
  - 增加 Rerank 路由，校验 `model`，将请求转发到选中的上游 `/v1/rerank`。
  - 支持站点 API 地址池、首字节超时、通道重试和失败切换。
  - 成功路径解析用量并记录计费；失败路径只记录通道失败和代理失败日志，不虚构用量或费用。
  - 路由已在 proxy router 中注册。
- **主要文件**：
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/routes/proxy/rerank.test.ts`
  - `src/server/routes/proxy/router.ts`
- **验证**：
  - 缺少 `model` 返回 HTTP 400。
  - 未携带下游鉴权调用实际本地接口返回 HTTP 401，鉴权边界生效。
  - Rerank 路由单元测试覆盖上游 URL、请求体转发和成功日志。
- **状态**：已完成。要得到真实排序结果，还需要在本地配置支持 Rerank 的上游站点和下游 API Key。

### 3. 路由优先级与 P0/P1/P2

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #590](https://github.com/cita-777/metapi/issues/590)
- **目标**：新建通道进入当前路由的下一优先级；拖拽或批量更新后优先级保持连续并和页面展示一致。
- **实现范围**：
  - 创建通道时按当前路由已有最大优先级计算默认值，不再把所有新通道固定为 `P0`。
  - 批量保存时按路由压缩为连续的 `P0`、`P1`、`P2` 等层级。
  - 返回通道列表时按 `priority`、`id` 排序，确保 API 和页面顺序一致。
  - 保留优先级拖拽后的保存和路由决策刷新行为。
- **主要文件**：
  - `src/server/routes/api/tokens.ts`
  - `src/web/pages/TokenRoutes.tsx`
  - `src/web/pages/token-routes/priorityRail.ts`
  - `src/web/pages/token-routes/RouteCard.tsx`
- **验证**：
  - 前端优先级 helper 和拖拽相关测试通过。
  - 本地路由页面实际展开 `deepseek-v4-pro`，通道显示在 `P0` 优先级桶中。
  - API 返回顺序使用 `priority`、`id` 排序。
- **状态**：已完成并在当前本地服务中运行。

### 4. Coding Plan v3 URL 拼接

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #586](https://github.com/cita-777/metapi/issues/586)
- **目标**：当上游 Base URL 已经以 `/v3` 等版本段结尾时，不要把下游请求的 `/v1` 重复拼接到 URL 中。
- **实现范围**：
  - URL 拼接逻辑识别末尾 `/vN` 版本段。
  - `.../api/coding/v3` 加 `/v1/chat/completions` 后得到 `.../api/coding/v3/chat/completions`。
  - 保持已有 `/v1`、无版本后缀和其他平台路径行为不回归。
- **主要文件**：
  - `src/server/proxy-core/orchestration/upstreamRequest.ts`
- **验证**：
  - Coding Plan v3 URL 拼接单元测试覆盖 v3、v1、无版本后缀和现有特殊路径。
  - Rerank 测试中的 Coding Plan v3 上游地址实际拼接为 `https://ark.cn-beijing.volces.com/api/coding/v3/rerank`。
- **状态**：已完成。

### 5. 渠道失败隔离

- **类型**：缺陷修复
- **需求来源**：[GitHub Issue #585](https://github.com/cita-777/metapi/issues/585)
- **目标**：一个渠道失败时，只更新实际失败渠道的冷却和失败状态，不影响同凭据的其他渠道，也不误触发站点级运行时熔断。
- **实现范围**：
  - 429 用量限流只冷却本次实际失败的 channel。
  - 不再按同一凭据扩散 `cooldownUntil` 或失败状态。
  - 429 不再写入站点级运行时熔断；其他健康渠道仍可参与选择。
  - 成功恢复时只清理当前通道自身的失败状态。
- **主要文件**：
  - `src/server/services/tokenRouter.ts`
  - 相关 token router、proxy retry 和路由健康状态测试文件
- **验证**：
  - 单线程 Vitest 覆盖限流失败、普通失败、成功恢复和站点熔断边界。
  - 验证结论：失败通道进入冷却，同凭据其他通道不扩散，429 不写入站点级熔断。
- **状态**：已完成。

### 6. 需求文档和演示交付物

- **类型**：文档与交付物
- **需求来源**：本会话中提供的四个 GitHub Issue
- **实现范围**：
  - 需求说明：[docs/plans/github-issues-591-590-586-585.md](plans/github-issues-591-590-586-585.md)
  - 网页演示 PDF：`output/pdf/metapi-issues-demo-2026-08-03.pdf`
  - PDF 包含当前 run 页面截图、站点独立并发、路由 P0、Rerank 请求示例、Coding Plan v3 和渠道失败隔离说明。
- **验证**：
  - 前端 `http://127.0.0.1:5174/` 返回 HTTP 200。
  - 后端 `http://127.0.0.1:4000/health` 返回 HTTP 200。
  - PDF 已渲染检查，共 6 页，中文正文和接口示例可读。
- **状态**：已完成。

### 7. 汇总验证

- `npm run typecheck:server`：通过
- `npm run typecheck:web`：通过
- `npm run typecheck:web:test`：通过
- `npm run test:schema:unit`：通过
- `npm run repo:drift-check`：通过
- 相关 Rerank、endpoint flow、路由优先级、tokenRouter、站点并发测试：使用单线程 Vitest 通过
- 说明：本机并行 Vitest worker 曾出现 OOM/UNKNOWN，后续复测优先使用：

```powershell
npx vitest run --pool=threads --poolOptions.threads.singleThread=true <test-file>
```

### 8. 建立持续变更日志

- **类型**：文档维护
- **需求来源**：本会话需求
- **目标**：把功能、修复、测试和交付物集中记录，作为后续改动的唯一开发日志。
- **实现范围**：新增本文件 `docs/change-log.md`，并提供 Issue 链接、文件路径、验证结果和后续追加模板。
- **状态**：已完成；后续每次代码或文档变更都追加到本文件。

### 9. 提交到上游仓库的独立分支

- **类型**：版本交付
- **需求来源**：本会话需求：[Metapi 仓库](https://github.com/cita-777/metapi)
- **目标**：将本地已完成的站点独立并发、Rerank 和四个 Issue 修复提交到上游仓库的独立分支，不直接修改 `main`。
- **实现范围**：以远程 `main` 为基线创建 `codex/metapi-issues-591-590-586-585`，迁移代码、测试、数据库迁移产物、需求文档、持续日志和演示 PDF。
- **主要文件**：
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/tokenRouter.ts`
  - `src/server/db/schema.ts`
  - `docs/change-log.md`
- **验证**：`npm run typecheck:server`、`npm run typecheck:web`、`npm run typecheck:web:test`、`npm run test:schema:unit`、`npm run repo:drift-check` 均通过；相关聚焦测试通过，`tokenRouter.selection.test.ts` 单独运行 26/26 通过。
- **提交**：本地提交 `02e2308`（`feat: add proxy fixes and per-site concurrency`）。
- **推送结果**：未推送；GitHub 返回 `403 Permission to cita-777/metapi.git denied to lengxiaouser`，当前凭据对该仓库没有写权限；远程分支尚未创建。
- **状态**：代码已验证并在本地分支就绪，等待具备该仓库写权限的凭据后重试。

### 10. 创建 Fork 并准备 Pull Request

- **类型**：版本交付
- **需求来源**：本会话需求
- **目标**：通过个人 Fork 提交变更，避免直接写入上游仓库。
- **实现范围**：已创建 [lengxiaouser/metapi](https://github.com/lengxiaouser/metapi) Fork，目标分支为 `codex/metapi-issues-591-590-586-585`，PR 基线为上游 `main`。
- **验证**：Fork 的 `main` 已通过 Git 远程读取确认，功能分支已成功推送。
- **状态**：已完成。

### 11. 创建上游 Pull Request

- **类型**：版本交付
- **需求来源**：本会话需求
- **目标**：请求上游仓库审核本次站点并发控制、Rerank 及四个 Issue 修复。
- **实现范围**：创建 [PR #609](https://github.com/cita-777/metapi/pull/609)，源分支为 `lengxiaouser:codex/metapi-issues-591-590-586-585`，目标为 `cita-777:main`。
- **验证**：GitHub API 返回 PR 编号 `609`，状态为 `open`；PR 描述已包含 Issue 链接、验证命令和变更范围。
- **状态**：已提交，等待上游审核。

### 12. 修复 CodeRabbit PR 审查问题

- **类型**：缺陷修复与架构重构
- **需求来源**：CodeRabbit 对 [PR #609](https://github.com/cita-777/metapi/pull/609) 的审查；对应 Issue：[#591](https://github.com/cita-777/metapi/issues/591)、[#590](https://github.com/cita-777/metapi/issues/590)、[#586](https://github.com/cita-777/metapi/issues/586)、[#585](https://github.com/cita-777/metapi/issues/585)
- **目标**：修复站点并发租约释放、并发超时误判、路由通道优先级竞态、Rerank 路由职责过重和变更日志字段不完整等问题。
- **实现范围**：
  - 流式响应交接后暂停后台续租，按真实读取进度续租；读取失败先取消 reader，再释放站点租约。
  - 为本地站点排队超时增加显式 `siteConcurrencyTimeout` 标记，统一由 `sharedSurface.ts` 分类，避免把真实上游 503 当成站点排队超时。
  - 新增 `routeChannelService.ts`，用进程内串行锁和数据库事务统一处理自动通道、批量通道、单通道和批量优先级写入，并统一清理路由决策缓存。
  - 新增 `rerankSurface.ts`，通过 `executeEndpointFlow()` 承担 Rerank 的站点地址池、首字节超时、上游请求、用量计费、日志和失败重试；路由文件只保留校验与委托。
  - 修正 Rerank 记录：只有成功响应解析用量并计费，失败只写失败状态日志，费用和用量为零/未知不代表已发生计费。
- **主要文件**：
  - `src/server/services/proxyChannelCoordinator.ts`
  - `src/server/services/siteApiEndpointService.ts`
  - `src/server/proxy-core/surfaces/sharedSurface.ts`
  - `src/server/proxy-core/surfaces/chatSurface.ts`
  - `src/server/proxy-core/surfaces/openAiResponsesSurface.ts`
  - `src/server/proxy-core/surfaces/geminiSurface.ts`
  - `src/server/proxy-core/surfaces/rerankSurface.ts`
  - `src/server/routes/proxy/rerank.ts`
  - `src/server/services/routeChannelService.ts`
  - `src/server/routes/api/tokens.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck:server`：通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true src/server/routes/proxy/rerank.test.ts src/server/services/siteApiEndpointService.test.ts src/server/services/proxyChannelCoordinator.test.ts`：通过，24 个测试通过。
  - 路由优先级与共享 surface 回归测试：通过，`tokens.batch.test.ts`、`tokens.route-update-rebuild.test.ts` 共 21 个测试，`sharedSurface.test.ts` 与 `sharedSurface.usage-source.test.ts` 共 24 个测试。
  - Rerank 测试实际验证上游 URL 为 `https://ark.cn-beijing.volces.com/api/coding/v3/rerank`、请求体转发和成功日志；测试环境的 quota best-effort 查询因未创建 `accounts` 表输出告警，但不影响请求结果。
  - `npm run typecheck:web`：通过。
  - `npm run typecheck:web:test`：通过。
  - `npm run test:schema:unit`：通过，15 个测试通过。
  - `npm run repo:drift-check`：通过，新增违规 0 个；报告中的 5 项为既有 tracked debt。
- **交付物**：本地 checkout 中的修复代码和本变更日志；无新增 PDF 或截图。
- **状态**：已完成，等待提交并更新 PR。

### 13. 修复 CodeRabbit follow-up 审查问题

- **类型**：缺陷修复与文档修正
- **需求来源**：CodeRabbit 对 [PR #609](https://github.com/cita-777/metapi/pull/609) 的 follow-up 审查
- **目标**：修复 Issue 链接的 Markdown 空格，并确保手工通道传入的明确优先级不会被自动分配逻辑覆盖。
- **实现范围**：
  - 将 `[ #591]` 修正为 `[#591]`，并确认 PR/Issue 链接均为合法 Markdown。
  - `routeChannelService` 区分明确优先级和自动候选：手工通道传入 `priority: 0`、`priority: 3` 等值时原样归一化保留；自动候选才分配下一个优先级。
  - 自动补齐候选不再把 `priority: 0` 当成显式优先级，避免所有自动通道固定在 P0。
- **主要文件**：
  - `src/server/services/routeChannelService.ts`
  - `src/server/routes/api/tokens.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck:server`：通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true --hookTimeout=30000 src/server/routes/api/tokens.batch.test.ts`：6 个测试通过。
  - `npx vitest run --pool=threads --poolOptions.threads.singleThread=true --hookTimeout=30000 src/server/routes/api/tokens.route-update-rebuild.test.ts`：15 个测试通过。
- **交付物**：代码与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成，已推送到 PR 分支；本次日志修正随当前文档提交同步。

### 13. GitHub 账号密码保活，恢复澎湃AI网关自动登录

- **类型**：功能实现与缺陷修复
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：GitHub 快捷登录会话失效后，服务器能自己重新登录，使绑定 GitHub OAuth 的站点（如澎湃AI网关）恢复自动重新登录与签到；不再依赖人工重新粘贴 Cookie。
- **实现范围**：
  - 新增 GitHub 账号密码凭据存储：密码复用 `accountCredentialService` 的 `v1:` 加密格式保存在设置表，任何读取接口都不回显密码。
  - 新增受管浏览器密码登录驱动：打开 `github.com/login`，填入账号密码并提交，成功后在浏览器 Cookie 罐里取回会话，走既有 `saveImportedSession` 路径持久化，让原有 HTTP 保活巡检接管。
  - 失败分类：区分「用户名或密码不正确」「两步验证（2FA）」「设备验证」「人机验证」「限流」，避免把风控拦截误报成密码错误。
  - 尝试冷却：连续失败 2 次后冷却 6 小时，其余失败冷却 10 分钟，防止反复回放密码触发 GitHub 风控。
  - 澎湃AI网关的 OAuth 握手在返回 `needs_provider_login` 时会先自愈再重试一次；自愈失败仍保留站点原始判定，人工导入路径不受影响。
  - 会话巡检查到 GitHub 未登录时先尝试自愈，只有自愈也失败才发送失效通知，并在通知里附上失败原因。
  - 新增设置接口 `GET/POST/DELETE /api/assisted-login/github/auto-login` 与手动触发的 `POST /api/assisted-login/github/auto-login/run`，GitHub 快捷登录页新增对应卡片。
  - 健壮性：凭据存储读写失败一律降级为「未配置」，自愈异常不会中断站点登录主流程。
- **主要文件**：
  - `src/server/services/assistedLogin/sites/githubPasswordLogin.ts`
  - `src/server/services/assistedLogin/sites/githubPasswordLogin.test.ts`
  - `src/server/services/assistedLogin/sites/hyper.ts`
  - `src/server/services/assistedLogin/sessionWatchScheduler.ts`
  - `src/server/services/assistedLogin/watchers.ts`
  - `src/server/routes/api/assistedLogin.ts`
  - `src/web/api.ts`
  - `src/web/pages/AssistedLogin.tsx`
  - `docs/change-log.md`
- **验证**：
  - 实机验证：清空受管浏览器 GitHub Cookie 后执行自愈，账号 `liumeijicui` 用密码重新登录成功（无 2FA、无设备验证）。
  - 实机验证：账号 #1（澎湃AI网关）经 `POST /api/assisted-login/github/refresh-account` 恢复，状态由 `expired` 变为 `active`，余额 63.615314，`POST /api/checkin/trigger/1` 返回「签到成功」奖励 13.749828。
  - `npm run typecheck`（web / web:test / server / desktop）：通过。
  - `npx vitest run --root . src/server/services/assistedLogin`：56 个测试通过。
  - 全量 `npx vitest run --root .`：2857 通过、4 失败，4 项失败在改动前的 HEAD 上同样失败（`generate-icons` 缺 GLIBCXX、`DATA_DIR`/`factoryResetService`/`siteProxy` 宿主环境变量泄漏、`accounts.rebind-panel-focus` 既有问题），与本次改动无关。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成并在当前本地服务中运行。

### 14. 站点侧拒绝原因如实上报，Cloudflare 挑战不再误报会话失效

- **类型**：缺陷修复
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：处理剩余 `expired` 账号时，发现两处会误导排查方向的缺陷：站点明确给出的拒绝原因被通用「令牌失效」覆盖；OAuth 握手页面上的 Cloudflare 挑战被判定为「提供方会话已失效」。
- **实现范围**：
  - 新增 `session_limit` 失败分类：识别 `AUTH_SESSION_LIMIT`、`Too many active login sessions`、`Sign out other sessions` 等站点原文，给出「在站点上退出其他登录会话（或重置密码）」的动作提示。此前这类拒绝被归为未知错误，账号上只留下 `访问令牌失效：HTTP 401`。
  - 新增 `invalid_credentials` 失败分类：识别 `Username or password is incorrect`、`user has been banned` 等站点原文，明确指出是凭据无效或账号被封禁。
  - `tryAutoRelogin` 新增 `onRefusal` 回调，把站点给出的、操作者必须自行处理的拒绝原因交给调用方；余额刷新与签到两处调用方都据此写入健康原因，不再让通用 401 覆盖它。
  - 修复一处竞态：`handleBalanceError` 里的健康写入未 `await`，其异步落库会晚于随后写入的具体原因并把后者覆盖；该写入现在被 `await`，顺序确定。
  - Linux.do 的 OAuth 握手有 `/authorize` 与 `/approve` 两步，此前只承认第一步，导致已授权或正在过 Cloudflare 的 `/approve` 页面被判为「无握手在飞」并报「会话已失效」；现在两步都算握手。
  - 判定握手失败前先调用已有的 `passCloudflareChallenge` 等待挑战通过（页面不是挑战时立即返回，正常路径零开销）。
- **主要文件**：
  - `src/server/services/failureReasonService.ts`
  - `src/server/services/failureReasonService.test.ts`
  - `src/server/services/autoRelogin.ts`
  - `src/server/services/balanceService.ts`
  - `src/server/services/balanceService.autoRelogin.test.ts`
  - `src/server/services/checkinService.ts`
  - `src/server/services/assistedLogin/providers/linuxdo.ts`
  - `src/server/services/assistedLogin/sessionService.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck`：通过。
  - `npx vitest run --root . src/server/services/balanceService src/server/services/autoRelogin src/server/services/checkinService src/server/services/failureReasonService src/server/services/assistedLogin`：108 个测试通过。
  - 实机验证 luckyg(#4) / happycoding(#7) 现报「站点登录会话数已达上限：在站点上退出其他登录会话（或重置密码）后重试」；蛙蛙公益站(#10) 现报「账号密码无效或账号被封禁」；此前三者都只报「访问令牌失效」。
  - 实机验证 JustDoWork(#25) 改用站点支持的 GitHub OAuth 入口重新授权后由 `expired` 恢复为 `active`，余额 720.97，签到返回已签到。
  - 实机验证 Linux.do OAuth 走 luckyg 不再误报「会话已失效」，如实返回「等待站点返回凭证超时」（站点因会话数上限拒绝下发）。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成并在当前本地服务中运行。

### 15. 签到失败日志如实显示站点拒绝原因

- **类型**：缺陷修复
- **需求来源**：本会话需求
- **目标**：站点已明确拒绝（会话数上限、账号密码无效/被封禁）时，签到日志、事件与通知不应再显示「HTTP 401: Unauthorized」这类笼统结论，否则运维会去排查并不存在的令牌问题。
- **实现范围**：
  - `src/server/services/checkinService.ts`：重登被站点拒绝时，把站点声明的原因作为签到日志、事件、通知与账号健康原因；并把 `reportTokenExpired()` 提前到健康写入之前，避免它记录的通用「令牌失效」覆盖更具体的原因。
  - `src/server/services/failureReasonService.ts`：补充中文关键词，使系统自己写入的拒绝文案（「账号密码无效」「账号被封禁」「密码无效」）在日志分类时仍能还原为 `invalid_credentials`。
- **主要文件**：
  - `src/server/services/checkinService.ts`
  - `src/server/services/failureReasonService.ts`
  - `src/server/services/checkinService.autoRelogin.test.ts`
  - `src/server/services/failureReasonService.test.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck`：通过。
  - `npx vitest run --root . src/server/services/checkinService src/server/services/failureReasonService src/server/services/autoRelogin src/server/services/balanceService`：55 个测试通过。
  - 单元测试锁定：会话数上限被拒绝时，签到日志与通知均只含「站点登录会话数已达上限…」且不含 `401`；`reportTokenExpired()` 之后写入的仍是该具体原因。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成并在当前本地服务中运行。

### 16. 登录成功后自动清理多余会话，避免被会话数上限卡死

- **类型**：功能实现
- **需求来源**：本会话需求
- **目标**：站点限制同时在线会话数时，会话堆积会拒绝下一次自动重登（`409 AUTH_SESSION_LIMIT`）。在每次成功登录后自动清掉其它会话，只保留本次登录的会话，避免反复卡死。
- **实现范围**：
  - `src/server/services/platforms/base.ts`：新增 `SiteSessionInfo` 类型与可选能力 `listSessions` / `revokeSession`，缺失该接口的站点不受影响。
  - `src/server/services/platforms/newApi.ts`：实现 `GET /api/user/sessions` 与 `DELETE /api/user/sessions/:sid`；无该接口返回 `null`，已不存在的会话视为已清理。
  - `src/server/services/sessionHygiene.ts`：新增会话清理服务，同时用站点返回的 `current` 标记与令牌自身 `sid` 判定当前会话，两者都无法识别时放弃清理（绝不误删在用会话）。
  - `src/server/services/accountExtraConfig.ts`：新增 `shouldPruneOtherSessions()`，默认开启，可用 `autoRelogin.pruneOtherSessions: false` 关闭。
  - `src/server/services/autoRelogin.ts`：密码重登成功后执行清理，并把 `sessionHygiene` 结果写入 `extraConfig`。
- **主要文件**：
  - `src/server/services/sessionHygiene.ts`
  - `src/server/services/autoRelogin.ts`
  - `src/server/services/accountExtraConfig.ts`
  - `src/server/services/platforms/base.ts`
  - `src/server/services/platforms/newApi.ts`
  - `src/server/services/sessionHygiene.test.ts`
  - `src/server/services/autoRelogin.test.ts`
  - `src/server/services/platforms/newApi.test.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run typecheck`：通过。
  - `npx vitest run --root . src/server/services/sessionHygiene src/server/services/autoRelogin src/server/services/platforms/newApi src/server/services/accountExtraConfig src/server/services/checkinService src/server/services/balanceService`：115 个测试通过。
  - 实机验证 happycoding(#7)：一次重登后记录 `sessionHygiene: {"outcome":"pruned","removed":2,"kept":1}`，站点会话列表由多条降为 1 条（本次登录会话）。
  - 实机确认 luckyg(#4) 在已被上限拒绝时其存储令牌同样失效（`AUTH_TOKEN_EXPIRED`），拿不到会话列表，需先人工清一次；此后由本功能维持不再堆积。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成并在当前本地服务中运行。

### 17. 登录保存可续期的 refresh cookie，不再靠反复登录维持会话

- **类型**：缺陷修复
- **需求来源**：本会话需求（“会话满了，我也登不上，有没有什么其他方式能登陆 luck 的”），关联第 16、15 条
- **目标**：查清幸运 G（账号 #4）被 `AUTH_SESSION_LIMIT` 挡住的真实原因，并从根上消除它。
- **实测原因**：
  - 新版 New API 登录会**同时**下发 15 分钟的 `access_token`（JSON 里）和 30 天的 `new_api_refresh` cookie（`Set-Cookie`），并且**每次登录都新建一条服务端登录会话**（会话上限默认 50、固定 30 天不续期）。
  - `newApi.login()` 之前优先保存 JSON 里的 access token，于是账号凭据每 15 分钟就失效，调度每跑一次（每小时签到/余额）就得重新登录一次，而每次登录都会 **+1 条会话**：约两天就把 50 条顶满，之后密码登录和 LinuxDO OAuth 全部被站点以 `409 AUTH_SESSION_LIMIT` 拒绝（OAuth 回调 `POST /api/oauth/linuxdo` 也实测返回同一错误）。
  - 站点侧只有三条出路：在仍登录的设备上「退出其他登录会话」、重置密码（服务端会撤销全部会话，但该站 `SMTPFrom` 未配置，`/api/verification` 直接返回 `invalid SMTP account`，重置邮件发不出去）、或等 30 天后会话自然到期（站点每小时清理过期行）。
- **实现范围**：
  - `newApi.login()` 优先保存可续期的 `new_api_refresh` cookie；同一次登录拿到的短期 access token 改由 `LoginResult.bearerToken` 单独返回，供这一轮流程里尚未换票的调用（会话清理）使用，不再被持久化成账号凭据。
  - `autoRelogin` 的会话清理改用 `bearerToken`，避免在落库前先把 cookie 密钥轮换掉。
  - `listSessions` / `revokeSession` 支持直接传入 refresh cookie（先换票再调用），cookie 凭据下会话清理同样可用。
  - `session_limit` 的失败原因文案改为如实描述出路（含“30 天后自动释放”“重置密码依赖站点邮件通道”），不再只写“重置密码”这种在该站根本走不通的建议。
- **主要文件**：
  - `src/server/services/platforms/base.ts`
  - `src/server/services/platforms/newApi.ts`
  - `src/server/services/autoRelogin.ts`
  - `src/server/services/failureReasonService.ts`
  - `src/server/services/platforms/newApi.test.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过。
  - `npx vitest run`（newApi / autoRelogin / sessionHygiene / accountCredentialRotation / platforms index）：84 个用例通过，含新增的「登录保存 refresh cookie 而非短期令牌」用例。
  - 实机 happycoding(#7)：登录返回 `new_api_refresh=…` 与独立 `bearerToken`；用该 cookie 换票后 `/api/user/self` 正常；连续 3 轮换票均成功、密钥轮换已落库，且访问令牌的 `sid` 与会话列表里的当前会话一致（说明复用同一会话，不再新增）；会话清理 `{"status":"pruned","removed":2,"kept":1}`，站点会话数由 3 降为 1。
  - 幸运 G(#4)：确认已被上限锁死，其 50 条会话只能等 30 天自然过期或由站长清理，代码层无可绕过的入口（密码 / OAuth / Passkey 全部走同一套会话签发）。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

### 18. 全部 New API 站点巡检 + 每次登录后清理其他会话（含安全修复）

- **类型**：功能实现 / 缺陷修复
- **需求来源**：本会话需求（“现在看下所有的网站是否有这个问题，登录上以后就默认删掉其他的会话”），关联第 16、17 条
- **巡检结果（21 个 new-api 账号）**：
  - 存短期令牌（会反复重登、反复新增会话）的 12 个；存 refresh cookie 的 9 个。
  - 有会话堆积的 7 个：方舟 19、chinahk 24、motomoto 15、KKtoken AI 15、澎湃AI网关 8、JustDoWork 7、happycoding 2。站点上限 50、会话固定 30 天不续期，这些站点都已走到一半以上。
  - 另外 13 个账号读不到会话列表：站点版本旧、未开该接口，或账号本身已失效（luckyg、蛙蛙公益站、Fate）。
- **实现范围**：
  - 会话清理从“只在密码重登后执行”扩展为**所有登录路径都执行**：`autoRelogin` 的浏览器重登与 OAuth 重登、`/api/accounts/login` 手动绑定、`createManualAccount`、以及托管登录的“重新获取凭证”。登录即默认清掉其他会话（`autoRelogin.pruneOtherSessions: false` 可关）。
  - `sessionHygiene` 改为**只凭凭据自身的会话 id 判定**当前会话：access token 读 `sid` 声明，refresh cookie 读 `<sid>.<secret>` 的前半段。站点的 `current` 标记只用于“多留”不用于“删”，凭据读不出会话 id 时直接放弃清理。
  - 清理后复查会话仍在，若被清掉则如实上报 `current-session-lost`，而不是谎报成功。
  - `exchangeRefreshCookie` 改为按**调用方传入的那份密钥**缓存换票结果。此前按“最新密钥”做缓存键，导致一次清理里每个请求都重新换票、重新轮换密钥：既放大丢密钥的风险，也可能让服务端把重复使用的旧密钥判定为盗用。
- **主要文件**：
  - `src/server/services/sessionHygiene.ts`（含 `.test.ts`）
  - `src/server/services/autoRelogin.ts`（含 `.test.ts`）
  - `src/server/routes/api/accounts.ts`（新增 `.login-session-hygiene.test.ts`）
  - `src/server/services/manualAccountCreationService.ts`
  - `src/server/services/assistedLogin/routeHandlers.ts`
  - `src/server/services/platforms/newApi.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过。
  - `npx vitest run`：2899 用例中 2887 通过，4 个失败与本次无关（generate-icons、index.default-path、factoryResetService、siteProxy、rebind-panel-focus，均为既有环境性失败）。
  - 实机清堆积：澎湃 8→1、方舟 19→1、chinahk 24→1、motomoto 15→1、KKtoken 15→1、JustDoWork 7→1、happycoding 2→1、Columbina 2→1；清理后逐个复验余额，全部正常。
  - 实机验证“一次清理只换票一次”（Columbina，制造 3 条堆积）：清理过程仅 1 次密钥轮换，清理后凭据仍可正常取余额，会话数 4→1。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

### 19. Cloudflare 勾选框改为动态定位 + 修复重登被误判为失败

- **类型**：缺陷修复
- **需求来源**：本会话需求（“改掉吧，改成最新的，然后告诉我几个不行的网址”），关联第 17、18 条
- **问题**：
  - 脚本原先按每个布局一套**固定坐标**点 Turnstile 勾选框。站点卡片只要因为公告条、语言或按钮换行挪动几十像素，点击就落到空白处，Cloudflare 不过、登录失败，而日志会把它写成密码错误。
  - Turnstile 控件在页面里**拿不到 DOM**：它渲染在一个独立的 OOPIF 里，控件本身又位于 **closed shadow root**（DOM 深度 14）。`document.querySelectorAll('*')` 和 `element.shadowRoot` 遍历都找不到它；`DOM.getFrameOwner` 对 OOPIF 也无效。
  - 第二个独立缺陷：`login()` 已经量到“已登录且今日已签到”，主流程随后仍无条件再导航一次 `/profile`。chinahk 这类站点会在整页重载时重新校验会话，把刚建立的 cookie 判为无效并弹回 `/sign-in`，于是**登录成功反而上报 `login_failed`**。
- **实现范围**：
  - 新增 `scripts/checkin-browser/challengeLocator.mjs`：通过 DevTools 的 `DOM.getDocument({ depth: -1, pierce: true })` 穿透 closed shadow root 找到挑战 iframe，再用 `DOM.getBoxModel({ backendNodeId })` 取真实盒子，换算成 X11 屏幕坐标后输出 `x= y= w= h=`。**只读**，不点击、不导航、不禁用任何自动化特征；点击仍由 xdotool 发出。
  - `challengeLocator.mjs` 复用脚本自己启动的 `--remote-debugging-port=0` 生成的 `DevToolsActivePort`，不额外开端口；找不到控件就打印 `none`。
  - `newapi-x11-checkin.sh` 新增 `click_shield()`：先问定位器，拿到坐标就点那里，拿不到才退回各布局测得的 `LOGIN_SHIELD_XY`。登录等待循环中途（第 5 轮）再定位一次，以覆盖“控件挂载晚于首次点击”的情况。
  - 两个 chromium 启动分支都加上 `--remote-debugging-port=0`。
  - 主流程改为**只在 `login()` 结束后仍未量到 profile 时**才重新导航，登录成功的那一次不再被二次导航推翻。
- **主要文件**：
  - `scripts/checkin-browser/challengeLocator.mjs`（新增）
  - `scripts/checkin-browser/newapi-x11-checkin.sh`
  - `docs/change-log.md`
- **验证**：
  - `bash -n newapi-x11-checkin.sh`：通过。
  - 定位器实测（chinahk 登录页，1440x1000 显示 / 1280x900 窗口）：输出 `x=457 y=666 w=300 h=65`，与页面复选框中心一致。
  - 端到端实机回归（chinahk #14，未登录冷启动 → 动态定位点中勾选框 → 密码登录）：run.log 记录 `sign-in attempt 1` → `clicking the Turnstile checkbox at 457 640 (located)` → `attempt1 shield=1` → `attempt1 profile=1 state=CHECKED` → `already checked in today` → `login cookie stored in the profile (landed=1)`，并成功取回 `new_api_refresh` 凭据。改造前同一场景上报 `login_failed`。
- **交付物**：代码与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

### 20. Linux.do 重登：退出站点时的导航竞态不再中断整个流程

- **类型**：缺陷修复
- **需求来源**：本会话需求（“告诉我几个不行的网址”），Any Router 的保活巡检结果
- **问题**：Any Router（`https://anyrouter.top`）的 Linux.do 重新登录固定失败在第一步，报
  `Linux.do 重新登录失败：page.goto: Navigation to "https://anyrouter.top/" is interrupted by another navigation to "https://anyrouter.top/"`。
  原因是 `signOutOfSite` 在清掉站点 cookie 后重新加载站点首页，而站点 SPA 会在此时**自己**跳到 `/login`；这次客户端跳转把 Playwright 的 `goto` 判为被另一次导航打断并抛出，整个重登就此中止。谁的导航先到是竞态，所以同一站点会时好时坏。
- **实现范围**：`signOutOfSite` 的收尾导航容忍这一种错误：只有错误信息匹配
  `interrupted by another navigation` 才吞掉，其余错误照旧抛出。这一步本来就是为了让 SPA 丢掉内存里的会话，页面已经在加载就达到了目的；不重试是因为重试同样会被下一次竞态打断。
- **主要文件**：
  - `src/server/services/assistedLogin/sites/linuxDoOAuthRelogin.ts`
  - `docs/change-log.md`
- **验证**：
  - `npm run build:server`：通过。
  - 实机回归（Any Router `#28`）：修复前第一步即报 `page.goto ... interrupted`；修复后流程推进到后续阶段（本次停在站点的 Linux.do 授权回调 “授权后站点未回调”，属另一环节，见巡检清单）。同期该账号 HTTP 凭证仍可用，余额读取正常（1957.19）。
- **交付物**：代码与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

### 21. 签到后自动抽奖（百倍 / 林夕这类带幸运抽奖的 Sub2API 站点）

- **类型**：功能实现
- **需求来源**：本会话需求（“百倍网站和林夕网站为啥抽奖不抽了”“每天抽满10次”），关联第 18、19 条
- **问题**：这两个站的每日福利其实是两段——签到领奖励，再用**免费额度**抽奖（每天上限 10 次）。之前能看到抽奖记录，是因为 09-30 之前的抽奖是手动在网页上做的；09-30 起签到交给 metapi 自动跑之后，抽奖那段没人做，于是从那天起记录就断了（百倍最后一条 09-30 16:00、林夕 09-30 16:20，都紧跟在最后一次手动签到之后）。metapi 里**从来没有**抽奖代码，这才是“现在不行了”的真正原因——站点侧一直是好的。
- **实现范围**：
  - `Sub2ApiAdapter` 新增 `getLotteryStatus` / `drawLottery`：读 `/api/v1/lottery/status`，抽奖走站点自带 UI 用的 `/api/v1/lottery/draw-batch`（旧版没有该路由时回退单抽 `/api/v1/lottery`），并带上 `idempotency_key` 让重试不会被重复扣费。站点没有该路由时返回 `null`，表示“这个平台没有抽奖”，而不是当成抽奖失败。
  - 新增 `lotteryService`：`planLotteryDraws` 是纯函数，规则明确——**先用签到送的免费次数（bonus），再用免费额度（free）**；**永不动用付费余额，也不花活跃度**；次数取“配置目标”与“站点当天上限”的较小值，并按站点允许的批量（3 次）拆批；免费额度不够就停在能付得起的次数上，并在日志里写明原因。
  - 挂在签到流程里：签到成功后（含“今日已签到”的那几轮）先抽奖、**再**刷新余额，这样余额里已经包含当天的中奖。站点计数器是权威来源，所以每小时那一轮签到发现当天已抽满就自动跳过，不需要本地记账。
  - 结果写入事件日志（`type: lottery`）与账号 `extraConfig.lottery`（最后运行时间/次数/中奖/原因）；真的抽了的那一次会在签到日志行尾附上 `· 抽奖 N 次 +$X`，不额外插一行以免污染签到达成率与收益统计。
  - 抽 0 次是常态（当天抽满后的每一轮都如此），所以**不写事件**；只有站点给出的拒绝原因（“今日抽奖次数已用完”“免费额度不足”“站点未开启抽奖”“读取抽奖状态失败”）会记进 `extraConfig.lottery.reason`，且**只在原因变化时**写一次——站点停止发奖正是以前没人发现的那类故障，而每小时重写同一句话没有意义。账号级不适用的原因（平台没有抽奖接口、站点没有该路由）不落盘，否则每次签到都会去改一条与它无关的账号记录。
  - 开关：默认开启、每天 10 次。账号级可用 `extraConfig.lottery = { enabled: false, dailyDraws: N }` 关掉或改目标。
- **主要文件**：
  - `src/server/services/lotteryService.ts`（含 `.test.ts`）
  - `src/server/services/platforms/sub2api.ts`（含 `.test.ts`）
  - `src/server/services/platforms/base.ts`
  - `src/server/services/checkinService.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过。
  - `npm run build:server`：通过。
  - 新增单测：`lotteryService.test.ts`（12 例，覆盖 bonus 优先、批量拆分、站点上限、免费额度不足、付费关掉时不越界）、`sub2api.test.ts` 新增 4 例（状态解析、无抽奖路由返回 null、批量抽奖、单抽回退）。
  - `npx vitest run`：2903 通过、4 失败，失败项与本次无关（generate-icons、index.default-path、factoryResetService、siteProxy、rebind-panel-focus，均为既有环境性失败）。
  - 实机（今日）：
    - 林夕 #18：`今日已签到 · 抽奖 9 次 +$350`，站点计数器 10/10，免费额度 826.30 → 384.30。
    - 百倍 #17：`今日已签到 · 抽奖 9 次 +$490`，站点计数器 10/10，免费额度 8163.00 → 8203.00。
    - 两站的抽奖记录都从“09-30 之后断档”恢复为“当天抽满 10 次”。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

# Metapi 变更日志

> 这是当前项目的持续变更记录。后续每次新增功能、修复缺陷、调整接口或修改文档，都要在本文件追加一条记录，不能只修改代码而不记录。

## 记录规则

- 每条记录使用日期、变更类型、需求来源、Issue 链接、实现范围、验证结果和交付物几个字段。
- 有 GitHub Issue 时必须附上完整链接；没有 Issue 时标记为“本会话需求”，不要虚构编号。
- 代码完成后再补充实际文件路径和测试结果，未验证的内容必须明确标记为“未验证”。
- 采用追加方式维护历史记录，不覆盖已完成记录；如果后续修复同一问题，新增一条记录并链接到原记录。
- PDF、截图、需求说明等交付物也要记录，但不能把交付物当成代码实现本身。

## 2026-08-03

## 2026-08-21

## 2026-08-22

## 2026-10-02

## 后续记录模板

复制下面模板追加到对应日期下，先记录需求来源，再补充实际实现和验证结果：

```md
### YYYY-MM-DD - 简短标题

- **类型**：功能实现 / 缺陷修复 / 重构 / 文档
- **需求来源**：[Issue #N](https://github.com/cita-777/metapi/issues/N) 或本会话需求
- **目标**：
- **实现范围**：
- **主要文件**：
  - `path/to/file`
- **验证**：
- **交付物**：代码、文档、PDF、截图等；没有交付物时填写“无”。
- **状态**：进行中 / 已完成 / 阻塞
```
