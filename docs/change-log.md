### 35. 修复 Linux.do 自动重登取不到 state（rc 版接口），并批量启用

- **类型**：缺陷修复 + 配置
- **需求来源**：本会话需求（用户同意“给这些站配上 Linux.do 自动重登”）
- **问题**：Linux.do 重登在大多数站点上秒退，报「站点未返回 OAuth state」。原因是取 state 只试了老接口 `GET /api/oauth/state?mode=login`（返回 `data: "<state>"`），而 new-api 的 rc 构建早已把它标准化成 `POST /api/oauth/state`，请求体 `{"provider":"linuxdo","intent":"login"}`、响应 `data.flow_token`——**GitHub 那条链路早就在用这个接口**（`newApiGithubOauthRelogin.ts`），Linux.do 这条一直没跟上。
- **实测**：12 个站里只有 2 个（`lazydaily`、`123nhh`）还答老形式，其余 10 个全部只认 POST 形式。用托管浏览器打开站点登录页抓包确认了前端真实调用：`POST /api/oauth/state {"provider":"linuxdo","intent":"login"}` → 拿 `flow_token` 当 `state` 拼 `connect.linux.do/oauth2/authorize`。
- **改动**：
  - `assistedLogin/sites/linuxDoOAuthRelogin.ts`：抽出两个纯函数 `readLegacyOAuthState()`（老形式的裸字符串）与 `readOAuthFlowToken()`（rc 形式的 `flow_token`）；`readOAuthStateInPage()` 先试老接口，拿不到再试 POST 形式（两者都受同源会话约束，只能在页面内发请求，所以是两次 `page.evaluate`）。失败文案改为「站点未返回 OAuth state（老接口与 flow_token 接口都没给）」。
  - 新增 `linuxDoOAuthRelogin.test.ts`（7 例）覆盖两种响应形态与错误体。
- **验证（真实演练）**：
  - 账号 `#37 HongShi`：把凭证换成死值并置 `expired` → `POST /api/accounts/37/balance` → **37 秒内自动重登成功**，凭证换成新的 `new_api_refresh`、状态回 `active`、余额正常（$11.28），并且 `sessionHygiene: {pruned, removed: 1, kept: 1}`——登录后自动清掉多余会话，正是用户要求的行为。
  - 账号 `#39 123nhh`（老形式站点）：同样演练通过。
  - 12 个站逐一核对 `api/oauth/state`：修复后全部拿到 state（10 个走 POST、2 个走 GET）。
- **配置**：给下列账号写入 `relogin: {provider:"linuxdo"}` 标记（共 12 个新启用，另 5 个此前已有，现计 16 个）：`#5 techmob`、`#6 ultrarouter`、`#7 happycoding`、`#8 coee`、`#9 grok-heavy`、`#26 咕咕嘎嘎`、`#34 霸气公益平台`、`#36 Loveyy`、`#37 HongShi`、`#38 TOM&JERRY`、`#39 123nhh`。
  - 启用前逐个核对了站点侧 `linux_do_id == 367936`，避免给非 Linux.do 绑定的账号挂错链路。
  - **两个账号被排除并回滚标记**：`#10 蛙蛙公益站`（回调回「New user registration has been disabled by administrator」，说明该站用户并非 Linux.do 绑定）、`#4 luckyg`（回调回 `Conflict`，Linux.do 账号在该站绑的是另一个用户）。两者的可用路径仍是密码重登，标记留着只会每 15 分钟白跑一次浏览器，因此移除。
  - `#13 fuka` 未启用：该站用户 `linux_do_id` 为空。
- **主要文件**：`src/server/services/assistedLogin/sites/linuxDoOAuthRelogin.ts`、`src/server/services/assistedLogin/sites/linuxDoOAuthRelogin.test.ts`、`docs/change-log.md`
- **状态**：已完成

### 34. 登记「123nhh」（api.123nhh.com）

- **类型**：站点登记（无代码改动）
- **需求来源**：本会话需求（“登录秘钥 plTynZihTd5znGNlmACUQ75QXq5OyME= 网址 https://api.123nhh.com/console/personal ID 417”）
- **站点事实（实测）**：
  - new-api 系的定制构建（`/api/status` 的 `system_name` 是默认的「New API」、`version` 为空，带 `/api/deployments`、`/api/enhancements/*`、会话日志等定制模块）；`checkin_enabled: true`、`turnstile_check: false`、`linuxdo_oauth: true`、`github_oauth: false`。
  - **直连可用**（无 CF 盾），站点未开系统代理。
  - 签到奖励区间 `min_quota 5000000 ~ max_quota 50000000`（约 $10~$100），账号 `linux_do_id = 367936`（与本机 Linux.do 账号一致），分组只有 `default`（倍率 1.2）。
  - 站上已有现成密钥 `li`（无限额度），**无需新建**；同样刻意未调用 `/api/user/token`。
- **登记结果（本机）**：
  - 站点 `#53 123nhh`（`new-api`，未开系统代理）+ 账号 `#39`（用户名 `3145215575`、`platformUserId 417`、`session` 模式、`checkinEnabled: true`）。
  - 令牌 `account_tokens #50 li`（default 分组、`ready`、默认令牌，由上游同步发现）。
- **验证**：
  - 签到：`POST /api/checkin/trigger/39` → `{"success":true,"message":"签到成功","reward":"69.188036"}`，余额 `$3489.25 → $3558.44`。
  - 余额同步正常：`quota 1744624154 / used 445301175`（约 $3489 余额 / $890 已用，历史 343 次请求），数据与站点一致。
  - 已按第 35 条配置 Linux.do 自动重登，并做过失效演练（通过）。
- **已知情况（站点侧，非配置问题）**：**该站当前没有任何可用模型**。`/api/pricing` 返回 `data: []`、`/v1/models` 返回空数组，任一模型（如 `gpt-4o`）都回 `No available channel for model … under group default (distributor)`；站点自带的「模型可用性」页（`/model-status`）也是空的。账号本身完全正常（能登录、能签到、能列令牌、余额真实），metapi 探测到 0 个模型是**如实反映站点现状**。等站方恢复渠道后，无需改配置，重新探测即可出量。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成（站点侧恢复渠道后即可出量）

### 33. 登记「TOM&JERRY」（lazydaily.de5.net）

