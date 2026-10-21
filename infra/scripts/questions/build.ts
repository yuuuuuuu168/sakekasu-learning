/**
 * content/ 配下の問題メモを JSON に変換して build/questions/ に出力する。
 *
 * content/ は非公開リポジトリ sakekasu-learning-content の clone で、このリポジトリには入っていない
 * （docs/question-data.md）。環境変数 QUESTIONS_CONTENT_DIR で別の場所を指せる。
 *
 *   content/<category>/category.json      分野のメタ情報（AWS, OCI, Terraform ...）
 *   content/<category>/<exam>/exam.json   資格のメタ情報
 *   content/<category>/<exam>/*.md        問題メモ（複数ファイル可）
 *   content/<category>/<exam>/diagrams/<問題番号>/<問題番号>_選択肢<番号>_<正解|不正解>.drawio.png
 *                                          選択肢ごとの図解（任意。draw.io のデータ入り PNG）
 *
 * 出力:
 *   build/questions/catalog.json
 *   build/questions/<category>/<exam>.json
 *   build/questions/<category>/<exam>/diagrams/<問題番号>/<選択肢番号>.png
 *
 * 出力は非公開の S3 バケットへ同期し、API Lambda と AI チャットだけが読む。
 * 使い方: npx tsx scripts/questions/build.ts [--check]
 *   --check  出力せずに形式チェックだけ行う（CI の PR チェック用）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG } from '../../../shared/ids';
import type { Catalog, CategorySummary, ExamFile } from '../../../shared/types';
import { parseQuestions } from './parse';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONTENT_DIR = resolve(ROOT, process.env.QUESTIONS_CONTENT_DIR ?? 'content');
const OUT_DIR = join(ROOT, 'build/questions');

interface CategoryMeta {
  name: string;
  description?: string;
  order?: number;
}
interface ExamMeta {
  name: string;
  code?: string;
  order?: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function subdirs(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort();
}

function assertSlug(name: string, path: string) {
  if (!SLUG.test(name)) {
    throw new Error(`${path}: ディレクトリ名は英小文字・数字・ハイフンにしてください（${name}）`);
  }
}

/** 図解のファイル名: <問題番号>_選択肢<番号>_<正解|不正解>.drawio.png */
const DIAGRAM_FILE = /^(.+)_選択肢(\d+)_(正解|不正解)\.drawio\.png$/;

/** DOP-2003 と DOP-10 のような番号を数値として並べる */
const collator = new Intl.Collator('ja', { numeric: true });

export function buildQuestions(contentDir = CONTENT_DIR) {
  const categories: CategorySummary[] = [];
  const exams: ExamFile[] = [];
  const diagrams: { category: string; exam: string; id: string; choice: number; source: string }[] = [];

  for (const category of subdirs(contentDir)) {
    const categoryDir = join(contentDir, category);
    assertSlug(category, categoryDir);
    const categoryMeta = readJson<CategoryMeta>(join(categoryDir, 'category.json'));
    const summary: CategorySummary = {
      category,
      name: categoryMeta.name,
      description: categoryMeta.description,
      order: categoryMeta.order ?? 100,
      exams: [],
    };

    for (const exam of subdirs(categoryDir)) {
      const examDir = join(categoryDir, exam);
      assertSlug(exam, examDir);
      const examMeta = readJson<ExamMeta>(join(examDir, 'exam.json'));
      const mdFiles = readdirSync(examDir).filter((f) => f.endsWith('.md')).sort();

      const questions = mdFiles.flatMap((file) =>
        parseQuestions(readFileSync(join(examDir, file), 'utf8'), `${category}/${exam}/${file}`),
      );
      const ids = new Set<string>();
      for (const q of questions) {
        if (ids.has(q.id)) throw new Error(`${category}/${exam}: 問題番号 ${q.id} が複数ファイルで重複しています`);
        ids.add(q.id);
      }
      questions.sort((a, b) => collator.compare(a.id, b.id));

      // 図解: diagrams/<問題番号>/<選択肢番号>.drawio.png（diagrams/src は図の設計ファイルなので対象外）
      const diagramDir = join(examDir, 'diagrams');
      for (const id of existsSync(diagramDir) ? subdirs(diagramDir).filter((d) => d !== 'src') : []) {
        const question = questions.find((q) => q.id === id);
        if (!question) throw new Error(`${category}/${exam}/diagrams/${id}: 問題番号 ${id} の問題がありません`);
        const choices: number[] = [];
        for (const file of readdirSync(join(diagramDir, id)).filter((f) => f.endsWith('.png'))) {
          const where = `${category}/${exam}/diagrams/${id}/${file}`;
          const m = DIAGRAM_FILE.exec(file);
          if (!m || m[1] !== id) {
            throw new Error(`${where}: ファイル名は ${id}_選択肢<番号>_<正解|不正解>.drawio.png にしてください`);
          }
          const n = Number(m[2]);
          if (n < 1 || n > question.choices.length) throw new Error(`${where}: 選択肢${n}はありません`);
          if (choices.includes(n - 1)) throw new Error(`${where}: 選択肢${n}の図解が重複しています`);
          // ファイル名の正解/不正解が問題メモと食い違っていたら止める（名前を見て判断できるようにするため）
          const actual = question.answers.includes(n - 1) ? '正解' : '不正解';
          if (m[3] !== actual) throw new Error(`${where}: 選択肢${n}は問題メモでは${actual}です`);
          choices.push(n - 1);
          diagrams.push({ category, exam, id, choice: n, source: join(diagramDir, id, file) });
        }
        if (choices.length > 0) question.diagramChoices = choices.sort((a, b) => a - b);
      }

      exams.push({ category, exam, name: examMeta.name, code: examMeta.code, questions });
      summary.exams.push({
        category,
        exam,
        name: examMeta.name,
        code: examMeta.code,
        order: examMeta.order ?? 100,
        questionCount: questions.length,
      });
    }
    summary.exams.sort((a, b) => a.order - b.order || a.exam.localeCompare(b.exam));
    categories.push(summary);
  }
  categories.sort((a, b) => a.order - b.order || a.category.localeCompare(b.category));

  const catalog: Catalog = { generatedAt: new Date().toISOString(), categories };
  return { catalog, exams, diagrams };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  // 問題データが無いまま出力すると、デプロイの同期（--delete）で非公開バケットの問題が消える。ここで止める
  if (!existsSync(CONTENT_DIR)) {
    throw new Error(`${CONTENT_DIR} がありません。問題データのリポジトリを clone してください（docs/question-data.md）`);
  }
  const { catalog, exams, diagrams } = buildQuestions();
  if (exams.length === 0) throw new Error(`${CONTENT_DIR} に資格が1つもありません`);

  for (const c of catalog.categories) {
    for (const e of c.exams) console.log(`${c.category}/${e.exam}: ${e.questionCount} 問`);
  }
  if (checkOnly) return;

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'catalog.json'), JSON.stringify(catalog));
  for (const e of exams) {
    mkdirSync(join(OUT_DIR, e.category), { recursive: true });
    writeFileSync(join(OUT_DIR, e.category, `${e.exam}.json`), JSON.stringify(e));
  }
  for (const d of diagrams) {
    const dir = join(OUT_DIR, d.category, d.exam, 'diagrams', d.id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(d.source, join(dir, `${d.choice}.png`));
  }
  if (diagrams.length > 0) console.log(`図解: ${diagrams.length} 件`);
  console.log(`出力先: ${OUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
