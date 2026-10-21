import { describe, expect, it } from 'vitest';
import { choiceState, correctLabels, toggleSelection } from './answer';

describe('toggleSelection', () => {
  it('1 つ選ぶ問題は押したものに置き換える', () => {
    expect(toggleSelection([2], 0, 1)).toEqual([0]);
    expect(toggleSelection([2], 2, 1)).toEqual([2]);
  });

  it('複数選ぶ問題は押すたびに付け外しする', () => {
    expect(toggleSelection([], 1, 2)).toEqual([1]);
    expect(toggleSelection([1], 3, 2)).toEqual([1, 3]);
    expect(toggleSelection([1, 3], 1, 2)).toEqual([3]);
  });

  it('選べる数を超えたら最初に選んだものを外す', () => {
    expect(toggleSelection([1, 3], 0, 2)).toEqual([3, 0]);
  });
});

describe('choiceState', () => {
  it('採点前は選んだかどうかだけ', () => {
    expect(choiceState(0, [0], null)).toBe('picked');
    expect(choiceState(1, [0], null)).toBe('idle');
  });

  it('採点後は正誤と選んだかどうかの組み合わせ', () => {
    const answers = [0, 2];
    expect(choiceState(0, [0, 1], answers)).toBe('correct-picked');
    expect(choiceState(1, [0, 1], answers)).toBe('wrong-picked');
    expect(choiceState(2, [0, 1], answers)).toBe('correct-missed');
    expect(choiceState(3, [0, 1], answers)).toBe('idle');
  });
});

describe('correctLabels', () => {
  it('画面の並びのラベルにして並べ替える', () => {
    // 画面: A=原本4, B=原本2, C=原本1, D=原本3
    expect(correctLabels([0, 3], [3, 1, 0, 2])).toBe('A, C');
  });
});
