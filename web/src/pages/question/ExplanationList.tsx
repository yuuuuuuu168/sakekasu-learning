import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { AnswerResponse } from '../../../../shared/types';
import { Markdown } from '../../components/Markdown';
import { LABELS, relabel } from '../../lib/choices';
import type { DiagramState } from './useDiagrams';

export function ExplanationList({
  result,
  displayOrder,
  selected,
  diagrams,
  loadDiagrams,
  onZoom,
}: {
  result: AnswerResponse;
  displayOrder: number[];
  selected: number[];
  diagrams: Record<number, DiagramState>;
  loadDiagrams: (originals: readonly number[]) => void;
  onZoom: (src: string) => void;
}) {
  /** 開いている解説（原本の index）。最初はすべて閉じておく */
  const [open, setOpen] = useState<Set<number>>(new Set());
  const allOpen = open.size === displayOrder.length;

  const toggle = (original: number) => {
    if (!open.has(original)) loadDiagrams([original]);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(original)) next.delete(original);
      else next.add(original);
      return next;
    });
  };

  const toggleAll = () => {
    if (!allOpen) loadDiagrams(displayOrder);
    setOpen(allOpen ? new Set() : new Set(displayOrder));
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="font-semibold">解説</h2>
        <button onClick={toggleAll} className="text-sm text-accent hover:underline">
          {allOpen ? 'すべて閉じる' : 'すべて開く'}
        </button>
      </div>
      {displayOrder.map((original, pos) => {
        const correct = result.answers.includes(original);
        const isOpen = open.has(original);
        return (
          <div key={original} className="rounded-2xl border border-grid bg-surface shadow-sm">
            <button
              onClick={() => toggle(original)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-2 p-4 text-left"
            >
              <span className={`rounded-md px-2 py-0.5 text-xs font-semibold text-on-fill ${correct ? 'bg-success' : 'bg-muted'}`}>
                {correct ? '正解' : '不正解'}
              </span>
              <span className="font-semibold">選択肢 {LABELS[pos]}</span>
              {selected.includes(original) && <span className="text-xs text-muted">（あなたの回答）</span>}
              <ChevronDown className={`ml-auto size-5 shrink-0 text-muted transition ${isOpen ? 'rotate-180' : ''}`} />
            </button>
            {isOpen && (
              <div className="space-y-3 border-t border-grid p-4">
                {original in diagrams && (
                  <DiagramImage src={diagrams[original]} alt={`選択肢 ${LABELS[pos]} の図解`} onZoom={onZoom} />
                )}
                <Markdown className="prose-sm">{relabel(result.explanations[original], displayOrder)}</Markdown>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function DiagramImage({ src, alt, onZoom }: { src: DiagramState; alt: string; onZoom: (src: string) => void }) {
  if (src === null) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg bg-plane text-muted">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  if (src === 'error') {
    return <p className="rounded-lg bg-plane px-3 py-2 text-xs text-muted">図解を読み込めませんでした</p>;
  }
  return (
    <button onClick={() => onZoom(src)} className="block w-full cursor-zoom-in" aria-label={`${alt}を拡大表示`}>
      <img src={src} alt={alt} className="w-full rounded-lg ring-1 ring-grid" />
    </button>
  );
}
