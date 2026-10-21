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

/** SSE の 1 行から応答の文字列を取り出す。data 行でなければ null、エラーの知らせなら投げる */
export function parseDataLine(line: string): string | null {
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

/**
 * 受け取ったバイト列を SSE の行に分けて、応答の文字列を取り出す。
 * 行はチャンクの境目で切れて届くことがあるので、最後の行の途中は次のチャンクまで持ち越す
 */
export function createSseParser() {
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (lines: string[]) => lines.map(parseDataLine).filter((text): text is string => text !== null);
  return {
    push(chunk: Uint8Array): string[] {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      return parse(lines);
    },
    /** 最後に改行なしで残った行 */
    flush(): string[] {
      const rest = buffer + decoder.decode();
      buffer = '';
      return parse([rest]);
    },
  };
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
  const parser = createSseParser();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(value);
    }
    yield* parser.flush();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
