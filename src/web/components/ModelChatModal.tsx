import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
};

type PromptCaseOption = {
  id: number;
  title: string;
  prompt: string;
  suiteName: string;
  expectedAnswer: string | null;
  answerNotes: string | null;
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
  const [channels, setChannels] = useState<ModelChatChannelOption[]>([]);
  const [forcedChannelId, setForcedChannelId] = useState<number | null>(null);
  const [promptCases, setPromptCases] = useState<PromptCaseOption[]>([]);
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [promptQuery, setPromptQuery] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const modelName = target?.modelName || '';

  // 换模型时重置对话，避免把上一个模型的上下文带过去。
  useEffect(() => {
    if (!open) return;
    setMessages([]);
    setInput('');
    setSending(false);
    setPromptQuery('');
    setPromptPickerOpen(false);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open, modelName, target?.siteId]);

  // 打开时拉这个站点下可固定的通道：默认固定到当前站点，失败才落回自动路由。
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    setChannels([]);
    setForcedChannelId(null);
    void api.getModelMonitorChatChannels(target.siteId, target.modelName)
      .then((res) => {
        if (cancelled) return;
        const list: ModelChatChannelOption[] = Array.isArray(res?.channels) ? res.channels : [];
        setChannels(list);
        setForcedChannelId(list.length ? list[0].channelId : null);
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      });
    return () => { cancelled = true; };
  }, [open, target?.siteId, target?.modelName, target]);

  // 快捷提示词：题库里的启用题目。
  useEffect(() => {
    if (!open || promptCases.length) return;
    void api.getPromptCases()
      .then((res) => {
        const list: PromptCaseOption[] = (Array.isArray(res?.cases) ? res.cases : [])
          .map((item: any) => ({
            id: Number(item?.id),
            title: String(item?.title || ''),
            prompt: String(item?.prompt || ''),
            suiteName: String(item?.suiteName || ''),
            expectedAnswer: item?.expectedAnswer ?? null,
            answerNotes: item?.answerNotes ?? null,
          }))
          .filter((item: PromptCaseOption) => item.prompt);
        setPromptCases(list);
      })
      .catch(() => setPromptCases([]));
  }, [open, promptCases.length]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const filteredPrompts = useMemo(() => {
    const query = promptQuery.trim().toLowerCase();
    if (!query) return promptCases;
    return promptCases.filter((item) => (
      item.title.toLowerCase().includes(query)
      || item.suiteName.toLowerCase().includes(query)
      || item.prompt.toLowerCase().includes(query)
    ));
  }, [promptCases, promptQuery]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !target) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setSending(true);

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
      // forcedChannelId 只走信封层（后端据此注入固定通道头），不要塞进请求体。
      const body: Record<string, unknown> = {
        model: target.modelName,
        messages: nextMessages.map((item) => ({ role: item.role, content: item.content })),
        stream: true,
      };

      const response = await api.proxyTestStream(
        {
          method: 'POST',
          path: '/v1/chat/completions',
          requestKind: 'json',
          stream: true,
          forcedChannelId: forcedChannelId,
          jsonBody: body,
        },
        controller.signal,
      );

      if (!response.ok) throw new Error(await readStreamErrorText(response));
      if (!response.body) throw new Error(tr('流式响应体为空'));

      const decoder = new TextDecoder('utf-8');
      const reader = response.body.getReader();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const parsed = parseSseBlock(block);
          if (!parsed.data || parsed.data === '[DONE]') continue;
          let payload: any;
          try {
            payload = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          if (payload?.error) throw new Error(String(payload.error?.message || payload.error));
          const delta = readOpenAiDelta(payload);
          if (delta.content || delta.reasoning) applyDelta(delta);
        }
      }
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
  }, [input, sending, target, messages, forcedChannelId, toast]);

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

  const activeChannel = channels.find((item) => item.channelId === forcedChannelId) || null;

  return (
    <CenteredModal
      open={open}
      onClose={() => { if (!sending) onClose(); }}
      title={tr('对话测试')}
      maxWidth={760}
      bodyStyle={{ padding: 0 }}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
            {tr('测试流量，日志里标记为「模型测试」')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            {sending ? (
              <button type="button" className="btn btn-ghost" onClick={stop}>{tr('停止')}</button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
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
          {channels.length ? (
            <label className="model-chat-route">
              <span>{tr('路由')}</span>
              <select
                value={forcedChannelId === null ? '__auto__' : String(forcedChannelId)}
                onChange={(event) => {
                  const value = event.target.value;
                  setForcedChannelId(value === '__auto__' ? null : Number.parseInt(value, 10));
                }}
                disabled={sending}
              >
                <option value="__auto__">{tr('自动路由')}</option>
                {channels.map((item) => (
                  <option key={item.channelId} value={item.channelId}>
                    {item.routeName}{item.accountName ? ` · ${item.accountName}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="model-chat-route-hint">{tr('该站点没有可固定的通道，走自动路由')}</span>
          )}
        </div>

        <div className="model-chat-messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="model-chat-empty">
              {tr('发一条消息试试这个模型；也可以从下方快捷选一条测试提示词。')}
              {activeChannel ? (
                <div className="model-chat-empty-hint">
                  {tr('当前固定到')} {activeChannel.routeName}
                  {activeChannel.sourceModel ? ` → ${activeChannel.sourceModel}` : ''}
                </div>
              ) : null}
            </div>
          ) : (
            messages.map((item, index) => (
              <div key={index} className={`model-chat-bubble is-${item.role}${item.error ? ' is-error' : ''}`}>
                <div className="model-chat-role">{item.role === 'user' ? tr('我') : tr('模型')}</div>
                {item.reasoning ? (
                  <details className="model-chat-reasoning">
                    <summary>{tr('思考过程')}</summary>
                    <pre>{item.reasoning}</pre>
                  </details>
                ) : null}
                <div className="model-chat-content">
                  {item.content || (sending && index === messages.length - 1 ? tr('生成中…') : '')}
                </div>
              </div>
            ))
          )}
        </div>

        {promptPickerOpen ? (
          <div className="model-chat-prompt-picker">
            <div className="model-chat-prompt-head">
              <input
                value={promptQuery}
                onChange={(event) => setPromptQuery(event.target.value)}
                placeholder={tr('搜索提示词（鹈鹕测试 / 糖果测试…）')}
                autoFocus
              />
              <button type="button" className="btn btn-ghost" onClick={() => setPromptPickerOpen(false)}>
                {tr('收起')}
              </button>
            </div>
            <div className="model-chat-prompt-list">
              {filteredPrompts.length === 0 ? (
                <div className="model-chat-prompt-empty">{tr('提示词管理里还没有启用的题目')}</div>
              ) : filteredPrompts.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="model-chat-prompt-item"
                  onClick={() => applyPrompt(item)}
                  title={item.prompt}
                >
                  <span className="model-chat-prompt-title">{item.title}</span>
                  <span className="model-chat-prompt-suite">{item.suiteName}</span>
                  {item.expectedAnswer ? (
                    <span className="model-chat-prompt-answer">{tr('答案')} {item.expectedAnswer}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}

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
              className={`btn btn-ghost${promptPickerOpen ? ' btn-ghost-active' : ''}`}
              onClick={() => setPromptPickerOpen((current) => !current)}
            >
              {tr('快捷提示词')}{promptCases.length ? ` (${promptCases.length})` : ''}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void send()}
              disabled={sending || !input.trim()}
            >
              {sending ? tr('生成中…') : tr('发送')}
            </button>
          </div>
        </div>
      </div>
    </CenteredModal>
  );
}
