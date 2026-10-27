/**
 * 「今回解く問題の並び」をタブ単位で覚えておく（sessionStorage）。
 * 問題画面の「次の問題へ」はこの並びをたどる。
 *
 * 「演習を始める」から始めた並び（演習）は、どこまで進んだかをサーバーにも残し
 * （PUT / PATCH /exams/{category}/{exam}/drill）、別の端末やタブを閉じた後でも続きから再開できる。
 * ここではその演習の ID をタブの並びと一緒に覚え、問題を開いた・答えたときにサーバーへ送る内容を作る。
 * 問題マップから開いた並びは演習の ID を持たないので、のぞいただけで演習の続きは動かない
 */
import type { DrillFilter, DrillOrder } from '../../../shared/drill';
import type { Mastery } from '../../../shared/mastery';
import type { UpdateDrillRequest } from '../../../shared/types';

export type StudyFilter = DrillFilter;
export type StudyOrder = DrillOrder;

export const FILTERS: Record<StudyFilter, { label: string; includes: (m: Mastery) => boolean }> = {
  all: { label: 'すべて', includes: () => true },
  unanswered: { label: '未回答だけ', includes: (m) => m === 'unanswered' },
  review: { label: '苦手 + あいまい', includes: (m) => m === 'weak' || m === 'shaky' },
  weak: { label: '苦手だけ', includes: (m) => m === 'weak' },
  shaky: { label: 'あいまいだけ', includes: (m) => m === 'shaky' },
};

export const ORDERS: Record<StudyOrder, string> = {
  random: 'ランダム',
  sequential: '番号順',
};

interface StudySession {
  queue: string[];
  /** 演習から始めた並びなら、その演習の ID */
  drillId?: string;
}

const key = (category: string, exam: string) => `study:${category}/${exam}`;

function isStudySession(value: unknown): value is StudySession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as StudySession;
  return (
    Array.isArray(v.queue) &&
    v.queue.every((id) => typeof id === 'string') &&
    (v.drillId === undefined || typeof v.drillId === 'string')
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

/** 並びを始める。drillId を渡すと、その演習の続きとしてサーバーに位置を残す */
export function startSession(category: string, exam: string, queue: string[], drillId?: string) {
  try {
    sessionStorage.setItem(key(category, exam), JSON.stringify({ queue, drillId } satisfies StudySession));
  } catch {
    // 保存できなくても問題は開ける。「次の問題へ」の代わりに一覧へ戻るボタンが出る
  }
}

/**
 * 演習の中で問題を開いた（answered=false）・答えた（answered=true）ときに、サーバーへ送る続きの位置。
 * 開いたらその問題、答えたらその次の問題から再開する。最後の問題に答えたら current は null（続きを消す）。
 * 演習の並びの外なら null（送らない）
 */
export function drillProgress(category: string, exam: string, id: string, answered: boolean): UpdateDrillRequest | null {
  const session = read(category, exam);
  const index = session?.queue.indexOf(id) ?? -1;
  if (!session?.drillId || index < 0) return null;
  return { id: session.drillId, current: answered ? (session.queue[index + 1] ?? null) : id };
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
