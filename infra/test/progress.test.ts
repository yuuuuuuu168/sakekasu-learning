import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send }) } };
});

process.env.PROGRESS_TABLE_NAME = 'progress';
const { recordAnswer, resetExamProgress, updateDrill } = await import('../lambda/api/progress');
const { HttpError } = await import('../lambda/api/http-error');

const conflict = () => new ConditionalCheckFailedException({ message: 'conflict', $metadata: {} });

beforeEach(() => {
  send.mockReset();
});

describe('recordAnswer', () => {
  it('初回は存在しないことを条件に書く', async () => {
    send.mockResolvedValue({});
    const item = await recordAnswer('u', 'aws', 'dop-c02', 'Q-1', true);
    expect(item).toMatchObject({ qkey: 'aws/dop-c02#Q-1', history: [true], attempts: 1 });
    const put = send.mock.calls.map(([c]) => c).find((c) => c instanceof PutCommand) as PutCommand;
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(qkey)');
    // 選んだ選択肢は残さない
    expect(Object.keys(put.input.Item!).sort()).toEqual(['attempts', 'history', 'lastAnsweredAt', 'qkey', 'userId']);
  });

  it('競合したら読み直して、新しい履歴に積む', async () => {
    let attempts = 1;
    let history = [false];
    let failNext = true;
    send.mockImplementation(async (cmd) => {
      if (cmd instanceof GetCommand) return { Item: { history, attempts } };
      if (cmd instanceof PutCommand) {
        if (failNext) {
          // 別のタブが先に書いた
          failNext = false;
          attempts = 2;
          history = [false, true];
          throw conflict();
        }
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    const item = await recordAnswer('u', 'aws', 'dop-c02', 'Q-1', true);
    expect(item).toMatchObject({ history: [false, true, true], attempts: 3 });
    const puts = send.mock.calls.map(([c]) => c).filter((c) => c instanceof PutCommand) as PutCommand[];
    expect(puts.at(-1)!.input.ExpressionAttributeValues).toEqual({ ':prev': 2 });
  });

  it('競合が続いたら 409 を投げる', async () => {
    send.mockImplementation(async (cmd) => {
      if (cmd instanceof GetCommand) return { Item: { history: [], attempts: 1 } };
      throw conflict();
    });
    const err = await recordAnswer('u', 'aws', 'dop-c02', 'Q-1', true).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(send.mock.calls.filter(([c]) => c instanceof PutCommand)).toHaveLength(3);
  });

  it('条件の失敗以外はそのまま投げる', async () => {
    send.mockImplementation(async (cmd) => {
      if (cmd instanceof GetCommand) return {};
      throw new Error('throttled');
    });
    await expect(recordAnswer('u', 'aws', 'dop-c02', 'Q-1', true)).rejects.toThrow('throttled');
  });
});

describe('resetExamProgress', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ qkey: `aws/dop-c02#Q-${i}` }));

  it('25 件ずつ消し、未処理の分は送り直す', async () => {
    let retried = false;
    send.mockImplementation(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: items(30) };
      if (cmd instanceof BatchWriteCommand) {
        const reqs = cmd.input.RequestItems!.progress;
        if (!retried && reqs.length === 25) {
          retried = true;
          return { UnprocessedItems: { progress: reqs.slice(0, 2) } };
        }
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    expect(await resetExamProgress('u', 'aws', 'dop-c02')).toBe(30);
    const sizes = send.mock.calls
      .map(([c]) => c)
      .filter((c) => c instanceof BatchWriteCommand)
      .map((c) => (c as BatchWriteCommand).input.RequestItems!.progress.length);
    expect(sizes).toEqual([25, 2, 5]);
  });

  it('送り直しても残るときは投げる', async () => {
    send.mockImplementation(async (cmd) => {
      if (cmd instanceof QueryCommand) return { Items: items(1) };
      return { UnprocessedItems: { progress: cmd.input.RequestItems.progress } };
    });
    await expect(resetExamProgress('u', 'aws', 'dop-c02')).rejects.toThrow('履歴の削除を完了できませんでした');
    expect(send.mock.calls.filter(([c]) => c instanceof BatchWriteCommand)).toHaveLength(5);
  });
});

describe('updateDrill', () => {
  it('同じ演習で、並びにある問題のときだけ書き換える', async () => {
    send.mockResolvedValue({});
    expect(await updateDrill('u', 'aws', 'dop-c02', 'd-1', 'Q-2')).toBe(true);
    const update = send.mock.calls[0][0] as UpdateCommand;
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.Key).toEqual({ userId: 'u', qkey: 'drill#aws/dop-c02' });
    expect(update.input.ConditionExpression).toBe('#id = :id AND contains(#queue, :current)');
    expect(update.input.ExpressionAttributeValues).toMatchObject({ ':id': 'd-1', ':current': 'Q-2' });
  });

  it('終えたら同じ演習のときだけ消す', async () => {
    send.mockResolvedValue({});
    expect(await updateDrill('u', 'aws', 'dop-c02', 'd-1', null)).toBe(true);
    const del = send.mock.calls[0][0] as DeleteCommand;
    expect(del).toBeInstanceOf(DeleteCommand);
    expect(del.input.ConditionExpression).toBe('#id = :id');
  });

  it('条件に合わなければ false、それ以外の失敗は投げる', async () => {
    send.mockRejectedValueOnce(conflict());
    expect(await updateDrill('u', 'aws', 'dop-c02', 'old', 'Q-2')).toBe(false);
    send.mockRejectedValueOnce(new Error('boom'));
    await expect(updateDrill('u', 'aws', 'dop-c02', 'd-1', 'Q-2')).rejects.toThrow('boom');
  });
});
