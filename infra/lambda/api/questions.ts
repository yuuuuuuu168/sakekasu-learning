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
