import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// S3 の代わり。キーごとに本文と ETag を持ち、If-None-Match が一致すれば 304 を返す
const objects = new Map<string, { body: string; etag: string }>();
const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class S3ServiceException extends Error {
    constructor(readonly $metadata: { httpStatusCode: number }) {
      super('s3 error');
    }
  }
  class NoSuchKey extends S3ServiceException {}
  class GetObjectCommand {
    constructor(readonly input: { Key: string; IfNoneMatch?: string }) {}
  }
  class S3Client {
    send(cmd: GetObjectCommand) {
      return send(cmd);
    }
  }
  send.mockImplementation(async (cmd: GetObjectCommand) => {
    const obj = objects.get(cmd.input.Key);
    if (!obj) throw new NoSuchKey({ httpStatusCode: 404 });
    if (cmd.input.IfNoneMatch === obj.etag) throw new S3ServiceException({ httpStatusCode: 304 });
    return { ETag: obj.etag, Body: { transformToString: async () => obj.body } };
  });
  return { GetObjectCommand, NoSuchKey, S3Client, S3ServiceException };
});

const { loadExam } = await import('../lambda/api/questions');

const put = (key: string, name: string, etag: string) =>
  objects.set(key, { body: JSON.stringify({ name, questions: [] }), etag });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('問題データのキャッシュ', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    send.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('TTL 内は S3 を読まない', async () => {
    put('c/ttl.json', 'v1', '"1"');
    expect((await loadExam('c', 'ttl'))?.name).toBe('v1');
    expect((await loadExam('c', 'ttl'))?.name).toBe('v1');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('TTL 切れでは手元の版をすぐ返し、裏で取り直した版を次から返す', async () => {
    put('c/swr.json', 'v1', '"1"');
    await loadExam('c', 'swr');
    put('c/swr.json', 'v2', '"2"');
    vi.advanceTimersByTime(6 * 60 * 1000);

    expect((await loadExam('c', 'swr'))?.name).toBe('v1');
    await flush();
    expect((await loadExam('c', 'swr'))?.name).toBe('v2');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('変わっていなければ 304 で済ませ、手元の版を使い続ける', async () => {
    put('c/same.json', 'v1', '"1"');
    await loadExam('c', 'same');
    vi.advanceTimersByTime(6 * 60 * 1000);

    await loadExam('c', 'same');
    await flush();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ IfNoneMatch: '"1"' }) }),
    );
    expect((await loadExam('c', 'same'))?.name).toBe('v1');
    // 304 で TTL が延びたので、続けて呼んでも取りに行かない
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('取り直しに失敗しても手元の版を返し、次の呼び出しでまた確かめる', async () => {
    put('c/fail.json', 'v1', '"1"');
    await loadExam('c', 'fail');
    vi.advanceTimersByTime(6 * 60 * 1000);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    send.mockRejectedValueOnce(new Error('network'));

    expect((await loadExam('c', 'fail'))?.name).toBe('v1');
    await flush();
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    put('c/fail.json', 'v2', '"2"');
    await loadExam('c', 'fail');
    await flush();
    expect((await loadExam('c', 'fail'))?.name).toBe('v2');
  });

  it('無い資格は null', async () => {
    expect(await loadExam('c', 'missing')).toBeNull();
  });
});
