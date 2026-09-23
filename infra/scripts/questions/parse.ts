/**
 * 問題メモ（content/FORMAT.md の形式）の Markdown を QuestionRecord に変換する。
 *
 * # <問題番号>
 * ## 問題
 * ## 選択肢
 * 1. ...
 * ## 解説
 * ### 【正解】選択肢1の解説
 * ### 【不正解】選択肢2の解説
 *
 * 形式が崩れた問題を黙って取り込むと、正解が無い・解説がずれるといった
 * 気づきにくい不具合になる。問題を見つけたら例外にしてビルドを止める。
 */
import type { QuestionRecord } from '../../../shared/types';

export class QuestionFormatError extends Error {}

const QUESTION_HEADING = /^# (?!#)(.+?)\s*$/;
const SECTION_HEADING = /^## (?!#)(.+?)\s*$/;
const EXPLANATION_HEADING = /^### 【(正解|不正解)】選択肢\s*(\d+)\s*の解説\s*$/;
const CHOICE_LINE = /^(\d+)\.\s+(.*)$/;
/** 問題文の「（2 つ選択）」表記。全角・半角の括弧と数字の揺れを許す */
const SELECT_COUNT = /[（(]\s*([0-9０-９]+)\s*つ選択\s*[）)]/;
/** 問題番号は URL のパスと DynamoDB のキーに載るため、使える文字を絞る */
export const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface RawQuestion {
  id: string;
  line: number;
  sections: Map<string, string[]>;
}

function splitQuestions(markdown: string): RawQuestion[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const questions: RawQuestion[] = [];
  let current: RawQuestion | null = null;
  let section: string | null = null;
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const q = inFence ? null : QUESTION_HEADING.exec(line);
    if (q) {
      current = { id: q[1], line: i + 1, sections: new Map() };
      questions.push(current);
      section = null;
      return;
    }
    const s = inFence ? null : SECTION_HEADING.exec(line);
    if (s && current) {
      section = s[1];
      if (current.sections.has(section)) {
        throw new QuestionFormatError(`${current.id}: 「## ${section}」が重複しています`);
      }
      current.sections.set(section, []);
      return;
    }
    if (current && section) current.sections.get(section)!.push(line);
  });
  return questions;
}

function trimBlock(lines: string[]): string {
  return lines.join('\n').trim();
}

function parseChoices(id: string, lines: string[]): string[] {
  const choices: string[] = [];
  for (const line of lines) {
    const m = CHOICE_LINE.exec(line);
    if (m) {
      const n = Number(m[1]);
      if (n !== choices.length + 1) {
        throw new QuestionFormatError(`${id}: 選択肢の番号が連番になっていません（${n}）`);
      }
      choices.push(m[2].trim());
    } else if (line.trim() && choices.length > 0) {
      // 折り返し行は直前の選択肢の続きとして扱う
      choices[choices.length - 1] += `\n${line.trim()}`;
    } else if (line.trim()) {
      throw new QuestionFormatError(`${id}: 選択肢の前に不明な行があります: ${line}`);
    }
  }
  return choices;
}

function parseExplanations(id: string, lines: string[], choiceCount: number) {
  const bodies = new Map<number, { correct: boolean; lines: string[] }>();
  let current: { correct: boolean; lines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      const m = EXPLANATION_HEADING.exec(line);
      if (!m) throw new QuestionFormatError(`${id}: 解説の見出しの形式が不正です: ${line}`);
      const n = Number(m[2]);
      if (n < 1 || n > choiceCount) {
        throw new QuestionFormatError(`${id}: 存在しない選択肢${n}の解説があります`);
      }
      if (bodies.has(n)) throw new QuestionFormatError(`${id}: 選択肢${n}の解説が重複しています`);
      current = { correct: m[1] === '正解', lines: [] };
      bodies.set(n, current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  const answers: number[] = [];
  const explanations: string[] = [];
  for (let n = 1; n <= choiceCount; n++) {
    const body = bodies.get(n);
    if (!body) throw new QuestionFormatError(`${id}: 選択肢${n}の解説がありません`);
    const text = trimBlock(body.lines);
    if (!text) throw new QuestionFormatError(`${id}: 選択肢${n}の解説が空です`);
    if (body.correct) answers.push(n - 1);
    explanations.push(text);
  }
  return { answers, explanations };
}

function toHalfWidthNumber(s: string): number {
  return Number(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
}

export function parseQuestions(markdown: string, source = 'markdown'): QuestionRecord[] {
  const raws = splitQuestions(markdown);
  const seen = new Set<string>();

  return raws.map((raw) => {
    const where = `${source}:${raw.line} ${raw.id}`;
    try {
      if (!QUESTION_ID.test(raw.id)) {
        throw new QuestionFormatError('問題番号は英数字と . _ - の64文字以内にしてください');
      }
      if (seen.has(raw.id)) throw new QuestionFormatError('問題番号が重複しています');
      seen.add(raw.id);

      const questionLines = raw.sections.get('問題');
      const choiceLines = raw.sections.get('選択肢');
      const explanationLines = raw.sections.get('解説');
      if (!questionLines || !choiceLines || !explanationLines) {
        throw new QuestionFormatError('「## 問題」「## 選択肢」「## 解説」のいずれかがありません');
      }

      const question = trimBlock(questionLines);
      if (!question) throw new QuestionFormatError('問題文が空です');

      const choices = parseChoices(raw.id, choiceLines);
      if (choices.length < 2) throw new QuestionFormatError('選択肢が2つ未満です');

      const { answers, explanations } = parseExplanations(raw.id, explanationLines, choices.length);
      if (answers.length === 0) throw new QuestionFormatError('正解の選択肢がありません');

      const declared = SELECT_COUNT.exec(question);
      if (declared && toHalfWidthNumber(declared[1]) !== answers.length) {
        throw new QuestionFormatError(
          `問題文は「${declared[1]} つ選択」ですが、正解の解説は ${answers.length} 件です`,
        );
      }
      if (!declared && answers.length > 1) {
        throw new QuestionFormatError(
          `正解が ${answers.length} 件ありますが、問題文に「（${answers.length} つ選択）」の表記がありません`,
        );
      }

      return { id: raw.id, question, choices, answers, explanations };
    } catch (err) {
      if (err instanceof QuestionFormatError) {
        throw new QuestionFormatError(`${where}: ${err.message}`);
      }
      throw err;
    }
  });
}
