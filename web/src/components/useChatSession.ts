import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ChatPayload } from '../../../shared/types';
import { newSessionId, sendChat } from '../lib/chat';
import { appendToLast, dropEmptyTurn, historyToSend, startTurn } from '../lib/chat-messages';

/** 相談の対象（どの問題・画面の並び・選んだ選択肢）。ChatPayload から会話の部分を除いたもの */
export type ChatTarget = Omit<ChatPayload, 'history' | 'prompt'>;

/**
 * 1 つの問題についての会話。送信・応答の流し込み・中断と、空の応答の後始末を受け持つ。
 * 画面を閉じたら（外されたら）流している応答を止める
 */
export function useChatSession(target: ChatTarget) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useRef(newSessionId());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** 送信を受け付けたら true（空の入力や応答中なら false） */
  const send = (prompt: string): boolean => {
    const text = prompt.trim();
    if (!text || streaming) return false;
    setError(null);
    const history = historyToSend(messages);
    setMessages(startTurn(messages, text));
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    void (async () => {
      try {
        const stream = sendChat(
          { ...target, history, prompt: text },
          { sessionId: sessionId.current, signal: controller.signal },
        );
        for await (const chunk of stream) {
          setMessages((prev) => appendToLast(prev, chunk));
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      } finally {
        setStreaming(false);
        abortRef.current = null;
        setMessages(dropEmptyTurn);
      }
    })();
    return true;
  };

  const abort = () => abortRef.current?.abort();

  return { messages, streaming, error, send, abort };
}