- **类型**：站点登记（无代码改动）
- **需求来源**：本会话需求（“登录令牌 Y4/YzGbLGFFYpg9rJF5FBBMarrL+QA== 网址 https://lazydaily.de5.net/profile id:108 帮我登记这个网站”）
- **站点事实（实测）**：
  - new-api `v1.0.0-rc.21`，站名「TOM&JERRY」；`checkin_enabled: true`、`turnstile_check: false`、`email_verification: false`；`linuxdo_oauth: true`、`github_oauth: false`、`password_login_enabled: true`，但 `register_enabled/password_register_enabled` 均为 `false` 且 `linuxdo_minimum_trust_level: 2`（**注册门槛：Linux.do 信任等级 2**）。
  - **直连可用**（无 CF 盾），站点未开系统代理。
  - 账号 `linux_do_id = 367936`（与本机 Linux.do 账号一致）；签到奖励区间 `min_quota 500000 ~ max_quota 2500000`（约 $1~$5），账号可用分组为 `default` 与 `vip`。
  - `/api/token/` 列表接口正常（Bearer + `New-Api-User` 兼容头），站上已有现成令牌 `li`（默认分组、无限额度），因此**无需新建**；本次排查**刻意未调用 `/api/user/token`**，规避上一站（HongShi）那种「一调就轮换令牌」的坑。
- **登记结果（本机）**：
  - 站点 `#52 TOM&JERRY`（`new-api`，未开系统代理）+ 账号 `#38`（用户名 `3145215575`、`platformUserId 108`、`session` 模式、`checkinEnabled: true`）。
  - 令牌 `account_tokens #49 li`（`token_group = default`、`value_status = ready`、`is_default = 1`，由上游同步发现，非 metapi 新建）；模型 7 个 / 路由 6 条（`grok-4.5`、`grok-build-0.1`、`gpt-5.5`、`gpt-5.6-luna/sol/terra`）。
- **验证**：
  - 签到：`POST /api/checkin/trigger/38` → `{"success":true,"message":"签到成功","reward":"3.947302"}`，余额 `$66.50 → $70.45`；`checkin_logs #1759/#1771` 记录成功；上游 `checked_in_today: true`。
  - 代理链路：`grok-4.5` 连续 5 次请求经 metapi 全部 `200 success`。
- **已知情况（站点侧，非配置问题）**：**该站当前所有模型上游都是挂的**，与站内公告一致（“中午grok短暂失活…gpt依旧不可用，等我！！！”）。逐模型直连上游实测：
  - `grok-4.5` / `grok-build-0.1` → `auth_unavailable: no auth available (providers=xai)`；
  - `gpt-5.5` / `gpt-5.6-luna` → `auth_unavailable (providers=codex)`；
  - `gpt-5.6-sol` / `gpt-5.6-terra` → `Personal access token is inactive`。
  除 `grok-build-0.1` 外，这些模型名同时由 7~8 个其它账号提供，因此**不影响**下游可用性：metapi 的 `PROXY_MAX_CHANNEL_ATTEMPTS`（默认 3）会在命中账号 38 第一次失败后自动换渠道，并给该 channel 写冷却（实测 `route_channels #704/#705` 已 `cooldown_until` 置位）。等站点号池恢复后无需任何操作即可自动恢复。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成（站点侧上游恢复后即可正常出量）

### 32. 登记「HongShi API」（api.hongshi.cc.cd）

- **类型**：站点登记（无代码改动）
- **需求来源**：本会话需求（“用户id 308 登录令牌 cCcTZvtR+… 有签到，帮我配置登录一下” + “网址是 https://api.hongshi.cc.cd/profile”）
- **站点事实（实测）**：
  - new-api 系（`/api/status` 报 `HongShi API`，`version` 被抹成 `v0.0.0`），`checkin_enabled: true`、`turnstile_check: false`、`email_verification: false`、`linuxdo_oauth/github_oauth/password_login` 均开启，`quota_per_unit: 500000`；**直连可用**（无 CF 盾），因此站点未开系统代理。
  - 签到：`GET /api/user/checkin` 报 `enabled: true`、奖励区间 `min_quota 500000 ~ max_quota 2500000`（约 $1~$5），账号 `linux_do_id = 367936`（与本机 Linux.do 账号一致）。
  - **该站 `GET /api/user/token` 会「轮换」访问令牌**：每调用一次就返回一个新值，旧值立刻失效。本次排查时正是这一次无意调用，把用户给的原始令牌 `cCcTZvtR…` 弄失效了（已改用轮换后的新值）。已确认 metapi 代码中**不存在**对该接口的调用（`grep "user/token" src/` 为空），所以凭证在 metapi 手里不会被自己转掉；但**今后手工排查该站时绝不能再调 `/api/user/token`**。
- **账号与路由**：
  - 站点 `#51 HongShi API`（`new-api`，未开系统代理）+ 账号 `#37`（用户名 `3145215575`、`platformUserId 308`、凭证为访问令牌的 `session` 模式、`checkinEnabled: true`）。
  - 上游默认分组（`default`）能用的模型已经很少：站点广告 214 个模型，探测后只有 14 个进路由，其中实测只有 `openai/gpt-oss-20b` 真能出结果，其余多为 `has reached its end of life` 或 `Function '…': Not found for account …`（站点侧渠道已下线）。
  - 该用户的账号还能选「CF百万请求（每日）」分组，于是**在站点侧另建了一个该分组的令牌并纳入 metapi 管理**：`account_tokens #48 metapi-cf`（`token_group = CF百万请求（每日）`），探测出 **61 个可用模型**（`@cf/openai/gpt-oss-20b`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`、`@cf/qwen/qwen3-30b-a3b-fp8` 等）。连同默认分组的 14 条，账号共 **75 条路由**。
  - 令牌自动创建/多令牌同步走的是既有入口 `POST /api/account-tokens/sync/:accountId`（本次返回 `created 1 / updated 1 / total 2`），无需改动代码。
- **验证**：
  - 签到：`POST /api/checkin/trigger/37` → `{"success":true,"message":"签到成功","reward":"3.506312"}`；上游 `checked_in_today: true`；余额由 `$7.78` → `$11.28`；`checkin_logs #1758` 记录成功。
  - 真实调用：经 metapi 请求 `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 与 `@cf/openai/gpt-oss-20b` 均 `200 success`（`proxy_logs #33/#34`，account 37）。
- **注意**：默认分组里那 13 个已下线模型仍留在路由里，首次被选中会失败一次，之后由既有的失败退避机制避开；这是站点侧渠道下线，不是配置问题。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成

### 31. 登记「Loveyy 公益站」（ai.loveyy.qzz.io）

- **类型**：站点登记（无代码改动）
- **需求来源**：本会话需求（“帮我维护这个网站:https://ai.loveyy.qzz.io/dashboard/overview 用户名密码 3145215575/liyaodong7238508”）
- **站点事实（实测）**：
  - new-api `v1.0.0-rc.41`，站名「公益站」；`password_login_enabled: true`、**`turnstile_check: false`**、`email_verification: false`；`linuxdo_oauth: true`、`github_oauth: false`。
  - **无签到**：`/api/status` 的 `checkin_enabled` 为 `false`，触发签到只会回「签到功能未启用」，因此账号 `checkinEnabled` 置 `false`，避免每天刷出无意义的失败记录。
  - **必须走系统代理**：直连 `https://ai.loveyy.qzz.io` 被 Cloudflare 挡成 `403`（本地 `POST /api/sites/detect` 直连同样失败），开系统代理后一切正常。注意这与同批登记的其他 new-api 站（如霸气公益平台、ai.121628.xyz 直连可用）不同，属站点侧策略差异。
