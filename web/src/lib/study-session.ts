/**
 * 「今回解く問題の並び」をタブ単位で覚えておく（sessionStorage）。
 * 問題画面の「次の問題へ」はこの並びをたどる。
 */
import type { Mastery } from '../../../shared/mastery';

export type StudyFilter = 'all' | 'unanswered' | 'weak' | 'shaky' | 'review';
export type StudyOrder = 'sequential' | 'random';

export const FILTERS: Record<StudyFilter, { label: string; includes: (m: Mastery) => boolean }> = {
  all: { label: 'すべて', includes: () => true },
  unanswered: { label: '未回答だけ', includes: (m) => m === 'unanswered' },
  review: { label: '苦手 + あいまい', includes: (m) => m === 'weak' || m === 'shaky' },
  weak: { label: '苦手だけ', includes: (m) => m === 'weak' },
  shaky: { label: 'あいまいだけ', includes: (m) => m === 'shaky' },
};

interface StudySession {
  queue: string[];
}

const key = (category: string, exam: string) => `study:${category}/${exam}`;

function read(category: string, exam: string): StudySession | null {
  try {
    const raw = sessionStorage.getItem(key(category, exam));
    return raw ? (JSON.parse(raw) as StudySession) : null;
  } catch {
    return null;
  }
}

export function startSession(category: string, exam: string, queue: string[]) {
  try {
    sessionStorage.setItem(key(category, exam), JSON.stringify({ queue }));
  } catch {
    // 保存できなくても、問題一覧の順で「次へ」が動くので致命的ではない
  }
}

/** 今の問題の次の問題 ID と、並びの中での位置 */
export function nextInSession(category: string, exam: string, current: string, fallback: string[]) {
  const queue = read(category, exam)?.queue ?? fallback;
  const index = queue.indexOf(current);
  return {
    position: index >= 0 ? index + 1 : null,
    next: index >= 0 ? (queue[index + 1] ?? null) : null,
  };
}
