/** 選択と採点の判定（画面から切り離して単体テストする） */
import { labelOf } from './choices';

/** 選択肢 1 つの見た目の状態 */
export type ChoiceState = 'idle' | 'picked' | 'correct-picked' | 'correct-missed' | 'wrong-picked';

/** 選択肢を押したときの新しい選択（原本の index） */
export function toggleSelection(prev: readonly number[], original: number, selectCount: number): number[] {
  if (selectCount <= 1) return [original];
  if (prev.includes(original)) return prev.filter((v) => v !== original);
  // 選べる数を超えたら、最初に選んだものを外す
  return [...prev, original].slice(-selectCount);
}

/** answers は採点前なら null */
export function choiceState(original: number, selected: readonly number[], answers: readonly number[] | null): ChoiceState {
  const picked = selected.includes(original);
  if (!answers) return picked ? 'picked' : 'idle';
  if (answers.includes(original)) return picked ? 'correct-picked' : 'correct-missed';
  return picked ? 'wrong-picked' : 'idle';
}

/** 正解を画面のラベルで並べる（例: "A, C"） */
export function correctLabels(answers: readonly number[], displayOrder: readonly number[]): string {
  return answers
    .map((a) => labelOf(displayOrder, a))
    .sort()
    .join(', ');
}