- **登记结果（本机）**：
  - 站点 `#50 Loveyy 公益站`（`new-api`，**`useSystemProxy = true`**，无 `externalCheckinUrl`）。
  - 账号 `#36`（用户名 `3145215575`、`credentialMode: session`、凭证为 `new_api_refresh` Cookie、密码已加密存为 `autoRelogin`、`platformUserId 7419`），建成 9 个可用模型 / 8 条路由（`route_channels`），上游令牌 `account_tokens #46`。
- **验证**：
  - 密码登录成功，模型同步 9 个，`account_tokens #46` 状态 `ready`。
  - 失效重登演练：把凭证改成死值并置 `status=expired` → `POST /api/accounts/36/balance` → 自动用密码重登换回新的 `new_api_refresh`、状态回 `active`，会话清理 `removed: 1 / kept: 1`。
  - 路由已重建核对：`route_channels where account_id=36` 由 0 恢复为 8。
- **教训（重要，避免重复踩坑）**：
  - 重登后 Cookie 处于**轮换边界**，此期间反复调 `POST /api/accounts/:id/models` 会让 `refreshModelsForAccount` 拿到 403 并判成“无可用模型”，从而**清空 `model_availability` 与 `route_channels`**。重登后只做一次 `balance` 即可，`models` 只在首次建号时调。
  - 恢复顺序：先 `refreshModelsForAccount(id)` 写回 `model_availability`，再触发一次路由重建（`PUT /api/accounts/:id` 且只改 `checkinEnabled` 这类非凭证字段时 `refreshModels = false`，但结尾会走 `rebuildRoutesBestEffort()`，是最轻的正确入口）。
  - **禁用** `/api/settings/maintenance/clear-cache`：它会整表清空 `model_availability` + `route_channels`。
  - **上游额度为 0，不是登记问题**：账号已正确绑定 Linux.do（上游 `linux_do_id = 367936`，与 metapi 的 Linux.do 账号一致），但站方给的 `quota = 0`、`used_quota = 0`、`group = default`（分组倍率 1），且站内**没有任何签到/每日领取**（`checkin_enabled = false`，`/api/user/checkin` 回「签到功能未启用」）。因此路由虽然建好，真实调用会被上游拒：`HTTP 403 用户额度不足, 剩余额度: $0.000000`，在 metapi 下游被统一表述为 `No available channels for this model`（`channelSelection` 的兜底文案，容易误判为路由没建好）。额度只能由站方发放（兑换码/站长群），metapi 侧无需也无法改动。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成

### 30. 登记「Fengwind API」（api.fengwind.com）并支持 SSO 型福利站签到

- **类型**：功能扩展 + 站点登记
- **需求来源**：本会话需求（“https://api-donation.fengwind.com/ 有 linux 登录，签到好像是另开的一个签到站，额度有效期选择永久”）
- **站点事实（实测）**：
  - 主站 `https://api.fengwind.com` 是 Sub2API：`GET /api/v1/settings/public` 报 `linuxdo` 登录/注册均开启，会话是 JWT（`auth_token` + 可轮换的 `refresh_token`），`POST /api/v1/auth/refresh` 可续期，`/api/v1/auth/me` 报用户 `id 2975`。
  - 用户提到的“签到站”是**独立福利站** `https://api-welfalre.fengwind.com`（`service: welfare`，`/api/health` 报 `0.1.34`）：签到接口 `POST /api/checkin`、状态 `GET /api/checkin/status`，**认证是 Bearer 而不是 Cookie**（`missing bearer token`），并且状态里带 `validity_options`：`d1/d2/d3/d5/d7/permanent`（`permanent` 的 `multiplier_bps` 只有 1000，即折扣最狠，换来“永久”不过期）。
  - 福利站不直接接 Linux.do：登录走 `https://api.fengwind.com/sso/continue?client_id=welfare...`，即**主站 SSO**；纯 HTTP 可用主站令牌 `POST /api/v1/sso/code`（`client_id: welfare`）拿到一次性 code，再 `POST /api/auth/sso/exchange` 换成福利站 `access_token`（有效期约 3 天）。
  - 捐赠站 `https://api-donation.fengwind.com` 是同一家的第三个服务（`service: donation`），与本需求无关：它按捐赠周期性发额度（策略里额度只有 7~28 天），没有签到接口。
- **实现范围（本次代码改动）**：
  - `accountExtraConfig`：`externalCheckin` 增加 `bearerToken` / `ssoClientId` / `validityOptionId`，并且三者任一存在即视为已绑定（此前必须有 `cookieHeader`，否则整条绑定被丢弃）。
  - `platforms/sub2api`：外部签到在“Cookie 会话”之外新增“Bearer 福利站”分支。绑定里带 `ssoClientId` 时，**每次签到现用主站令牌换一枚新福利站令牌**（无需再存第二个会过期的密钥，福利站令牌过期即自愈）；随后先查 `/api/checkin/status` 判断 `enabled` / `checked_in_today` / `can_check_in`，再按 `validityOptionId` 带上 `validity_option_id` + `validity_policy_version` 调签到接口，并把 `validity_label_snapshot`（如“永久”）写进签到结果。
  - 老的 Cookie 型福利站行为不变（含 `mode` 透传、`already` 文案、401 提示）。
- **登记结果（本机）**：
  - 站点 `#49 Fengwind API`（`sub2api`，`externalCheckinUrl = https://api-welfalre.fengwind.com`，未开系统代理——直连正常）。
  - 账号 `#35`（`platformUserId 2975`，`credentialMode: session`，凭证为主站 access + `sub2apiAuth.refreshToken`/`tokenExpiresAt`，`checkinEnabled: true`）；主站 access 约 1 天有效，由既有 `sub2apiRefreshScheduler` 自动续期；福利站令牌不落库，靠 SSO 每次现取。
  - 绑定：`externalCheckin = { ssoClientId: "welfare", userId: 6130, validityOptionId: "permanent" }`。
- **验证**：
  - 今日签到已用纯 HTTP 完成：`POST /api/checkin` 带 `validity_option_id: permanent` → `status: pending_credit`、`amount 0.76`、`validity_label_snapshot: 永久`；主站 `/api/v1/auth/me` 余额同步显示 `$0.76`。
  - metapi 触发 `POST /api/checkin/trigger/35` → `{"success":true,"message":"今日已签到","status":"success"}`，`checkin_logs` 记录 `success / 今日已签到`（走的是新写的 SSO 换令牌 → 状态查询分支）。
  - 建号时模型发现通过（`runtimeHealth: healthy`）、上游 `sk-` 令牌已自动创建。
