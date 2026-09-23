/** 選択肢の表示ラベル（画面の並び順で A, B, C ...） */
export const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 0..n-1 をランダムに並べた配列（Fisher–Yates） */
export function shuffledOrder(n: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** 原本の index → 画面のラベル */
export function labelOf(displayOrder: readonly number[], original: number): string {
  return LABELS[displayOrder.indexOf(original)] ?? '?';
}

/**
 * 解説本文の「選択肢 3」「選択肢 1 と 4」を画面のラベルに置き換える。
 * 解説は原本の番号で書かれているため、選択肢をシャッフルするとそのままでは食い違う。
 */
export function relabel(text: string, displayOrder: readonly number[]): string {
  return text.replace(
    /選択肢\s*\d+(?:\s*(?:と|、|,|および|及び|や|・)\s*\d+)*/g,
    (ref) =>
      ref.replace(/\d+/g, (num) => {
        const n = Number(num);
        return n >= 1 && n <= displayOrder.length ? labelOf(displayOrder, n - 1) : num;
      }),
  );
}
