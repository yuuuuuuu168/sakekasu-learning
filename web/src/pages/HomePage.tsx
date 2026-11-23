import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import type { CatalogResponse } from '../../../shared/types';
import { MasteryBar } from '../components/MasteryBar';
import { ErrorMessage, Loading } from '../components/Status';
import { api } from '../lib/api';
import { archivedDate, splitArchived } from '../lib/archive';
import { useApiResource } from '../lib/useApiResource';

export function HomePage() {
  const { data, error, reload } = useApiResource<CatalogResponse>('catalog', () => api.catalog());

  if (error) return <ErrorMessage message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (data.categories.length === 0) {
    return <p className="py-20 text-center text-muted">まだ問題が登録されていません</p>;
  }

  const { active, archived } = splitArchived(data.categories);

  return (
    <div className="space-y-10">
      {active.map((category) => (
        <section key={category.category} className="space-y-3">
          <div>
            <h2 className="text-lg font-bold">{category.name}</h2>
            {category.description && <p className="text-sm text-muted">{category.description}</p>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {category.exams.map((exam) => {
              const answered = exam.questionCount - exam.mastery.unanswered;
              return (
                <Link
                  key={exam.exam}
                  to={`/exams/${exam.category}/${exam.exam}`}
                  className="group flex flex-col gap-4 rounded-2xl border border-grid bg-surface p-5 shadow-sm transition-colors hover:border-accent/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {exam.code && (
                        <p className="text-xs text-muted">{exam.code}</p>
                      )}
                      <h3 className="font-semibold leading-snug">{exam.name}</h3>
                    </div>
                    <ChevronRight className="size-5 shrink-0 text-muted transition-colors group-hover:text-accent" />
                  </div>
                  <div className="space-y-2">
                    {exam.drill && (
                      <p className="text-xs font-semibold text-accent">途中の演習があります</p>
                    )}
                    <p className="text-xs tabular-nums text-muted">
                      回答済み <span className="font-semibold text-ink-2">{answered}</span> / {exam.questionCount} 問
                    </p>
                    <MasteryBar counts={exam.mastery} total={exam.questionCount} />
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      {archived.length > 0 && (
        <details className="group/archive space-y-3" open={active.length === 0}>
          <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-semibold text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform group-open/archive:rotate-90" />
            アーカイブ <span className="font-normal tabular-nums text-muted">{archived.length} 件</span>
          </summary>
          <ul className="divide-y divide-grid rounded-2xl border border-grid bg-surface">
            {archived.map((exam) => (
              <li key={`${exam.category}/${exam.exam}`}>
                <Link
                  to={`/exams/${exam.category}/${exam.exam}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-plane"
                >
                  <div className="min-w-0">
                    {exam.code && <p className="text-xs text-muted">{exam.code}</p>}
                    <p className="text-sm text-ink-2">{exam.name}</p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {archivedDate(exam.archivedAt!)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
