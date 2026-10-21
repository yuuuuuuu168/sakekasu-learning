/** 会話履歴の更新（ChatPanel から切り離して単体テストする） */
import type { ChatMessage } from '../../../shared/types';
import { MAX_HISTORY_MESSAGES } from '../../../shared/chat';

/** 送信したときの表示。今回の発言と、応答を流し込む空の発言を足す */
export function startTurn(messages: readonly ChatMessage[], prompt: string): ChatMessage[] {
  return [...messages, { role: 'user', content: prompt }, { role: 'assistant', content: '' }];
}

/** 届いた応答を最後の発言に足す */
export function appendToLast(messages: readonly ChatMessage[], chunk: string): ChatMessage[] {
  const next = [...messages];
  const last = next[next.length - 1];
  next[next.length - 1] = { ...last, content: last.content + chunk };
  return next;
}

/** 応答が空のまま終わった発言（とその質問）を消す。残すと次の送信で履歴が崩れる */
export function dropEmptyTurn(messages: readonly ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  return last?.role === 'assistant' && !last.content ? messages.slice(0, -2) : [...messages];
}

/** 送る履歴（agent も直近の分しか使わないので、古いものは送らない） */
export function historyToSend(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_HISTORY_MESSAGES);
}
