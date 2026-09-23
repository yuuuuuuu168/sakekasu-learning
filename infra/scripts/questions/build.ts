/**
 * content/ 配下の問題メモを JSON に変換して build/questions/ に出力する。
 *
 *   content/<category>/category.json      分野のメタ情報（AWS, OCI, Terraform ...）
 *   content/<category>/<exam>/exam.json   資格のメタ情報
 *   content/<category>/<exam>/*.md        問題メモ（複数ファイル可）
 *
 * 出力:
 *   build/questions/catalog.json
 *   build/questions/<category>/<exam>.json
 *
 * 出力は非公開の S3 バケットへ同期し、API Lambda と AI チャットだけが読む。
 * 使い方: npx tsx scripts/questions/build.ts [--check]
 *   --check  出力せずに形式チェックだけ行う（CI の PR チェック用）
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, CategorySummary, ExamFile } from '../../../shared/types';
import { parseQuestions } from './parse';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTENT_DIR = join(ROOT, 'content');
const OUT_DIR = join(ROOT, 'build/questions');

/** URL とS3 キーに使うため、ディレクトリ名は英小文字・数字・ハイフンに限る */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

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

/** DOP-2003 と DOP-10 のような番号を数値として並べる */
const collator = new Intl.Collator('ja', { numeric: true });

export function buildQuestions(contentDir = CONTENT_DIR) {
  const categories: CategorySummary[] = [];
  const exams: ExamFile[] = [];

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
  return { catalog, exams };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const { catalog, exams } = buildQuestions();

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
  console.log(`出力先: ${OUT_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