- **注意**：`permanent` 的额度系数是 `0.1`（基础 $2~$15 折后约 $0.2~$1.5），比默认 `d2`（0.8）低很多——永久不过期但单次金额小，这是用户明确要求的选择。
- **主要文件**：`src/server/services/accountExtraConfig.ts`、`src/server/services/platforms/sub2api.ts`、`src/server/services/platforms/sub2api.test.ts`、`docs/change-log.md`
- **状态**：已完成

### 29. 登记「霸气公益平台」（ai.121628.xyz）

- **类型**：站点登记（无代码改动）
- **需求来源**：本会话需求（“登记这个网站 https://ai.121628.xyz/sign-in 用户名密码 3145215575/liyaodong7238508”）
- **站点事实（实测）**：
  - new-api `v1.0.0-rc.41`，站名「霸气公益平台」；`password_login_enabled: true`、**`turnstile_check: false`**（登录/签到都不需要人机校验），账号 `linux_do_id: 367936`。
  - **无签到**：`/api/status` 的 `checkin_enabled` 为 `false`，`GET/POST /api/user/checkin` 都回「签到功能未启用」。
  - 站点广告 90 个模型，但令牌所在分组是「免费分组 (distributor)」，该分组只对 52 个模型有可用渠道（`agnes-*` 等 38 个直接回 `No available channel for model … under group 免费分组`）。metapi 探测后只给这 52 个建路由，与站点实际能力一致，非配置问题。
- **登记结果（本机）**：站点 `#48 霸气公益平台`（`new-api`，未开系统代理——直连正常，与 seekai 不同）+ 账号 `#34`（用户名 `3145215575`、`credentialMode: session`、`platformUserId: 7525`、密码已加密存为 `autoRelogin`、**`checkinEnabled: false`**）。建号时会话清理退掉 2 条多余会话。
- **验证**：
  - 密码登录成功、模型同步 90 个（其中 52 个建成路由）、余额刷新 `$0.998`（`quota 499000 / 500000`）。
  - 失效重登演练：把凭证改成死值并置 `status=expired` → `POST /api/accounts/34/balance` → 自动用密码重登换回新 `new_api_refresh`、状态回 `active`。
  - 代理实测：`POST /v1/chat/completions`（`deepseek-v4-flash-free`）经 metapi 200，`proxy_logs` 记录 `account_id=34 / success`。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成

### 28. GitHub 快捷登录站点改为纯 HTTP 自动重登（并登记 SeekAi 站点）

- **类型**：功能泛化 + 站点登记
- **需求来源**：本会话需求（“这是登录访问令牌 T0Zc… / 用户id 8245 / 地址 https://seekai.cc/profile”）
- **背景**：`seekai.cc` 是 new-api `v1.0.0-rc.25`，签到开着（每次 $20），但站点开了 `turnstile_check`：签到接口对任何 HTTP 请求都回 `Turnstile token 为空`，且账号是 GitHub 快捷登录（`github_id` 已绑定、没有站点密码），所以只有「真实浏览器 + 已登录会话」这条路过得去。旧代码里 GitHub 的 HTTP 重登只对澎湃（`ai.hyper.nyc.mn`）一个站点开放，其余 GitHub 账号一旦会话失效就只能人工重绑。
- **站点事实（实测）**：
  - `/api/user/checkin` 走 HTTP 一定失败（Turnstile），`checkin_enabled: true`、`max_quota: 10000000`（$20/次）。
  - 国内直连被 Cloudflare 403（`Attention Required`，`cf-ray` 落地 AMS），本地代理落地 HKG 正常 → 该站点记录开启 `useSystemProxy`。
  - 站点暴露了标准化的 OAuth 流程：`POST /api/oauth/state {provider, intent}` 取 `flow_token` → GitHub `authorize` → 回调 `/oauth/github` 用 `Set-Cookie: new_api_refresh=…` 发会话。`kktoken.cc`（rc.25）、`api2.zdc.mom`（rc.41）同样支持，`ai.venlacy.com` / `sotamodel.net` 不支持（它们只报 Linux.do）。
- **实现范围**：
  - 新增 `assistedLogin/sites/newApiGithubOauthRelogin.ts`：把澎湃那段写死 origin 的握手抽成通用实现（`supportsNewApiGithubOauth()` 只判 URL 形状，`captureNewApiGithubCredentials(siteUrl)` 负责探测 `/api/status` 的 `github_oauth` / `github_client_id`、取 flow token、带导入的 GitHub 会话请求 authorize、校验回调 origin + `state` + `iss` 白名单、再换回 `new_api_refresh`）。错误语义与澎湃一致（`needs_provider_login` / `login_button_not_found` / `timeout`），并保留「用已存 GitHub 密码在托管浏览器里续期后重试一次」的自愈。
  - `hyper.ts` 退化成薄封装（同样的导出与消息，行为不变），测试原样通过。
  - `autoRelogin` 的 GitHub 分支：澎湃走原路径，其他站点走通用实现；成功后写入 `relogin: { provider: 'github', boundAt, lastReloginAt }` 标记（**不是 `oauth`**：拿到的是站点自己的 refresh cookie，路由必须继续用托管令牌）。
  - 顺手把同样的标记发给 `kktoken.cc`（账号 #22）与 `api2.zdc.mom`（账号 #30），它们也是 GitHub 绑定、没有站点密码。
- **登记结果（本机）**：站点 `#47 SeekAi`（`new-api`，`useSystemProxy: true`）+ 账号 `#33`（`credentialMode: session`，凭证为 GitHub OAuth 换来的 `new_api_refresh`，`checkinEnabled: true`，`relogin: github`）。
- **验证**：
  - 今日签到已通过浏览器兜底完成：`checkin_logs` 记 `success / 浏览器签到成功（已通过站点人机校验）/ reward 20`，余额 59.04 → 79.04（+$20），浏览器 `runs/site-47-…/run.log` 里可见点击与 `state=CHECKED`。
  - 失效重登演练：把账号凭证改成死值并置 `status=expired` → `POST /api/accounts/33/balance` → 通用 GitHub 握手换回新 cookie、状态回 `active`、余额 79.04，并把被取代的会话退掉（`sessionHygiene.removed=1`）。
  - `npx tsc -p tsconfig.server.json --noEmit`：通过；`npm run build:server`：通过；重启 `metapi.service` 正常；`npx vitest run`：2951 用例中 2939 通过、4 失败（与既有环境性失败一致）。
  - 新增单测 7 例：`newApiGithubOauthRelogin.test.ts` 6 例（URL 形状、捕获 cookie 且不漏 provider cookie、拒绝可疑回调、缺会话/未开放 GitHub/非法地址的判定），`autoRelogin.test.ts` 1 例（非澎湃站点的 `relogin: github` 走 HTTP 握手并落库）。
