import { LayoutGrid } from 'lucide-react';
import { PORTAL_APPS_URL } from '../auth/oauth';

/**
 * ヘッダーの「アプリ一覧」。4 アプリの入口の一覧（ポータル）へ同じタブで移る。
 * 狭い幅ではアイコンだけにするので、読み上げ用に aria-label を付けておく
 */
export function AppsLink() {
  return (
    <a
      href={PORTAL_APPS_URL}
      aria-label="アプリ一覧"
      className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
    >
      <LayoutGrid className="size-4" />
      <span className="hidden sm:inline">アプリ一覧</span>
    </a>
  );
}
