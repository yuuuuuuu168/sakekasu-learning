import { LoaderCircle, TriangleAlert } from 'lucide-react';

export function Loading() {
  return (
    <div className="flex justify-center py-20 text-slate-400">
      <LoaderCircle className="size-6 animate-spin" />
    </div>
  );
}

export function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-10 text-center text-rose-700">
      <TriangleAlert className="size-6" />
      <p className="text-sm">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="rounded-lg bg-white px-3 py-1.5 text-sm ring-1 ring-rose-200 hover:bg-rose-100">
          再読み込み
        </button>
      )}
    </div>
  );
}