- **主要文件**：
  - `src/server/services/assistedLogin/sites/newApiGithubOauthRelogin.ts`
  - `src/server/services/assistedLogin/sites/hyper.ts`
  - `src/server/services/autoRelogin.ts`
- **状态**：已完成

### 27. 新增 X-API（x-api.cfd）平台适配器并登记站点

- **类型**：新平台接入
- **需求来源**：本会话需求（“这是模型调用需要的 sk key `xapi_...`，这是网址 https://x-api.cfd/console/models，只能 linux do 快捷登录”）
- **站点事实（实测）**：
  - `https://x-api.cfd` 是**自建网关**，不是 New API / Sub2API：`/api/status` 返回 `{"error":{"type":"not_found",...,"source":"x-api"}}`，`/api/user/self`、`/api/user/checkin`、`/api/user/sessions`、`/api/oauth/linuxdo` 全部 404。
  - 只有 **Linux.do 快捷登录**：`POST /auth/linuxdo/start` 需要 Cloudflare Turnstile token（`/api/public-config` 的 `turnstile_enabled: true`），没有用户名密码接口；登录后是服务端会话（`/api/me`、`/api/keys`），**API Key 不能当会话用**。
  - **没有签到**：前端 bundle 中「签到」出现 0 次，也没有 checkin 路由 ⇒ 以 API Key 连接，`checkinEnabled: false`。
  - 用户给出的 `xapi_...` 是**站点自己的 API Key**：`GET /v1/models` 返回 5 个模型，`POST /v1/chat/completions`（`grok-4.6`）实测 200。
- **实现范围**：
  - 新增 `XApiAdapter`（`platformName: 'xapi'`），继承 `StandardApiProviderAdapterBase`：`getModels` 走标准 `/v1/models`（自动兼容站点 URL 带不带 `/v1`），`getBalance` 沿用基类返回 0，`login` / `checkin` 显式回报「不支持」而不是抛错。
  - **不设置 `balanceUnavailableReason`**：余额接口检查在该标记之前命中，若设置会把 API Key 账号标成 `degraded`；API Key 账号本来就会以 `proxy_only` 跳过余额刷新。
  - `src/shared/platformIdentity.js`：新增别名 `xapi` / `x-api` / `x api` / `x-api.cfd`，并按 **host 精确匹配** `x-api.cfd`（含子域）识别平台，与 OrcaRouter 同样避免被 URL 路径 / query 里的同名文本误判。
  - 注册进 `adapters`；前端补齐平台入口：`defaultConnectionSegment`（API Key 优先）、`Sites.tsx`（平台下拉 + 徽章色）、`token-routes/utils.ts`（默认 openai 端点）、`payloadRuleProtocolOptions.ts`。
  - `siteInitializationPresets`：新增 `xapi-openai` 预设（默认 URL `https://x-api.cfd`，`recommendedSkipModelFetch: false`，推荐模型 `grok-4.7` / `grok-4.6` / `grok-4.5` / `grok-4.20-multi-agent-0309`）。
  - 文档：`README.md` / `README_EN.md` / `docs/getting-started.md` / `docs/upstream-integration.md`（新增 X-API 章节与预设表行）。
  - **保活（未做）**：站点没有会话接口，Linux.do 快捷登录又需要 Turnstile，当前无法做自动重登；如果以后要保活，需要新增浏览器驱动并在 `autoRelogin` 加分枝。
- **登记结果（本机）**：站点 `#46 X-API`（`platform: xapi`，`https://x-api.cfd`）+ 账号 `#32`（`credentialMode: apikey`，`checkinEnabled: false`）。
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`、`tsc -p tsconfig.web.json --noEmit`：通过；`npm run build:server`：通过；重启 `metapi.service`。
  - 新增单测：`xapi.test.ts`（4 例）、`index.test.ts` +2 例、`platformIdentity.test.ts` +3 条断言、`siteInitializationPresets.test.ts` +2 条断言、`defaultConnectionSegment.test.ts` +1 条断言。
  - 接口实测：`POST /api/sites/detect` 返回 `platform: xapi` / 预设 `xapi-openai`；`POST /api/accounts` 返回 `modelCount: 5`；账号模型列表 5 个；`POST /v1/chat/completions`（`grok-4.6`）经代理 200 且回复「你好」。
- **主要文件**：
  - `src/server/services/platforms/xapi.ts`
  - `src/server/services/platforms/index.ts`
  - `src/shared/platformIdentity.js`
  - `src/shared/siteInitializationPresets.js`
  - `src/web/pages/Sites.tsx`
- **状态**：已完成

### 26. 「每次登录后都清掉其他会话」补齐所有登录入口

- **类型**：功能补齐 + 缺陷修复
- **需求来源**：本会话需求（“你每次登录后都要把其他的登录会话给删除”），承接第 25 条 luckyg 被会话上限锁死的事故
- **目标**：不论账号走哪条登录路径，登录成功后都自动退掉被它取代的会话，不再让「登录 → 新增一条会话 → 从不清理」慢慢把站点配额堆满。
- **审计结果（改动前）**：
  - 已清理：`POST /api/accounts/login`（建号绑定）、`assistedLogin` 抓取（重新绑定）、`manualAccountCreationService`、`autoRelogin` 的密码重登 / GitHub OAuth / Linux.do OAuth / new-api 浏览器重登。
  - **未清理（真正的漏洞）**：`checkinService.tryBrowserCheckin()`。签到被 Turnstile 挡住时它会用浏览器**重新登录**并把新凭据写回账号行，却从不清理——而这条路径恰恰只在「已存会话早已失效」时才触发，也就是每次运行都可能新增一条服务端会话。luckyg 的会话就是这样攒满的。
  - **未清理（次要）**：`autoRelogin` 里辉哥中转（`gwrelay`）的浏览器登录分支，只写凭据不清理。
- **实现范围**：
  - `checkinService` 新增 `pruneSessionsAfterBrowserSignIn()`，在浏览器签到写入新凭据之后立即调用：
    - 在**账号凭据作用域内**执行，因为该凭据常是滚动的 `new_api_refresh` cookie，清理过程会花掉它并从 `Set-Cookie` 拿回新的值，只有作用域知道回写到哪一行；回写走 `applyRotatedCredentialIfCarried()`，避免把已作废的密钥写回去。
    - 只记录 `pruned` / `skipped` 两种结果。站点没有会话接口时返回 `unsupported`，不落盘任何字段——否则每次签到都会去改一条与它无关的账号记录。
    - 全程 best-effort：清理失败不影响签到本身。
  - `autoRelogin` 的 gwrelay 分支补上与其它重登路径相同的 `pruneAfterSignIn`（该面板没有会话接口，实际会得到 `unsupported`）。
  - 开关沿用既有的 `autoRelogin.pruneOtherSessions`（默认开启，显式设为 `false` 才关闭）。
- **仍然无解的部分**：`agentrouter` / `anyrouter` 走 Linux.do 驱动重登，但这两个平台**没有会话接口**（`adapter.listSessions` 不存在），清理无从下手，只能记为 `unsupported`。
- **主要文件**：
  - `src/server/services/checkinService.ts`
  - `src/server/services/checkinService.autoRelogin.test.ts`
  - `src/server/services/autoRelogin.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过；`npm run build:server`：通过；`npx vitest run`：2938 用例中 2926 通过、4 失败（与前几条一致的既有环境性失败）；重启服务后接口正常。
  - 新增单测 2 例（`checkinService.autoRelogin.test.ts`，23 例全过）：
    - 浏览器签到后被取代的两条会话被退掉（`revokeSession` 收到 `old-one`/`old-two`，**不含**本次登录的 `mine-sid`），并写入 `sessionHygiene { outcome: pruned, removed: 2, kept: 1 }`；
    - 凭据是无法辨认归属的透明 cookie 时**一条都不删**（避免把账号自己踢下线）。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成（luckyg 账号 `#4` 现有的满额会话仍需按第 25 条的途径清理）

