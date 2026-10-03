/**
 * 回答履歴の付け替え（旧ユーザープールの sub → 共通ログインの sub）の純粋な部分。
 * DynamoDB を触る部分は migrate.ts にあり、ここは引数の解釈とキーの変換だけを持つ。
 *
 * 回答履歴テーブル（infra/lib/backend-stack.ts の ProgressTable）:
 *   PK = userId（Cognito の sub）, SK = qkey（"<category>/<exam>#<questionId>"）
 *   GSI / LSI は無い。sub が入っているのはキーの userId だけ（infra/lambda/api/progress.ts）
 */

/** Cognito の sub（UUID） */
const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** DynamoDB のテーブル名に使える文字 */
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

export const PARTITION_KEY = 'userId';
export const SORT_KEY = 'qkey';

export interface MigrateOptions {
  table: string;
  oldSub: string;
  newSub: string;
  region: string;
  /** false なら書き込まずに件数と例を表示するだけ（既定） */
  apply: boolean;
}

export const USAGE = `使い方（infra/ で実行）:
  npx tsx scripts/migrate-progress/migrate.ts --table <テーブル名> --old-sub <旧 sub> --new-sub <新 sub> [--region <リージョン>] [--apply]

  --table    回答履歴のテーブル（dev なら dev-sakekasu-learning-progress）
  --old-sub  旧ユーザープール（sakekasu-learning-dev-auth）でのユーザーの sub
  --new-sub  共通ログインのユーザープールでの同じ人の sub
  --region   既定は AWS_REGION、無ければ ap-northeast-1
  --apply    実際に書き込む。付けなければ件数と例を表示するだけ（dry-run）`;

/** コマンドラインの引数を解釈する。誤りは Error で返し、何も書かない */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): MigrateOptions {
  const values: Record<string, string> = {};
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    const match = /^--(table|old-sub|new-sub|region)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`知らない引数です: ${arg}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${match[1]} の値がありません`);
    values[match[1]] = value;
  }

  const table = values.table;
  const oldSub = values['old-sub']?.toLowerCase();
  const newSub = values['new-sub']?.toLowerCase();
  if (!table || !TABLE_NAME.test(table)) throw new Error('--table にテーブル名を指定してください');
  if (!oldSub || !SUB.test(oldSub)) throw new Error('--old-sub に旧ユーザープールの sub（UUID）を指定してください');
  if (!newSub || !SUB.test(newSub)) throw new Error('--new-sub に共通ログインの sub（UUID）を指定してください');
  if (oldSub === newSub) throw new Error('--old-sub と --new-sub が同じです');
  const region = values.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'ap-northeast-1';
  return { table, oldSub, newSub, region, apply };
}

/**
 * 旧 sub の項目を、新 sub の項目に写す。キーの userId だけを差し替え、ほかの属性はそのまま。
 * 旧 sub の項目でなければ（取り違え防止）Error にする
 */
export function toNewItem<T extends Record<string, unknown>>(item: T, oldSub: string, newSub: string): T {
  if (item[PARTITION_KEY] !== oldSub) {
    throw new Error(`旧 sub の項目ではありません: ${String(item[PARTITION_KEY])}`);
  }
  if (typeof item[SORT_KEY] !== 'string' || !item[SORT_KEY]) {
    throw new Error(`${SORT_KEY} の無い項目です`);
  }
  return { ...item, [PARTITION_KEY]: newSub };
}

export interface CopyPlan<T> {
  /** 新 sub に書き込む項目 */
  toCopy: T[];
  /** 新 sub に同じ qkey が既にあるので書かない項目（共通ログインで解き始めた問題など） */
  alreadyExists: T[];
}

/**
 * 写す項目と、新 sub に既にあるので飛ばす項目に分ける。
 * 既にある項目は上書きしない（新しいログインで解いた結果を優先し、何度流しても同じ結果にする）
 */
export function planCopy<T extends Record<string, unknown>>(
  oldItems: T[],
  existingNewQkeys: Iterable<string>,
  oldSub: string,
  newSub: string,
): CopyPlan<T> {
  const existing = new Set(existingNewQkeys);
  const plan: CopyPlan<T> = { toCopy: [], alreadyExists: [] };
  for (const item of oldItems) {
    const next = toNewItem(item, oldSub, newSub);
    if (existing.has(next[SORT_KEY] as string)) plan.alreadyExists.push(next);
    else plan.toCopy.push(next);
  }
  return plan;
}

/** 書き込みの条件。新しいキーにまだ項目が無いときだけ書く */
export const PUT_CONDITION = `attribute_not_exists(${PARTITION_KEY})`;
