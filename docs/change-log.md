### 68. 模型监控的「对话」改为按站点凭据直连：有账号或 sk 就能聊

- **类型**：缺陷修复
- **需求来源**：本会话（用户：「为啥还会出现这个提醒啊：该站点没有可直连的通道 有源站点和源站点的sk不就能直接调用吗？」）

#### 复核结论（先量后改）
- 提示不是空穴来风，但也确实是实现选错了凭据来源。原实现要求对话必须固定到一条 `route_channels`，
  而 `route_channels` 是**模型路由**配置的产物：站点有账号、有 sk，但没给这个模型配路由
  （比如 `lzhiyuu` / `LLM AI` / `Lucky` / `Kimi` 这类只有模型清单的站点），列表就是空的，
  于是弹「该站点没有可直连的通道」。
- 关键点：直连本来应该只依赖「站点 + 账号 + 凭据」，跟路由配置毫无关系。用路由通道来代表
  「可直连」是错的。
- 过程中还踩到一个真 bug：给 `executeEndpointFlow` 传 `proxyUrl` 会让请求打到
  `http://127.0.0.1:7890/v1/chat/completions`（把代理地址当成了 API base），上游回 400。

#### 改了什么
- **新增 `siteDirectChatService`**：直接按「站点 + 账号 + 凭据」发起对话，完全不查路由。
  - `listSiteDirectChatTargets(siteId)`：列出该站点可用凭据 —— 账号下就绪的 sk- 令牌优先，
    没有令牌的账号退回账号凭据（非 oauth 账号用 `api_token`，oauth 账号用 `access_token`）。
  - `resolveSiteDirectChat()`：校验站点 / 账号 / 令牌归属，给出可展示的失败原因；只返回令牌 ID，
    绝不把密钥明文带出接口。
  - `requestSiteDirectChat()`：复用现有的端点推导与请求构造（`resolveUpstreamEndpointCandidates`
    + `buildUpstreamEndpointRequest`，所以 Claude / Gemini / codex 等非 openai 平台同样适配），
    只发一次请求，失败就把上游原因原样返回，不做跨协议降级重试。
  - 站点代理只在 `dispatchRequest` 里通过 `withSiteRecordProxyRequestInit` 生效，不再误传 `proxyUrl`。
- **新增 `POST /api/model-monitor/chat/stream`**：直连对话，请求体里的 `model` 就是页面点中的那个，
  不做任何模型名改写；`/chat-channels` 额外返回 `credentials`（accountId / tokenId / label / 类型）。
- **弹窗**：下拉从「直连通道」改成「直连凭据」（例如 `3145215575 · default`），默认选第一条；
  一条凭据都没有时才禁止发送，提示语改成「该站点还没有可用凭据（账号或 sk- 密钥），先去「站点」里补一个再来对话。」
- 直连对话同样写一条使用日志（`route_id` / `channel_id` 留空，`client_app_name = 模型测试`），
  失败也记，方便在「使用日志」里看到真实原因。
- **线路行为固定为「sk 密钥 + OpenAI 协议直接打源站」**，并显式关掉回退：
  `executeEndpointFlow({ disableCrossProtocolFallback: true })`，只发候选表里第一个端点
  （openai 协议下即 `/v1/chat/completions`），失败不换协议、不换端点。实测线上抓到的报文是：
  - `site.url = https://happycoding.xyz`（platform `new-api`）
  - 凭据 = 账号下的 sk- 令牌（`valueStatus = ready`），请求头 `Authorization: Bearer sk-...`
  - 最终 URL = `https://happycoding.xyz/v1/chat/completions`
  - `body.model` = 页面点中的模型名（`kimi-k3`），无改写
  - 该请求不命中任何 `route_channels`，日志 `route_id / channel_id` 均为 `NULL`

#### 测试与实测
- 新增 `siteDirectChatService.test.ts` 4 例：完全无路由也能直连、无 sk 时退回账号凭据、
  令牌未就绪时不当作可用凭据也不带出明文、跨站点取账号被拒。
- 路由用例新增「对话只依赖站点自己的凭据，没有路由也能直连」：不建任何 `token_routes` /
  `route_channels`，`chat-channels` 仍返回 `credentials`，且响应里不出现密钥明文。
- 前端架构测试改成正向断言：走 `api.directChatStream()`、带 `accountId / tokenId`、
  不再出现 `api.proxyTestStream(` / `forcedChannelId` / `__auto__`。
- 相关套件 61 例通过（直连服务 / modelMonitor 路由与服务 / 对话弹窗架构 / api / proxy 测试），
  三道 `tsc` 通过。
- **生产实测（真实调用）**：
  - happycoding 的 `kimi-k3`：`POST /api/model-monitor/chat/stream` 返回 200 并流出
    `moonshotai/kimi-k3` 的 SSE 内容，日志 `route_id=NULL / channel_id=NULL / account_id=7 /
    model_requested=kimi-k3 / status=success / client_app_name=模型测试`。
  - 南梁 API（`route_channels = 0`，之前必然弹「没有可直连的通道」）：现在返回可用凭据
    `3145215575 · metapi`；用它发起对话，上游如实回 503 `No available channel for model
    deepseek-v4-flash under group default` —— 说明请求**真的打到站点**了，站点侧没有可用通道是
    站点自己的问题，不再是本地一句「没有可直连的通道」把用户挡在外面。
- 界面复验（无头 Chromium）：happycoding 的 `deepseek-v4.1-flash` 卡片点「对话」，下拉显示
  「直连凭据：3145215575 · default」，状态行「直连目标站点 happycoding，用「3145215575 · default」
  的凭据直接调用，不经过新路由 / 老路由，也不会转发到其它站点。」
- **主要文件**：`src/server/services/siteDirectChatService.ts`（新增）、
  `src/server/services/siteDirectChatService.test.ts`（新增）、`src/server/routes/api/modelMonitor.ts`、
  `src/web/api.ts`、`src/web/components/ModelChatModal.tsx`、`src/server/routes/api/modelMonitor.test.ts`、
  `src/web/pages/modelMonitor.chat.test.ts`
- **状态**：已完成

### 67. 提示词管理：样式归位、题面中文化、快捷提示词回填输入框

- **类型**：缺陷修复 + 文案调整
- **需求来源**：本会话（用户：「提示词管理做的还是太差了，样式啥的都乱了，而且提示次详情不要英文，并且不满意，我要的是对话选择提示词的时候，提示词详情直接粘贴到对应的框里面，你目前不知道是不是」）

#### 复核结论（先量后改）
- 先说第 3 点：**「选中题目名称 → 描述自动填进对话框」本来就是生效的**，之前只是没人实测过。这次用无头 Chromium 真实点了一遍：打开「模型监控 → 对话 → 快捷提示词」，点第一项「鹈鹕骑自行车（原版）」，输入框 `textarea.value` 立刻变成 `请用 SVG 画一只骑自行车的鹈鹕`，选择面板同时收起。逻辑无需改动。
- 样式确实是坏的，量出来三条硬证据：
  - 表格写的是 `className="table prompt-library-table"`，但仓库里根本没有 `.table`（约定是 `.data-table`）→ 表头 padding `0px`、无分隔线。
  - 搜索框写的是 `className="form-label"` / `className="input"`，这两个 class 在 `index.css` 里也不存在 → 输入框 padding `0px`、只剩浏览器默认边框。
  - 编辑弹窗同样用了不存在的 `form-group` / `form-label` / `input`。
- 题目描述是英文的根因：内置题库常量里 7 条 `prompt` 直接用英文原文写的，而且**已经按英文形态落库**（`prompt_cases.prompt`），只改源码常量不会更新已有行。

#### 改了什么
- **表格**：`table` → `data-table`，并补 `table-layout: fixed` + `td { white-space: normal }`。`.data-table td` 自带的 `white-space: nowrap` 会把长文本撑到 2372px、行高被拉到 123px，加上这两条后表格回到 1098px、行高 75px，列宽稳定、行内不再错位。
- **搜索框**：换成仓库标准写法 `.toolbar` + `.toolbar-search`（带放大镜图标、`padding: 8px 12px 8px 36px`、聚焦高亮），和「模型」等页面完全一致。
- **编辑弹窗**：改用页面内联样式常量（`FIELD_STYLE` / `LABEL_STYLE` / `INPUT_STYLE`，与模型转发弹窗同款：`padding 10px 14px`、`1px solid var(--color-border)`、`border-radius 8px`）。
- **操作列**：三颗按钮从竖排改回横排（`flex-wrap: wrap`），只在窄屏（≤768px）才竖排，避免每行被按钮撑高。
- **题面中文化**：内置题库 7 条英文 `prompt` 改成中文（骑自行车鹈鹕 / 糖果计数 / 字母 r / 10:10 时钟 / 旋转六边形弹跳球）；`9.11 vs 9.9`、`棉花与铁`、`中文指令版鹈鹕` 原本就是中文，不动。
- **历史数据一并纠正**：新增 `refreshLegacyBuiltinPromptTexts()`，在启动流程 `ensureBuiltinPromptPresets()` 里执行——只把「描述仍一字不差等于旧英文原文」的行改成中文，**用户自己改过的描述不动**；幂等，第二次启动匹配不到旧值。首次启动日志：`translated 7 legacy builtin prompt(s) to Chinese`。
- **清掉死代码**：`CaseTable.tsx` / `SuiteEditorModal.tsx` / `CaseEditorModal.tsx` 三个旧版组件已无任何引用（全仓 grep 确认），删除；`index.css` 里对应的 `.prompt-library-suite-*` / `-tags` / `-status*` / `-mono` / `-switch` / `-hint` / `-case-list` / `-case-meta` / `-toolbar*` / `-answer` 一并移除，`-preset-*`、`-chip`、`-btn-sm`、`-muted` 仍在用，保留。

#### 测试与实测
- 新增服务用例「会把历史遗留的英文题目描述纠正成中文，但不动用户改过的描述」：导入鹈鹕题库 → 把一条改回旧英文、把另一条改成自定义中文 → 跑 `ensureBuiltinPromptPresets()` → 第一条变中文、第二条保持自定义、再跑一次 `translated === 0`（幂等）。
- 相关套件 52 例通过：`promptLibrary.architecture.test.ts`、`promptLibraryService.test.ts`、`promptLibrary.test.ts`（路由）、`modelMonitor.chat.test.ts`、`listFilters.architecture.test.ts`、`modelForwarding.architecture.test.ts`、`tokenRouter.cache.test.ts`；三道 `tsc` 通过（server / web / web.test）。
- 真实浏览器复验（无头 Chromium，1400×1000）：表头 padding `10px 14px`、`border-bottom 1px`，搜索框 padding `8px 12px 8px 36px`、圆角 `8px`，弹窗输入框 padding `10px 14px`、边框 `solid 1px`；表头文案为「题目名称 / 题目描述 / 答案 / 操作」；全库 10 条题目描述均为中文；点「快捷提示词」第 1 项后 `textarea.value` 等于该题描述。
- **主要文件**：`src/web/pages/PromptLibrary.tsx`、`src/web/pages/prompt-library/SimpleCaseEditorModal.tsx`、`src/server/services/promptLibraryService.ts`、`src/server/index.ts`、`src/web/index.css`、`src/server/services/promptLibraryService.test.ts`
- **状态**：已完成

### 66. 模型转发：顺序按钮全部可点，改动立即作用于真实调用顺序

- **类型**：缺陷修复 + 交互调整
- **需求来源**：本会话（用户：「模型转发那感觉做的不怎么对，置顶是所有都能点，只是置顶相当于顺序最靠前，而且上移，下移也是改的默认调用的顺序，而不是只是显示用的，改完帮我测试几条，改变模型顺序后，调用的模型也跟着改变」）

#### 复核结论（先量后改）
- 先按用户描述逐项实测，结论是**排序本身已经同步到真实优先级**：`sort_order` 会写进 `route_channels.priority`，路由器按 P0→P1 分层，只在前一层停用 / 冷却 / 连续失败时才落到下一层。
- 但实测中确实翻出两个问题：
  1. **改动不是立即生效**：`syncModelForwardRule` 只写库，没有失效 tokenRouter 的进程内路由缓存（`routeMatchCache`，TTL 1.5s）。窗口内仍按旧优先级派发，看起来就像「只改了显示」。
  2. **置顶在第一行被禁用**：`disabled={targetBusy || isFirst}`，用户想点却发现点不动；上移 / 下移同样按首尾位置置灰。

#### 改了什么
- **立即生效**：`syncModelForwardRule` 收尾统一调 `invalidateTokenRouterCache()`，覆盖新增 / 编辑 / 移动 / 启停 / 删除目标；`deleteModelForwardRule` 删完通道也一并失效，避免残留快照指向已删通道。
- **按钮全部可点**：置顶 / 上移 / 下移 只在「本行操作进行中」禁用，不再因是否首行 / 末行置灰；置顶对首行是幂等操作（不报错）。三个按钮补 `data-testid`。
- **语义写清楚**：目标徽标从「目标N」改成「顺序N」（悬停提示「调用顺序：数字越小越先被调用」），列表下方加说明「顺序即默认调用顺序：排在前面的目标优先被调用，该目标停用 / 冷却 / 连续失败时才自动落到下一个。」

#### 测试与实测
- 新增回归用例（`tokenRouter.cache.test.ts`）「模型转发调整顺序后立即改变调用目标，不等缓存 TTL」：把 TTL 调到 60s（只有显式失效才能立即生效），建一条双目标转发规则 → 选通道命中第 1 个 → 置顶第 2 个 → 再选命中第 2 个 → 下移还原 → 命中回到第 1 个 → 对首行重复置顶不报错。**故意摘掉 `invalidateTokenRouterCache()` 复跑，该用例转红**（`expected 2 to be 3`），确认它真能拦住这个回归。
- 架构测试同步更新：断言三个按钮的 `data-testid`、不再存在 `disabled={targetBusy || isFirst/isLast}`、顺序提示文案、以及 `syncModelForwardRule` / `deleteModelForwardRule` 都带缓存失效。
- 相关套件 86 例通过（forward 服务 / 路由 API / tokenRouter 选择与缓存 / pattern 同步 / 转发页架构），两道 `tsc` 通过。
- **生产实测（真实调用，非单测）**：对外模型 `gpt-6-astra` 绑两个目标（glm-5.3-flash、deepseek-v4.1-flash），走 `/api/test/proxy/stream` 自动路由，逐条核对 `proxy_logs` 落到的通道：
  | 操作 | 顺序（order/prio） | 实际调用通道 |
  |------|------------------|--------------|
  | 基准 | glm P0 / deepseek P1 | glm-5.3-flash（ch 1146） |
  | 置顶 deepseek | deepseek P0 / glm P1 | deepseek-v4.1-flash（ch 1128） |
  | 上移 glm | glm P0 / deepseek P1 | glm-5.3-flash（ch 1146） |
  | 下移 glm | deepseek P0 / glm P1 | deepseek-v4.1-flash（ch 1128） |
  | 首行重复置顶 | 不变 | deepseek-v4.1-flash（幂等，无报错） |
  每一步都是 0.5~2.4s 内立即换目标，最后一次调用后已把顺序还原成「glm 在前」。
- **主要文件**：`src/server/services/modelForwardService.ts`、`src/web/pages/ModelForwarding.tsx`、`src/server/services/tokenRouter.cache.test.ts`、`src/web/pages/modelForwarding.architecture.test.ts`
- **状态**：已完成

### 65. 英文站点名回填为站点官方中文名

- **类型**：配置调整（无代码改动）
- **需求来源**：本会话需求（“现在很多站点显示的是英文名，但是他的首页titel或者保存标签的时候是有站点的中文名的，没有的就保持原状。帮我更新目前英文站点看有没有对应的中文名吧”）

#### 做法
- 对全部 41 个站点逐个取「站点自己声明的名字」：`GET {url}/api/status` 的 `data.system_name`（new-api 系前端就是用这个渲染站点名与浏览器标题），并辅以 HTML `<title>` 兜底。
- JS 挑战页（Any Router）、Cloudflare 拦截页（KKtoken / SeekAi）、SPA 站点（sub2api 系 / SOTA / Agent Router / X-API 等）静态抓取拿不到名字，改用无头 Chromium 真实渲染后再读 `document.title` 与页头可见文案；被墙或需要过盾的再挂系统代理跑一遍。渲染结果与静态结果一致，未发现额外中文名。
- 只在「站点确实自称中文名」时才改，纯英文品牌名（happycoding / SeekAi / TOM&JERRY / HongShi API / SOTA Model / l0veyou / motomoto / X-API 等）保持原状；`l0veyou - 你的 AI 智能助手`、`MotoMoto · 公益 API` 这类标题里的中文只是品牌后缀/标语，不算站点名，同样保持原状。

#### 更新结果
| 站点 | 原名称 | 新名称 | 来源 |
|------|--------|--------|------|
| #18 | ultrarouter | 艺の公益站 | `system_name = Ultra Router - 艺の公益站` |
| #21 | grok-heavy | GN公益站 | `system_name = GN公益站` |
| #29 | fuka | 芙卡卡の小食堂 | `system_name = 芙卡卡の小食堂` |
| #31 | llmpm | 南梁 API | `system_name = 南梁 API` |

#### 验证
- 4 条更新均走 `PUT /api/sites/:id`，返回 200；回查 `GET /api/sites` 与库内 `hex(name)` 确认是合法 UTF-8，无乱码残留。
- 其余 37 个站点名称未改动。
- **踩坑**：第一次用 `python3 -c ... "$name"` 拼 JSON 时，因 shell 环境 `LC_ALL` 失效、Python 3.6 按 ASCII + surrogateescape 解析 argv，写入的汉字变成了 CESU-8 代理对（`ED B3 A8 …`）。改为「Python 先写好 UTF-8 的 JSON 文件，再 `curl --data-binary @file`」后正常；以后往接口写中文一律走文件，不要走命令行参数。
- **主要文件**：仅数据库登记（变更日志除外）。
- **状态**：已完成

### 64. 登记「小鸡毛公益API站」（api.ark717.com）

