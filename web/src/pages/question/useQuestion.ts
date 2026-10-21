import { useCallback, useEffect, useState } from 'react';
import type { QuestionDetailResponse } from '../../../../shared/types';
import { api } from '../../lib/api';

interface Loaded {
  /** どの問題・何回目の読み込みの結果か */
  key: string;
  question?: QuestionDetailResponse;
  error?: string;
}

/**
 * 問題本文を読み込む。「次の問題へ」で同じ画面のまま問題が替わるので、
 * 前の問題の応答が後から届いても捨てる。key は問題と読み込み直しの回数ごとに変わり、
 * 問題ごとの画面（QuestionView）の key に使う
 */
export function useQuestion(category: string, exam: string, id: string) {
  const [attempt, setAttempt] = useState(0);
  const key = `${category}/${exam}/${id}#${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.question(category, exam, id).then(
      (question) => {
        if (!cancelled) setLoaded({ key, question });
      },
      (err: Error) => {
        if (!cancelled) setLoaded({ key, error: err.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [category, exam, id, key]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  // 問題が替わった直後の描画では、まだ前の問題の結果が残っているので出さない
  const current = loaded?.key === key ? loaded : undefined;
  return { key, question: current?.question, error: current?.error, reload };
}
