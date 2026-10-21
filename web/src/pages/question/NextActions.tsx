import { ArrowRight, RotateCcw } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

/** 解き直しと次の問題へのボタン。解説の上と下の両方に置く（解説を読まずに進むときも、読み終えてからも押しやすいように） */
export function NextActions({
  examPath,
  next,
  inSession,
  onRetry,
}: {
  examPath: string;
  /** 並びの中の次の問題 ID。最後の問題や並びの外なら null */
  next: string | null;
  /** 一覧から始めた並びの中で解いているか */
  inSession: boolean;
  onRetry: () => void;
}) {
  const navigate = useNavigate();
  const primary =
    'flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 font-semibold text-on-fill hover:bg-accent-hover';
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <button
        onClick={onRetry}
        className="flex items-center justify-center gap-2 rounded-xl bg-surface px-4 py-3 font-semibold text-ink-2 ring-1 ring-grid hover:bg-plane"
      >
        <RotateCcw className="size-4" />
        もう一度解く
      </button>
      {next ? (
        <button onClick={() => navigate(`${examPath}/q/${encodeURIComponent(next)}`)} className={primary}>
          次の問題へ
          <ArrowRight className="size-4" />
        </button>
      ) : (
        <Link to={examPath} className={primary}>
          {inSession ? 'おつかれさまでした！一覧へ戻る' : '問題一覧へ'}
        </Link>
      )}
    </div>
  );
}
