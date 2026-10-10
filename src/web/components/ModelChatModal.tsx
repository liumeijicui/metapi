import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.js';
import CenteredModal from './CenteredModal.js';
import { tr } from '../i18n.js';

/**
 * 「模型监控」里点「对话」用的轻量聊天窗：直接对这个模型发一轮对话。
 * 参考模型操练厂，但只保留最必要的部分——发消息、看流式回复、快捷选提示词。
 *
 * 走的是和操练厂同一条 `/api/test/proxy/stream` 通道，所以代理日志会自动
 * 带上「模型测试」标记（见 proxy-core/downstreamClientContext）。
 */

export type ModelChatTarget = {
  modelName: string;
  siteName: string;
  siteId: number;
  siteUrl?: string;
};

export type ModelChatChannelOption = {
  channelId: number;
  routeName: string;
  sourceModel: string | null;
  accountName: string;
  upstreamModel: string;
};

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  error?: boolean;
  /**
   * 这一轮流是怎么结束的（只对助手消息有意义）。
   *
   * 上游把回答截断了却照样回 `finish_reason: stop` + `[DONE]` 时（胖猫的
   * deepseek-v4.1-flash 就是这样），页面上光看内容分不出是上游停的还是我们断的，
   * 所以把上游自己声明的结束原因和 token 用量留在气泡下面。
   */
  finishReason?: string | null;
  completionTokens?: number | null;
  /** 有没有收到 `[DONE]`。没收到就说明这轮不是正常收尾。 */
  sawDone?: boolean;
};

/** 一条可按直连的凭据：站点账号自己的 JWT，或账号下的 sk- 令牌。 */
type DirectCredentialOption = {
  accountId: number;
  tokenId: number | null;
  label: string;
  accountName: string;
  tokenName: string | null;
  credential: 'account' | 'api_token';
};

type PromptCaseOption = {
  id: number;
  title: string;
  prompt: string;
  answer: string | null;
};

const parseSseBlock = (block: string): { event: string; data: string | null } => {
  const lines = block.split(/\r?\n/);
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.length > 0 ? dataLines.join('\n') : null };
};

/** 凭据在下拉里的唯一键：账号 ID + 令牌 ID。 */
export function buildCredentialKey(credential: { accountId: number; tokenId: number | null }): string {
  return `${credential.accountId}:${credential.tokenId ?? 0}`;
}

/** 从一帧 SSE JSON 里取增量文本。这里只处理 OpenAI 风格的 chunk。 */
function readOpenAiDelta(payload: any): { content?: string; reasoning?: string; done?: boolean } {
  if (!payload || typeof payload !== 'object') return {};
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) {
    if (payload?.type === 'response.completed') return { done: true };
    return {};
  }
  const delta = choice.delta || {};
  const content = typeof delta.content === 'string' ? delta.content : '';
  const reasoning = typeof delta.reasoning_content === 'string'
    ? delta.reasoning_content
    : typeof delta.reasoning === 'string'
      ? delta.reasoning
      : '';
  return {
    content: content || undefined,
    reasoning: reasoning || undefined,
    done: Boolean(choice.finish_reason),
  };
}

