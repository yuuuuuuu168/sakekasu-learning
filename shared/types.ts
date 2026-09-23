/**
 * web / API Lambda / 問題ビルドスクリプトで共有する型。
 * API の入出力を変えるときはここを直し、両側の型チェックで追従漏れを検出する。
 */

import type { Mastery } from './mastery';

/** 問題ビルドが出力する1問分（非公開バケットにだけ置く。正解と解説を含む） */
export interface QuestionRecord {
  id: string;
  /** 問題文（Markdown） */
  question: string;
  /** 選択肢（原本の番号順。index 0 が「選択肢1」） */
  choices: string[];
  /** 正解の選択肢 index（0 始まり、昇順） */
  answers: number[];
  /** 選択肢ごとの解説（choices と同じ並び） */
  explanations: string[];
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

/** GET /exams/{category}/{exam}/questions */
export interface QuestionListResponse {
  exam: ExamSummary;
  mastery: MasteryCounts;
  questions: QuestionProgress[];
}

/** GET /exams/{category}/{exam}/questions/{id}（正解・解説は含まない） */
export interface QuestionDetailResponse {
  id: string;
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
