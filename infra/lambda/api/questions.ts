/**
 * 非公開バケットに置いた問題 JSON を読む。
 *
 * 問題 JSON は資格1つで数 MB あり、取得と解析に数百 ms かかる。問題は頻繁には
 * 変わらないため、実行環境ごとにキャッシュし、TTL を過ぎたら手元の版をそのまま
 * 返しつつ裏で ETag つきの条件付き GET で確かめ直す（変わっていなければ本文を
 * 取り直さない）。TTL を置くのは、問題を差し替えたときに古い実行環境が延々と
 * 旧版を返さないようにするため。
 */
import { GetObjectCommand, NoSuchKey, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { Catalog, ExamFile } from '../../../shared/types';

const s3 = new S3Client({});
const BUCKET = process.env.QUESTIONS_BUCKET_NAME!;
const TTL_MS = 5 * 60 * 1000;

interface Entry {
  value: unknown;
  etag?: string;
  expiresAt: number;
  /** 確かめ直しの最中なら、その Promise（同じキーを重ねて取りに行かない） */
  refreshing?: Promise<Entry>;
}

const cache = new Map<string, Entry>();

async function fetchJson(key: string, prev?: Entry): Promise<Entry> {
  let entry: Entry;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key, IfNoneMatch: prev?.etag }),
    );
    entry = {
      value: JSON.parse(await res.Body!.transformToString('utf-8')),
      etag: res.ETag,
      expiresAt: Date.now() + TTL_MS,
    };
  } catch (err) {
    if (prev && err instanceof S3ServiceException && err.$metadata.httpStatusCode === 304) {
      entry = { value: prev.value, etag: prev.etag, expiresAt: Date.now() + TTL_MS };
    } else if (err instanceof NoSuchKey) {
      entry = { value: null, expiresAt: Date.now() + TTL_MS };
    } else {
      throw err;
    }
  }
  cache.set(key, entry);
  return entry;
}

async function getJson<T>(key: string): Promise<T | null> {
  const hit = cache.get(key);
  if (!hit) return (await fetchJson(key)).value as T | null;

  if (hit.expiresAt <= Date.now() && !hit.refreshing) {
    hit.refreshing = fetchJson(key, hit);
    // 失敗したら手元の版を使い続け、次の呼び出しでまた確かめる
    hit.refreshing.catch((err: unknown) => {
      console.error(`問題データの再取得に失敗しました（${key}）`, err);
      hit.refreshing = undefined;
    });
  }
  return hit.value as T | null;
}

export async function loadCatalog(): Promise<Catalog> {
  return (await getJson<Catalog>('catalog.json')) ?? { generatedAt: '', categories: [] };
}

export async function loadExam(category: string, exam: string): Promise<ExamFile | null> {
  return getJson<ExamFile>(`${category}/${exam}.json`);
}

/**
 * 選択肢の図解を data URL で返す（choice は 0 始まり、ファイル名は 1 始まり）。
 * 回答した人にだけ返すため、公開の配信には置かない
 */
export async function loadDiagram(
  category: string,
  exam: string,
  id: string,
  choice: number,
): Promise<string | undefined> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: `${category}/${exam}/diagrams/${id}/${choice + 1}.png` }),
    );
    const bytes = await res.Body!.transformToByteArray();
    return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  } catch (err) {
    if (err instanceof NoSuchKey) return undefined;
    throw err;
  }
}
