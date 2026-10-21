import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../../shared/types';
import { appendToLast, dropEmptyTurn, historyToSend, startTurn } from './chat-messages';

const turn = (q: string, a: string): ChatMessage[] => [
  { role: 'user', content: q },
  { role: 'assistant', content: a },
];

describe('会話履歴の更新', () => {
  it('送信すると質問と空の応答を足し、届いた応答を最後に足していく', () => {
    let messages = startTurn(turn('q1', 'a1'), 'q2');
    expect(messages.slice(-2)).toEqual(turn('q2', ''));
    messages = appendToLast(appendToLast(messages, 'あ'), 'い');
    expect(messages).toEqual([...turn('q1', 'a1'), ...turn('q2', 'あい')]);
  });

  it('応答が空のまま終わったら、その質問ごと消す', () => {
    expect(dropEmptyTurn(startTurn(turn('q1', 'a1'), 'q2'))).toEqual(turn('q1', 'a1'));
  });

  it('応答が途中まで届いていれば残す', () => {
    const messages = appendToLast(startTurn([], 'q1'), '途中');
    expect(dropEmptyTurn(messages)).toEqual(turn('q1', '途中'));
    expect(dropEmptyTurn([])).toEqual([]);
  });

  it('送る履歴は直近 20 件まで', () => {
    const messages = Array.from({ length: 15 }, (_, i) => turn(`q${i}`, `a${i}`)).flat();
    const sent = historyToSend(messages);
    expect(sent).toHaveLength(20);
    expect(sent[0]).toEqual({ role: 'user', content: 'q5' });
  });
});