- **类型**：站点登记（无代码改动）
- **需求来源**：本会话需求（“帮我登记这个网站：https://api.ark717.com/security 用户名密码：3145215575/liyaodong7238508 登录秘钥：jDnn351BCYN9Ygj1aosulXxIHN7FXA== 有签到”）
- **站点事实（实测）**：
  - `https://api.ark717.com`，`system_name = 小鸡毛的公益API站`，`version = v1.0.0-rc.34-ark717.20260907.1`（New API 定制分支，`/security` 只是站内安全设置页，不是盾）；`checkin_enabled = true`、`turnstile_check = false`、`linuxdo_oauth = true`（`linuxdo_minimum_trust_level = 0`）、`github_oauth = true`。
  - **直连可用**（无 Cloudflare 盾），未开系统代理、未写 customHeaders。
  - 签到奖励 `min_quota 500000 ~ max_quota 1000000`（约 $1~$2/天），`grant_duration_days = 0`（不设过期）；账号已完成 55 次签到、今日已签（+997155 ≈ $1.99）。
  - 分组：`default`（倍率 1、限速 15RPM）与 `【GPT】降智号池`（倍率 0.05）两个。
  - 站上已有一个现成密钥 `li`（id 191、unlimited、default 分组），metapi 直接接管复用，**未新建**（上游 token 总数仍是 1）。
- **登记结果（本机）**：
  - 站点 **`#57 小鸡毛公益API站`**（`new-api`，未开系统代理）。
  - 账号 **`#43`**（用户名 `3145215575`、`display_name 柳眉积翠`、`platformUserId 76`、`linux_do_id 367936` 与本机 Linux.do 账号一致、`credentialMode: session`、`status=active`、**`checkinEnabled: true`**、密码已加密存为 `autoRelogin`）。
  - 走 `/api/accounts/login` 登记时自动做了会话清理（`sessionHygiene: {outcome: pruned, removed: 1, kept: 1}`），登录后轮转出的 `new_api_refresh=…` 会话已回写。
  - 令牌 **`account_tokens #103`**（`default` 分组、`ready`、默认令牌，源自上游同步）；模型 **32 个**全部探测可用，对应建出 32 条路由通道。
- **验证**：
  - 余额同步：`balance $85.30 / used $684.01 / quota $769.30`，与站点 `/api/user/self` 一致；`POST /api/accounts/43/balance` 二次刷新仍正常。
  - 签到：`POST /api/checkin/trigger/43` → `{"success":true,"message":"今日已签到"}`（站点侧今日已签，不会重复发放），`checkin_logs #3931` 落库。
  - 真实调用：用同步到的上游密钥 `POST /v1/chat/completions`（`gemini-3.1-flash`）返回 200，内容「正常」（`deepseek-v4.1-flash` 首包较慢，90s 超时，属上游调度慢，非登记问题）。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成

### 63. 提示词管理简化为三字段 + 站点/密钥列表补齐字段筛选

- **类型**：功能调整
- **需求来源**：本会话（用户：「提示词管理做的太麻烦了，我就想要题目名称 ，题目描述 ，答案(如果有的话)，测试的时候就选题目名称，带出题目描述就行了。还有很多菜单，如站点管理，秘钥管理，缺少字段查询筛选的功能，也帮我加上吧」）

#### 问题
- 提示词管理沿用了「题库 → 题目 → 判分模式 / 标签 / 排序」的整套结构，实际只用来做对话测试，编辑一条题目要过题库选择、判分模式、标签、排序等一堆跟使用无关的字段。
- 站点管理只有排序，没有关键词 / 平台 / 状态类筛选；下游密钥、账号令牌也缺少按字段过滤的能力，站点一多只能靠肉眼翻。

#### 改了什么
- **提示词管理砍到三个字段**：页面重写为平铺表格，只有「题目名称 / 题目描述 / 答案（可选）」，支持关键词搜索（名称 / 描述 / 答案）与新增、编辑、删除；题库、判分模式、标签、排序、启用开关全部从界面移除。内置题库导入后直接平铺进同一列表。
  - 后端新增简化接口：`GET/POST /api/prompt-library/cases`、`PUT /api/prompt-library/cases/:id`，内部落到默认题库（`my-prompts`），答案统一写 `expected_answer`，内置题库把评分要点写在 `answer_notes` 的也一并对齐读取。
- **对话测试按题目名称带出描述**：`ModelChatModal` 的快捷提示词改为读简化接口，列表只显示题目名称（附答案），选中后把题目描述填进输入框，不再出现题库概念。
- **站点管理字段筛选**：新增关键词（名称 / 地址 / 平台）、平台、签到状态（今日已签到 / 未签到）、余额（有 / 为 0）四个条件 + 一键重置，桌面端与移动端筛选面板共用同一组控件；排序作用在筛选后的集合上，全选可见项也跟随筛选结果。
- **下游密钥字段筛选**：在原有搜索 / 状态 / 主分组 / 标签之外，补上群组范围（已绑定 / 未限制）、模型范围（有限白名单 / 不限模型）、有效期（已过期 / 7 天内到期 / 永久有效）三个维度，重置按钮同步清空。
- **账号令牌字段筛选**：新增关键词（令牌名 / 账号 / 站点 / 分组）、站点、分组、状态（启用 / 禁用 / 待补全）四项筛选 + 重置，过滤结果直接驱动列表与全选。

#### 测试与实测
- 重写 `promptLibrary.architecture.test.ts`：断言页面只保留三字段编辑器、不再引用题库 / 判分模式 / 标签、内置题库仍可导入、对话弹窗按名称带描述且不再出现 `suiteName`。
- 新增 `listFilters.architecture.test.ts`：断言站点 / 下游密钥 / 账号令牌三处筛选控件、筛选逻辑与重置按钮均已接线。
- `promptLibraryService`、`xapiKeyService`、`DownstreamKeys`、`sites.*`、`accounts.tokens-header` 等 12 个相关套件共 73 例通过；两道 `tsc` 通过。

### 62. X-API 对话密钥每天自动重新签发（受管浏览器过 Turnstile）

- **类型**：新功能
- **需求来源**：本会话（用户：「x-api的sk key需要每天手动签发，你是过不去是么？」→「开始做吧，注意如果后期x-api被删除啥的，对应签发的定时任务应该也要自动停止的」）

#### 问题
- x-api.cfd 的对话密钥只能手动签发：`POST /auth/linuxdo/start` 直接回 `400 turnstile_required`，签发对话框还带第二道 Turnstile，任何纯 HTTP 客户端都过不去。
- 站点的密钥有闲置作废机制（`idleHours`，默认 24 小时），且**明文只在签发时显示一次**，过期后站点自己也不给看，于是必须每天重新签发。
- 站点**只允许 1 个有效 Key**（「已达有效 Key 上限（1），请先作废后再签发」）：不先作废旧 Key，签发按钮就是禁用的。

#### 改了什么
- 新增 `xapiKeyService`：在受管的 Linux.do 浏览器 profile 里跑完整流程——过登录页 Turnstile → Linux.do 授权 → 过签发对话框的 Turnstile → 抓一次性明文。
  - 站点的「1 个有效 Key」规则：签发前先列出并在页面内作废所有有效 Key，再刷新页面让「签发」按钮重新可用。
  - 明文只在签发响应里读取，脱敏/空响应一律不落库（绝不存 `****` 或半成品）。
  - 每一步都调 `keepAlive()`，避免受管浏览器 5 分钟空闲回收把流程掐断。
- **回写**：新 Key 作为该账号默认令牌写入 `account_tokens` 并同步 `accounts.api_token`；同账号其余令牌被证明已作废，统一置为禁用（保留行历史，路由不再使用），随后做一次模型刷新做校验。
- **定时任务**：`XAPI_KEY_ENABLED`（默认开）+ `XAPI_KEY_REFRESH_HOUR`（默认 5 点），每天一轮；同一账号当天已签过就跳过（重启不会重复签发烧掉配额），上一轮没跑完则跳过本次，不并发。
- **站点删除即自动停**：每轮都按当前库里的行重新挑选目标（`platform=xapi`/`x-api` 或 URL 命中 x-api.cfd，且站点启用、有账号）。站点被删除或改平台后目标集为空，任务只打一行 `idle` 日志、不再联系上游——等于随站点一起下线。

#### 测试与实测
- 新增 `xapiKeyService.test.ts` 16 例：host 防伪（look-alike 域名不算）、明文的严格解析（脱敏/非 JSON 拒绝）、有效 Key 判定、每日到期边界（未到点不签、当天签过不重复）、目标挑选（删站后为空、禁用站排除、无账号跳过），以及注入依赖的刷新流程（签发成功落库、站点消失时空转、当天已签跳过、失败时保留旧 Key 并回传真实原因）。
- 生产实测：真实签发一次成功（40s，作废旧 Key 0 个），新 Key 写入 `accounts.api_token`（48 位、`xapi_LgzydT…`）与 `account_tokens#101`（`metapi`、默认、ready），`GET /v1/models` 返回 200/5 个模型；重启服务后调度器首轮输出 `targets=1 issued=0 skipped=1`（当天已签，未重复签发）。

### 61. new-api 建密钥支持站点二级安全验证：明文回传 + 会话回写

- **类型**：缺陷修复 / 功能补全
- **需求来源**：本会话（用户：「帮我看下目前绑定的这些网站有没有建对话秘钥，一般是 sk- 开头的，如果没有能否通过 http 或者浏览器帮我建好，然后维护到我们的系统上」）

#### 问题
- 部分 new-api 分支把「创建令牌」放在二级安全验证后面：`POST /api/token/` 直接回 `403 VERIFICATION_REQUIRED` + 一次性 `verification_challenge`，不完成 `/api/verify` 就永远建不出密钥，账号只能在站点页面上手工建。
- 这些分支的令牌列表和单条读取都只回脱敏值，且没有 reveal 路由，所以「建完再读」拿到的还是 `****`，等于白建。
- 完成验证后站点会换发新的 `session` cookie；不存回去的话，旧 cookie 已经作废，下一次同步又要从头再验证一遍。

#### 改了什么
- `createApiTokenWithValue` 新增 `securityPassword` 选项（只在校验期临时传入，不落库）与 `rotatedSession` 返回。`newApi` 适配器在建密钥被安全验证拦下、且拿到了账号密码时，自动 `POST /api/verify {method:'password'}`，再用验证返回的**新会话**重试建密钥，并把新会话一并返回。
- 明文只认「建密钥响应」里的 key：响应是脱敏值就回 `null`，绝不把 `****` 当密钥存入库。
- 令牌同步与手动建令牌链路会自动带上账号密码（解密自 `autoRelogin`），建密钥成功后把轮转出的新会话写回账号（`persistRotatedRefreshCookie`，带 compare-and-set，避免覆盖更晚的会话）。
- 建密钥落库时同时记录 `tokenGroup`，默认分组也能正确进系统。

#### 测试与实测
- 假站新增 `/api/verify` 与安全验证分支，新增两个用例：「用账号密码过二级验证拿明文 key 并回传新会话」「没给密码时不返回半成品 key」。
- `newApi.test.ts` 48 例、`accountTokens.sync.test.ts` 34 例、`modelMonitorService.test.ts` 25 例共 107 例通过；两道 `tsc` 通过。
- 生产实测：哈基米API站（site 36）原先只有一条脱敏 `li` 令牌，走新链路后自动建出 `metapi` 密钥（48 位明文、`value_status=ready`）并回写轮转会话；用该密钥 `POST /v1/chat/completions` 返回 200。

### 60. 模型监控「对话」按钮 + 日志测试标记 + 内置提示词题库自动入库

- **类型**：新功能
- **需求来源**：本会话（用户：「模型监控的挂到转发后面再加个对话的按钮，直接对该模型发起对话。可以参考模型操练厂，日志里也标明测试。并且找找着提示词帮我刷到我们的提示词管理里，比如鹈鹕测试，糖果测试之类的提示词，对话的时候可以快捷选提示词，或者手动输入都行」）

#### 改了什么
- **「对话」入口**：模型监控的卡片视图和表格视图，在「挂到转发」旁边各加一个「对话」按钮，点开弹出 `ModelChatModal`，直接对「该站点 + 该模型」发一轮聊天。
- **固定通道可选**：弹窗打开时调 `GET /api/model-monitor/chat-channels?siteId=&model=` 拉出该站点下能接这个模型、且启用的通道（普通路由按 `model_pattern` 命中，转发路由按 `display_name` 对外名命中），默认固定到第一个；下拉里也能切「自动路由」。没有可用通道时只提供自动路由并给出提示。
- **复用测试链路**：发送走和模型操练厂同一条 `/api/test/proxy/stream`（`requestKind: json`、`stream: true`、带 `forcedChannelId`），支持流式增量、思考过程折叠、停止、清空对话，输入框 Ctrl/⌘ + Enter 发送。
- **日志标明测试**：`downstreamClientContext` 现在把带 `x-metapi-tester-request: 1` 的请求优先识别成 `clientAppName = 模型测试`（会盖过 Cherry Studio 之类的弱指纹）。测试代理请求本来就带这个头，所以操练厂和这个对话弹窗的流量在代理日志里都会显示为「模型测试」。
- **快捷提示词**：弹窗底部的「快捷提示词」面板一次拉取全部启用题目（新增 `GET /api/prompt-cases`，带题库名），支持按标题 / 题库 / 内容搜索，点一下填进输入框，也可以照常手动输入。
- **题库补齐**：内置题库新增「时钟测试」（SVG 时钟指向 10:10）和「六边形弹跳球」（单文件 HTML 的旋转六边形弹跳球），加上原有的鹈鹕测试 / 糖果测试 / 经典推理测试共 5 个。启动时 `ensureBuiltinPromptPresets()` 按 slug 幂等补齐——换库或新装后不用再手动点导入，已有的题库不会被覆盖。

#### 测试与实测
- 新增 / 更新单测：`listChatChannelsForSiteModel`（pattern 命中、转发路由按对外名命中且 `upstream_model` 取 `source_model`、过滤他站 / 禁用通道 / 空参数）；`detectDownstreamClientContext` 测试头优先于其它指纹；`GET /api/prompt-cases` 带题库名且只回启用题；`ensureBuiltinPromptPresets` 幂等；web 断言「对话」入口 + 弹窗要素。
- 相关套件 85 例通过，`promptLibrary.test.ts` 内置预设 slug 断言同步更新；两道 `tsc` 通过。

### 59. 站点公告只同步最近 2 天（新增保留窗口 + 历史公告清理）

- **类型**：优化
- **需求来源**：本会话（用户：「我们系统的公告，不知道是同步的上游站点多少天的，帮我改成只同步近2天的吧」）

#### 问题
- 上游（`sub2api` 的 `/api/v1/announcements?page=1&page_size=100`，以及各 new-api 站）会把很久以前的公告一起返回，同步逻辑是「来多少存多少」，导致库里积压了 7、8 月的老公告（实测库里 49 条里最老的是 7 月 15 日）。

#### 改了什么
- **保留窗口**：新增配置 `SITE_ANNOUNCEMENT_RETENTION_DAYS`（默认 `2`，已写进 `.env`）。同步时先按窗口判断：公告时间早于「现在 - 2 天」就**不落库**，计入 `skippedOld`。
- **时间基准**：`resolveAnnouncementTimeMs` 取上游「更新 / 创建 / 开始 / 结束」时间里**最晚**的一个——一条二月创建、今天被编辑过、或维护窗口还没结束的公告都算「新」，不会被误删。
- **无时间戳的公告保留**：像 new-api 的 `/api/notice` 只返回一段当前文本、没有任何时间戳，这类公告代表「站点当前公告」而不是历史记录，`resolveAnnouncementTimeMs` 返回 null，不受窗口过滤（否则会把站点当前公告也丢掉）。
- **历史清理**：每轮同步后会顺手把这个站点里时间早于窗口的存量公告删掉（计入 `pruned`），所以首次启用窗口不需要手工清库；公告页也加了副标题「只同步各站点最近 2 天的公告，更早的不会入库。」

#### 测试与实测
- 新增单测：老公告被忽略（`skippedOld=1`）且不入库；存量老公告在下一轮被清掉（`pruned=1`）；无时间戳公告跨轮保留；有未来 `endsAt` 的老公告按最新时间算仍保留。
- `siteAnnouncementService.test.ts` 5 例、store / polling / web 用例共 12 例通过；两道 `tsc` 通过。
- 生产实测：重启后首次同步把库里 49 条公告压缩到近 2 天范围（清理掉的都是 7-9 月的历史公告）。

### 58. 模型监控：「仅模型列表」站点不跟着 15 分钟轮次跑，改为每天早上 7 点后刷一次

- **类型**：优化
- **需求来源**：本会话（用户：「对于通过 sk- 拉出来的模型就不要做 15 分钟拉取一次了，他的变化很少，每天早上 7 点拉取一次就行」）

#### 改了什么
- **按状态跳过**：`executeModelMonitorFetch` 遍历站点时，上一轮状态是 `models_only`（没有监控接口、只用密钥列了模型）的站点，如果今天的刷新点上已经刷过，就整站跳过——不打上游、不写库、不清上一轮数据，页面继续沿用已有结果。
- **每天一次**：新增配置 `MODEL_MONITOR_MODEL_LIST_REFRESH_HOUR`（默认 7），判定逻辑 `isModelListDailyRefreshDue(fetchedAt, now, refreshHour)`——`fetchedAt` 早于「今天 refreshHour:00」就算到期，当天刷过就不再刷。窗口本来就是 7:00 起，所以 7 点后的第一轮就会把它们刷掉。
- **跳过可见**：`runModelMonitorFetch` 的汇总新增 `skippedModelListSites`，调度日志追加 `skipList=N`，并单独打一行 `[ModelMonitor] skipped N models-only sites (...)`；`/api/model-monitor/overview` 回传 `modelListRefreshHour`，页面在「仅模型列表」折叠块标注「（每天早上刷新一次）」。
- **正常站点不受影响**：有监控接口的站点依旧每 15 分钟一轮；站点如果后来升级出了监控接口，因为每天还会重试一次，会自动从 `models_only` 回到 `ok`。

#### 测试与实测
- 新增单测：`isModelListDailyRefreshDue` 边界（今天 7:00 之后刷过 = 不到期、6:59 刷的 = 到期、昨天刷的 = 到期、无记录/坏时间戳 = 到期）；集成用例「今天刷过 → `scannedSites=0` / `skippedModelListSites=1`，不打上游且数据保留；改成昨天 → 重新拉一次并把时间戳推进」；「正常监控站点连续两轮都照跑」。
- `modelMonitorService.test.ts` 22 例通过，web 断言 7 例通过，两道 `tsc` 通过。