### 25. 修复「抓错凭据把会话刷满」——luckyg 账号被 AUTH_SESSION_LIMIT 锁死的根因

- **类型**：缺陷修复 + 事故记录
- **需求来源**：本会话需求（“lucky 的网站被你一直登录导致会话超了，我也登录不了，删除不了会话”）
- **问题（已定位到代码）**：
  - 站点 `https://luckyg.131518.xyz`（站点 `#16` / 账号 `#4`）是较新的 new-api：登录返回**15 分钟的 access JWT** + **可轮换的 `new_api_refresh` cookie**，服务端为每次登录建一条会话。
  - 我们 09-29 之前抓凭据走的是浏览器，而 `harvestFromPage` 是**先看 localStorage、后看 cookie**。该站点把 access JWT 放在页面存储里，于是账号行存下的是那个 15 分钟 JWT，真正耐用的 `new_api_refresh` cookie 被跳过。
  - 后果链：JWT 15 分钟即失效 → 每轮巡检（每小时）`HTTP 401 Unauthorized, not logged in` → 触发重登 → **每次重登在站点新增一条会话**，而我们从没持有能用来清理的会话凭据。10-01 11:00 之后 24 次重登把活跃会话堆到站点上限，**10-02 01:13 起站点开始回 `409 AUTH_SESSION_LIMIT`**。
  - 站点侧语义（源码 `QuantumNous/new-api`，HEAD `1a4166d`）：`service/auth_session.go` 的 `createLoginSession()` 在 `CountActiveUserSessions(userID) >= common.UserSessionActiveLimit`（默认 50，站点可配）时**直接拒绝发新会话**（409 `AUTH_SESSION_LIMIT`），没有“踢掉最旧一条”的兜底；会话有效期 `LoginSessionTTL = 30 天`且**不是滑动续期**。所以上限一旦撞到，任何登录方式（密码 / 验证码 / Passkey / OAuth 都走同一个 `setupLogin`）都进不去，用户本人也无法登录去清理。
- **当前事实（如实记录，未解决）**：
  - 本地**不存在**任何可用的 luckyg 凭据。已排查：`hub.db`（只有两条已过期 JWT，sid `a5238573…` / `e71cf29a…`）、`hub.db-wal`、全部浏览器 profile 的 cookie 库（`github-browser`/`chinahk-browser`/`linuxdo-browser`/`checkin-browser/*`，均无 `131518` 记录）、各 profile 的 Local Storage、签到站点的 profile（`checkin-browser/site-16` 的 cookie 库为空，且其 `run.log` 记录登录从未成功）。
  - 因此**无法**从服务端调用 `DELETE /api/user/sessions/:sid` 或 `POST /api/user/sessions/revoke-others` 去清理会话——这两个路由都需要一个有效会话。
  - 恢复途径只有两条：① 用**仍持有该站 refresh cookie 的那台设备/浏览器**直接打开站点（refresh 流程不检查会话上限，会自动续上），再走「个人设置 → 会话管理 → 退出其他设备」；② 由站长把该账号的 `auth_version` 提一版（等价于“下线全部设备”）。站点 `email_verification=false`，所以“忘记密码自助重置”这条路走不通。
- **实现范围（防止再发生）**：
  - 新增纯函数 `selectHarvestedCredential()` 并让 `harvestFromPage()` 走它，抓取优先级改为：**`new_api_refresh` cookie ＞ 页面存储里的 token ＞ 其他 session cookie**。
    - 只把 `new_api_refresh` 提到存储之前：其它站点维持原顺序（存储优先），避免改变 SnowAPI 这类「必须带整份 cookie 串过盾」之外的行为。
    - 该 cookie 是轮换密钥，适配器本来就会拿它换 access token（`isRefreshCookieCredential`），所以存它能让账号在一个会期（30 天）里自行续期，不再每 15 分钟重新登录。
- **主要文件**：
  - `src/server/services/assistedLogin/sessionService.ts`
  - `src/server/services/linuxdoSession/sessionService.ts`（facade 导出）
  - `src/server/services/linuxdoSession/sessionService.test.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过；`npm run build:server`：通过；`npx vitest run`：2920 通过、4 失败（与前几条一致的既有环境性失败）。
  - 新增单测 4 例：refresh cookie 胜过页面存储里的 JWT（含从存储补 `platformUserId`/`username`）、无 refresh cookie 时仍存储优先、只有 session cookie 时回落、短值 flag cookie 不算凭据。
  - 站点行为实测：`POST https://luckyg.131518.xyz/api/user/login` → `409 {"code":"AUTH_SESSION_LIMIT"}`；两条历史 JWT 打到 `/api/user/sessions` → `401 AUTH_TOKEN_EXPIRED`。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：代码侧已完成；账号 `#4` 的站点会话需按上面的两条途径之一清理，服务端无法代为删除

### 24. Lanln 的 Linux.do 自动重登（含「重登标记不得影响路由」修复）+ New API 会话有效期调研

- **类型**：功能实现 + 缺陷修复 + 源码调研
- **需求来源**：本会话需求，未提供 GitHub Issue 链接（关联第 23 条的 Lanln 登记）
- **目标**：
  - 给 `https://ai.venlacy.com`（站点 `#45` / 账号 `#31`）配上「Linux.do 快捷登录」的自动重登，让凭据过期后不必人工再登一次。
  - 回答「New API 的会话过期时间是多少天、源码里写没写」。
