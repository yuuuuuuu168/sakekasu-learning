/**
 * 習熟度の判定。直近2回の正誤で決める。
 *
 * | 直近の結果            | 判定        |
 * |-----------------------|-------------|
 * | 未回答                | unanswered  |
 * | 正解 → 正解           | mastered    |
 * | 正解/不正解が混在     | shaky       |
 * | 不正解 → 不正解       | weak        |
 * | 1回だけ回答して正解   | shaky       |
 * | 1回だけ回答して不正解 | weak        |
 *
 * 1回だけの正解は「まぐれ」の可能性があるため、バッチリ扱いにしない。
 */

export const MASTERIES = ['mastered', 'shaky', 'weak', 'unanswered'] as const;
export type Mastery = (typeof MASTERIES)[number];

/** 1問あたり保持する正誤履歴の件数 */
export const HISTORY_LIMIT = 10;

export function masteryOf(history: readonly boolean[]): Mastery {
  if (history.length === 0) return 'unanswered';
  const recent = history.slice(-2);
  if (recent.length === 1) return recent[0] ? 'shaky' : 'weak';
  const [prev, last] = recent;
  if (prev && last) return 'mastered';
  if (!prev && !last) return 'weak';
  return 'shaky';
}

export function emptyMasteryCounts(): Record<Mastery, number> {
  return { mastered: 0, shaky: 0, weak: 0, unanswered: 0 };
}

/** 選んだ選択肢と正解が完全に一致したときだけ正解とする */
export function isCorrect(selected: readonly number[], answers: readonly number[]): boolean {
  const a = [...new Set(selected)].sort((x, y) => x - y);
  const b = [...answers].sort((x, y) => x - y);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
