import { useCallback, useEffect, useState } from 'react';

interface Loaded<T> {
  /** どの key の読み込みの結果か */
  key: string;
  data?: T;
  error?: string;
}

/**
 * 画面を開いたときに API から 1 つ読み込む。読み込み中は data も error も undefined。
 *
 * - key は「何を読んでいるか」（URL のパラメータなど）。key が替わったら読み直し、前の key の応答は
 *   後から届いても捨てる。替わった直後の描画でも前の key の結果は返さない
 * - reload は同じ key で読み直す。読み直している間は今の data を出したままにする
 *   （エラーからの読み直しは、エラーを消して読み込み中に戻す）
 * - fetch は key が替わった（か reload した）ときの描画のものを使う
 */
export function useApiResource<T>(key: string, fetch: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch().then(
      (data) => {
        if (!cancelled) setLoaded({ key, data });
      },
      (err: Error) => {
        if (!cancelled) setLoaded({ key, error: err.message });
      },
    );
    return () => {
      cancelled = true;
    };
    // fetch は描画のたびに作り直される関数なので deps に入れない（key と attempt が読み直しの合図）
  }, [key, attempt]);

  const reload = useCallback(() => {
    setLoaded((prev) => (prev?.error ? null : prev));
    setAttempt((n) => n + 1);
  }, []);

  const current = loaded?.key === key ? loaded : undefined;
  return { data: current?.data, error: current?.error, reload };
}