- **实现范围**：
  - **重登链路**：`tryOauthRelogin` 增加 `linuxdo` 分支 → `tryLinuxDoRelogin`：
    - 复用 Any Router 那套共享驱动 `reloginWithLinuxDo`（先退站再授权，`hosts` 只放本站域名、回调用 `/api/oauth/linuxdo`），并用 15 分钟冷却（`extraConfig.browserRelogin.attemptedAt`）挡掉「余额刷新 + 定时签到」在同一小时内各起一次浏览器跑批。
    - `clientId` 先读 `/api/status` 的 `linuxdo_client_id`（被盾挡住就交给驱动在页面里自己解析）。
    - 驱动只负责「登进去」，凭据要靠新增的 `harvestSiteCredential()` / `harvestLinuxDoSiteCredential()` 从刚登录的浏览器里读回来——否则会出现「浏览器已登录、账号行里还是死密钥」。读完 `parkSiteTab` 把标签页停住，避免中继站 SPA 把刚展示给我们的密钥又轮换掉。
  - **重登标记写在 `relogin` 而不是 `oauth`（关键修复）**：该 fork 的管理 cookie 是裸 `session=`，它的 `/v1/*` 只认 `Authorization: Bearer`（实测 `Cookie: session=…` 打 `/v1/models` 得 401，而令牌 `C5XJ…Lemx` 得 200）。而 `extraConfig.oauth.provider` 在路由里是「这条凭据本身就是上游凭据」的声明：
    - `resolveChannelTokenValue()` 见到它就会把 `accessToken`（管理用 session）当成上游凭据发给 `/v1`；
    - `requiresManagedAccountTokens()` 见到它就不再使用站点上代管令牌。
    - 结果：账号显示 `healthy`、余额和签到都正常，但**它提供的所有模型都会 401**。改成 `relogin: { provider, boundAt, lastReloginAt }` 后路由语义不变，模型继续走代管令牌。实测路由解析由「通道 `tokenId=null`、凭据取 `session=…`」变为「通道绑定 `tokenId=26`（`C5XJ…Lemx`）」，该令牌直连 `/v1/models` 返回 200。
    - `getOauthProviderFromExtraConfig()` 与 `getReloginProviderFromExtraConfig()` 并列读取，GitHub 那类仍写 `oauth` 的账号行为不变；`buildReloginMarkerPatch()` 保留首次 `boundAt`、只更新 `lastReloginAt`。
  - **New API 会话有效期（源码 `QuantumNous/new-api`，HEAD `1a4166d`，2026-10-01）**：
    - `service/auth_token.go:22` `LoginSessionTTL = 30 * 24 * time.Hour` → **会话（refresh token / 服务端 session）有效期 30 天**。
    - `service/auth_token.go:20` `AccessTokenTTL = 15 * time.Minute`；`RefreshReplayWindow = 30 * time.Second`；`SecurityProofTTL = time.Minute`。
    - 以上均为**编译期常量**，没有 env / 配置项可调（全仓仅定义处一处赋值）。
    - **不是滑动续期**：`RefreshLoginSession()` 只校验 `session.ExpiresAt`，`RotateUserSessionRefresh()` 只换 refresh 值而不延长 `ExpiresAt`，所以 30 天是绝对上限，到期必须重新登录一次——这正是本条的自动重登要兜住的场景。
    - 并发会话数上限是可配置的：`common/constants.go` 的 `DefaultUserSessionActiveLimit = 50`、`DefaultUserSessionIssuanceLimit = 100` 等，env 名为 `USER_SESSION_ACTIVE_LIMIT` / `USER_SESSION_ISSUANCE_LIMIT` / `USER_SESSION_REVOKED_RETENTION_DAYS`。
    - 说明：上游主线已无名为 `session` 的 cookie（用 `new_api_refresh`），Lanln 的 `session=` 是该 fork 自己的机制，所以「管理 cookie 不能当上游凭据」这条在它身上才成立。
- **主要文件**：
  - `src/server/services/autoRelogin.ts`（含 `.test.ts`）
  - `src/server/services/accountExtraConfig.ts`（含 `.test.ts`）
  - `src/server/services/assistedLogin/sessionService.ts`
  - `src/server/services/linuxdoSession/sessionService.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过；`npm run build:server`：通过；`systemctl restart metapi` 后接口正常。
  - 新增单测：`autoRelogin.test.ts`（17 例，新增「Linux.do 重登并写 `relogin` 而非 `oauth`」「冷却期内不再起浏览器跑批」）、`accountExtraConfig.test.ts`（20 例，新增「`relogin` 标记不参与路由判定」「`boundAt` 保留、`lastReloginAt` 更新」）。
  - `npx vitest run`：2932 用例中 2920 通过、4 失败，失败项与前几条完全一致（generate-icons、index.default-path、factoryResetService、siteProxy、rebind-panel-focus，均为既有环境性失败）。
  - 实机（站点 `#45` / 账号 `#31`，构建后重启再跑）：
    - 自动重登：`tryAutoRelogin` 返回 OK，`session=` 凭据轮换（`MTc5MDk5MTMzMX…` → `MTc5MDk5NzE2OX…`），用新凭据读余额成功 `$286.853862`。
    - 标记落盘：`relogin.boundAt` 保持 `01:34:32Z`，`lastReloginAt` 更新为 `03:12:52Z`，`oauth` 不存在。
    - 管理链路不受影响：`POST /api/accounts/31/balance` → 200（`$286.853862`），`POST /api/checkin/trigger/31` → 「今日已签到」。
    - 路由：`previewSelectedChannel('dall-e-3')` → 站点 Lanln / 账号 `#31` / 通道绑定 `tokenId=26`；该令牌直连 `GET /v1/models` 返回 200（28 个模型），而 `Cookie: session=…` 返回 401。
    - 站点后端本身仍有 `HTTP 522`（`POST /v1/chat/completions` 时而 `You have reached the concurrent request limit`、时而 522），属站点侧状态，与本条无关。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

### 23. Lanln（ai.venlacy.com）登记 + 支持「列表脱敏、逐条查看」的密钥

- **类型**：功能实现 + 站点登记
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：
  - 登记 `https://ai.venlacy.com`（站点名 `Lanln`），账号 `3145215575`（用户 id `6597`），开启签到。
  - 该站的令牌列表只给脱敏值，注册后不要停在「请手动补全明文 token」上。
- **实现范围**：
  - 站点 `#45`（`platform=new-api`、`checkin_enabled=true`、无 Turnstile、登录只有 LinuxDO OAuth），账号 `#31`。
  - `NewApiAdapter` 新增脱敏密钥揭示：列表里长得像 `C5XJ**********Lemx` 的 key，改用该 fork 的逐条查看接口 `POST /api/token/{id}/key` 取明文（站点自己的「复制」按钮走的就是它）。
    - 只在 key 含 `*`/`•` 且该行有数字 id 时才多打一次请求，已经拿到明文的行不产生额外请求；顺序执行且上限 20 条，避免把按出口 IP 限流的公益站打成 429。
    - 没有该接口的 fork 会返回 404，行为与改动前完全一致：仍是脱敏值，仍记为待补全。
    - 返回体若仍是脱敏值也视作失败，不会把一个占位符当成真密钥存下来。
