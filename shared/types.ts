/**
 * web / API Lambda / 問題ビルドスクリプトで共有する型。
 * API の入出力を変えるときはここを直し、両側の型チェックで追従漏れを検出する。
 */

import type { DrillFilter, DrillOrder } from './drill';
import type { Mastery } from './mastery';

/** 問題ビルドが出力する1問分（非公開バケットにだけ置く。正解と解説を含む） */
export interface QuestionRecord {
  /** 管理用の問題番号（原本の見出し。例: DOP-2154）。URL と回答履歴のキーに使い、画面には出さない */
  id: string;
  /** 問題文（Markdown） */
  question: string;
  /** 選択肢（原本の番号順。index 0 が「選択肢1」） */
  choices: string[];
  /** 正解の選択肢 index（0 始まり、昇順） */
  answers: number[];
  /** 選択肢ごとの解説（choices と同じ並び） */
  explanations: string[];
  /** 図解がある選択肢の index（0 始まり）。図は <category>/<exam>/diagrams/<id>/<選択肢番号>.png */
  diagramChoices?: number[];
}

/** 問題ビルドが出力する資格1つ分のファイル（questions/<category>/<exam>.json） */
export interface ExamFile {
  category: string;
  exam: string;
  name: string;
  code?: string;
  questions: QuestionRecord[];
}

export interface ExamSummary {
  category: string;
  exam: string;
  name: string;
  code?: string;
  order: number;
  questionCount: number;
}

export interface CategorySummary {
  category: string;
  name: string;
  description?: string;
  order: number;
  exams: ExamSummary[];
}

/** 問題ビルドが出力するカタログ（questions/catalog.json） */
export interface Catalog {
  generatedAt: string;
  categories: CategorySummary[];
}

export type MasteryCounts = Record<Mastery, number>;

// ---- API レスポンス ----

/** GET /catalog */
export interface CatalogResponse {
  categories: (Omit<CategorySummary, 'exams'> & {
    exams: (ExamSummary & {
      mastery: MasteryCounts;
      /** 続きから再開できる演習があるか */
      drill: boolean;
    })[];
  })[];
}

export interface QuestionProgress {
  id: string;
  mastery: Mastery;
  attempts: number;
  /** 直近の正誤（古い順、最大 HISTORY_LIMIT 件） */
  history: boolean[];
  lastAnsweredAt?: string;
}

/**
 * 画面に出す問題番号（資格ごとの 1 始まりの通し番号）。
 * 管理用の番号（id）の並び順で振るため、途中に問題を足すと以降の番号はずれる。
 * 回答履歴は id で持つので、番号がずれても記録は失われない。
 */
export type QuestionNumber = number;

/** GET /exams/{category}/{exam}/questions */
export interface QuestionListResponse {
  exam: ExamSummary;
  mastery: MasteryCounts;
  questions: (QuestionProgress & { number: QuestionNumber })[];
  /** 続きから再開できる演習。無ければ null */
  drill: Drill | null;
}

/**
 * 演習（「演習を始める」から始めた問題の並び）の続き。資格ごとに 1 つだけ持つ。
 * 問題一覧の応答では、削除された問題を queue から外し、current も残っている問題に合わせて返す
 */
export interface Drill {
  /** 演習を見分ける ID。新しく始めると替わり、古い演習の画面からの更新を弾く */
  id: string;
  filter: DrillFilter;
  order: DrillOrder;
  /** 出題する問題 ID の並び */
  queue: string[];
  /** 次に解く問題 ID（開いたが答えていない問題、または最後に答えた問題の次） */
  current: string;
}

/** PUT /exams/{category}/{exam}/drill のリクエスト（新しく演習を始める。前の演習の続きは消える） */
export interface StartDrillRequest {
  filter: DrillFilter;
  order: DrillOrder;
  queue: string[];
}

/** PUT /exams/{category}/{exam}/drill のレスポンス */
export type StartDrillResponse = Drill;

/** PATCH /exams/{category}/{exam}/drill のリクエスト（どこまで進んだかを残す） */
export interface UpdateDrillRequest {
  /** 更新する演習の ID。別の演習が始まっていたら更新しない */
  id: string;
  /** 次に解く問題 ID。null なら演習を終えたので続きを消す */
  current: string | null;
}

/** PATCH /exams/{category}/{exam}/drill のレスポンス */
export interface UpdateDrillResponse {
  /** 更新したか。別の演習が始まっていた・current が並びに無いときは false */
  updated: boolean;
}

/** GET /exams/{category}/{exam}/questions/{id}（正解・解説は含まない） */
export interface QuestionDetailResponse {
  id: string;
  number: QuestionNumber;
  /** 資格の問題数 */
  total: number;
  question: string;
  choices: string[];
  /** 選ぶべき選択肢の数 */
  selectCount: number;
  progress: QuestionProgress;
}

/** POST /exams/{category}/{exam}/questions/{id}/answer のリクエスト */
export interface AnswerRequest {
  /** 選んだ選択肢（原本の index、0 始まり） */
  selected: number[];
}

/** POST /exams/{category}/{exam}/questions/{id}/answer のレスポンス */
export interface AnswerResponse {
  correct: boolean;
  answers: number[];
  explanations: string[];
  /** 図解がある選択肢の index（0 始まり）。図は GET .../diagrams/{choice} で取得する */
  diagramChoices: number[];
  progress: QuestionProgress;
}

/** GET /exams/{category}/{exam}/questions/{id}/diagrams/{choice} */
export interface DiagramResponse {
  /** PNG の data URL */
  image: string;
}

/** DELETE /exams/{category}/{exam}/progress */
export interface ResetProgressResponse {
  /** 消した問題の数 */
  deleted: number;
}

/** API が 4xx / 5xx で返す本文 */
export interface ApiErrorResponse {
  message: string;
}

/** AI チャットの1発言 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** AgentCore Runtime に送るペイロード */
export interface ChatPayload {
  category: string;
  exam: string;
  questionId: string;
  /** 画面での表示順（原本の index の並び）。A, B, C... の対応づけに使う */
  displayOrder: number[];
  /** 人間様が選んだ選択肢（原本の index）。未回答なら空 */
  selected: number[];
  /** これまでの会話（今回の発言は含まない） */
  history: ChatMessage[];
  prompt: string;
}
