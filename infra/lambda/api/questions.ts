/**
 * 非公開バケットに置いた問題 JSON を読む。
 *
 * 問題は頻繁には変わらないため、実行環境ごとに短時間キャッシュする。
 * TTL を置くのは、問題を差し替えたときに古い実行環境が延々と旧版を返さないようにするため。
 */
import { GetObjectCommand, NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import type { Catalog, ExamFile } from '../../../shared/types';

const s3 = new S3Client({});
const BUCKET = process.env.QUESTIONS_BUCKET_NAME!;
const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { value: unknown; expiresAt: number }>();

async function getJson<T>(key: string): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T | null;

  let value: T | null;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    value = JSON.parse(await res.Body!.transformToString('utf-8')) as T;
  } catch (err) {
    if (!(err instanceof NoSuchKey)) throw err;
    value = null;
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function loadCatalog(): Promise<Catalog> {
  return (await getJson<Catalog>('catalog.json')) ?? { generatedAt: '', categories: [] };
}

export async function loadExam(category: string, exam: string): Promise<ExamFile | null> {
  return getJson<ExamFile>(`${category}/${exam}.json`);
}
