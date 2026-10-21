import { useState } from 'react';
import { api } from '../../lib/api';

/** 図解の data URL。読み込み中は null、失敗は 'error' */
export type DiagramState = string | null;

/**
 * 選択肢ごとの図解（原本の index がキー）。解説を開いたときに初めて読み込む
 * （1 問に数枚あるため、回答時にまとめて取らない）。
 * 問題ごとに作り直す QuestionView の中で使うので、前の問題の応答は外された画面に届いて捨てられる
 */
export function useDiagrams(category: string, exam: string, id: string, available: readonly number[]) {
  const [diagrams, setDiagrams] = useState<Record<number, DiagramState>>({});

  const load = (originals: readonly number[]) => {
    const targets = originals.filter((o) => available.includes(o) && !(o in diagrams));
    if (targets.length === 0) return;
    const put = (o: number, image: DiagramState) => setDiagrams((prev) => ({ ...prev, [o]: image }));
    setDiagrams((prev) => ({ ...prev, ...Object.fromEntries(targets.map((o) => [o, null])) }));
    for (const o of targets) {
      api.diagram(category, exam, id, o).then(
        (res) => put(o, res.image),
        () => put(o, 'error'),
      );
    }
  };

  return { diagrams, load };
}
