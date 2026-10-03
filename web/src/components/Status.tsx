import { LoaderCircle, TriangleAlert } from 'lucide-react';

export function Loading() {
  return (
    <div className="flex justify-center py-20 text-muted">
      <LoaderCircle className="size-6 animate-spin" />
    </div>
  );
}

export function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-10 text-center text-danger">
      <TriangleAlert className="size-6" />
      <p className="text-sm">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="rounded-lg bg-surface px-3 py-1.5 text-sm ring-1 ring-danger/30 hover:bg-danger/15">
          再読み込み
        </button>
      )}
    </div>
  );
}