### 57. 模型监控降级采集：没有监控接口的站点（sub2api / 老版本 new-api）改用密钥只拉模型列表

- **类型**：功能补全 + 缺陷修复
- **需求来源**：本会话（用户：「模型监控目前都是拉的别人模型广场的数据，对于 sub2api 之类，或者老版本的 new api 可能没有这些接口，对于这部分站点，是不是可以通过 sk- 的秘钥拉取模型，耗时这些无法获取到的就不显示」）

#### 改了什么
- **降级路径**：`fetchSiteMetrics` 在「平台没有 `getPerfMetricsSummary`」或「上游返回 404 说站点没有 `/api/perf-metrics`」时，不再直接判成 `unsupported`，而是用同一份凭据（账号 JWT 或 sk- 密钥）走 `adapter.getModels()`（即 `/v1/models`）把模型名拉回来。
- **指标留空而不是编 0**：降级拿到的模型行 `successRate / avgLatencyMs / avgTps` 全部写 `null`，`showThroughput=false`，`recentSuccess=[]`；`PerfMetricsModel` 的指标字段类型相应放宽成 `number | null`。页面成功率/延迟/吞吐显示 `—`，不显示假数据。
- **新状态 `models_only`（页面显示「仅模型列表」）**：降级成功的站点归到 `models_only`，与 `unsupported`、`error` 区分开；页头统计加「仅模型列表 N」，站点下拉标「（仅模型）」，另有一块折叠区列出这些站点。`ModelMonitorModelView.metricsAvailable` 由站点状态推导，卡片/表格据此隐藏成功率、延迟、吞吐与采样条，只显示模型名 + 价格 + 挂到转发。
- **失败原因写清楚**：降级也失败时把原因并进站点状态，例如「站点没有 /api/perf-metrics 接口（版本较旧）；用密钥没读回任何模型（密钥无权限或被盾拦截）」，不再笼统报一句不支持。
- **优先 sk- 令牌**：降级时把 `api_token`（sk- 密钥）排在账号 JWT 前面——`/v1/models` 本来就是密钥接口；一份读不到会再试下一份，最多 `MODEL_LIST_FALLBACK_LIMIT = 3` 份，避免令牌多的站点把每份都发一次上游请求。

#### 测试与实测
- 新增单测：`sub2api` 无监控接口 → 降级 `models_only`（去重、空名过滤、指标全 null、`metricsAvailable=false`）；老版本 new-api 404 → 降级成功；密钥也读不回模型 → 回到 `unsupported` 且原因包含「没读回任何模型」。`modelMonitorService.test.ts` 18 例、web 源码断言 6 例、连同模型转发相关共 55 例通过；两道 `tsc` 通过。
- 生产实测（重启后自动跑一轮，40 站点）：`799 models in 98570ms (ok=21 modelsOnly=10 empty=3 unsupported=2 error=4)`——原来 13 个「不支持」里有 10 个现在能显示模型列表（如 123nhh、Columbina 这两个站点连 `/v1/models` 也读不回来，仍如实标记为不支持并写明原因）。
- 注意：站点一个凭据都没有时会报 `error：站点下没有可用凭据（缺少账号或密钥）`（例如 X-API），这是配置问题，比旧实现直接吞成「站点不支持」更接近真实情况。

### 56. 模型监控定时采集修复（07:00-23:00 每 15 分钟）+ 一键挂到模型转发 + 站点/模型可搜索可输入

- **类型**：缺陷修复 + 功能补全
- **需求来源**：本会话（用户：「模型监控那7点到23点每15min刷新一次的定时任务好像失效了，帮我搞起来。如果到下个任务时，上次任务还没跑完，则忽略此次任务，任务都是单线程执行，一个个站跑，不要并发跑」+「模型转发里的站点名，模型名这些既能下拉搜索，又能直接输入填充」+「模型那加个操作能直接把该站点的该模型，再选择对外模型，直接挂到对外模型的最后面，重复的不允许添加，页面提醒」）

#### 1) 定时采集失效的根因与修复
- **根因一（直接原因）**：采集窗口配置默认是 `07:00-12:00`，而 `.env` 里没有覆盖，所以 12:00 之后一律不跑。用户要的是 07:00-23:00。默认值改成 23，并在 `.env` 里显式写死 `MODEL_MONITOR_WINDOW_START_HOUR=7`、`MODEL_MONITOR_WINDOW_END_HOUR=23`、`MODEL_MONITOR_INTERVAL_MS=900000`，不再依赖代码默认值。
- **根因二（可观测性）**：旧实现跑成功、跑失败都不打日志，页面也看不到调度状态，任务假死时完全无感。现在每轮「起跑 / 跑完 / 跳过」都写 `[Scheduler] Model monitor ...` 日志，并把调度状态（`nextRunAt / lastRunStartedAt / lastRunFinishedAt / skippedRuns`）并进 `/api/model-monitor/overview`，页头显示「下次采集」与「已跳过 N 次」。
- **重写调度逻辑**：用显式的「下次可跑时间」代替旧的 `now - 上次开始 < interval` 隐式判断，并且**启动时先 tick 一次**——进程在窗口内重启会立刻补一轮，不再白等 15 分钟（旧实现只要计时器起点不对，整段时间都可能不跑）。
- **跳而不排队**：到点发现上一轮还在跑时，只把本次 slot 记为「跳过」并顺延到下一个 interval，不排队、不并发；单飞（`runModelMonitorFetch` 复用同一轮 promise）保持不变。
- **单线程按站点顺序**：`executeModelMonitorFetch` 一直是 `for (const site of sites) { await ... }`，40 个站点一个一个采，没有跨站点并发；本次未改动采集顺序，只补了回归测试锁住这个行为。
- **实测**：重启后进窗口立刻自动起跑一轮——`40 sites, 655 models in 52096ms (ok=21 empty=3 unsupported=13 error=3)`，`nextRunAt` = 起跑时间 + 15 分钟，服务 RSS 约 200MB，无内存压力。

#### 2) 一键挂到模型转发
- **后端**：新增 `attachModelForwardTarget({ siteId, upstreamModel, modelName, accountId? })` 与 `POST /api/model-forward-attach`。
  - 对外模型已有规则 → 追加一个目标，`sort_order` 取「当前最大值 + 1」，也就是**永远挂在最后面**（优先级最低，作为兜底），并同步成 `route_channels.priority`；
  - 对外模型还没有规则 → 顺手新建一条，只有这一个目标（接口回 `created=true`，页面提示「已新建对外模型并挂上该模型」）；
  - 账号自动挑：优先该站点 active 且有可用令牌的账号，其次第一个 active 账号；也允许显式传 `accountId`（会校验归属站点）；
  - **重复拒绝**：同一账号 + 同一上游模型（大小写不敏感、trim 后比较）已存在时返回 400，文案 `「<对外模型>」下已经有 <模型> 这个转发目标了，不能重复添加`。
- **前端**：模型监控页的卡片和表格各加一个「挂到转发」按钮，弹窗里用可搜索 / 可输入的下拉选对外模型（已有规则直接选，输入新名字就新建），保存后 toast 出结果，重复挂载原样透出后端的原因。

#### 3) 站点名 / 模型名可搜索 + 可直接输入
- 新增通用 `Combobox` 组件（触发器本身就是输入框）：既能下拉搜索候选，也能直接敲字填充。
  - `allowCustom=false`（模型转发弹窗的「站点」）：只能选候选，但直接把站点名敲进去时，完全匹配或候选只剩一个就自动补全成那一项；对不上会回退，避免「看着填了其实没生效」。
  - `allowCustom=true`（「上游模型名」、监控页挂载弹窗的「对外模型」）：输入什么就用什么，候选只用于提示和快速挑选，回车即采用。
  - 支持 ↑↓ 高亮、回车选中、Esc 还原、× 清空、点空白处落定。
- 模型转发弹窗的「站点」「上游模型名」由 `ModernSelect` / `input+datalist` 换成 `Combobox`（上游模型名换掉 `datalist` 后可以真正自由输入）。

- **测试**：`Combobox.test.tsx` 5 例（过滤 / 直接输入补全 / allowCustom / 回退 / 点击选中）；`modelMonitorService.test.ts` 加 4 例调度器用例（进窗口立刻补一轮且按 interval、窗口外不跑、上一轮没跑完则跳过且不并发、开关关闭不启动，共 16 例）；`modelForwardService.test.ts` 加 1 例挂载（追加末尾 / 重复拒绝 / 自动新建，共 11 例）；`routes/api/modelForward.test.ts` 加 1 例挂载接口（共 6 例）；`modelForwarding.architecture.test.ts` 加 2 例（Combobox 接线、监控页挂载接线，共 9 例）。相关 52 例全部通过；server/web 两道 `tsc` 通过；`build:server` + `vite build` 通过。
- **端到端验证**：生产环境用真实站点实测挂载四步——新对外模型自动创建、第二个模型追加到末尾（priority 0/1）、大小写不同的重复挂载被 400 拦下、验完删除临时规则（路由与通道已清理）；自动采集一轮 40 站点成功。
- **主要文件**：`src/server/config.ts`、`.env`、`src/server/services/modelMonitorService.ts`、`src/server/services/modelForwardService.ts`、`src/server/routes/api/modelForward.ts`、`src/web/components/Combobox.tsx`、`src/web/api.ts`、`src/web/pages/ModelMonitor.tsx`、`src/web/pages/model-forwarding/RuleEditorModal.tsx`
- **状态**：已完成（已构建、重启并端到端校验）

### 55. 模型转发：对外模型名查重（大小写不敏感）+ 转发目标排序与单独启停

- **类型**：功能补全（模型转发页）
- **需求来源**：本会话（用户：「1.对外的模型名不能重复 2.模型下的转发目标1 目标2之类的，支持上移，下移，置顶，启用，禁用等操作」）
- **对外模型名查重**：`model_forward_rules.model_name` 上只有普通唯一索引，只按原始大小写比较，所以此前 `gpt-6-astra` 与 `GPT-6-Astra` 能各建一条规则、抢同一个对外模型名（已实测复现）。现在统一按**大小写不敏感 + trim** 查重：
  - 新增 `findRuleByModelName()`，用 `lower(model_name) = ?` 查询，创建与编辑都走它；
  - 报错文案带上已存在的那个名字（`对外模型 gpt-6-astra 已经有转发规则，模型名不能重复`），避免用户看不出撞了哪条；
  - 前端弹窗同步做即时校验：把**其它规则**占用的模型名（排除当前正在编辑的这条）传给 `RuleEditorModal`，输入撞名时直接禁用「保存」并红字提示，少跑一次注定失败的接口。
- **转发目标排序**：复用已有的 `model_forward_targets.sort_order`，新增 `moveModelForwardTarget(ruleId, targetId, 'up' | 'down' | 'top')`：
  - 先按当前顺序取出目标，把目标挪到目标位置，再 `renumberTargetSortOrders()` 重排成 `0..n-1`；
  - 越界操作（第一个再上移 / 最后一个再下移）是空操作，不报错；
  - **顺序即优先级**：同步阶段把 `index` 写进 `route_channels.priority`（此前一律写 0，等于所有目标同层按权重随机）。这样「目标1」会优先被选中，失败 / 冷却 / 停用后才落到「目标2」，与列表顺序一致。同一规则下目标的 `weight` 仍保留，仅在优先级相同时才起作用。
- **转发目标单独启停**：新增 `setModelForwardTargetEnabled(ruleId, targetId, enabled)`，只改这一条 `model_forward_targets.enabled` 并同步到它自己的通道，同规则下其它目标不受影响；规则级的启用 / 停用仍由原来那个按钮控制（通道 enabled = 目标 enabled && 规则 enabled）。
- **接口**：新增 `POST /api/model-forward-rules/:id/targets/:targetId/move`（body `{ action: 'up' | 'down' | 'top' }`）与 `POST /api/model-forward-rules/:id/targets/:targetId/enabled`（body `{ enabled }`），都返回更新后的完整规则；非法 action / 非法 id 返回 400。
- **前端**：转发目标从一排徽标改成有序列表，每行显示「目标N + 站点 + 账号 + 上游模型 + 状态」，右侧是「置顶 / ↑ 上移 / ↓ 下移 / 停用(启用)」，第一个禁用上移与置顶、最后一个禁用下移，停用的目标整行半透明，操作中禁用按钮防重复点击。
- **测试**：`modelForwardService.test.ts` 加 3 例（大小写不敏感查重建/改都拦、上移/下移/置顶顺序与通道 priority 一致且越界空操作、目标单独启停不影响其它目标）、`routes/api/modelForward.test.ts` 加 2 例（大小写重复 400、目标排序与启停 + 非法入参 400）、`modelForwarding.architecture.test.ts` 加 3 例（UI 操作接线、查重与优先级实现、弹窗即时查重）；相关回归 186 例通过；server/web 两道 `tsc` 通过。
- **端到端验证**：生产环境实测 `GPT-6-ASTRa` 创建被 400 拦下并提示已存在 `gpt-6-astra`；临时规则三目标实测置顶 / 上移 / 下移 / 停用后 `sort_order` 与 `route_channels.priority` 完全一致、停用只影响该目标，验完已删除（临时路由与通道已清理）；原规则 `gpt-6-astra` 走 SK 调用仍 200 正常，通道 `1128` priority=0。
- **主要文件**：`src/server/services/modelForwardService.ts`、`src/server/routes/api/modelForward.ts`、`src/web/api.ts`、`src/web/pages/ModelForwarding.tsx`、`src/web/pages/model-forwarding/RuleEditorModal.tsx`
- **状态**：已完成（已构建、重启并端到端校验）

### 54. 使用日志新增「新路由 / 老路由」标记与秒级耗时，并核对路由缓存性能

- **类型**：体验优化 + 性能核查
- **需求来源**：本会话（用户：「日志里能加上老路由和新路由的字段吗？然后时间能改成秒为单位吗？比如 0.8s。再看看原先的这些路由是不是都存在内存里的，不是的话看看耗时影响大不大」）
- **新老路由标记**：`proxy_logs` 只存 `route_id`，是否属于「模型转发」需要回查 `token_routes.model_pattern`。因此在 `GET /api/stats/proxy-logs`（列表）与 `GET /api/stats/proxy-logs/:id`（详情）两处查询里 `leftJoin token_routes`，用 `isForwardRoutePattern(model_pattern)` 判定并输出 `routeKind: 'forward' | 'legacy' | null`：
  - `forward` = 命中「模型转发」自动生成的 `forward:<对外模型名>` 路由（新路由）；
  - `legacy` = 老路由（含早期无 `route_id` 的精确/通配符路由）；
  - `null` = 该日志没有关联路由（如直连/本地模型），不误标为老路由。
- **耗时改秒**：`ProxyLogs.tsx` 的 `formatLatency()` 统一输出秒（`0.8s` / `1.2s` / `12s`），首字耗时、首字/总耗时、桌面与移动端全部复用同一函数，页面内不再出现 `ms` 字样。动态小数位：≥10s 取整、≥1s 一位、<1s 两位，并去掉末尾多余的 0。
- **展示位置**：桌面列表行、移动端卡片、展开详情各加一枚徽标（新路由=蓝色 info，老路由=灰色 muted）；无路由日志不显示徽标。
- **映射后的模型也进日志**：只要 `model_actual` 与 `model_requested` 不同（老路由的 `model_mapping`、新路由通道的 `source_model` 都会落到 `model_actual`），列表行在模型名下方追加一行 `→ deepseek-v4.1-flash`，移动端卡片追同一枚灰色徽标，鼠标悬停显示「模型映射：gpt-6-astra → deepseek-v4.1-flash」；映射后与请求同名时不重复展示。展开详情原有的「请求模型 → 实际模型」保留。
- **路由缓存性能核查（结论：影响可忽略）**：路由**不是全程常驻内存**。`tokenRouter` 里有两层进程内缓存——`routeCacheSnapshot`（`token_routes` 全表快照，只含 `enabled=1`）与 `routeMatchCache`（按 routeId 缓存 通道/账号/站点/令牌），TTL 均为 `TOKEN_ROUTER_CACHE_TTL_MS`（默认 **1500ms**，生产实测值 1500）。也就是命中缓存时零 DB 查询；每 1.5s 后的第一个请求走一次冷路径，需要查 `token_routes` 全表 + 该路由相关 `route_channels`/`accounts`/`sites`/`account_tokens`/`oauth_route_units`。
  - 以生产库规模实测（`token_routes=384`、`route_channels=658`，复制到临时库跑 `TokenRouter.selectChannel()`，25 轮冷启动 + 500 轮热命中）：**冷路径 avg 3.1ms / p50 2.7ms / p95 5.9ms / max 7.9ms；热命中 avg 0.21ms / p95 0.27ms**。
  - 结论：冷查询是「每 1.5s 至多一次」的摊销成本，且只有几毫秒，相对一次上游 LLM 请求（数百 ms 起步）完全可忽略，不会成为 p99 瓶颈；现有内存占用也只有几百行级别，无需改动。
- **测试**：`stats.proxy-logs.test.ts` 新增一例（`forward:` 路由 → `forward`、普通路由 → `legacy`，并覆盖详情接口），全套 9 例通过；`ProxyLogs.server-driven.test.tsx` 新增一例（映射模型展示 + 同名不重复），与 `logs.mobile.test.tsx` 共 17 例通过。
- **主要文件**：`src/server/routes/api/stats.ts`、`src/server/routes/api/stats.proxy-logs.test.ts`、`src/web/api.ts`、`src/web/pages/ProxyLogs.tsx`、`src/web/pages/ProxyLogs.server-driven.test.tsx`
- **状态**：已完成（已构建、重启并按生产数据端到端校验：`route_id=572` → `forward`，`route_id=75` → `legacy`；`gpt-6-astra → deepseek-v4.1-flash` 已在日志中展示）

### 53. 新增「模型转发」页面：对外模型名直接绑站点/上游模型/多账号，优先级高于老路由

