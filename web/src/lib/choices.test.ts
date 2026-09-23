import { describe, expect, it } from 'vitest';
import { labelOf, relabel, shuffledOrder } from './choices';

describe('shuffledOrder', () => {
  it('0..n-1 の並べ替えになる', () => {
    for (let i = 0; i < 50; i++) {
      expect([...shuffledOrder(6)].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    }
  });
});

describe('relabel', () => {
  // 画面: A=原本4, B=原本2, C=原本1, D=原本3
  const order = [3, 1, 0, 2];

  it('原本の番号を画面のラベルに置き換える', () => {
    expect(labelOf(order, 0)).toBe('C');
    expect(relabel('選択肢 4 が担う', order)).toBe('選択肢 A が担う');
    expect(relabel('選択肢3は誤り', order)).toBe('選択肢Dは誤り');
  });

  it('「選択肢 1 と 3」のような列挙もまとめて置き換える', () => {
    expect(relabel('選択肢 1 と 3 の組み合わせ', order)).toBe('選択肢 C と D の組み合わせ');
    expect(relabel('選択肢1、2', order)).toBe('選択肢C、B');
  });

  it('選択肢以外の数字や範囲外の番号は変えない', () => {
    expect(relabel('2 つ選択。選択肢 9 は無い', order)).toBe('2 つ選択。選択肢 9 は無い');
  });
});
