/**
 * AI チャット（AgentCore Runtime）の呼び出し。
 *
 * Cognito のアクセストークンを Bearer で送り、SSE（`data: "<JSON 文字列>"`）で届く
 * 応答を逐次返す。会話の履歴はこちらで持ち、毎回送る（Runtime 側は状態を持たない）。
 */
import type { ChatPayload } from '../../../shared/types';
import { config } from '../config';
import { accessToken } from './api';

/** AgentCore がセッションの識別に使うヘッダー（33文字以上が必要） */
const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

export function newSessionId(): string {
  return `learning-${crypto.randomUUID()}`;
}

function invocationUrl(): string {
  const { region, agentRuntimeArn } = config();
  return (
    `https://bedrock-agentcore.${region}.amazonaws.com` +
    `/runtimes/${encodeURIComponent(agentRuntimeArn)}/invocations?qualifier=DEFAULT`
  );
}

function parseDataLine(line: string): string | null {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice('data:'.length).trim();
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      throw new Error('AI の応答でエラーが発生しました');
    }
    return null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export async function* sendChat(
  payload: ChatPayload,
  { sessionId, signal }: { sessionId: string; signal?: AbortSignal },
): AsyncGenerator<string> {
  const res = await fetch(invocationUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await accessToken()}`,
      [SESSION_HEADER]: sessionId,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('認証に失敗しました。ログインし直してください');
  }
  if (!res.ok || !res.body) throw new Error(`AI の呼び出しに失敗しました（${res.status}）`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最後の要素は行の途中かもしれないので次のチャンクへ持ち越す
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const text = parseDataLine(line);
        if (text !== null) yield text;
      }
    }
    const rest = parseDataLine(buffer);
    if (rest !== null) yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