- **类型**：新功能（独立转发规则 + 新页面）
- **需求来源**：本会话（用户：「我想要的是有个添加按钮，然后选择要转发的站点，模型名，如果该站点维护多个账号，还能选择多个账号…新路由的，比如 gpt-6-astra 生效就走新路由的，老路由默认失效，新路由没有启用的，依旧走老路由」）
- **数据模型**：新增 `model_forward_rules`（对外模型名唯一、启用状态、同步生成的 `route_id`）与 `model_forward_targets`（规则 → 站点 + 账号 + 上游模型 + 通道 id + 权重），迁移 `drizzle/0031_yielding_cerebro.sql`；两张表加进 `TABLES_WITH_NUMERIC_ID`，保证 MySQL/Postgres 下能拿到自增 id。
- **实现方式（复用既有调度，不另造一套选择器）**：每条规则会同步出一条真实 `token_routes` + 若干 `route_channels`，因此冷却、失败退避、权重随机、站点健康度、计费与日志全部沿用现有链路。
  - 生成的路由 `model_pattern` 带保留前缀 `forward:`（例如 `forward:gpt-6-astra`），`display_name` 才是对外模型名。前缀同时保证 `patternRouteChannelSyncService` 不会把其它路由的通道复制进来、也不会被复制出去。
  - 通道 `source_model` = 目标的上游模型名，`manual_override=1`，自动重建不会删改。
  - 令牌自动解析：优先默认令牌，其次支持该上游模型的可用令牌（`token_model_availability`）。
- **优先级与回落**：`tokenRouter.findRoute()` 先按 `display_name` 找启用中的转发路由，且要求「至少一个通道可派发（通道启用、账号与站点 active、不在冷却中）」，命中就直接用；否则跳过所有 `forward:` 路由，回到原来的精确匹配 / 通配符匹配。因此：**规则启用 → 老路由被接管；规则停用或全部通道不可用 → 自动回落老路由**，无需改动老路由数据。
- **修正一个会导致规则失效的坑**：`rebuildTokenRoutesFromAvailability()` 会删除「pattern 不在最新可用模型列表里」的精确路由，而 `forward:*` 不是真实模型名，会被每次模型刷新清掉（实测重启后规则路由被删）。已在该清理循环里跳过 `forward:` 前缀路由，并加了回归测试。
- **路由页面隔离**：`listRoutesWithSources()` 过滤掉 `forward:` 路由，新规则不会污染「路由」页面；`/v1/models` 里同一个对外模型名仍然只出现一次。
- **前端**：新增页面 `/model-forwarding`「模型转发」（侧边栏在「路由」之后）。顶层 `src/web/pages/ModelForwarding.tsx` 只做编排，弹窗拆到 `src/web/pages/model-forwarding/`（`RuleEditorModal` / `types`）。弹窗里：填对外模型名（带模型建议列表）、逐条添加目标（选站点 → 填/选上游模型名 → 勾选该站点下的账号多选，账号超过 6 个时带搜索），每个目标可单独删除；列表卡片显示目标、按站点的账号数、每个通道的状态（正常/冷却中/已停用/待命）与最近使用时间。
- **接口**：`GET/POST /api/model-forward-rules`、`PUT /api/model-forward-rules/:id`、`POST /api/model-forward-rules/:id/enabled`、`DELETE /api/model-forward-rules/:id`、`GET /api/model-forward-options[?siteId=]`（站点 + 账号 + 站点模型列表）。
- **测试与门禁**：新增 `modelForwardService.test.ts`（7 例：同步生成路由与通道、令牌自动解析、启停联动、同账号多上游模型、重名拦截、非法入参、删除级联、编辑时通道复用）、`tokenRouter.modelForward.test.ts`（3 例：转发优先 + 停用回落 + 冷却回落、重建不清理转发路由）、`routes/api/modelForward.test.ts`（3 例：CRUD/启停/删除、非法入参 400、选项接口）、`web/pages/modelForwarding.architecture.test.ts`（4 例：分层、多选账号、前缀隔离、路由与 API 接线）。相关回归 `tokenRouter*`、`tokens*`、`tokenRoutes*`、`modelService*` 共 227 例通过；`test:schema:unit` 15 例通过；server/web 两道 `tsc` 通过；`build:server` 与 `vite build` 通过；已 `systemctl restart metapi`，生产库自动建表成功。
- **端到端验证**：生产库建了规则 `gpt-6-astra → happycoding(site 19) / deepseek-v4.1-flash / 账号 7`，走网关 SK 连续调用 5/5 成功，`proxy_logs` 记为 `route_id=572 / channel_id=1128 / model_requested=gpt-6-astra / model_actual=deepseek-v4.1-flash`；停用规则后立即回落到老路由 `route_id=75 / channel_id=1125`，重新启用又回到转发路由；`POST /api/routes/rebuild` 后转发路由与通道均保留。
- **主要文件**：`src/server/db/schema.ts`、`drizzle/0031_yielding_cerebro.sql`、`src/server/services/modelForwardService.ts`、`src/server/routes/api/modelForward.ts`、`src/server/services/tokenRouter.ts`、`src/server/services/modelService.ts`、`src/server/routes/api/tokens.ts`、`src/server/index.ts`、`src/web/pages/ModelForwarding.tsx`、`src/web/pages/model-forwarding/*`、`src/web/App.tsx`、`src/web/api.ts`
- **状态**：已完成（规则 CRUD、多账号、优先级与回落、页面均已上线）

### 52. 路由页面支持模型映射可视化编辑：对外模型名可转发到上游任意模型

- **类型**：新功能（路由模型映射 UI + 展示）
- **需求来源**：本会话（用户：「在路由菜单里我只看见你设置了这个站，但是没有写具体模型…可以，帮我加一下吧，让我能随意映射模型」）
- **背景**：`token_routes.model_mapping` 早已是转发链路的一环（`resolveMappedModel()` 把请求模型改写成上游模型），但前端只定义过类型、没有任何展示或编辑入口，导致 `gpt-6-astra → deepseek-v4.1-flash` 这类映射只能靠改库设置，页面上看不到。
- **后端**：无需改动。`GET /api/routes`、`/api/routes/summary` 本就返回 `modelMapping`，`POST /api/routes`、`PUT /api/routes/:id` 本就接受 `string | null`（`src/server/contracts/tokenRoutePayloads.ts` 的 zod schema 已含该字段）。
- **前端**：
  - 新增 `src/web/pages/token-routes/ModelMappingEditor.tsx`：多行「请求模型 → 上游模型」编辑器，支持增删行；行内保留本地状态，避免边输入边被解析截断；存在半填写行时给出红色提示。
  - `src/web/pages/token-routes/ManualRoutePanel.tsx`：编辑弹窗底部新增「模型映射」卡片，`pattern` 与 `explicit_group` 两种模式都可编辑。
  - `RouteEditorForm` 新增 `modelMapping` 字段；`TokenRoutes.tsx` 在编辑时回填（`normalizeModelMappingValue`）、保存时归一化（空则写 null），并拦截未填完整的映射行（`hasIncompleteModelMappingEntries`）。
  - `src/web/pages/token-routes/RouteCard.tsx`：折叠卡片显示 `映射 <目标模型>` 徽标（多行时 `+N`），展开卡片展示完整的 `from → to` 映射链，鼠标悬停有完整提示。
- **数据**：生产库无需刷数据——全库仅 `token_routes.id=75`（`gpt-6-astra`）有映射，格式已是规范 JSON，与新旧读写路径都兼容。
- **测试与门禁**：`utils.test.ts` 补 4 例（解析合法/非法、序列化归一、空值、未填完整检测）；web/server 两道 `tsc --noEmit` 通过；`tokenRoutes*` 7 个用例文件 40 例通过 + `RouteCard.test.tsx` 16 例通过；`vite build` 通过并已 `systemctl restart metapi`。
- **端到端验证**：经 `PUT /api/routes/75` 改映射后走网关 SK 调用，`proxy_logs` 显示 `model_requested=gpt-6-astra / model_actual` 随映射变化（切到 `glm-5.3-flash` 时上游返回 503、日志记为按新映射转发，随即还原为 `deepseek-v4.1-flash` 并恢复 200），证明界面写回的映射确实生效。
- **主要文件**：`src/web/pages/token-routes/ModelMappingEditor.tsx`、`src/web/pages/token-routes/ManualRoutePanel.tsx`、`src/web/pages/token-routes/RouteCard.tsx`、`src/web/pages/token-routes/utils.ts`、`src/web/pages/TokenRoutes.tsx`

### 51. 新增「提示词管理」：题库 + 题目 + 标准答案/评分要点，内置鹈鹕测试与糖果测试

- **类型**：新功能（评测提示词登记）
- **需求来源**：本会话（用户：「帮我加个提示词管理的效果，有鹈鹕测试，糖果测试等等测试提示词，然后可能有些题目是有答案的，也一并登记」）
- **数据模型**：新增两张表 `prompt_suites`（题库）与 `prompt_cases`（题目），迁移 `drizzle/0030_perfect_firebird.sql`。题目字段里 `expected_answer` 可空——主观题只登记 `answer_notes`（评分清单），`judge_mode` 取 `exact` / `contains` / `regex` / `manual`，默认 `manual`；题库按 `slug` 唯一，题目按 `(suite_id, title)` 唯一，删题库级联删题。
- **内置题库（预设，不硬编码进库，一键导入才落表）**：
  - **鹈鹕测试**（Pelican Benchmark，出处 Simon Willison 2024-08）：原版 SVG 题 + 动画/无背景变体 + 中文指令变体，共 3 题；视觉主观题，没有唯一答案，登记的是评分要点（必须是可渲染 SVG、车轮/车架/车把/脚踏齐全、鹈鹕大喙与喉囊可辨、脚踩脚踏等）。
  - **糖果测试**：图中共 21 颗（9 圆 + 12 星），题目带**标准答案** `21`（`exact`），另一题只数圆形糖果答案 `9`，并写明常见错误答案 24/18/30、必须配图。
  - **经典推理测试**：strawberry 里几个 r（3）、9.11 与 9.9 哪个大（9.9）、一公斤棉花与一公斤铁（一样重），都带标准答案。
  - 导入幂等：按 `slug` 复用题库、按 `(suiteId,title)` 跳过已存在题目，**不覆盖用户改动**；已导入的题库再点一次只会「补齐缺失题目」。
- **后端**：`src/server/services/promptLibraryService.ts`（题库/题目 CRUD、标签归一化、判定方式校验、内置预设与幂等导入、`PromptLibraryError`）、`src/server/routes/api/promptLibrary.ts`（`/api/prompt-suites*`、`/api/prompt-cases*`、`/api/prompt-presets`、`/api/prompt-presets/:slug/import`），并在 `src/server/index.ts` 注册；两张新表加进 `TABLES_WITH_NUMERIC_ID`，保证 MySQL/Postgres 下插入能拿到自增 id。
- **前端**：新增页面 `/prompts`「提示词管理」（侧边栏排在「模型监控」之后）。按仓库分层要求，顶层 `src/web/pages/PromptLibrary.tsx` 只做编排，编辑弹窗/表格拆到 `src/web/pages/prompt-library/`（`SuiteEditorModal` / `CaseEditorModal` / `PresetImportModal` / `CaseTable` / `types`）。功能：题库下拉（可搜索）、题目关键字过滤、题库与题目的增删改、题目启用/禁用、一键复制提示词、导入内置题库弹窗；移动端题目以卡片呈现。
- **测试与门禁**：新增 `promptLibraryService.test.ts`（6 例：标签/判定归一化、重复拦截、导入幂等与补齐、鹈鹕全为主观题、级联删除、未知预设报错）、`routes/api/promptLibrary.test.ts`（4 例：增改查、非法入参 400、预设导入幂等、删除级联）、`web/pages/promptLibrary.architecture.test.ts`（5 例：分层、答案可空、四种判定方式、预设导入接线、路由/侧边栏/API 接线）。`test:schema:unit` 15 例通过，server/web 两道 `tsc` 通过，`build:server` 与 `vite build` 通过，已 `systemctl restart metapi` 并确认 `prompt_suites` / `prompt_cases` 在生产库建出。
- **主要文件**：`src/server/db/schema.ts`、`drizzle/0030_perfect_firebird.sql`、`src/server/services/promptLibraryService.ts`、`src/server/routes/api/promptLibrary.ts`、`src/server/index.ts`、`src/web/pages/PromptLibrary.tsx`、`src/web/pages/prompt-library/*`、`src/web/App.tsx`、`src/web/api.ts`、`src/web/index.css`
- **状态**：已完成（题库/题目 CRUD、内置题库导入、页面与接口均已上线；如需删除题库请在页面上操作，删除会连带清掉题目）

### 50. Sub2API 会话保活补齐：登录不再丢 refresh token，续期失败会接着走重登

- **类型**：缺陷修复（凭据持久化 + 续期兜底）
- **需求来源**：本会话（用户：「可以，刷一遍吧」——把 sub2api 站过一遍）
- **一、刷库发现的两个真问题**
  - **登录把 refresh token 丢了**：`Sub2ApiAdapter.login()` 只取 `data.access_token`，把同一个响应里的 `refresh_token` / `expires_in` 扔掉了。后果是绑定那一刻起，账号就只能靠一个只活几小时的 JWT 活着——到期后要么每小时重登一次，要么（站点把登录表单挂了 Turnstile 时）**根本回不去**。
  - **续期失败就到底了**：`balanceService` 在 `sub2apiAuth.refreshToken` 存在时只试 HTTP 刷新，刷新被拒就直接报错——`tryAutoRelogin()` 那条（可重放的 Linux.do 握手）**永远不会被走到**。这正是 `#11 l0veyou` 卡在 `expired` 的样子。签到路径则压根没有 sub2api 续期，每天第一次签到必定撞在过期 JWT 上。
- **二、修复**
  - `Sub2ApiAdapter.login()` 现在把 `refreshToken` / `tokenExpiresAt` 一起报出来（`LoginResult` 新增这两个可选字段，注释写明「只有一半的凭据等于没有」），账号绑定与自动重登两条路径都会写进 `extra_config.sub2apiAuth`。
  - `balanceService`：`sub2apiAuth` 刷新被拒后不再终结，而是把站点这次的原始拒绝留作文案、继续走 `tryAutoRelogin()`。刷新成功则完全不变（绝大多数情况仍然是纯 HTTP，不拉浏览器）。
  - `checkinService`：签到前若 sub2api 令牌将过期，先用 `refreshSub2ApiManagedSessionSingleflight()` 续一次，让每日签到走 HTTP 而不是撞 401。
  - `trySub2ApiLinuxDoRelogin()` 现在把驱动的判决（`onRefusal`）原样交给调用方记录：授权页没出现、站点回调没下发令牌、登录到了别的账号——这些都会写进账号健康原因，而不是被压成一句「Token 无效或已过期」。
- **三、驱动自身的两个问题（这轮实测抓出来的）**
  - **把浏览器里的旧令牌当成了本次结果**：`#11` 第一次重登「成功」用的其实是 profile 里上一次手工登录留下的、**已经过期一天**的 JWT（`exp` 比当前时间早 24 小时）。现在捕获前先读基线，并做两道校验：令牌自身还没过期、且与基线不同，否则按「读到旧会话」报错而不是存下来——把能用的凭据换成死凭据，比什么都不做更糟。
  - 授权后停在站点自己的回调页而无令牌时，文案点明是站点侧的问题（`#11` 的站点把授权结果送回了 `/auth/linuxdo/callback`，该地址返回 404）。
- **四、刷库结果（5 个 sub2api 账号）**
  - `#2 虾蹬王`（账号密码登录）：补上 `relogin` 兜底标记；`platformUserId` 341 与 JWT 一致；实测重登成功，`sub2apiAuth` 已换成新的 `rt_…`（有效期到 10-05 14:46），`/auth/me` 200。
  - `#11 l0veyou`：**修正了错了一轮的 `platformUserId`**（原 45215575，JWT 里其实是 9054，正好等于 `user.id`，与站点其它账号命名一致），并补上 `relogin`。驱动能走到授权页、能点「允许」、`connect.linux.do` 也确实下发了 `code`，但**站点把回调送进 404、不下发令牌**——站点侧缺陷，需人工在浏览器里登一次该站。
  - `#35 Fengwind API`：上一轮已修复，本轮复测 `/auth/me` 200。
  - `#17 100xlabs`、`#18 林夕(k40)`：**已确认无需改动**——两站的 `/api/v1/settings/public` 里 `turnstile_enabled=true` 且 `linuxdo_oauth_enabled=false`，`/api/v1/auth/oauth/linuxdo/start` 返回 404，即它们根本没有 Linux.do 快捷登录，只能用账号密码（两份密码站点自己回 `turnstile verification failed`，即密码本来就不对）。给它们加 `relogin` 标记只会每次失效白跑一趟浏览器，所以没加。
- **五、测试与门禁**
  - 新增/修改：`sub2api.test.ts` 2 例（登录带出 refresh 对 / 站点不给时不编造 token 过期时间）、`accounts.login-browser-session.test.ts` 1 例（绑定写入 `sub2apiAuth`）、`autoRelogin.test.ts` 3 例（sub2api 密码登录保留 refresh 对 / 非 sub2api 平台不写 `sub2apiAuth` / 驱动失败时 `onRefusal` 原样上报）、`sub2ApiLinuxDoRelogin.test.ts` 6 例（过期令牌拒绝、基线比对四例、空捕获）。
  - 回归：`src/server/services` + `src/server/routes` 共 **1844 例**，2 例失败与本次改动无关（`siteProxy.test.ts`、`factoryResetService.test.ts` 读本机 `HTTP_PROXY` 与 `.env` 的 `PROXY_TOKEN`，属既有环境耦合）；`tsc` 两道门通过，服务已重启。
- **主要文件**：`src/server/services/platforms/sub2api.ts`、`src/server/services/platforms/base.ts`、`src/server/services/autoRelogin.ts`、`src/server/services/balanceService.ts`、`src/server/services/checkinService.ts`、`src/server/services/assistedLogin/sites/sub2ApiLinuxDoRelogin.ts`、`src/server/routes/api/accounts.ts`
- **状态**：已完成（`#11` 站点侧回调 404 需人工登一次；其余 sub2api 账号均已核实清楚）

### 49. 补上 Sub2API 站的 Linux.do 自动重登：Fengwind 这类站现在能自己救活了

