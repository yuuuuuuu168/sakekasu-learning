import { X } from 'lucide-react';

export function DiagramZoomDialog({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="図解の拡大表示"
      onClick={onClose}
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-slate-900/80 p-2 sm:p-6"
    >
      <img src={src} alt="図解" className="max-h-full max-w-full rounded-lg bg-surface" />
      <button onClick={onClose} className="absolute right-4 top-4 rounded-full bg-surface/90 p-2 text-ink-2" aria-label="閉じる">
        <X className="size-5" />
      </button>
    </div>
  );
}
