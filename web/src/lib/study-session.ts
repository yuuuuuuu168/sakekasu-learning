/**
 * 「今回解く問題の並び」をタブ単位で覚えておく（sessionStorage）。
 * 問題画面の「次の問題へ」はこの並びをたどる。
 *
 * 「演習を始める」から始めた並び（演習）は、どこまで進んだかを localStorage にも残し、
 * 一覧やトップへ戻ったり、タブを閉じたりしても続きから再開できるようにする。
 * 問題マップから開いた並びは残さない（のぞいただけで演習の続きを消さないように）
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

export const ORDERS: Record<StudyOrder, string> = {
  random: 'ランダム',
  sequential: '番号順',
};

interface StudySession {
  queue: string[];
  /** 演習から始めた並びなら、その演習の ID */
  drillId?: string;
}

/** 演習の続き。current は次に解く問題（開いたが答えていない問題、または最後に答えた問題の次） */
export interface SavedDrill {
  id: string;
  filter: StudyFilter;
  order: StudyOrder;
  queue: string[];
  current: string;
}

const key = (category: string, exam: string) => `study:${category}/${exam}`;
const drillKey = (category: string, exam: string) => `study-drill:${category}/${exam}`;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string');

function isStudySession(value: unknown): value is StudySession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as StudySession;
  return isStringArray(v.queue) && (v.drillId === undefined || typeof v.drillId === 'string');
}

function isSavedDrill(value: unknown): value is SavedDrill {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as SavedDrill;
  return (
    typeof v.id === 'string' &&
    Object.hasOwn(FILTERS, v.filter) &&
    Object.hasOwn(ORDERS, v.order) &&
    isStringArray(v.queue) &&
    v.queue.includes(v.current)
  );
}

/** 保存した値。無い・読めない・形が違うときは null */
function load<T>(storage: () => Storage, k: string, guard: (v: unknown) => v is T): T | null {
  try {
    const raw = storage().getItem(k);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return guard(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function save(storage: () => Storage, k: string, value: unknown) {
  try {
    storage().setItem(k, JSON.stringify(value));
  } catch {
    // 保存できなくても問題は開ける。「次の問題へ」の代わりに一覧へ戻るボタンが出る
  }
}

function remove(storage: () => Storage, k: string) {
  try {
    storage().removeItem(k);
  } catch {
    // 消せなくても次に始めた演習で上書きされる
  }
}

// 触るだけで例外になるブラウザがあるので、使う時点で読む
const tab = () => sessionStorage;
const device = () => localStorage;

const read = (category: string, exam: string) => load(tab, key(category, exam), isStudySession);

/** 一覧から選んだ問題から順に解く並びを始める（続きは残さない） */
export function startSession(category: string, exam: string, queue: string[]) {
  save(tab, key(category, exam), { queue } satisfies StudySession);
}

/** 「演習を始める」から並びを始め、続きを残す */
export function startDrill(category: string, exam: string, queue: string[], filter: StudyFilter, order: StudyOrder) {
  if (queue.length === 0) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  save(tab, key(category, exam), { queue, drillId: id } satisfies StudySession);
  save(device, drillKey(category, exam), { id, filter, order, queue, current: queue[0] } satisfies SavedDrill);
}

/** 続きから再開できる演習。無ければ null */
export function savedDrill(category: string, exam: string): SavedDrill | null {
  return load(device, drillKey(category, exam), isSavedDrill);
}

/**
 * 残しておいた演習を、このタブの並びとして再開し、開く問題の ID を返す。
 * exists は今ある問題の ID。問題が削除されていたら並びから外し、
 * 次に解く問題が無くなっていたらその先の問題から始める。再開できないときは null
 */
export function resumeDrill(category: string, exam: string, exists: (id: string) => boolean): string | null {
  const drill = savedDrill(category, exam);
  if (!drill) return null;
  const rest = drill.queue.slice(drill.queue.indexOf(drill.current)).filter(exists);
  if (rest.length === 0) {
    remove(device, drillKey(category, exam));
    return null;
  }
  const queue = drill.queue.filter(exists);
  save(tab, key(category, exam), { queue, drillId: drill.id } satisfies StudySession);
  save(device, drillKey(category, exam), { ...drill, queue, current: rest[0] } satisfies SavedDrill);
  return rest[0];
}

/** このタブで解いている演習の続きを更新する。別のタブで新しい演習を始めていたら触らない */
function updateDrill(category: string, exam: string, id: string, update: (drill: SavedDrill) => SavedDrill | null) {
  const drillId = read(category, exam)?.drillId;
  const drill = savedDrill(category, exam);
  if (!drillId || !drill || drill.id !== drillId || !drill.queue.includes(id)) return;
  const next = update(drill);
  if (next) save(device, drillKey(category, exam), next);
  else remove(device, drillKey(category, exam));
}

/** 問題を開いた。再開するとこの問題から */
export function markOpened(category: string, exam: string, id: string) {
  updateDrill(category, exam, id, (drill) => ({ ...drill, current: id }));
}

/** 問題に答えた。再開するとこの次の問題から。最後の問題なら演習は終わりなので続きを消す */
export function markAnswered(category: string, exam: string, id: string) {
  updateDrill(category, exam, id, (drill) => {
    const next = drill.queue[drill.queue.indexOf(id) + 1];
    return next ? { ...drill, current: next } : null;
  });
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
