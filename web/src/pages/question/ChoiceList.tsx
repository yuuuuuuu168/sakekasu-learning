import { Check, X } from 'lucide-react';
import { choiceState, type ChoiceState } from '../../lib/answer';
import { LABELS } from '../../lib/choices';

const STYLE: Record<ChoiceState, { card: string; badge: string }> = {
  idle: { card: 'ring-grid bg-surface hover:bg-plane', badge: 'bg-surface-2 text-ink-2' },
  picked: { card: 'ring-2 ring-accent bg-accent-weak', badge: 'bg-accent text-on-fill' },
  'correct-picked': { card: 'ring-2 ring-success bg-success/10', badge: 'bg-success text-on-fill' },
  'correct-missed': { card: 'ring-2 ring-success bg-surface', badge: 'bg-success text-on-fill' },
  'wrong-picked': { card: 'ring-2 ring-danger bg-danger/10', badge: 'bg-danger text-on-fill' },
};

function Badge({ state, label }: { state: ChoiceState; label: string }) {
  if (state === 'correct-picked' || state === 'correct-missed') return <Check className="size-4" />;
  if (state === 'wrong-picked') return <X className="size-4" />;
  return <>{label}</>;
}

export function ChoiceList({
  choices,
  displayOrder,
  selected,
  multi,
  answers,
  onToggle,
}: {
  choices: string[];
  displayOrder: number[];
  selected: number[];
  multi: boolean;
  /** 採点前は null */
  answers: number[] | null;
  onToggle: (original: number) => void;
}) {
  return (
    <div role={multi ? 'group' : 'radiogroup'} className="space-y-2.5">
      {displayOrder.map((original, pos) => {
        const state = choiceState(original, selected, answers);
        return (
          <button
            key={original}
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={selected.includes(original)}
            disabled={!!answers}
            onClick={() => onToggle(original)}
            className={`flex w-full items-start gap-3 rounded-xl p-4 text-left ring-1 transition disabled:cursor-default ${STYLE[state].card}`}
          >
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${STYLE[state].badge}`}
            >
              <Badge state={state} label={LABELS[pos]} />
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed">
              {answers && <span className="mr-1 font-semibold text-muted">{LABELS[pos]}.</span>}
              {choices[original]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
