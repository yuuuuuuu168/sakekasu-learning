/**
 * 回答履歴（DynamoDB）を、旧ユーザープールの sub から共通ログインの sub へコピーする。
 *
 * ログインを共通ログインに移すと、同じ人でも sub が変わる。API は sub をキーに回答履歴を読むので、
 * 旧 sub の項目を新 sub のキーに写す。旧 sub の項目は消さない（切り戻しに使える）。
 *
 * - 既定は dry-run。件数と例を表示するだけで、何も書かない
 * - --apply で書き込む。新 sub に同じ問題の項目が既にあれば上書きしない（条件付きの Put）
 * - 何度流しても結果は変わらない（2 回目以降は全部「既にある」になる）
 *
 * 管理者の権限で手元（Mac）から流す。手順は docs/shared-login.md。
 *   AWS_PROFILE=sakekasu-builder npx tsx scripts/migrate-progress/migrate.ts \
 *     --table dev-sakekasu-learning-progress --old-sub <旧 sub> --new-sub <新 sub>
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PARTITION_KEY, PUT_CONDITION, SORT_KEY, USAGE, parseArgs, planCopy } from './keys';

type Item = Record<string, unknown>;

/** 表示する例の件数 */
const SAMPLE_SIZE = 5;

async function queryAll(ddb: DynamoDBDocumentClient, table: string, userId: string): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: '#pk = :u',
        ExpressionAttributeNames: { '#pk': PARTITION_KEY },
        ExpressionAttributeValues: { ':u': userId },
        // 写すときに属性を落とさないよう、強い整合性で全部の属性を読む
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

function describe(item: Item): string {
  const { history, attempts, lastAnsweredAt } = item as {
    history?: unknown;
    attempts?: unknown;
    lastAnsweredAt?: unknown;
  };
  return `${String(item[SORT_KEY])}  attempts=${String(attempts)} history=${JSON.stringify(history)} last=${String(lastAnsweredAt ?? '-')}`;
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    process.exit(2);
  }
  const { table, oldSub, newSub, region, apply } = options;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  console.log(`テーブル: ${table}（${region}）`);
  console.log(`旧 sub:   ${oldSub}`);
  console.log(`新 sub:   ${newSub}`);
  console.log(apply ? 'モード:   --apply（書き込む）' : 'モード:   dry-run（書き込まない）');

  const [oldItems, newItems] = await Promise.all([
    queryAll(ddb, table, oldSub),
    queryAll(ddb, table, newSub),
  ]);
  const plan = planCopy(
    oldItems,
    newItems.map((item) => String(item[SORT_KEY])),
    oldSub,
    newSub,
  );

  console.log('');
  console.log(`旧 sub の項目:            ${oldItems.length} 件`);
  console.log(`新 sub に既にある項目:    ${newItems.length} 件`);
  console.log(`コピーする項目:           ${plan.toCopy.length} 件`);
  console.log(`新 sub に既にあるので飛ばす: ${plan.alreadyExists.length} 件`);
  if (oldItems.length === 0) {
    console.log('\n旧 sub の項目がありません。sub の取り違え（旧と新の逆など）が無いか確かめてください');
  }
  if (plan.toCopy.length > 0) {
    console.log(`\nコピーする項目の例（最大 ${SAMPLE_SIZE} 件）:`);
    for (const item of plan.toCopy.slice(0, SAMPLE_SIZE)) console.log(`  ${describe(item)}`);
  }
  if (plan.alreadyExists.length > 0) {
    console.log(`\n飛ばす項目の例（最大 ${SAMPLE_SIZE} 件。新 sub 側の結果を残す）:`);
    for (const item of plan.alreadyExists.slice(0, SAMPLE_SIZE)) console.log(`  ${describe(item)}`);
  }

  if (!apply) {
    console.log('\ndry-run のため書き込んでいません。内容がよければ --apply を付けて流してください');
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const item of plan.toCopy) {
    try {
      await ddb.send(
        new PutCommand({ TableName: table, Item: item, ConditionExpression: PUT_CONDITION }),
      );
      written++;
    } catch (err) {
      // 数えた後に画面から回答された問題。新しい方を残す
      if (err instanceof ConditionalCheckFailedException) {
        skipped++;
        continue;
      }
      console.error(`${String(item[SORT_KEY])} の書き込みに失敗しました（書けた分はそのまま。もう一度流せば続きから入る）`);
      throw err;
    }
  }
  console.log(`\n書き込み: ${written} 件、既にあったので飛ばした: ${plan.alreadyExists.length + skipped} 件`);
  console.log('旧 sub の項目は消していません');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