async function readStreamErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      return String(
        parsed?.error?.message || parsed?.message || parsed?.error || text,
      ).slice(0, 300);
    } catch {
      return `${text.slice(0, 300)}`;
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * 是否已经在底部附近。留一点余量，免得手指 / 触控板抖一下就被判成「用户翻上去了」。
 */
function isNearBottom(node: HTMLElement | null, threshold = 48): boolean {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

export default function ModelChatModal({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: ModelChatTarget | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // 直连凭据：站点自己的账号 / sk- 令牌。选一条就直接打目标站，
  // 完全不走网关的新路由 / 老路由，所以和「有没有配路由」无关。
  const [credentials, setCredentials] = useState<DirectCredentialOption[]>([]);
  const [credentialKey, setCredentialKey] = useState('');
  // 思考强度：直接作为 OpenAI 协议的 reasoning_effort 字段透传给上游。
  // 上游不支持时会忽略这个字段，所以默认留空（按站点默认）。
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [promptCases, setPromptCases] = useState<PromptCaseOption[]>([]);
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [promptQuery, setPromptQuery] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const reasoningScrollRef = useRef<HTMLPreElement | null>(null);
  // 是否跟随最新。默认跟随；用户自己往上翻时暂停，滚回底部（或点「回到最新」）
  // 再恢复 —— 边出字边看历史时才不会被一直拽回底部。
  const [followingLatest, setFollowingLatest] = useState(true);
  const followLatestRef = useRef(true);
  const followReasoningRef = useRef(true);

  const modelName = target?.modelName || '';

  // 换模型时重置对话，避免把上一个模型的上下文带过去。
  useEffect(() => {
    if (!open) return;
    setMessages([]);
    setInput('');
    setSending(false);
    setPromptQuery('');
    setPromptPickerOpen(false);
    followLatestRef.current = true;
    followReasoningRef.current = true;
    setFollowingLatest(true);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open, modelName, target?.siteId]);

  // 打开时拉这个站点可用于直连的凭据，默认选第一条。
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setCredentials([]);
    setCredentialKey('');
    void api.getModelMonitorChatChannels(target.siteId, target.modelName)
      .then((res) => {
        if (cancelled) return;
        const list: DirectCredentialOption[] = (Array.isArray(res?.credentials) ? res.credentials : [])
          .map((item: any): DirectCredentialOption => ({
            accountId: Number(item?.accountId),
            tokenId: item?.tokenId == null ? null : Number(item.tokenId),
            label: String(item?.label || ''),
            accountName: String(item?.accountName || ''),
            tokenName: item?.tokenName == null ? null : String(item.tokenName),
            credential: item?.credential === 'api_token' ? 'api_token' : 'account',
          }))
          .filter((item: DirectCredentialOption) => Number.isFinite(item.accountId) && item.accountId > 0) as DirectCredentialOption[];
        setCredentials(list);
        setCredentialKey(list.length ? buildCredentialKey(list[0]) : '');
      })
      .catch(() => {
        if (!cancelled) {
          setCredentials([]);
          setCredentialKey('');
        }
      });
    return () => { cancelled = true; };
  }, [open, target?.siteId, target?.modelName, target]);

  // 快捷提示词：提示词管理里的题目（图名称 → 描述）。
  useEffect(() => {
    if (!open || promptCases.length) return;
    void api.getSimplePromptCases()
      .then((res) => {
        const list: PromptCaseOption[] = (Array.isArray(res?.cases) ? res.cases : [])
          .map((item: any) => ({
            id: Number(item?.id),
            title: String(item?.title || ''),
            prompt: String(item?.description || ''),
            answer: item?.answer == null || item?.answer === '' ? null : String(item.answer),
          }))
          .filter((item: PromptCaseOption) => item.prompt);
        setPromptCases(list);
      })
      .catch(() => setPromptCases([]));
  }, [open, promptCases.length]);

  /**
   * 把「消息列表」和「思考过程」都钉到底部。
   *
   * 用 useLayoutEffect 且不写依赖数组：每次提交都跑，所以不管内容是哪条路径改
   * 的（流式增量、结束标记、报错）都不会漏。只用 `[messages]` 当依赖时，一旦某
   * 次更新没产生新的 messages 引用，滚动就跟不上了。
   */
  const pinToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
      // 视口很矮时（横屏手机）弹窗卡片自己也会滚起来，一并拉到底，免得最新那
      // 一行被卡片裁在外面。只在这一层之前停，不去动页面本身的滚动。
      let ancestor = node.parentElement;
      while (ancestor) {
        if (ancestor.classList.contains('modal-content')) {
          if (ancestor.scrollHeight > ancestor.clientHeight + 1) {
            ancestor.scrollTop = ancestor.scrollHeight;
          }
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    // 思考过程是独立的滚动容器，单独判断：用户自己在里面往上翻时不要拽回来。
    const reasoning = reasoningScrollRef.current;
    if (reasoning && followReasoningRef.current) reasoning.scrollTop = reasoning.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (!followLatestRef.current) return;
    pinToLatest();
  });

  // 用户往上翻就暂停跟随（否则刚看两行又被拽回底部），滚回底部自动恢复。
  const handleMessagesScroll = useCallback(() => {
    const next = isNearBottom(scrollRef.current);
    if (next === followLatestRef.current) return;
    followLatestRef.current = next;
    // 回到最新时思考过程也一起跟上。
    if (next) followReasoningRef.current = true;
    setFollowingLatest(next);
  }, []);

  /**
   * 「用户想往上看」必须从滚轮 / 滑动这些输入上判定，不能等 scroll 事件：
   * 流式增量每几十毫秒提交一次，每次提交都会把容器钉回底部，而 scroll 事件要等
   * 下一帧才派发，那时位置早被钉回去了，永远会被判成「还在底部」。
   */
  const pauseFollowing = useCallback(() => {
    followReasoningRef.current = false;
    if (!followLatestRef.current) return;
    followLatestRef.current = false;
    setFollowingLatest(false);
  }, []);

  const handleMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pauseFollowing();
  }, [pauseFollowing]);

  const touchStartYRef = useRef<number | null>(null);
  const handleMessagesTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);
  const handleMessagesTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    const y = event.touches[0]?.clientY;
    if (startY == null || y == null) return;
    // 手指往下拉 = 想看更早的内容。
    if (y - startY > 4) pauseFollowing();
  }, [pauseFollowing]);

  const handleReasoningScroll = useCallback(() => {
    followReasoningRef.current = isNearBottom(reasoningScrollRef.current);
  }, []);

  // 思考过程是 <details>，默认收着；用户展开时直接跳到最新的一段，而不是从头看。
  // 收起时 pre 不可见，赋值 scrollTop 不生效，所以只在展开这一刻补一次。
  const handleReasoningToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return;
    followReasoningRef.current = true;
    const pin = () => {
      const node = reasoningScrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    };
    pin();
    // 展开的一帧内内容才拿到真实高度，补一次，避免停在第一行。
    if (typeof window !== 'undefined') window.requestAnimationFrame(pin);
  }, []);

  const jumpToLatest = useCallback(() => {
    followLatestRef.current = true;
    followReasoningRef.current = true;
    setFollowingLatest(true);
    pinToLatest();
  }, [pinToLatest]);

  const filteredPrompts = useMemo(() => {
    const query = promptQuery.trim().toLowerCase();
    if (!query) return promptCases;
    return promptCases.filter((item) => (
      item.title.toLowerCase().includes(query)
      || item.prompt.toLowerCase().includes(query)
    ));
  }, [promptCases, promptQuery]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !target) return;
    const credential = credentials.find((item) => buildCredentialKey(item) === credentialKey);
    if (!credential) {
      toast.error(tr('该站点没有可用于直连的账号或密钥，无法发起对话'));
      return;
    }

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setSending(true);
    // 新的一轮从底部开始：用户可能上一轮翻到中间看历史了，这里要回到最新。
    followLatestRef.current = true;
    followReasoningRef.current = true;
    setFollowingLatest(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const applyDelta = (patch: { content?: string; reasoning?: string }) => {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        copy[copy.length - 1] = {
          ...last,
          content: last.content + (patch.content || ''),
          reasoning: (last.reasoning || '') + (patch.reasoning || ''),
        };
        return copy;
      });
    };

    try {
      // 直连接口：站点 + 账号 + 凭据直接打上游，和路由配置无关；
      // 模型名就是页面上点中的那个，不做任何改写。
      const response = await api.directChatStream(
        {
          siteId: target.siteId,
          accountId: credential.accountId,
          tokenId: credential.tokenId,
          model: target.modelName,
          messages: nextMessages.map((item) => ({ role: item.role, content: item.content })),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
        controller.signal,
      );

      if (!response.ok) throw new Error(await readStreamErrorText(response));
      if (!response.body) throw new Error(tr('流式响应体为空'));

      const decoder = new TextDecoder('utf-8');
      const reader = response.body.getReader();
      let buffer = '';
      // 只记录「这轮怎么结束的」，用来把责任写清楚：上游声明的结束原因、用量、
      // 有没有结束标记。上游截断内容却回 stop + [DONE] 时，只有这行字能说明白。
      let finishReason: string | null = null;
      let completionTokens: number | null = null;
      let sawDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed.data) continue;
          if (parsed.data === '[DONE]') {
            sawDone = true;
            continue;
          }
          let payload: any;
          try {
            payload = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          if (payload?.error) throw new Error(String(payload.error?.message || payload.error));
          const finishChoice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
          if (finishChoice?.finish_reason) finishReason = String(finishChoice.finish_reason);
          if (typeof payload?.usage?.completion_tokens === 'number') {
            completionTokens = payload.usage.completion_tokens;
          }
          const delta = readOpenAiDelta(payload);
          if (delta.content || delta.reasoning) applyDelta(delta);
        }
      }
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          copy[copy.length - 1] = { ...last, finishReason, completionTokens, sawDone };
        }
        return copy;
      });
    } catch (error: any) {
      const message = error?.name === 'AbortError'
        ? tr('已停止')
        : String(error?.message || tr('请求失败'));
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant' && !last.content && !last.reasoning) {
          copy[copy.length - 1] = { role: 'assistant', content: message, error: true };
          return copy;
        }
        return [...copy, { role: 'assistant', content: message, error: true }];
      });
      if (error?.name !== 'AbortError') toast.error(message);
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }, [input, sending, target, messages, credentials, credentialKey, toast]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }, []);

  const applyPrompt = useCallback((item: PromptCaseOption) => {
    setInput(item.prompt);
    setPromptPickerOpen(false);
    setPromptQuery('');
  }, []);

  const activeCredential = credentials.find((item) => buildCredentialKey(item) === credentialKey) || null;

  return (
    <>
    <CenteredModal
      open={open}
      onClose={() => { if (!sending) onClose(); }}
      title={tr('对话测试')}
      maxWidth={760}
      bodyStyle={{ padding: 0 }}
      footer={(
        <div className="model-chat-footer">
          <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
            {tr('直连目标站点；日志里标记为「模型测试」')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {sending ? (
              <button type="button" className="btn btn-ghost model-chat-footer-btn" onClick={stop}>
                {tr('停止')}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost model-chat-footer-btn"
              onClick={() => setMessages([])}
              disabled={!messages.length || sending}
            >
              {tr('清空对话')}
            </button>
          </div>
        </div>
      )}
    >
      <div className="model-chat">
        <div className="model-chat-target">
          <div className="model-chat-target-main">
            <strong>{target?.modelName || ''}</strong>
            <span className="model-chat-target-site">{target?.siteName || ''}</span>
          </div>
          {credentials.length ? (
            <label className="model-chat-route">
              <span>{tr('直连凭据')}</span>
              <select
                value={credentialKey}
                onChange={(event) => setCredentialKey(event.target.value)}
                disabled={sending}
              >
                {credentials.map((item) => (
                  <option key={buildCredentialKey(item)} value={buildCredentialKey(item)}>
                    {item.label}{item.credential === 'api_token' ? '' : '（账号）'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="model-chat-route-hint">{tr('该站点没有可用于直连的账号或密钥')}</span>
          )}
          <label className="model-chat-route">
            <span>{tr('思考强度')}</span>
            <select
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value)}
              disabled={sending}
              title={tr('作为 reasoning_effort 透传给上游；上游不支持时会被忽略')}
            >
              <option value="">{tr('站点默认')}</option>
              <option value="minimal">minimal</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </label>
        </div>

        <div className="model-chat-route-note">
          {activeCredential ? (
            <>{tr('直连目标站点')} {target?.siteName || ''}{tr('，用「')}{activeCredential.label}{tr('」的凭据直接调用，不经过新路由 / 老路由，也不会转发到其它站点。')}{reasoningEffort ? `${tr('思考强度')}：${reasoningEffort}。` : ''}</>
          ) : (
            <>{tr('该站点还没有可用凭据（账号或 sk- 密钥），先去「站点」里补一个再来对话。')}</>
          )}
        </div>

        <div className="model-chat-messages-wrap">
          <div
            className="model-chat-messages"
            ref={scrollRef}
            onScroll={handleMessagesScroll}
            onWheel={handleMessagesWheel}
            onTouchStart={handleMessagesTouchStart}
            onTouchMove={handleMessagesTouchMove}
          >
            {messages.length === 0 ? (
              <div className="model-chat-empty">
                {tr('发一条消息试试这个模型；也可以从下方快捷选一条测试提示词。')}
                {activeCredential ? (
                  <div className="model-chat-empty-hint">
                    {tr('直连')} {target?.siteName || ''} · {activeCredential.label}
                  </div>
                ) : null}
              </div>
            ) : (
              messages.map((item, index) => (
                <div key={index} className={`model-chat-bubble is-${item.role}${item.error ? ' is-error' : ''}`}>
                  <div className="model-chat-role">{item.role === 'user' ? tr('我') : tr('模型')}</div>
                  {item.reasoning ? (
                    <details className="model-chat-reasoning" onToggle={handleReasoningToggle}>
                      <summary>{tr('思考过程')}</summary>
                      <pre ref={reasoningScrollRef} onScroll={handleReasoningScroll}>{item.reasoning}</pre>
                    </details>
                  ) : null}
                  <div className="model-chat-content">
                    {item.content || (sending && index === messages.length - 1 ? tr('生成中…') : '')}
                  </div>
                  {item.role === 'assistant' && item.finishReason !== undefined ? (
                    <div className="model-chat-finish">
                      {item.sawDone
                        ? `${tr('上游结束原因')}: ${item.finishReason || tr('未声明')}${item.completionTokens == null ? '' : ` · ${tr('输出')} ${item.completionTokens} tokens`}`
                        : tr('上游没有发送结束标记，这轮可能被中断')}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {!followingLatest ? (
            <button
              type="button"
              className="model-chat-jump-latest"
              onClick={jumpToLatest}
            >
              {tr('回到最新')}
            </button>
          ) : null}
        </div>

        <div className="model-chat-composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder={tr('输入消息，Ctrl/⌘ + Enter 发送')}
            rows={3}
            disabled={sending}
          />
          <div className="model-chat-composer-actions">
            <button
              type="button"
              className="btn btn-ghost model-chat-footer-btn"
              onClick={() => setPromptPickerOpen(true)}
            >
              {tr('快捷提示词')}{promptCases.length ? ` (${promptCases.length})` : ''}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void send()}
              disabled={sending || !input.trim() || !activeCredential}
            >
              {sending ? tr('生成中…') : tr('发送')}
            </button>
          </div>
        </div>
      </div>
    </CenteredModal>

    <CenteredModal
      open={open && promptPickerOpen}
      onClose={() => { setPromptPickerOpen(false); setPromptQuery(''); }}
      title={tr('快捷提示词')}
      maxWidth={560}
      closeOnBackdrop
      closeOnEscape
      footer={(
        <button
          type="button"
          className="btn btn-ghost model-chat-footer-btn"
          onClick={() => { setPromptPickerOpen(false); setPromptQuery(''); }}
        >
          {tr('关闭')}
        </button>
      )}
    >
      <div className="model-chat-prompt-head">
        <input
          value={promptQuery}
          onChange={(event) => setPromptQuery(event.target.value)}
          placeholder={tr('搜索提示词（鹈鹕测试 / 糖果测试…）')}
          autoFocus
        />
      </div>
      <div className="model-chat-prompt-list model-chat-prompt-list-modal">
        {filteredPrompts.length === 0 ? (
          <div className="model-chat-prompt-empty">{tr('提示词管理里还没有题目')}</div>
        ) : filteredPrompts.map((item) => (
          <button
            key={item.id}
            type="button"
            className="model-chat-prompt-item"
            onClick={() => applyPrompt(item)}
            title={item.prompt}
          >
            <span className="model-chat-prompt-title">{item.title}</span>
            {item.answer ? (
              <span className="model-chat-prompt-answer">{tr('答案')} {item.answer}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div className="model-chat-prompt-tip">
        {tr('选中后会把题目描述填进输入框，可再手动修改。')}
      </div>
    </CenteredModal>
    </>
  );
}
