/**
 * 回答履歴（DynamoDB）の読み書き。
 *
 * テーブル: PK=userId（Cognito の sub）, SK=qkey（"<category>/<exam>#<questionId>"）
 * 1問1アイテムで、直近 HISTORY_LIMIT 件の正誤だけを持つ。
 *
 * 同じテーブルに、演習の続きも資格ごとに 1 アイテム置く（SK="drill#<category>/<exam>"）。
 * 回答履歴の SK（"<category>/<exam>#..."）とは前方一致しないので、履歴の集計やリセットには混ざらない。
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { HISTORY_LIMIT, masteryOf } from '../../../shared/mastery';
import type { Drill, QuestionProgress } from '../../../shared/types';
import { HttpError } from './http-error';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.PROGRESS_TABLE_NAME!;

interface ProgressItem {
  userId: string;
  qkey: string;
  history: boolean[];
  attempts: number;
  lastAnsweredAt?: string;
}

export const examPrefix = (category: string, exam: string) => `${category}/${exam}#`;
export const drillKey = (category: string, exam: string) => `drill#${category}/${exam}`;

export function toProgress(id: string, item?: Pick<ProgressItem, 'history' | 'attempts' | 'lastAnsweredAt'>): QuestionProgress {
  const history = item?.history ?? [];
  return {
    id,
    mastery: masteryOf(history),
    attempts: item?.attempts ?? 0,
    history,
    lastAnsweredAt: item?.lastAnsweredAt,
  };
}

async function queryAll(userId: string, prefix?: string): Promise<ProgressItem[]> {
  const items: ProgressItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: prefix
          ? 'userId = :u AND begins_with(qkey, :p)'
          : 'userId = :u',
        ExpressionAttributeValues: prefix ? { ':u': userId, ':p': prefix } : { ':u': userId },
        ProjectionExpression: 'qkey, history, attempts, lastAnsweredAt',
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as ProgressItem[]));
    startKey = res.LastEvaluatedKey;
  } while (startKey);
  return items;
}

/** ユーザーの全回答履歴（カタログの集計用） */
export function listAllProgress(userId: string) {
  return queryAll(userId);
}

/** 資格1つ分の回答履歴を questionId をキーにして返す */
export async function listExamProgress(userId: string, category: string, exam: string) {
  const prefix = examPrefix(category, exam);
  const items = await queryAll(userId, prefix);
  return new Map(items.map((item) => [item.qkey.slice(prefix.length), item]));
}

export async function getProgress(userId: string, category: string, exam: string, id: string) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { userId, qkey: `${examPrefix(category, exam)}${id}` } }),
  );
  return res.Item as ProgressItem | undefined;
}

/**
 * 回答を1件記録する。
 * 同じ問題への同時回答（別タブなど）で履歴を取りこぼさないよう、attempts を
 * 楽観ロックに使い、競合したら読み直してやり直す。
 * 選んだ選択肢は記録しない（採点にしか使わない）。前は lastSelected に残していたが、どこからも
 * 読まれていなかった。古いアイテムに残っている値は、次にその問題に回答したときの上書きで消える
 */
export async function recordAnswer(
  userId: string,
  category: string,
  exam: string,
  id: string,
  correct: boolean,
): Promise<ProgressItem> {
  const qkey = `${examPrefix(category, exam)}${id}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await getProgress(userId, category, exam, id);
    const next: ProgressItem = {
      userId,
      qkey,
      history: [...(current?.history ?? []), correct].slice(-HISTORY_LIMIT),
      attempts: (current?.attempts ?? 0) + 1,
      lastAnsweredAt: new Date().toISOString(),
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: next,
          ConditionExpression: current ? 'attempts = :prev' : 'attribute_not_exists(qkey)',
          ExpressionAttributeValues: current ? { ':prev': current.attempts } : undefined,
        }),
      );
      return next;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
  // 利用者が送り直せば済むので 409 にする（500 にすると 5xx のアラームが鳴る）
  throw new HttpError(409, '回答の記録が競合しました。もう一度送ってください');
}

/** 資格1つ分の回答履歴を消す（学習のやり直し用） */
export async function resetExamProgress(userId: string, category: string, exam: string) {
  const items = await queryAll(userId, examPrefix(category, exam));
  for (let i = 0; i < items.length; i += 25) {
    let requests: Record<string, unknown>[] | undefined = items.slice(i, i + 25).map((item) => ({
      DeleteRequest: { Key: { userId, qkey: item.qkey } },
    }));
    for (let retry = 0; requests && requests.length > 0 && retry < 5; retry++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: requests } }));
      requests = res.UnprocessedItems?.[TABLE] as Record<string, unknown>[] | undefined;
    }
    if (requests && requests.length > 0) throw new Error('履歴の削除を完了できませんでした');
  }
  return items.length;
}

/** 演習の続き。無ければ undefined */
export async function getDrill(userId: string, category: string, exam: string): Promise<Drill | undefined> {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { userId, qkey: drillKey(category, exam) } }),
  );
  if (!res.Item) return undefined;
  const { id, filter, order, queue, current } = res.Item as Drill;
  return { id, filter, order, queue, current };
}

/** 新しく演習を始める。前の演習の続きは上書きする */
export async function putDrill(userId: string, category: string, exam: string, drill: Drill) {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { userId, qkey: drillKey(category, exam), ...drill, updatedAt: new Date().toISOString() },
    }),
  );
}

/**
 * 演習の次に解く問題を書き換える（current が null なら続きを消す）。
 * 別の演習が始まっていた・current が並びに無いときは書かずに false を返す
 */
export async function updateDrill(
  userId: string,
  category: string,
  exam: string,
  id: string,
  current: string | null,
): Promise<boolean> {
  const Key = { userId, qkey: drillKey(category, exam) };
  try {
    if (current === null) {
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE,
          Key,
          ConditionExpression: '#id = :id',
          ExpressionAttributeNames: { '#id': 'id' },
          ExpressionAttributeValues: { ':id': id },
        }),
      );
    } else {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key,
          UpdateExpression: 'SET #current = :current, updatedAt = :now',
          ConditionExpression: '#id = :id AND contains(#queue, :current)',
          ExpressionAttributeNames: { '#id': 'id', '#current': 'current', '#queue': 'queue' },
          ExpressionAttributeValues: { ':id': id, ':current': current, ':now': new Date().toISOString() },
        }),
      );
    }
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}