- **主要文件**：
  - `src/server/services/platforms/newApi.ts`（含 `.test.ts`）
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过；`npm run build:server`：通过。
  - 新增单测：`newApi.test.ts` 覆盖「脱敏值经逐条查看拿到明文」「fork 无该接口时原样保留脱敏值且不误判」。
  - `npx vitest run`：2928 用例中 4 失败，均为既有环境性失败（generate-icons、index.default-path、factoryResetService、siteProxy、rebind-panel-focus）。
  - 实机（站点 #45 / 账号 #31）：
    - 绑定前用凭据直连：`GET /api/user/self` 返回 id `6597`、用户名 `3145215575`、`linux_do_id=367936`，余额 `$283.17`。
    - 令牌同步：修复前为「2 条脱敏令牌待补全」，修复后 `maskedPending=0`、`updated=2`、默认令牌 `#26`，两条（`claude`/`li`）状态均为 `ready`；用取到的明文密钥直连站点 `GET /v1/models` 返回 28 个模型。
    - 模型与路由：`refreshModelsForAccount` 拉到 28 个模型，重建出 28 条通道（账号 #31 + 令牌 #26），全部 enabled。
    - 签到：`POST /api/checkin/trigger/31` 返回「签到成功」，奖励 `$3.681276`；刷新余额 `$286.85`，账号 `active`、运行状态 `healthy`。
    - 代理：请求确实被路由到本站通道（代理日志 `accountId=31`、渠道 `239/231/237/229`），但站点此刻**自己**返回 `HTTP 522: Connection timed out`——直连 `POST https://ai.venlacy.com/v1/chat/completions` 同样 522，属站点后端当前不可用，与登记无关；站点恢复后即可用。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

### 22. 枫叶公益登记 + 修复「换票丢密钥」与「限流被误判为凭据过期」

- **类型**：缺陷修复 + 站点登记
- **需求来源**：本会话需求，未提供 GitHub Issue 链接
- **目标**：
  - 登记 `https://api2.zdc.mom`（枫叶公益），账号 `liumeijicui`（用户 id `199`），登录后自动清理其他会话。
  - 查清「有账号自己就变成过期」的原因：不能把站的限流/异常答成凭据失效。
- **实现范围**：
  - **修复一（真正的根因）**：`new_api_refresh` 是滚动密钥，换票会作废本次提交的密钥、只把新密钥放在 `Set-Cookie` 里。凡是**没有账号凭据上下文**（或上下文里没有 `accountId`）的换票，新密钥无处落盘，行里留下已作废的旧密钥，账号下一次请求就 401，并被记成过期。改动：
    - `persistRotatedRefreshCookieByCredentials()`：上下文无法指定账号行时，按「被花掉的那一条密钥」反查所属账号行（按站点 origin + 密钥精确匹配）并做同样的 CAS 落盘；无上下文/上下文缺 `accountId` 的换票都走它。
    - 登录绑定的行前令牌查询（`POST /api/accounts/login`）、手工建号、`autoRelogin` 的三条重登路径、它们的登录后清会话，全部放进账号上下文，并把轮换值写回要落库的凭据。
    - 新增 `applyRotatedCredentialIfCarried()`：只有凭据本身带该 cookie 时才回填轮换值，避免把 `new_api_refresh=…` 拼到 JWT/API Key 后面把凭据写成垃圾。
  - **修复二**：站点边缘限流返回的 `429`（空 body、无 `x-tengine-error`）以前既不是「限流」也不是「401 是有效答」，换票失败后拿原始 cookie 当 `Bearer` 发出去，站点回 `401 invalid access token`，账号被置为 `expired` 并退出每日签到。改动：
    - `isEdgeRateLimitResponse()`：空 body 的 `429` 直接判为边缘限流。
    - `SiteThrottledError`：换票被限流时抛出，**不再回退成「拿 cookie 当 Bearer」**（回退必然产生假 401）。
    - `classifyFailureReason()` 新增 `rate_limited`：「站点限流，稍后自动重试，凭据本身没有问题」。
- **主要文件**：
  - `src/server/services/accountCredentialRotation.ts`（含 `.test.ts`）
  - `src/server/services/platforms/newApi.ts`（含 `.test.ts`）
  - `src/server/services/platforms/newApiShield.ts`
  - `src/server/services/sessionHygiene.ts`
  - `src/server/services/autoRelogin.ts`
  - `src/server/services/manualAccountCreationService.ts`
  - `src/server/services/failureReasonService.ts`（含 `.test.ts`）
  - `src/server/routes/api/accounts.ts`
  - `docs/change-log.md`
- **验证**：
  - `npx tsc -p tsconfig.server.json --noEmit`：通过；`npm run build:server`：通过。
  - 新增单测：`accountCredentialRotation.test.ts`（按密钥反查落盘、跨站点不误改、JWT 不被追加 cookie）、`newApi.test.ts`（空 body 429 判为限流；限流换票抛错且**不会**把 cookie 当 Bearer 发出）、`failureReasonService.test.ts`（限流不被判为凭据失效）。
  - `npx vitest run`：2926 用例中 4 失败，均为既有环境性失败（generate-icons、index.default-path、factoryResetService、siteProxy、rebind-panel-focus）。
  - 实机（枫叶公益 #30）：
    - 诊断脚本实测：无上下文的换票后，行内密钥被正确轮换（`row rotated: true`），随后用行内新密钥换票成功、余额可读。
    - 复现并修好限流路径：同一轮里连续 429 后，接口如实返回「站点当前限流（HTTP 429）」且账号保持 `active`，不再变成 `expired`；限流窗口过去后 `POST /api/accounts/30/balance` 直接恢复 200、余额 `$4`。
    - 登录清会话：绑定返回 `sessionHygiene: {outcome: pruned, removed: 4, kept: 1}`；站点侧 `GET /api/user/sessions` 实测只剩 metapi 自己这一条。
    - `POST /api/checkin/trigger/30`：`今日已签到`（站点今日签到已完成，链路正常）。
- **交付物**：代码、单元测试与持续变更日志；无新增 PDF 或截图。
- **状态**：已完成

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
  - 开关：默认开启、**按站点当天的全部额度抽满**（不写死次数——站点把上限从 10 提到 20 的那天，写死的 10 会白丢一半）。账号级 `extraConfig.lottery = { enabled: false, dailyDraws: N }` 可关掉，或把目标压到 N 次以下。
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
  - 自动路径同样验证：21:08 那一轮定时签到也走了抽奖检查，并把 `extraConfig.lottery.reason` 记成“今日抽奖次数已用完（10/10）”，日志行不再重复追加抽奖备注。
  - 追记：目标次数由“固定 10”改为“站点当天上限”（`dailyDraws: null` 即抽满），单测相应改为覆盖“按上限抽满 / 目标低于上限 / 站点未报上限时按当天剩余”。上线后 21:14 起两站仍为 10/10。
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