- **类型**：功能新增（自动续期驱动）
- **需求来源**：本会话（用户：「https://api.fengwind.com/profile 这个是linux do快捷登录，为啥登录不上啊」→ 查清原因后用户授权「可以做一下试试吧」）
- **一、为什么之前登不上（先查现场，全部实测过）**
  - `#35 Fengwind API`（site `#49`，platform `sub2api`）的 `extra_config` 里**没有任何 `oauth` / `relogin` 标记**，账号行 `oauth_provider` 也是 NULL → `tryOauthRelogin()` 在取 provider 那一步就返回了，系统每小时 401 之后**什么都没做**，`describeRenewalGap()` 只是照实说「没有可续期凭据」。上一轮的第 48 条补上了这句话，这一轮补上真正的能力。
  - 老的 `linuxDoOAuthRelogin.ts` 是照 new-api 写的：它先读 `GET /api/status` 拿 `linuxdo_client_id`，再走 `/api/oauth/state` + `/api/oauth/linuxdo`。**Sub2API 上 `/api/status` 是 404，也没有 `oauth/state`**，两条都走不通——同一个 provider，两套协议。
  - 站点和账号本身都没问题：`/api/v1/settings/public` 里 `linux_methods.linuxdo.login_enabled = true`，受管浏览器实测能走到授权页并显示该账号可授权。
- **二、Sub2API 的真实流程（在真实浏览器里逐跳验证后照抄）**
  - 入口只有一个：**`GET /api/v1/auth/oauth/linuxdo/start?redirect=%2Fdashboard`** → `302` 到 `connect.linux.do/oauth2/authorize`，授权后 `connect.linux.do/oauth2/approve/<token>` 由页面自己 POST，站点回调把**令牌对放在 URL 片段里**（`#access_token=…&refresh_token=…&expires_in=…`），前端再把 `auth_token` / `refresh_token` 写进 `localStorage`。
  - 三处让这件事必须是浏览器活：`connect.linux.do` 与站点自己的 WAF 都会对裸 HTTP 客户端弹挑战；批准动作是页面替访客发的 POST，没有请求可以重放。
  - 新增驱动 `src/server/services/assistedLogin/sites/sub2ApiLinuxDoRelogin.ts`：在受管 profile 里打开 `/start`，轮询 URL/`localStorage` 取令牌，命中 CF 挑战就走 `passCloudflareChallenge()`，在授权页点一次「允许」。**刻意不先退出站点登录**（与 new-api 驱动不同）：`/start` 每次都会新开一条 flow，回调片段里必然是新的令牌对，清站点存储反而有把 profile 留在已登出 SPA 的风险。
  - 换到别的账号时报 `needs_provider_login` 而**不是**把令牌存下来：静默把账号换成浏览器里那个人是唯一绝对不能发生的结果。JWT 里的 `user_id` 与账号的 `platformUserId` 不一致就直接拒绝。
  - **低频是硬要求**：`connect.linux.do` 的盾在连续尝试后会从「点一下」升级成硬 403 `Just a moment`，所以沿用既有的 `BROWSER_RELOGIN_COOLDOWN_MS`（15 分钟）且驱动本身不重试。
- **三、接进续期链路**
  - `tryOauthRelogin()` 里 `provider === 'linuxdo'` 时按 `site.platform` 分流：`sub2api` 走新驱动，其余仍走 new-api 驱动。
  - 成功后既写 `relogin` 标记（不是 `oauth`，路由必须继续用受管令牌），也把 `refreshToken` / `tokenExpiresAt` 写进 `extra_config.sub2apiAuth` ——**这是关键**：Sub2API 的 access token 只活几小时，有了这对 refresh 凭据，后续每小时续期走 `refreshSub2ApiManagedSession()` 的 HTTP 刷新，**正常情况下再也不会为这个站拉起浏览器**。
  - Sub2API 凭据是 JWT，不是站点保留会话列表的 cookie，其 adapter 也没有 session API，所以这条路径不做 prune（prune 只会写一条 `unsupported`）。
  - 顺手把两个 Linux.do 驱动的浏览器调用都**放进 `browserLane`**：这是唯一的有头队列，否则一次集中失效会同时拉起多个 Chromium（就是之前把机器内存打满的那类问题）。
- **四、生产验证（真实跑，不是单测）**
  - 给 `#35` 补上 `relogin: { provider: 'linuxdo' }` 标记后，用真实账号走完整链路：**43 秒**完成，`status: expired → active`，新令牌 `user_id = 2975`（与账号一致），`extra_config.sub2apiAuth` 已换成新的 `rt_…` 与到期时间，`browserRelogin.attemptedAt` 已记；随后 `GET /api/v1/auth/me` 返回 **200**，账号信息正确（`3145215575`）。
  - 顺带修好 `#11 l0veyou`（同为 sub2api + linux.do 绑定）：它此前也会被误送给 new-api 驱动。
- **五、测试与门禁**
  - 新增 `sub2ApiLinuxDoRelogin.test.ts` 15 例：协议判定、JWT 解析、片段/查询串取令牌、`expires_in` 兜底、换账号拒绝、空凭据不算捕获、授权页与论坛 bounce 的识别。
  - `autoRelogin.test.ts` 补 2 例：sub2api 分支不走 new-api 驱动、不触发浏览器签到、写回 `sub2apiAuth` 且 `oauth` 保持未定义；捕获失败时只写尝试标记、不动凭据。
  - 回归：`autoRelogin` / `checkinService.autoRelogin` / `balanceService.autoRelogin` / `sub2apiRefreshScheduler` / `sub2apiRefreshSingleflight` / `sessionHygiene` / `platforms/sub2api` 共 **109 例全绿**；`tsc` 两道门通过，服务已重启。
- **主要文件**：`src/server/services/assistedLogin/sites/sub2ApiLinuxDoRelogin.ts`（新增）、`src/server/services/assistedLogin/sites/sub2ApiLinuxDoRelogin.test.ts`（新增）、`src/server/services/autoRelogin.ts`、`src/server/services/autoRelogin.test.ts`
- **状态**：已完成（`#35 Fengwind API` 已恢复为 `active`，后续续期走 HTTP 刷新；其他 Sub2API 站只要绑过 Linux.do 也自动获得这条重登路径）

### 48. 失效提示改成「说真话」：站点挂了就写站点挂了，续不了期就说清为什么

- **类型**：缺陷修复（失败原因分类 + 提示文案）
- **需求来源**：本会话（用户：「再看看签到那里，是不是又有一些网站提示token过期了，看看为啥不能续期，尽量提示成真实原因，比如网站挂了就提示网站挂了」）
- **一、先查现场：现在到底有谁在报失效，为什么续不上**
  - 生产库里挂着的就 3 个账号，而且**三个的真实原因互不相同**，全部已用真实凭据复测：
    - `#4 luckyg`：密码是对的，站点回 **409 `AUTH_SESSION_LIMIT`**（并发会话数上限）。要等旧会话过期或由人在站点上「退出其他会话」，任何重试都无效 → 系统每小时自动重试，一有空位就会自己登进去。
    - `#10 蛙蛙公益站`：站点回 **`Username or password is incorrect, or user has been banned`**，即密码被改或账号被封，属于要人去核对凭据，自动续期不可能成功。
    - `#35 Fengwind API`：**账号上没有可续期的凭据**（`autoRelogin` 没存密码、`oauth`/`relogin` 也没绑），主站会话失效后 HTTP 侧无路可走 → 只能人工登录一次，登录后系统会自动记下续期标记，之后就能自动续期。
  - 站点本身都是活的（`/api/status` 200），所以这三个都不是「网站挂了」。
- **二、改掉「一律说 Token 过期」这个误导**
  - 原来 `reportTokenExpired()` 无论什么原因都写「**Token 无效或已过期**」，即使里面括号里的详情已经写着「会话数已达上限」「账号密码无效」。详情对了、标题错了，用户第一眼看到的还是「令牌过期」，于是去换令牌——方向就是错的。
  - 现在标题与正文都从 `classifyFailureReason()` 的原因产出：会话数上限 → 「账号密码有效，但站点登录会话数已达上限，无法自动续期」；密码被拒 → 「站点拒绝了保存的账号密码（密码已改或被封禁）」；人机验证 → 「自动续期被人机验证拦下」；站点不可达 → 「站点无法访问（网站可能挂了），令牌未续期」；真正的令牌过期才保留「Token 无效或已过期」。
  - 并且**站点侧失败不再把账号标成 `expired`**：网站挂了并没有作废任何凭据，把它标成过期会让一个本来健康的账号退出轮换。
- **三、新识别一类「网站挂了」**
  - 新增 `site_unreachable`（`fetch failed` / `ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / `socket hang up` / `other side closed` / `network error` / Cloudflare `520/521/522/525/526` 等）→ 标题「站点无法访问（网站可能挂了）」，明确写「无需改动凭据，等站点恢复后会自动重试」。
  - `upstream_error`（5xx）从「上游站点错误」改成「**站点服务异常（网站可能挂了）**」，并说明请求已到达站点、失败在它那一侧。
  - 纯超时仍归 `network_timeout`（「请求超时」），没有被并进不可达，避免把两件事说成一件。
  - 签到路径与余额刷新路径都套了这层改写：账号上再也看不到光秃秃的 `fetch failed`，而是「站点无法访问（网站可能挂了）：fetch failed」，原文保留在末尾便于排查。
- **四、补上「为什么续不了期」这句话**
  - 新增 `describeRenewalGap()`（放在 `autoRelogin.ts`，因为只有它知道有哪几条续期路径）：当一个账号**没有任何可重放的凭据**（没存密码、没绑 `oauth`、没绑 `relogin`、账号行也没有 `oauth_provider`）时，失效记录会明确写上「该账号没有保存可自动续期的登录凭据（未存账号密码、也未绑定 OAuth），需要人工在站点上重新登录一次」。
  - 站点挂了/限流/5xx 时这句话**不写**——那时问题在站点侧，写「你没存密码」会把人引到错的方向。这正是 Fengwind 这种情况从「莫名其妙一直 401」变成「知道要人工登一次」的原因。
- **五、验证**
  - 新增单测：`failureReasonService` 补 3 例（不可达站点 / 5xx 网站可能挂了 / 纯超时仍是超时）；`alertService.credentialFailure.test.ts` 4 例（会话上限、密码被拒、站点不可达且不标过期、真正的令牌过期）；`autoRelogin` 补 3 例（无可续期凭据、三种有凭据的情形保持沉默、站点挂了不甩锅给凭据）；`checkinService` 补 1 例（`fetch failed` 的签到记录里写「网站可能挂了」且不触发失效上报）。
  - 生产实跑（`checkinAccount(4)` / `checkinAccount(10)`）：事件标题已变成「站点登录会话数已达上限」/「账号密码无效或账号被封禁」，账号健康原因分别落在对应的真实原因上。
  - 回归：`src/server/services` + `src/server/routes` 共 **1817 例**，其中 2 例失败与本次改动无关（`siteProxy.test.ts`、`factoryResetService.test.ts` 读的是本机 `HTTP_PROXY` 与 `.env` 里的 `PROXY_TOKEN`，属于环境耦合，改动前就已如此）；`tsc` 两道门、`npm run build:server` 通过，服务已重启。
- **主要文件**：`src/server/services/failureReasonService.ts`、`src/server/services/alertService.ts`、`src/server/services/autoRelogin.ts`、`src/server/services/checkinService.ts`、`src/server/services/balanceService.ts`、`src/server/services/alertService.credentialFailure.test.ts`
- **状态**：已完成（三个失效账号本身仍无法由服务端自动救活，原因如上；Fengwind 需要在站点上人工登录一次，登录后系统会自动记住续期方式）

### 47. 修「百倍 / 林夕」抽奖漏抽：原来把最后 1-2 次当成短批次发给站点，被拒后整轮中断

- **类型**：缺陷修复（抽奖批次拆分 + 适配器路由回退）
- **需求来源**：本会话（用户：「百倍和林夕站的抽奖好像又有问题了，他是 3 次一抽，总共抽 10 次，你好像总是会漏掉一次，你再检查检查看看吧」）
- **结论先说**：不是漏抽，是**最后那一次根本发不出去**。这两个站只按固定批量卖抽奖（`batch_draw.max_count = 3`），`count` 必须正好是 3：发 1 或 2 都会被回 `HTTP 400 LOTTERY_BATCH_COUNT_INVALID`（已用生产 token 实测，`count=1`、`count=2` 均被拒）。而一天 10 次除不尽 3，代码把余数 `10 - 3*3 = 1` 当成一个 `count: 1` 的批次继续发 batch 路由 → 400 → 循环「首个失败即中断」把整轮打断，于是账号上只剩一条 `drawn: 0` 的「抽奖中断」。
- **一、生产证据（先看现场再改）**
  - `events` 里 2026-10-03 与 10-04 两条记录其实是**成功抽到 9 次后卡在第 10 次**：`3145215575@qq.com @ 100xlabs: 抽奖 9 次，中奖 9 次，免费额度 +$490`；之后每小时一条 `抽奖 0 次`。
  - 账号 `#17`（100xlabs）/ `#18`（林夕 k40）的 `extra_config.lottery.reason` 都是同一句：`抽奖中断：HTTP 400: {"message":"invalid batch draw count","reason":"LOTTERY_BATCH_COUNT_INVALID"}`，且 `drawn: 0` —— 因为此时当天只剩 1 次，第一批就是那个短批次。
  - 站点 `GET /api/v1/lottery/status` 明确给了 `batch_draw: {enabled: true, max_count: 3}`；把该站前端 `LotteryView` 反混淆后确认，它的「三连抽」按钮在自己的 `today_remaining < max_count` 时是**禁用**的，站点 UI 从不下发短批次。
  - 顺带实测出站点契约：单抽走 `POST /api/v1/lottery`（body 为 `cost_type` + `idempotency_key`，无 `count`），批量走 `POST /api/v1/lottery/draw-batch`。批量要**一次性付满整批**（`free_balance` 112.30 时请求 `count=3`、单价 $88 会回 `LOTTERY_INSUFFICIENT`），单抽不受此限。
- **二、改法（两处，尽量少动）**
  - `planLotteryDraws`：批次拆分新增 `addBatches()`，先按 `batchMax` 整批切，**余数一律拆成 `count: 1` 的一个个批次**。于是 10 次 / 每批 3 次 = `3 + 3 + 3 + 1`，那个 1 是独立批次，走单抽；不再产生「小于站点批量」的批次。
  - `Sub2ApiAdapter.drawLottery`：**只有 `count > 1` 才先打 batch 路由**；`count === 1` 直接走单抽路由。batch 被 `HTTP 404`（没有该路由的旧版）或 `LOTTERY_BATCH_COUNT_INVALID`（站点只收整批）拒绝时，回退到单抽逐次完成，而不是把这一批丢掉。新增模块级判断函数 `isBatchRouteUnusable()` 集中这两条。
  - 副作用是**账目更准**：余数拆成独立批次后，某一批次失败不会连带抹掉已完成的批次，`drawn` / `wins` / `reward` 与真实发生次数一致，不会再出现「明明抽到了却记成 0」。
- **三、验证**
  - 新增 / 调整单测：`lotteryService.test.ts` 补「余数逐次单抽」「1/2/4/5/7/8 次都不产出小于 batchMax 的批次」；`sub2api.test.ts` 补「`count: 1` 只打单抽路由」「batch 被 `LOTTERY_BATCH_COUNT_INVALID` 拒绝后回退单抽并保留结果」。
  - 回归：`lotteryService.test.ts` + `sub2api.test.ts` 共 **71 例全绿**；`tsc -p tsconfig.server.json`、`tsc -p tsconfig.web.json`、`npm run build:server` 均通过。
- **主要文件**：`src/server/services/lotteryService.ts`、`src/server/services/platforms/sub2api.ts`、`src/server/services/lotteryService.test.ts`、`src/server/services/platforms/sub2api.test.ts`
- **状态**：已完成（站点侧仍会在「免费额度不够整批」时只允许单抽，属于站点规则，现在会如实走单抽并在余额真的不够时报「免费额度不足」）

### 45. 菜单「可用性监控」改成「模型监控」：按站点拉取上游模型广场数据，卡片式展示 + 7-12 点每 15 分钟采集

- **类型**：功能（菜单改造 + 后端采集 + 前端新页面）
- **需求来源**：本会话（用户：「可用性监控感觉完全没有什么用，我想在这里显示模型监控……定时 15min 拉取这些网站的模型监控到我们表里，然后显示在页面上……看着和 new-api 的模型广场差不多效果就行」）
- **一、数据源与字段（先实测再动手，不是猜的）**
  - 端点是 **`GET /api/perf-metrics/summary?hours=24`**，**普通用户权限**就能读；凭据既可以是账号的会话（bearer / cookie），也可以是站点的 `sk-` 密钥。
  - 上游有两个版本的响应形状，解析器两种都吃：
    - 新版：`{ summary:{avg_latency_ms,success_rate,avg_tps}, window_start, window_end, models:[{model_name, avg_latency_ms, success_rate, avg_tps, recent_success_series:[{ts,success_rate}]}] }`
    - 旧版：只有 `models:[{..., recent_success_rates:[100,100,100]}]`（纯数字数组，**没有时间轴**），另有 `{models:[], show_throughput:false}` 表示「站点没数据」。
  - 所以 `recent_success` 存成 `[{ts, rate}]`，旧版补齐 `ts: null`，前端按「有 ts 就按 `window_start` 落格、没有就尾部右对齐」渲染 24 根彩色成功率柱。
- **二、表只存最新（新增 2 张表，迁移 `0028_site_model_monitor`）**
  - `site_model_monitor_sites`：每站点一行，记 `status`（`ok`/`empty`/`unsupported`/`error`）、失败原因、模型数、用到的凭据（`account`/`api_token` + id）、站点级 summary 与 `fetched_at`。
  - `site_model_monitor_models`：`(site_id, model_name)` 唯一，只保留最近一轮；每轮把该站点上游已经不再返回的模型删掉，避免表随时间无限增长（单测覆盖）。
  - 采集失败时**不清空**上一轮数据，页面不会因为一次抖动变空白；失败原因写在站点行上。
