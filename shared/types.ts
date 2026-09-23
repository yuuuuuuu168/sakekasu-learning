/**
 * web / API Lambda / 問題ビルドスクリプトで共有する型。
 * API の入出力を変えるときはここを直し、両側の型チェックで追従漏れを検出する。
 */

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
  /** 解説用の図解があるか（<category>/<exam>/diagrams/<id>.png に置く） */
  hasDiagram?: boolean;
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
    exams: (ExamSummary & { mastery: MasteryCounts })[];
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
  /** 解説用の図解（PNG の data URL）。図解が無い問題では省略 */
  diagram?: string;
  progress: QuestionProgress;
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
