import { MASTERIES, type Mastery } from '../../../shared/mastery';
import { MASTERY_UI } from '../lib/mastery-ui';

export function MasteryBar({ counts, total }: { counts: Record<Mastery, number>; total: number }) {
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-2">
        {MASTERIES.filter((m) => m !== 'unanswered').map((m) =>
          counts[m] > 0 ? (
            <div
              key={m}
              className={MASTERY_UI[m].bar}
              style={{ width: `${(counts[m] / Math.max(total, 1)) * 100}%` }}
              title={`${MASTERY_UI[m].label}: ${counts[m]}`}
            />
          ) : null,
        )}
      </div>
      <MasteryLegend counts={counts} />
    </div>
  );
}

export function MasteryLegend({ counts }: { counts: Record<Mastery, number> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {MASTERIES.map((m) => (
        <span key={m} className="flex items-center gap-1.5" title={MASTERY_UI[m].description}>
          <span className={`size-2.5 rounded-full ${MASTERY_UI[m].dot}`} />
          {MASTERY_UI[m].label}
          <span className="font-semibold tabular-nums text-ink">{counts[m]}</span>
        </span>
      ))}
    </div>
  );
}

export function MasteryChip({ mastery }: { mastery: Mastery }) {
  const ui = MASTERY_UI[mastery];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${ui.chip}`}>
      <span className={`size-1.5 rounded-full ${ui.dot}`} />
      {ui.label}
    </span>
  );
}