- **三、定时任务：7:00–12:00、每 15 分钟、上一轮没跑完就跳过**
  - 触发用**每分钟 tick + 窗口判断**（`isModelMonitorWindowOpen` 支持跨夜与 `start===end` 视为全天），不用整点 cron 扇出；窗口内距上次启动不足 `intervalMs` 不重复触发。
  - **单飞**：`runModelMonitorFetch()` 进行中时再次调用直接复用同一轮（`isModelMonitorRunning()`），手动点「立即采集」也走这条路径，所以不会出现上一轮没跑完、下一轮又叠上去的情况。
  - 站点**串行**采集，每站 `modelMonitorTimeoutMs`（默认 30s）超时兜底；上一轮跑通的凭据记在库里，下一轮优先命中，不再从头逐个试。
  - 可用环境变量覆盖：`MODEL_MONITOR_ENABLED` / `MODEL_MONITOR_INTERVAL_MS` / `MODEL_MONITOR_TIMEOUT_MS` / `MODEL_MONITOR_WINDOW_START_HOUR` / `MODEL_MONITOR_WINDOW_END_HOUR`。
- **四、页面（`/monitor`，照 new-api 模型广场的方框卡片做）**
  - 顶部两张统计卡：模型数 / 覆盖站点、平均成功率 / **最近更新时间**（相对时间，悬停看绝对时间）与采集窗口说明。
  - 工具栏：模型名搜索、站点下拉、最低成功率、排序（成功率/延迟/吞吐/站点）、**卡片视图 / 表格视图**切换。
  - 卡片：模型名 + 右上角成功率（按 ≥100/≥90/≥70/<70 着色）、站点名、24 格成功率色带、延迟与吞吐。
  - 「未取到数据的站点」可展开，逐站显示状态徽章、**真实原因**（例如 `HTTP 401：站点判定当前凭据无效`）与时间——不写「401」这类只有内行才懂的字样。
  - 顺手**删掉了上一版的 LDOH iframe 代理整条链路**（`/api/monitor/*`、`/monitor-proxy/*` 路由与旧页面），`/monitor` 现在就是新页面；桌面端口令守卫里那条同源放行规则仍保留（对其它同源链接同样适用）。
- **四·补、（本轮追加）把「站点不支持」从失败列表里摘出去**
  - 11 个站点是平台/版本层面就没有 `/api/perf-metrics`，属于**已知无法采集**，跟真正需要关注的失败混在一起会让人每次都要展开看一遍。
  - 现在这类站点单独折叠成一行低调提示（`站点不支持 · 11 个站点没有模型监控接口`，点开是站点名标签），**默认不占版面**；「未取到数据的站点」只剩 6 个真正需要看的。
  - 「覆盖站点」的分母也跟着扣掉这些站点（现在是 `22 / 28`，悬停有说明），站点下拉里给它们加 `（不支持）` 后缀。
  - 补 2 例源码级断言（沿用仓库前端测试的写法）钉住这个行为。
- **四·补二、（本轮追加）模型名 / 站点名改成可搜索下拉**
  - 上游站点多的站一次列出 659 个模型，原来的输入框只能「盲输 + 精确等值」，站点又是原生 `<select>`，找一站要滚很久。
  - 模型名与站点名都换成仓库既有的 `ModernSelect`（`searchable`，带 `searchPlaceholder` / 空结果文案），宽度跟着工具栏伸缩、窄屏自动换行；最低成功率与排序仍是原生下拉（这轮只动这两个）。
  - 随之把**模型筛选从 `like(%kw%)` 改成完整模型名精确匹配**：下拉选项都是完整名，选 `gpt-5.5` 就不该把 `gpt-5.5-mini` 也带出来（单测已按新语义改）。
  - 新增 `overview.modelOptions`：下拉清单（模型名 + 覆盖站点数）只跟着**站点 / 最低成功率**筛，**不跟着模型名本身筛**——否则选中一个模型之后，下拉里就只剩它自己，没法直接换别的。
- **四·补三、（本轮追加）卡片补「按量计费的输入 / 输出单价」、站点名可点开原站、模型名点击即复制**
  - 价格取自站点自己的 **`GET /api/pricing`**，走的是 proxy 计费同一套 `fetchModelPricingCatalog`（带 10 分钟缓存），不额外发明一套抓取。
  - 每站只在采集成功后读**一次**价目表，摊平成「模型名 → 价格」；`quota_type` 是 0 就按**每 100 万 token 的美元价**存（`输入 $75 / 1M`、`输出 $75 / 1M`），是 1 呢按**每次调用的美元价**存（`$140 / 次`，new-api 只给总价时不硬写「输入」）。价目表读不到就只当没有价格，**不影响成功率 / 延迟 / 吞吐的采集**。
  - 新增 3 个字段 `pricing_unit` / `input_price` / `output_price`（迁移 `0029_square_hydra`），卡片与表格都显示；表格新增「价格」列，空的显示 `—`。
  - 站点名在卡片、失败列表、不支持列表里都变成**新标签页打开站点首页**的链接；模型名变成按钮，**点一下复制**，复制后按钮内浮出「已复制」提示。
  - 实测：659 个模型里 **540 个拿到价格**（哈基米 295/295、chinahk 69/70、HongShi 47/47、方舟 19/19…）。剩下 5 个站（霸气公益平台、君の公益、SeekAi、澎湃AI网关、JustDoWork）的 `/api/pricing` 需要登录态或站点侧就不开放，属于**站点侧拿不到**，不是没接。
- **四·补四、（本轮追加）修「表达式计费」站点的价格：原来整站模型都被算成 $75 / $75**
  - 现象与定位：happycoding 这类站点在 `/api/pricing` 里把 `model_ratio` 留成**废字段**（固定 37.5），真实价格写在 `billing_mode: "tiered_expr"` 的 `billing_expr` 里。旧逻辑照旧读 `model_ratio * 2`，于是整站每个模型都成了 `输入 $75 / 输出 $75`，与站点自己的价目页（`deepseek-v4.1-flash` 是 $0.3、`kimi-k3` $3、`glm-5.3-flash` $0.15……）完全不符。
  - 做法：新增 `src/server/services/billingExpression.ts` 求值器，按 new-api 的语义（表达式里的系数就是**「美元 / 1M tokens」的挂牌价**，`fixed(x)` 是**每次请求 x 美元**）代入 1M / 2M token 做差分，还原出输入 / 输出单价。`len` 取小值让多档表达式落到**最短上下文**那档，`p`/`c` 取样走大值以自动跳过「探测价」分支；时间档（`hour()` / `weekday()`）按取价当时的 UTC 时间选档。
  - 分组倍率照旧乘（与站点自己的价目页一致，如 ultrarouter 的 core 组 0.5）；`fixed()` 的模型改成**按次计费**（chinahk 那批 `fixed(0.6)` 原先也是 $75/$75，现在是 `$0.03 / 次`）。
  - 容错：解析不了的表达式**不落假价**，宁可显示「—」，也不再拿废掉的 `model_ratio` 编数字；非表达式站点（anyrouter / one-hub 那套）走原逻辑，行为不变。
  - 顺手修掉一个真 bug：三元表达式原先**两个分支都会被求值**，`tier()` / `fixed()` 的副作用互相覆盖，导致「探测价」模型被误判成按次计费。
  - 实测（生产刷新后）：happycoding 6 个模型里 5 个变成真实价（`deepseek-v4.1-flash $0.3/$1.2`、`kimi-k3 $3/$15`、`minimax-m3 $0.3/$1.2`、`glm-5.3 $1.4/$4.4`、`glm-5.3-flash $0.15/$0.5`）；唯一仍是 $75 的 `deepseek-v4-1-flash` 是因为**站点自己就没给它配 `billing_expr`**，站点价目页同样按 `37.5 × 2` 显示 $75，与我们一致。
  - 验证：新增单测 8 例（`billingExpression.test.ts`：flat / 多档 / 探测价 / fixed / 时间档 / 零价 / 解析失败）+ 2 例（`modelPricingService.tieredExpr.test.ts`：真实站点形状 + 解析失败不落假价），`modelPricingService` / `modelMonitorService` 既有 20 例回归全绿。
- **五、实测（生产库 + 真实站点，不是造数据）**
  - 首轮 39 个活跃站点全部跑完：**22 站取到数据、657 个模型**；`unsupported` 11 站（sub2api/agentrouter/xapi/gwrelay 等平台没有这个接口，或 new-api 版本较旧回 404）、`empty` 3 站（`{models:[], show_throughput:false}`）、`error` 3 站。
  - `error` 的都给了上游真实原因：Any Router 是 **HTTP 200 但返回的不是 JSON（被盾拦）**，luckyg 与 蛙蛙 是 **HTTP 401 凭据无效**（与第 44 条结论一致，不再是含糊的「没有凭据」——站点账号全部过期时也会照试一次，好让页面显示上游的原话）。
- **六、验证**
  - 新增单测 **20 例**：`modelMonitorService.test.ts`（窗口边界/跨夜、脏数据解析、采集成功写入、上一轮模型被清掉、失败保留旧数据、单飞复用、过期账号也照试、筛选与四种排序）、`newApi.perfMetricsPayload.test.ts`（新旧两种响应形状 + 空数据 + 脏行）、`modelMonitor.test.ts`（路由筛选、非法 sort 兜底、refresh 入队）。
  - 回归：`newApi` / `migrate` / `runtimeSchemaBootstrap` 等相关 **83 例全绿**；`tsc -p tsconfig.server.json`、`tsc -p tsconfig.web.json`、`npm run build:server`、`vite build`、`repo:drift-check`（0 violations）均通过；重启服务后实测接口与页面正常。
  - 重新生成并提交了 schema 三件套（drizzle 迁移 + SQLite journal + `schemaContract.json` 与 MySQL/Postgres bootstrap/upgrade），并把 README / `docs/index.md` 的菜单截图说明从「可用性监控」改成「模型监控」（截图已重新采集）。
- **主要文件**：`src/server/services/modelMonitorService.ts`、`src/server/services/modelPricingService.ts`、`src/server/services/billingExpression.ts`、`src/server/routes/api/modelMonitor.ts`、`src/server/services/platforms/newApi.ts`、`src/server/services/platforms/base.ts`、`src/server/db/schema.ts`、`drizzle/0028_site_model_monitor.sql`、`drizzle/0029_square_hydra.sql`、`src/web/pages/ModelMonitor.tsx`、`src/web/index.css`、`src/web/App.tsx`、`src/web/api.ts`、`src/web/i18n*.ts*`、`src/server/index.ts`、`src/server/config.ts`
- **状态**：已完成（`unsupported` 的站点是站点侧没有这个接口、5 个站点的 `/api/pricing` 拿不到价格，都属于站点侧限制，无法通过本站改造解决）
### 44. luckyg / 蛙蛙公益站 的恢复排查：两站都卡在站点侧，自动清理机制本身已验证有效

- **类型**：事故排查 + 验证（无代码改动）
- **需求来源**：本会话（承接第 43 条收尾时提出的「接着处理 luckyg（会话数上限）和 蛙蛙公益站的重登」，用户回复「继续」）
- **结论先说**：两站**都无法由服务端自动恢复**，原因各不相同，且都不在代码侧；而「每次登录后自动清掉其他会话」这个机制**已实现且在生产里确实在跑**（19 个账号有记录、其中 7 个真清掉了会话）。
- **一、验证「登录后自动清会话」真的生效（这是用户当初的核心诉求）**
  - 生产证据：`extraConfig.sessionHygiene` 共 **19 个账号**有记录，其中 **7 个是 `pruned`**（`#1` 清 1 条、`#7` 清 **2** 条、`#24`/`#30`/`#34`/`#36`/`#37` 各清若干，`#30` 最多清 **4** 条），其余为 `no-other-session` / `unsupported`。
  - 也就是说，这个机制正在持续阻止其它 new-api 账号重演 luckyg 的锁死，不是纸面功能。
- **二、luckyg（账号 `#4` / 站点 `#16`）：密码没问题，纯被会话上限锁死**
  - 复测确认：`POST /api/user/login` → **HTTP 409 `{"code":"AUTH_SESSION_LIMIT","message":"Conflict"}`**；用站点**存储的那份密码**（`autoRelogin.passwordCipher` 解密后与登记时一致）同样如此，所以这不是密码错，而是「活跃会话数达上限，站点拒绝再发放新会话」。
  - 存量凭据确实无法自救：账号行的两条 JWT 均**已过期**（`sid a5238573…`），打 `/api/user/sessions` 与 `DELETE /api/user/sessions/<sid>` 都是 **401 `AUTH_TOKEN_EXPIRED`**——清会话的路由本身需要一条有效会话，形成死锁。
  - 站点侧确认：`/api/status` 显示 `email_verification = false`，所以上游前端提示的「reset your password to sign out all sessions」在这站**走不通**（收不到重置邮件）；`linuxdo_oauth = true` 但按第 25/33 条，该站 Linux.do 绑的是**另一个用户**，且 OAuth 同样走 `setupLogin` → 一样被上限拒绝。
  - **会自愈**：站点 `LoginSessionTTL = 30 天` 且不滑动续期（第 25 条已从源码确认），现存会话建于 09-29~10-01，故预计 **10-29 ~ 10-31 前后自动解封**。账号 `#4` 的 `checkin_enabled = 1`，每小时仍在重试（今天已 10 次），一旦能登录就会立刻执行会话清理。每小时只发 1 次登录请求（约 600 次/25 天），量级很小，未做额外退避。
  - 想提前恢复只有两条路（都需要人工）：① 用**仍持有该站 refresh cookie 的浏览器/设备**打开站点（refresh 流程不检查会话上限），进「会话管理」退出其他设备；② 请站长把该账号 `auth_version` 提一版（等价于全端下线）。
- **三、蛙蛙公益站（账号 `#10` / 站点 `#22`）：存储密码已被站点拒绝**
  - 复测：`POST /api/user/login` → `{"message":"Username or password is incorrect, or user has been banned"}`；用**存储的那份密码**（与 luckyg 同一份）同样被拒。账号 `#10` 的 `checkin_enabled` 已是 `0`，即已停止自动重试，状态停在 `expired`。
  - 无法进一步区分「密码被改」还是「被封」：用**不存在的用户名**做对照，站点返回**完全相同**的文案，信息量为零；排行榜接口 `requireAuth=true`，未登录读不到。
  - **但站点公告指向封禁**：`/api/status` 的公告写着「**禁止测活，测活封禁 / 使用free分组使用**」，而该账号此前每小时都在做模型探测（`runtimeHealth` 记为「模型探测成功」），行为特征与公告所禁项一致，**大概率是被封**。
  - 需要人工：请站长解封，或提供当前密码；若已确认封禁，建议保持 `checkin_enabled = 0` 不要再试（继续探测可能加重处罚）。
- **验证方式**：站点接口实测（登录、`/api/user/sessions`、`DELETE .../sessions/:sid`、`/api/status`、密码解密比对、不存在用户名对照）；本地库取证（`accounts` / `extra_config.sessionHygiene` / `checkin_logs` / `events`）。
- **主要文件**：`docs/change-log.md`（本轮无代码变更，故不涉及源码）
- **状态**：排查完成；两站均待人工介入，luckyg 预计 10 月底自动恢复

### 43. 删除 Fate 站；补齐缺密钥的站点，并在「只给掩码」的站点上接住创建时的明文

- **类型**：功能 + 修复 + 运维
- **需求来源**：本会话（用户要求「把 fate 删了，然后检查一下哪些网站的 sk- 开头的密钥还没有的，可以通过 token 登录原网站帮我同步过来，有多个分组的可以建多个密钥，有些密钥可能加密了，注意这些」）
- **一、删除 `Fate` 站（`#38`）**：先 `sqlite3 .backup` 落库备份（`/home/app/metapi-backups/hub-pre-fate-delete-20261004.db`，`integrity_check` ok），再走 `DELETE /api/sites/38`，账号 `#23` 及其令牌/签到日志随之级联清除。删前该站账号已 `expired` 且连续 5 轮 `Unauthorized, invalid access token`。
- **二、密钥审计与补齐（改前 6 个账号一把可用密钥都没有）**
  - 有账号但无任何密钥：`chinahk#14`、`llmpm#15`、`100xlabs#17`、`林夕(k40)#18`、`Columbina#24`；只有掩码没有明文：`哈基米API站#21`。
  - 同步后：`chinahk`（default + `free` 分组）、`llmpm`、`Columbina`（default + `vip` 分组）由同步直接建出；`100xlabs`、`林夕(k40)` 走下面第三条的修复后各得 1 把可用密钥；`motomoto` 顺带更新 1 条。
  - **实测可用**（不是只看入库）：4 把新密钥直接打站点 `/v1/models`，全部 `HTTP 200`（k40 2 个模型、100xlabs 4 个、chinahk-free 91 个、Columbina-vip 2 个）。
  - 改后仍无可用密钥的只剩 4 处，且都是站点侧原因，非本次遗漏：`luckyg#4`（站点登录会话数上限，账号 `expired`）、`蛙蛙公益站#10`（`expired`，重登返回 401）、`哈基米API站#21`（见下）、`X-API#46`（api-key 连接，本就不走账号令牌表）。
- **三、代码修复：sub2api 系「只给掩码」的站，明文只存在于创建响应里**
  - **取证**：`sub2api` 系（100xlabs、林夕(k40)）的列表与单条读取一律回 `"key":"****...****"`，且没有取明文的路由（`POST /api/v1/keys/{id}/key` → `404 page not found`）。但**创建**的响应体里带着明文 `sk-…`。原实现的 `createApiToken()` 只返回 `boolean`，把这段明文丢掉了——于是在这类站上建出来的密钥，站点有、本地读不到，等于白建。
  - **改动**：
    - `base.ts`：新增 `CreatedApiToken` 与可选的 `createApiTokenWithValue()`。可选是刻意的——列表本身就有明文的适配器（new-api）无需实现，调用方用「能力是否存在」判断，而不是靠一个假的默认实现。
    - `sub2api.ts`：`createApiToken()` 改为薄封装，真正逻辑落在 `createApiTokenWithValue()`，把创建响应里的 `key`/`group_id` 带回来；值是掩码或缺失时回 `key: null`，让调用方退回读列表，而不是把占位符当密钥存下来。`tokenGroup` **只记站点确实存下的分组**：站点会拒绝「号池为空」的分组并把密钥落到默认分组，把请求值当结果记会写错。
    - `accountTokens.ts`：新增 `createUpstreamToken()` 统一走「能拿明文就拿」的创建路径；`executeAccountTokenSync()` 新增 `extraTokens`，把创建响应里的值显式送进同步（列表已掩码，只能这样带过去），`mergeCapturedTokens()` 按值去重。
