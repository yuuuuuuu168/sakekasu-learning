import { describe, expect, it } from 'vitest';
import { createSseParser, parseDataLine } from './chat';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('parseDataLine', () => {
  it('data 行の JSON 文字列を取り出す', () => {
    expect(parseDataLine('data: "こんにちは"')).toBe('こんにちは');
    expect(parseDataLine('data:"\\n\\n"')).toBe('\n\n');
  });

  it('data 行でないもの・空・JSON でないもの・文字列でないものは捨てる', () => {
    for (const line of ['', ': keep-alive', 'event: message', 'data:', 'data: {broken', 'data: 1', 'data: {"x":1}']) {
      expect(parseDataLine(line)).toBeNull();
    }
  });

  it('エラーの知らせは投げる', () => {
    expect(() => parseDataLine('data: {"error":"boom"}')).toThrow('AI の応答でエラーが発生しました');
  });
});

describe('createSseParser', () => {
  it('チャンクの境目で切れた行を次のチャンクとつなぐ', () => {
    const parser = createSseParser();
    expect(parser.push(bytes('data: "あ"\ndata: "い'))).toEqual(['あ']);
    expect(parser.push(bytes('う"\n\n'))).toEqual(['いう']);
    expect(parser.flush()).toEqual([]);
  });

  it('マルチバイト文字の途中で切れても崩さない', () => {
    const parser = createSseParser();
    const all = bytes('data: "相談"\n');
    expect(parser.push(all.slice(0, 8))).toEqual([]);
    expect(parser.push(all.slice(8))).toEqual(['相談']);
  });

  it('最後に改行なしで残った行も取り出す', () => {
    const parser = createSseParser();
    expect(parser.push(bytes('data: "a"\ndata: "b"'))).toEqual(['a']);
    expect(parser.flush()).toEqual(['b']);
  });
});
