import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QuestionFormatError, parseQuestions } from '../scripts/questions/parse';
import { buildQuestions } from '../scripts/questions/build';

const sample = `# Q-2
## 問題
正しいものを選択してください。（2 つ選択）

## 選択肢
1. 選択肢いち
2. 選択肢に
   続きの行
3. 選択肢さん

## 解説
### 【正解】選択肢1の解説
いちの解説。選択肢 3 と比べると…

### 【不正解】選択肢2の解説
にの解説

### 【正解】選択肢3の解説
さんの解説

# Q-1
## 問題
単一選択の問題

## 選択肢
1. A
2. B

## 解説
### 【不正解】選択肢1の解説
x

### 【正解】選択肢2の解説
y
`;

describe('parseQuestions', () => {
  it('問題文・選択肢・正解・解説を取り出す', () => {
    const [q2, q1] = parseQuestions(sample);
    expect(q2.id).toBe('Q-2');
    expect(q2.choices).toEqual(['選択肢いち', '選択肢に\n続きの行', '選択肢さん']);
    expect(q2.answers).toEqual([0, 2]);
    expect(q2.explanations[0]).toBe('いちの解説。選択肢 3 と比べると…');
    expect(q1.answers).toEqual([1]);
  });

  it('解説が欠けていたら失敗する', () => {
    const broken = sample.replace(/### 【不正解】選択肢2の解説\nにの解説\n/, '');
    expect(() => parseQuestions(broken)).toThrow(/選択肢2の解説がありません/);
  });

  it('「N つ選択」と正解数が食い違ったら失敗する', () => {
    const broken = sample.replace('（2 つ選択）', '（3 つ選択）');
    expect(() => parseQuestions(broken)).toThrow(QuestionFormatError);
  });

  it('複数正解なのに「つ選択」表記が無ければ失敗する', () => {
    const broken = sample.replace('（2 つ選択）', '');
    expect(() => parseQuestions(broken)).toThrow(/つ選択/);
  });

  it('問題番号の重複を検出する', () => {
    expect(() => parseQuestions(sample + '\n' + sample)).toThrow(/重複/);
  });
});

describe('buildQuestions（実データ）', () => {
  it('content/ 配下のすべての問題が形式チェックを通る', () => {
    const { catalog, exams } = buildQuestions();
    expect(catalog.categories.length).toBeGreaterThan(0);
    for (const e of exams) {
      for (const q of e.questions) {
        expect(q.explanations).toHaveLength(q.choices.length);
        expect(q.answers.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildQuestions（図解）', () => {
  function setup(diagramFile: string) {
    const dir = mkdtempSync(join(tmpdir(), 'content-'));
    mkdirSync(join(dir, 'aws/test-exam/diagrams/Q-1'), { recursive: true });
    writeFileSync(join(dir, 'aws/category.json'), '{"name":"AWS"}');
    writeFileSync(join(dir, 'aws/test-exam/exam.json'), '{"name":"Test"}');
    writeFileSync(join(dir, 'aws/test-exam/q.md'), sample.slice(sample.indexOf('# Q-1')));
    writeFileSync(join(dir, 'aws/test-exam/diagrams/Q-1', diagramFile), '');
    return dir;
  }

  it('ファイル名から図解のある選択肢を読み取る', () => {
    const { exams, diagrams } = buildQuestions(setup('Q-1_選択肢2_正解.drawio.png'));
    expect(exams[0].questions[0].diagramChoices).toEqual([1]);
    expect(diagrams).toHaveLength(1);
  });

  it('ファイル名の正解/不正解が問題メモと食い違ったら失敗する', () => {
    expect(() => buildQuestions(setup('Q-1_選択肢2_不正解.drawio.png'))).toThrow(/問題メモでは正解/);
  });

  it('形式の違うファイル名は失敗する', () => {
    expect(() => buildQuestions(setup('2.drawio.png'))).toThrow(/ファイル名は/);
  });
});
