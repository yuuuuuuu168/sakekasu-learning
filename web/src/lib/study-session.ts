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

function isStudySession(value: unknown): value is StudySession {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as StudySession).queue) &&
    (value as StudySession).queue.every((id) => typeof id === 'string')
  );
}

/** 保存した並び。無い・読めない・形が違うときは null */
function read(category: string, exam: string): StudySession | null {
  try {
    const raw = sessionStorage.getItem(key(category, exam));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isStudySession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function startSession(category: string, exam: string, queue: string[]) {
  try {
    sessionStorage.setItem(key(category, exam), JSON.stringify({ queue }));
  } catch {
    // 保存できなくても問題は開ける。「次の問題へ」の代わりに一覧へ戻るボタンが出る
  }
}

/**
 * 今の問題が並びの中にあるか（inSession）と、次の問題 ID（next。最後の問題や並びの外なら null）。
 * 並びが保存されていない（一覧を通らずに URL で開いた、保存できなかった）ときは並びの外として扱う
 */
export function nextInSession(category: string, exam: string, current: string) {
  const queue = read(category, exam)?.queue ?? [];
  const index = queue.indexOf(current);
  return {
    inSession: index >= 0,
    next: index >= 0 ? (queue[index + 1] ?? null) : null,
  };
}