- **四、顺带修掉一个自己引入的重复建 key 缺陷（创建接口触发时）**
  - **现象**：用「多分组建多把」跑完，站点侧多出 27 把 `metapi` 密钥（k40 13 把、100xlabs 14 把），而请求只有 6~7 次。
  - **根因**：显式创建之后再走的那次同步里，列表**全是掩码**，于是「全掩码就补建一把」的新逻辑又触发了一次，凭空多建一把默认分组的密钥。
  - **修法**：补建只在「该账号本地确实没有可用密钥」**且**「调用方这次没有刚建好并带明文进来」时才允许（`allowMaskedCreate`）。另外，链路不可回读明文（适配器没有 `createApiTokenWithValue`）的站点**一律不建**——否则只会在站点留下一把谁也读不到的密钥，比不建更糟。
  - **清理**：把误建的全部删掉（站点侧按 id `DELETE /api/v1/keys/{id}` 共 27 把，本地对应记录同步删除），保留各站原有的 `li`/`jia`，再各留 1 把默认分组的可用密钥；删后站点侧与本地都已复核。
- **五、哈基米API站（`#21`）：会话已修，密钥需人工**
  - 会话确实失效（`Unauthorized, invalid access token`）。用 `autoRelogin` 里存的账号密码走健康检查里的重登，`access_token` 已换成新 `session=…`。
  - 但密钥拿不到：列表回 `v6cc**********qe25`，该分支**没有取明文接口**（`/api/token/{id}/key` → 404），而**新建**密钥被站点拦下：`{"code":"VERIFICATION_REQUIRED","message":"需要安全验证"}`——即需要过一道人工安全验证。这正是用户说的「有些密钥可能加密了」。**结论**：只能在网页上手动建一把 key 再贴进来，自动化到不了。
- **验证**：新增 6 例单测（`accountTokens.sync.test.ts` 4 例：掩码站接住创建明文、不能回读时不建、创建接口存下明文、已有可用密钥时不重复建；`sub2api.test.ts` 2 例：创建响应带回明文、响应也是掩码时回 null）；`accountTokens.sync` 34 例、`sub2api` 51 例、以及令牌/批量相关共 **96 例全绿**；`tsc -p tsconfig.server.json` 通过；构建并重启后 `/api/sites` 200。
- **主要文件**：`src/server/services/platforms/base.ts`、`src/server/services/platforms/sub2api.ts`、`src/server/routes/api/accountTokens.ts`、`src/server/services/platforms/sub2api.test.ts`、`src/server/routes/api/accountTokens.sync.test.ts`
- **状态**：已完成（哈基米的密钥为站点要求人工验证，已说明）

### 42. 运维：清掉孤儿浏览器 profile，并给 metapi 加一道内存保险丝

- **类型**：运维（资源回收 + 防整机拖死）
- **需求来源**：本会话（第 41 条收尾时提出「清掉 `data/chinahk-browser`，并给 `metapi.service` 加 `MemoryMax` 保险丝」，用户回复「可以」）
- **一、清理孤儿浏览器 profile `data/chinahk-browser`（50MB）**
  - **判定它有资格被删的依据（三条都查过）**：① 全仓库 `grep` 只有变更日志里的历史排查文字提到它，**代码零引用**；② 当前浏览器 profile 的命名只有三种——`linuxdo-browser` / `github-browser`（`assistedLogin/profilePorts.ts`）与 `checkin-browser/site-<id>`（`browserSessionCredential.ts`），它不在其中；③ 拥有它的站点 `#30 chinahk` 账号 `#14` 近几日签到**一直成功**，走的正是 `checkin-browser/site-30`，即该目录早已被取代。
  - **先备份再删**：整包归档为 `/home/app/metapi-backups/chinahk-browser-20261004.tar.gz`（27MB / 831 条目，含其 cookie 库里的 `new_api_has_session`、`new_api_refresh`，后者有效期至 2026-10-30），确认归档可读后才 `rm -r` 原目录。删后 `data/` 只剩 `checkin-browser` / `github-browser` / `linuxdo-browser`。
  - **删后回归验证**：紧接着的全量签到里 `3145215575@qq.com @ chinahk` **成功**，坐实删除不影响该站签到。
- **二、`metapi.service` 内存保险丝**
  - 目的：metapi 与它 spawn 的 Chromium **同属一个 cgroup**，历史上无界并发叠加一次全量 `tsc` 曾把 3.6GB 内存的机器压到 SSH 都登不上。要一道只在服务自己失控时才收紧的兜底。
  - **踩到的坑**：本机 `systemd 219`（2015 年版）**不认** `MemoryMax` / `MemoryHigh`——写了 drop-in 也静默忽略（`systemctl show` 里 `MemoryLimit=18446744073709551615`，即无限）。219 用的旧指令是 **`MemoryLimit=`**。
  - 落地为 drop-in `/etc/systemd/system/metapi.service.d/memory.conf`：
    ```ini
    [Service]
    MemoryAccounting=yes
    MemoryLimit=2560M
    ```
    实测生效：`memory.limit_in_bytes = 2684354560`；`memsw` 保持无限（219 不联动写），即只卡物理内存、仍允许少量 swap 缓冲，比「内存+swap 合计封顶」温和。超限时由 systemd 只杀本服务，`Restart=on-failure` 负责拉起，整机不受牵连。
- **验证（实测数据）**：全量签到 `success 28 / skipped 2 / failed 3`（33 个账号，约 7 分钟）；该轮 **cgroup 峰值 682MB**，对 2560MB 硬限有 **3.7 倍余量**，全程 **无 OOM / 无被 kill 事件**；任务结束后 chromium 归零、cgroup 回落 144MB，系统 706MB、swap 仅 5MB。
- **备注（非本次引入）**：本轮 3 条失败均为站点侧既有问题——`luckyg`（HTTP 401 未登录，站点会话数上限）、`Fate`（invalid access token）、`Any Router`（授权后站点未回调 Linux.do 登录，偶发）；后者的 `Any Router` 属 linuxdo 授权回调时序问题，重登后一般可恢复。
- **主要文件**：`docs/change-log.md`；运维侧 `data/chinahk-browser`（已删，备份见上）、`/etc/systemd/system/metapi.service.d/memory.conf`（新，不在仓库内，内容见上）
- **状态**：已完成

### 41. 启动时清扫「孤儿托管浏览器」：重启后不再残留几百 MB 的僵尸 Chrome

- **类型**：修复（资源回收）
- **需求来源**：本会话（用户要求「直接 1 个浏览器、顺序执行，监控内存和进程数量，看是否已经解决」，并在排查中反馈过服务器被压死、SSH 登不上）
- **现象（实测取证）**：第 40 条收成单通道串行后，重启 metapi 服务，`ps` 里仍躺着 **14 个 chromium 进程**，其中一个是更早的诊断脚本留下的孤儿：`--remote-debugging-port=9333 --user-data-dir=.../linuxdo-browser`，**父进程已是 init**，独占约 450MB。而它并不被新服务接管——`/api/assisted-login/linuxdo/status` 显示 `running:false`。
- **根因**：托管浏览器「生命周期归启动它的进程所有、空闲时自行关闭、重启后重新挂载」这条规则，**没有覆盖启动者崩溃/被 kill 的情况**。孤儿进程带着 profile 锁和几百 MB 内存继续跑，原有回收是**惰性**的——只在下一次有流程真的要用浏览器时才顺带发现并接管，在那之前它就是纯浪费；在小内存机器上，这就是「有 headroom」和「开始吃 swap」的差别。
- **改动**：
  - `src/server/services/managedBrowserReaper.ts`（新）：`reapStrandedManagedBrowsersAndWait()` 扫描 `/proc`，凡命令行**同时**含 `--user-data-dir=` 与 `chrom`、且 profile 路径落在 `config.dataDir` 之下、且不是自己的进程，即认定为本安装的孤儿托管浏览器；先 `SIGTERM`（让 Chromium 干净地释放 profile 锁），等 3 秒，仍存活再 `SIGKILL`。`platform !== 'linux'` 直接返回 0，任何异常都被吞掉——读不到 `/proc` 的主机也应能正常启动并服务。
  - `src/server/index.ts`：在 `await app.listen(...)` **之前**调用。启动这一刻不可能有「我们自己的」浏览器在合法运行，所以扫到的一律是残留，先清干净再对外服务。
- **验证（实测，非推理）**：
  - 重启前 14 个 chromium → 重启日志打印 `[Startup] Reaped 10 stranded managed browser process(es)`，随后 chromium 归零；系统已用内存 **888MB → 743MB**。
  - 从 0 个浏览器起跑两轮全量签到：均为 `success 29 / skipped 2 / failed 2`，单轮约 5~6 分钟；**浏览器类报错数为 0**（`浏览%` / `ECONNREFUSED` / `session_rejected` / `no_verdict` / `timeout` 全部为 0）。
  - 峰值稳定锁在 **2 个浏览器实例 / 23 进程 / 1.2GB**（= 常驻 linuxdo-browser + 1 个签到用浏览器），**全程未超过**；`checkin-browser/site-xx` 严格一个接一个、用后即退；任务结束 chromium 归零，系统 730MB、swap 仅用 5MB。
  - 新增 5 例单测（命中受管 profile、命中签到 profile、忽略他人 profile、忽略无 profile 参数的浏览器、忽略仅碰巧提到路径的非浏览器进程）全绿；`tsc -p tsconfig.server.json` 通过。
- **备注**：剩余 4 条非成功项均为**站点侧既有问题**，非本次改动引起：`luckyg`（站点登录会话数已达上限）、`grok-heavy`（Turnstile 需人工）、`l0veyou`（Sub2API 不支持签到）、`Fate`（`Unauthorized, invalid access token`）。
- **主要文件**：`src/server/services/managedBrowserReaper.ts`（新）、`src/server/services/managedBrowserReaper.test.ts`（新）、`src/server/index.ts`
- **状态**：已完成

### 40. 浏览器工作收成单通道串行，止住每小时整点爆发的「拉不起浏览器」

- **类型**：修复（并发治理）
- **需求来源**：本会话（用户反馈「项目里好多拉起浏览器的报错，看是不是并发没控制导致的」，并要求「直接 1 个，顺序执行就行，速度不要求」）
- **现象（DB 取证，非猜测）**：`checkin_logs` 里失败高度聚集在**每小时的 `:08`**（签到 cron `0 8 * * * *` 是 6 段式，即「每小时第 8 分」），且失败量是 `:00~:11` 里最高的：`00:08` 10 次、`01:08` 15 次、`02:08` 14 次……同一分钟里另有两类尾巴错误：
  - `无法启动受管浏览器：Unable to attach to the managed browser: browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9334`（端口文件的旧值，已在第 39 条修掉，但仍说明同一时刻有多个流程在抢同一个浏览器）；
  - `浏览器签到未完成：session_rejected`，以及重登重试的 `连续 5 次退出重登仍未到账`。
  - 另有一条 `站点登录会话数已达上限：在站点上退出其他登录会话…`——并行登录被站点计成了多个会话。
- **根因**：**调度层面的无界扇出**。`checkinAll` 按站点分好组后直接 `Promise.all`，`refreshAllBalances` 对全部账号直接 `Promise.all`，两处都没有任何宽度限制；而这两条链路在会话失效时**都会回落到 `tryAutoRelogin` 的浏览器分支**。于是一个整点 tick 就能让二三十个账号同时走进浏览器：站点以 429/会话数上限回应，浏览器则以「起不来」和「拿到的 cookie 已被交换掉」回应。
  - 顺带发现 `session_rejected` 的机理：HTTP 签到那一步会**轮换滚动凭证**，把本次启动时持有的值作废；并发之下浏览器拿到的副本已经被别的流程换过，于是「播种的会话打不开登录后的页面」。
  - `browserCheckinRunner` 自己**本来就有**一条串行队列，所以它不是元凶；漏的是「它之外的重登路径」和「上层调度」。
- **改动**：
  - `src/server/shared/serialQueue.ts`（新）：一个定宽 FIFO 闸门，**可重入**。可重入不是锦上添花：重登分支内部会再调浏览器签到，二者共用同一条宽 1 的通道，若不可重入就会「自己等自己持有的名额」而永久卡死。实现用 `AsyncLocalStorage` 识别「同一条通道内发起的嵌套调用」，命中则内联执行。
  - `src/server/shared/browserLane.ts`（新）：全项目唯一一条 `browserLane`（宽度 1）。所有要驱动有头浏览器的流程都必须过它。
  - `browserCheckinRunner.runBrowserCheckin()`：弃用自带的局部队列，改走 `browserLane`——原来它只跟「自己人」互斥，仍会和外部的重登抢同一个 X display。
  - `autoRelogin.tryAutoRelogin()`：浏览器回落分支包进 `browserLane`，这是挡住整点爆发的关键一处。
  - `cloudflareClearance.refreshCloudflareClearance()`：过盾也走同一条通道，避免盾在没有预期的时候再开一个窗口。
  - `checkinService.checkinAll()`：`Promise.all` 改为**顺序执行**，按站点 id 稳定排序，保证每轮可复现。速度本来就不是约束（小时/天级调度）。
  - `balanceService.refreshAllBalances()`：无界 `Promise.all` 改为定宽 4 的闸门（`BALANCE_REFRESH_CONCURRENCY`），因为每次余额刷新都可能回落浏览器，但纯 HTTP 部分不必要退化成完全串行。
- **验证**：`serialQueue` 6 例（宽度限制、调用顺序、异常后不卡队列、嵌套重入、站外仍排队）、`browserLane` 3 例（宽度为 1、失败后仍可用、**嵌套不再死锁**）全绿；受影响的既有用例 `autoRelogin` / `checkinService.autoRelogin` / `browserCheckinRunner` / `browserSessionCredential` / `checkinScheduler` / `cloudflareClearance` / `balanceService` / `siteCustomHeaders` 共 80 例全绿；`tsc -p tsconfig.server.json` 通过；服务重启后 `/api/sites` 200。
- **备注**：`tsc -p tsconfig.json`（含测试文件）在本机有 92 个文件的既有类型报错，与本次改动无关，属环境性既有问题；项目构建门 `tsconfig.server.json` 干净。
- **主要文件**：`src/server/shared/serialQueue.ts`（新）、`src/server/shared/browserLane.ts`（新）、`src/server/shared/*.test.ts`（新）、`src/server/services/browserCheckinRunner.ts`、`src/server/services/autoRelogin.ts`、`src/server/services/cloudflareClearance.ts`、`src/server/services/checkinService.ts`、`src/server/services/balanceService.ts`
- **状态**：已完成

### 39. Cloudflare 盾自动续期：403 时自动重新过盾，并修掉受管浏览器「死活挂不上」

- **类型**：功能 + 修复 + 运维
- **需求来源**：本会话（第 38 条登记后，`muyuan.do` 的 `cf_clearance` 被 Cloudflare 作废，账号直接变 `expired`，需要人工重过盾）
- **问题**：Cloudflare 的 `cf_clearance` 会被主动作废（重新发挑战、出口 IP 变化、UA 变化都会）。作废后余额/模型/代理调用全部 403 `Just a moment...`，只能人工重过盾，账号就那样黑着。要的是「403 时自己重过盾」。
- **改动**：
  - `src/server/services/cloudflareClearance.ts`（新）：`isCloudflareChallengeResponse()` 认盾页（`text/html` + `Just a moment` / `challenges.cloudflare.com` / `__cf_chl`，或响应头 `cf-mitigated: challenge`）；`refreshCloudflareClearance(siteUrl)` 用托管浏览器打开站点 origin → `passCloudflareChallenge()` → 取 `navigator.userAgent` 与该 origin 的 `cf_clearance` → **成对写回**站点 `customHeaders`（cookie + user-agent）并置 `customHeadersOverrideRequestHeaders = true`，再 `invalidateSiteProxyCache()`。同 host 并发去重，另有 **60 秒冷却**——盾若反复挑战，不能让每次 API 调用都变成一次浏览器启动。
  - `src/server/services/platforms/newApi.ts`：`performJsonFetch()` 的 3 次重试循环里，命中盾页就续期一次再 `continue` 重试（判断顺序：先 `isEdgeRateLimitResponse` 限流、再盾、最后 `isShieldChallenge`）。
  - `src/server/services/siteCustomHeaders.ts`：新增 `mergeCookieHeaders()`，站点自定义 `Cookie` 与请求自带 `Cookie` **按 cookie 名逐对合并**。原来两者是整条互相覆盖的——盾的 `cf_clearance` 和账号的 `new_api_refresh` 都住在同一个 `Cookie` 头里，谁覆盖谁都会挂（403 或 401）。
  - `src/server/services/assistedLogin/browserManager.ts`：**挂载失效修复** + 内存回收（见下）。
- **根因（这个坑花了最久）**：托管浏览器的调试端口记在 `data/<profile>/debug-port`。该文件只在「新启动」时写，一旦它记的端口和目标浏览器实际端口不一致（本例文件写着 `9334`，活着的 Chrome 在 `9333`），每次挂载都会连错端口失败，然后一路走到「启动新浏览器」——而 profile 目录被活着的那个 Chrome 锁着，必然再失败。整个过程是**每次 30 秒的空等**，症状表现为「一次 API 调用卡 34 秒然后 403」，看起来像盾的问题，实际浏览器一直在跑，只是没连上。
  - 修法：端口文件只当**提示**。先在窗口内按「提示端口优先、其余顺序扫」逐个做 TCP 探活 + CDP 挂载 + profile 归属校验（`metapi_profile` cookie），挂上就顺手把正确的端口写回文件；扫不到才真正新启动。
