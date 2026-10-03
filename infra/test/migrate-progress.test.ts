import { describe, expect, it } from 'vitest';
import { PUT_CONDITION, parseArgs, planCopy, toNewItem } from '../scripts/migrate-progress/keys';

const OLD = '11111111-1111-1111-1111-111111111111';
const NEW = '22222222-2222-2222-2222-222222222222';
const base = ['--table', 'dev-sakekasu-learning-progress', '--old-sub', OLD, '--new-sub', NEW];

describe('parseArgs', () => {
  it('既定は dry-run で、リージョンは環境変数から取る', () => {
    expect(parseArgs(base, { AWS_REGION: 'us-west-2' })).toEqual({
      table: 'dev-sakekasu-learning-progress',
      oldSub: OLD,
      newSub: NEW,
      region: 'us-west-2',
      apply: false,
    });
    expect(parseArgs(base).region).toBe('ap-northeast-1');
  });

  it('--apply と --key=value の形を受け付け、sub は小文字にそろえる', () => {
    const opts = parseArgs([...base.slice(0, 4), `--new-sub=${NEW.toUpperCase()}`, '--region', 'ap-northeast-1', '--apply']);
    expect(opts.apply).toBe(true);
    expect(opts.newSub).toBe(NEW);
  });

  it('欠け・形の誤り・同じ sub・知らない引数は止める', () => {
    expect(() => parseArgs(base.slice(2))).toThrow('--table');
    expect(() => parseArgs(['--table', 't-1', '--old-sub', 'user@example.com', '--new-sub', NEW])).toThrow('--old-sub');
    expect(() => parseArgs(['--table', 't-1', '--old-sub', OLD])).toThrow('--new-sub');
    expect(() => parseArgs(['--table', 't-1', '--old-sub', OLD, '--new-sub', OLD])).toThrow('同じ');
    expect(() => parseArgs([...base, '--force'])).toThrow('知らない引数');
    expect(() => parseArgs(['--table', '--apply'])).toThrow('値がありません');
  });
});

describe('toNewItem', () => {
  const item = {
    userId: OLD,
    qkey: 'aws/dop-c02#DOP-2003',
    history: [true, false],
    attempts: 2,
    lastSelected: [1],
    lastAnsweredAt: '2026-10-01T00:00:00.000Z',
  };

  it('キーの userId だけを差し替え、ほかの属性はそのまま残す', () => {
    expect(toNewItem(item, OLD, NEW)).toEqual({ ...item, userId: NEW });
    // 元の項目は書き換えない
    expect(item.userId).toBe(OLD);
  });

  it('旧 sub 以外の項目や qkey の無い項目は止める', () => {
    expect(() => toNewItem({ ...item, userId: NEW }, OLD, NEW)).toThrow('旧 sub の項目ではありません');
    expect(() => toNewItem({ userId: OLD }, OLD, NEW)).toThrow('qkey');
  });
});

describe('planCopy', () => {
  const items = ['a/b#1', 'a/b#2', 'a/c#1'].map((qkey) => ({ userId: OLD, qkey, attempts: 1 }));

  it('新 sub に無い問題だけをコピーし、既にある問題は上書きしない', () => {
    const plan = planCopy(items, ['a/b#2'], OLD, NEW);
    expect(plan.toCopy.map((i) => i.qkey)).toEqual(['a/b#1', 'a/c#1']);
    expect(plan.alreadyExists.map((i) => i.qkey)).toEqual(['a/b#2']);
    expect(plan.toCopy.every((i) => i.userId === NEW)).toBe(true);
  });

  it('2 回目に流すと全部「既にある」になる（何度流しても同じ結果）', () => {
    const first = planCopy(items, [], OLD, NEW);
    const second = planCopy(items, first.toCopy.map((i) => i.qkey), OLD, NEW);
    expect(second.toCopy).toHaveLength(0);
    expect(second.alreadyExists).toHaveLength(3);
  });

  it('書き込みは新しいキーに項目が無いときだけ', () => {
    expect(PUT_CONDITION).toBe('attribute_not_exists(userId)');
  });
});