- **内存事故（同一次排查中发生，用户反馈服务器被压死、SSH 登不上）**：
  - 实测基线：一个刚起来的受管 Chrome 就是 **12 个进程 / ~500MB**；托管浏览器是**每个访问过的站点一个常驻 renderer**，出事前那个 profile 的 session 里躺着 20 多个站点、18 个 renderer，Chrome 一家就到 1GB 以上。
  - 叠加因素：3.6GB 内存的机器上跑了一次**全量 `tsc --noEmit`**（实测峰值 RSS ~1.4GB，且这还是加了 1.4GB 上限测出来的），再叠加 metapi / 浏览器 / codex / 容器守护进程 → 内存打满、swap 抖动，于是 SSH 会话都起不来（日志里全是 `systemd-logind: Failed to create session: Connection timed out`）。
  - 更糟的是：`/swapfile` 存在（2GB）但**没写进 fstab**，重启之后就没了，机器等于零缓冲。
  - 处置：① `/swapfile` 重建为 **4GB** 并写入 `/etc/fstab`（重启不再丢）；② 受管浏览器加启动参数 `--renderer-process-limit=6`、`--js-flags=--max-old-space-size=256`、`--disable-background-networking` 等，压住 renderer 数量与堆；③ 新增 **6 小时最大寿命回收**（`BROWSER_MAX_AGE_MS`）：周期性会话巡检会让浏览器永不空闲、renderer 只增不减，到点重启一次即可复位，且**有人在看远程登录窗口时（`keepAlive()` 10 分钟内）不回收**；另外 `ensureManagedBrowserContext` 是每个流程的入口，所以「最近 10 分钟没有任何调用」才允许回收，正在跑的重登流程不会被中途端掉（会话巡检本身 30~60 分钟一轮，正好落在这个空档里）。回收前还要等端口真正释放，免得新进程撞上未释放的 profile 锁。
- **验证（真实演练，非单测）**：
  - 故意把站点 `cf_clearance` 改成 `BROKEN-COOKIE-FOR-DRILL` → `POST /api/accounts/41/balance` → **2.2 秒内**走完「403 盾页 → 托管浏览器重新取盾 → 用新 cookie 重试 → 200」，返回余额 `7271.935414`，站点 `custom_headers` 被自动换成新 `cf_clearance`（`updated_at` 落到该次调用中）。对照：修挂载之前同样的调用是 34 秒 + 稳定 403。
  - 账号 **`#41`** 随后自动重登（`extra_config.relogin.lastReloginAt = 2026-10-04T01:55:06Z`）并回到 `active`，`runtimeHealth = healthy`，余额 $7271.94；`access_token` 已被重登写成全新的 `cf_clearance=…; session=…`。
  - 单测：`cloudflareClearance.test.ts` 4 例（盾页识别、非盾页不误判）、`siteCustomHeaders.test.ts` 6 例（含 cookie 逐对合并且同名站点侧优先）；`assistedLogin/*` 共 79 例全绿；`tsc -p tsconfig.server.json` 通过。
- **主要文件**：`src/server/services/cloudflareClearance.ts`（新）、`cloudflareClearance.test.ts`（新）、`src/server/services/siteCustomHeaders.ts`、`src/server/services/platforms/newApi.ts`、`src/server/services/assistedLogin/browserManager.ts`
- **运维注意**：换出口 IP（换代理节点）或换 UA 会让已存的 `cf_clearance` 立刻失效，此时**必须同时更新 cookie 与 UA**，只换一个没用；本机跑全量 `tsc` 务必带 `NODE_OPTIONS=--max-old-space-size=<上限>`，别在这台 3.6GB 的机器上裸跑。
- **状态**：已完成

### 38. 登记「君の公益」（muyuan.do，带 Cloudflare 盾）

- **类型**：配置
- **需求来源**：本会话需求（“帮我登记这个网站，登录秘钥 … 用户id 13274”）
- **站点事实（实测）**：
  - `https://muyuan.do`，`system_name = 君の公益`，`version = dev-d8d06cf`（New API），`checkin_enabled = false`（站内没有签到）、`linuxdo_oauth = true`（`linuxdo_client_id = BhXQoUAlShhv8gX3J7AwTIYflzanZghI`、`linuxdo_minimum_trust_level = 1`）、`github_oauth = false`、`price = 1`。
  - 账号 id 13274（显示名「柳眉积翠」、`linux_do_id 367936`、`group = default`），`quota 3635967707 / used 67003623` → 余额 **$7271.94**，历史 2561 次请求。
  - 站上已有两个现成密钥（`朱` id 59174、`君の的公益` id 36040，均 `default` 分组、无限额度、无模型限制），metapi 直接接管，未新建。
- **这道盾的坑（重点）**：站点整个域名挂在 Cloudflare 托管挑战后面，裸 HTTP 一律 403 `Just a moment...`。用托管浏览器过完盾后拿到 `cf_clearance`，但**该 cookie 绑定的是过盾时的出口 IP**——
  - 排查时先用 curl 验证「带 cookie 就通」，忽略了 shell 里 `HTTPS_PROXY=http://127.0.0.1:7890` 会让 curl 走代理，而 undici 默认**不读环境变量代理**，于是同一个 cookie 在 undici 上稳定 403，看起来像「undici 被盾拦」，实际是出口 IP 不一致。显式对比 `curl --noproxy '*'`（403）与 `curl -x http://127.0.0.1:7890`（200）后结论确定。
  - 因此这个站必须**走系统代理**（`useSystemProxy=true` → `http://127.0.0.1:7890`，与过盾时同一出口），同时在站点 `customHeaders` 里带 `Cookie: cf_clearance=…` 与过盾时的 `User-Agent`（并开 `customHeadersOverrideRequestHeaders`，否则会被各适配器自带的 UA 覆盖掉，Cloudflare 会因此判定失败）。
  - 单纯设置 proxyUrl 或单纯设 cookie 都无效，两者必须与 UA 一起配对。
- **登记结果**：
  - 站点 **`#55 君の公益`**（`new-api`，`useSystemProxy=true`，`customHeaders` = `{cookie: cf_clearance=…, user-agent: Chrome/126 Linux}`）。
  - 账号 **`#41`**（用户名 `3145215575`、`platformUserId 13274`、访问令牌登录、`status=active`、余额 **$7271.94 / quota $7405.94**）。
  - 模型 **25 个**；`checkinEnabled` 设为 **false**——站点自己回「签到功能未启用」，触发一次得到的是 `skipped`（不是失败），关掉可以少跑无意义的一轮。
  - 路由：现阶段只落了 **glm-5.2** 一条通道（站点对其余模型回 `No available channel for model … under group default`，是站点侧上游没配通道，不是 metapi 的问题；站方补了渠道后重新探测即可）。`glm-5.2` 已经过 metapi 端到端实测（`POST /v1/chat/completions` 正常返回）。
- **教训（避免以后再踩）**：判断「是不是盾拦的」不能只看请求方是不是浏览器，CF 的 `cf_clearance` 与**出口 IP + UA** 绑定；诊断时必须先弄清该请求究竟从哪个 IP 出去（环境变量代理只对部分客户端生效，这份差异曾直接导致误判）。
- **运维注意**：`cf_clearance` 过期或站点重新发挑战时，余额/模型/代理调用都会开始 403；届时重新过盾、更新站点 `customHeaders` 里的 cookie 与 UA 即可。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：已完成

### 37. 接入薄荷 API 的外部轮盘签到（up.x666.me），并支持会话自动续期

- **类型**：功能 + 配置
- **需求来源**：本会话需求（用户提供外部签到地址 `https://up.x666.me/`），补完第 36 条的遗留项
- **站点事实（实测）**：
  - `up.x666.me`（标题「薄荷公益站升档」）是与中转站 `x666.me` **分开部署**的签到站，Go 写的，**有独立的 Linux.do OAuth 应用**（`client_id=p4V7ALyYtjreFlru3Mp5V5enzhpMYxcy`，回调 `/api/auth/callback`），所以中转站的 `new_api_refresh` 在它这儿完全用不上。
  - 凭证是回调下发的 **`auth_token` JWT（30 天有效）**，`linux_do_id=367936`；奖励直接加在同一个账号的额度上（`current_quota` 与中转站 `quota` 一致），所以这一站本质是「用签到给中转站加额度」。
  - 签到接口 `POST /api/checkin/spin`（无 body）；**必须带 `Origin: https://up.x666.me`**，否则回「跨站请求被拒绝（缺少 Origin）」。状态读 `GET /api/checkin/status`（`can_spin`、`today_record`），用户信息读 `GET /api/user/info`。全程**纯 HTTP 可用**，不需要浏览器（只有续期需要）。
- **改动**：
  - `src/server/services/platforms/mintWheelCheckin.ts`（新）：轮盘方言。`runMintWheelCheckin()` 发一次 POST，把 `{success:true}` 当作中奖（`reward` 取站点的 `label`，如「150次」），把 `message` 为「今日已签到」的那种**重复运行**折成 `success:true`——那是当天已领取，不是需要重试的故障。另导出 `upsertAuthTokenCookie()` / `readAuthTokenCookie()` 维护绑定里的 cookie。
  - `src/server/services/platforms/newApi.ts`：`checkin()` 支持 `CheckinContext`；站点声明了 `externalCheckinUrl` 时**优先走外部轮盘**，没有绑定会话就明确报「外部签到站会话未绑定」，不再去戳中转站那条不存在的签到路由。
  - `src/server/services/assistedLogin/sites/mintWheelRelogin.ts`（新）：续期驱动。复用托管浏览器（`linuxdo` profile）打开签到站 → 页面内 `GET /api/auth/login` 取 `auth_url`（state 由站点服务端生成）→ 过 Cloudflare → 点授权页的「允许」（它是个 `<a href="/oauth2/approve/…">`，不是按钮）→ **等 `auth_token` 的值「变化」**（同名 cookie 会被重写，只等「存在」会拿到旧值），返回新 token。这里不学中转站那条链路先退出登录——签到站没有会话列表、也没有 bind/login 之分，退了只会白扔一个还能用的会话。
  - `src/server/services/checkinService.ts`：签到失败且消息命中「外部签到会话已失效」时，自动续期一次并重试。这是中转站自己的自动重登**修不了**的那一类故障——凭证属于另一个部署、另一个 OAuth 应用。
  - `src/web/pages/Accounts.tsx`：外部签到绑定输入框原来只对 `sub2api` 显示，现在 `new-api` 也显示（否则界面上根本没法绑），文案同步说明「会先尝试自动续期」。
- **验证（真实演练）**：
  - 首次真实抽奖：`level 6 / 150次 / quota 75000`，额度 `29699750 → 29774750`，与站点记录一致。
  - **过期演练**：把账号绑定改成死值 `auth_token=dead-token-for-drill` → `POST /api/checkin/trigger/40` → **12.8 秒**内完成「401 → 托管浏览器重新授权 → 写回新 token → 重试」，返回 `{"success":true,"message":"今日已签到"}`；落库的 cookie 已换成新 JWT（315 字符）。
  - 单测：`mintWheelCheckin.test.ts` 10 例（中奖/重复/OAuth 边界/Origin/cookie 助手）、`newApi.test.ts` 新增 2 例（走外部轮盘、未绑定时不回退），相关文件全绿；`tsc -p tsconfig.server.json` 通过。
- **配置**：站点 **#54** 写入 `externalCheckinUrl=https://up.x666.me`；账号 **#40** `checkinEnabled=true` 且 `extraConfig.externalCheckin.cookieHeader=auth_token=…`。
- **已知边界**：`auth_token` 30 天过期；自动续期依赖托管浏览器里仍然登录着的 Linux.do 会话（该会话在，续期就无人值守；不在则需要人工重登 Linux.do）。
- **主要文件**：`src/server/services/platforms/mintWheelCheckin.ts`（+`.test.ts`）、`src/server/services/platforms/newApi.ts`、`src/server/services/assistedLogin/sites/mintWheelRelogin.ts`、`src/server/services/checkinService.ts`、`src/web/pages/Accounts.tsx`、`docs/change-log.md`
- **状态**：已完成

### 36. 登记「薄荷 API」（x666.me，Futureppo/new-api 分支）

- **类型**：配置
- **需求来源**：本会话需求（“帮我登记这个站，登录秘钥 … 用户id 28720 … 支持 linuxdo 登录，签到是外部的提个转轮盘签到”）
- **站点事实（实测）**：`https://x666.me`，`system_name` 为「薄荷 API」，`version` 为 `custom-20260921-c856c7c`，是 `Futureppo/new-api` 的 fork；`checkin_enabled=false`（站内没有签到）、`linuxdo_oauth=true`（`linuxdo_client_id=4OtAotK6cp4047lgPD4kPXNhWRbRdTw3`、`linuxdo_minimum_trust_level=0`）、`github_oauth=false`、`turnstile_check=false`、`QuotaPerUnit=500000`、`price/usd_exchange_rate=7.3`。**直连可用**（无 CF 盾），未开系统代理。
- **登记结果**：
  - 站点 **#54 薄荷 API**（平台 `new-api`，未开系统代理，`externalCheckinUrl` 暂空）。
  - 账号 **#40**：用户名 `3145215575`、`platformUserId 28720`、登录方式为访问令牌（`credentialMode: session`）、`linux_do_id 367936`、`group level3`、余额约 **$59.40**（`quota 29699750 / used 125250`）；`checkinEnabled: false`。
  - 令牌：站上已有现成密钥 `li`（id 70592，`token_group = coding-plus`，无限额度），直接接管，无需新建。
  - 模型 **6 个 / 路由 6 条**，已建好。
  - 建号时会话清理结果 `no-other-session`（该站没有多余会话可删）。
- **外部轮盘签到（未完成项）**：用户说明该站的签到在**站外**、是转轮盘形式，但**地址未知**，因此本轮没有写入 `externalCheckinUrl`。已做的排查：
  - 站点 `/api/status` 的全部字段里**没有任何轮盘/签到相关地址或开关**；站点自身也确认 `checkin_enabled=false`。
  - 前端 `/assets/index-CUGEGy4k.js`（8.6 MB）里没有 `wheel`/`spin`/`lottery` 的签到实现（`draw`/`spin` 的命中都是绘图库误报）；SPA 也没有 `/wheel`、`/lottery`、`/checkin`、`/spin`、`/lucky`、`/daily` 等路由。
  - 站内 `chats` 里唯一的外部链接是 `https://check.crond.dev/`（标题「API CHECK」，是模型可用性检测工具，与轮盘无关）；站点头像托管在 `i.111666.best`（=「16图床」，同样无关）。
  - 按「签到/轮盘/抽奖」等猜测的子域（`x666.me`、`111666.best`、`crond.dev` 下）**全部 NXDOMAIN**，没有命中。
- **教训（避免以后再踩）**：该站对**任意不存在的路径**都返回 `{"message":"Unauthorized, insufficient privileges","success":false}`，响应长得像“接口存在但没权限”，**不能用它来判断接口是否存在**——第 21 条那种「按响应推断路由」的做法在这个站上不成立。
- **待办**：拿到外部轮盘签到站地址后，确认它的登录方式（若直接复用 x666 会话，走 `externalCheckinUrl` + cookie 绑定即可），再接入签到流程。
- **主要文件**：仅数据库登记，无源码改动（变更日志除外）。
- **状态**：主体已完成，外部轮盘签到待补充地址

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
- **配置**：给下列账号写入 `relogin: {provider:"linuxdo"}` 标记（先写入 12 个，其中 2 个实测无法使用已回滚，故本轮净新增 11 个；另 5 个此前已有，现计 16 个）：`#5 techmob`、`#6 ultrarouter`、`#7 happycoding`、`#8 coee`、`#9 grok-heavy`、`#26 咕咕嘎嘎`、`#34 霸气公益平台`、`#36 Loveyy`、`#37 HongShi`、`#38 TOM&JERRY`、`#39 123nhh`。
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

### 46. 登录页加「个人自用」声明：徽标 + 声明卡片 + 登录面板小提示

- **类型**：功能（前端文案与样式，无后端改动）
- **需求来源**：本会话（用户：「帮我的登录首页加下比较好看且清楚的话术，表明该网站只是自用」）
- **一、放在哪三处（不靠一句小字带过，扫一眼就能看见）**
  - 品牌区 `Metapi / 中转站的中转站` 下面加一枚**琥珀色胶囊徽标**：`个人自用 · 不对外提供服务`。
  - 正文与「兼容 …」清单之间放一张**声明卡片**（左侧琥珀色竖条 + 盾牌图标），标题 `个人自用声明`，正文一句定调 + 三条要点：
    - 这台网关只服务我一个人：不对外开放，也不接待任何访客。
    - 只有本人使用：没有注册、充值、分销，也不对外售卖额度。
    - 这里只是我自己的私人工具箱，密钥、额度和数据都归我一人使用。
    - 不接待任何访客，请不要尝试登录或使用这里的任何资源。
  - **措辞按「纯自用」校准过一次**：初版写的是「不承诺可用性、速度与 SLA，可能随时调整、停服或下线」「请不要把重要数据或生产业务依赖挂在上面」，读起来像是在给「对外转发服务」写免责声明；用户指出后改成上面这版，只强调「我自己的东西、不接客」，不再出现任何面向外部用户的 SLA / 责任口吻。
  - 右侧登录面板页脚再加一枚小徽标 `个人自用 · 非公开服务`，紧挨原有的「管理员登录后继续。」——落在真正要输令牌的地方。
- **二、样式与主题**
  - 全部沿用登录页既有的浅色玻璃质感配色（琥珀 `#f59e0b` / 文案 `#78350f`、`#854d0e`），不引入新色系；徽标是胶囊圆角，卡片 20px 圆角、`border-left` 加粗做视觉锚点。
  - **左侧品牌面板在明暗两种主题下都是浅色底**，所以声明卡片与徽标**不跟着暗色反转**（早先误加了暗色覆盖，导致暗色模式下卡片变灰、对比度变差，已改掉）；只给右侧会变暗的登录面板补了暗色样式。
  - 登录页脚页脚改成纵向 flex + `gap`，徽标与说明文字不再挤成一行。
  - 三档响应式（1080 / 900 / 640px）下都是单列，已在 390×844 移动视口实测。
- **三、验证**
  - `App.login-surface.test.tsx` 补 7 条文案断言（徽标文案、卡片标题、引导句、三条要点、登录面板小徽标），连同 `i18n.test.ts` 共 8 例全绿。
  - 英文模式全量补齐翻译（`Personal use only · Not a public service` / `Personal Use Notice` …），实测 `translateText` 不残留中文。
  - `tsc -p tsconfig.web.json`、`vite build` 通过；重启 `metapi` 后截图核对桌面（1440）、英文暗色（1440）、移动（390）三种视图均正常。
- **主要文件**：`src/web/App.tsx`、`src/web/index.css`、`src/web/i18n.tsx`、`src/web/App.login-surface.test.tsx`
- **状态**：已完成
