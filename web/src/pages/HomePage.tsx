import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import type { CatalogResponse } from '../../../shared/types';
import { MasteryBar } from '../components/MasteryBar';
import { ErrorMessage, Loading } from '../components/Status';
import { api } from '../lib/api';
import { savedDrill } from '../lib/study-session';
import { useApiResource } from '../lib/useApiResource';

export function HomePage() {
  const { data, error, reload } = useApiResource<CatalogResponse>('catalog', () => api.catalog());

  if (error) return <ErrorMessage message={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (data.categories.length === 0) {
    return <p className="py-20 text-center text-muted">まだ問題が登録されていません</p>;
  }

  return (
    <div className="space-y-10">
      {data.categories.map((category) => (
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
                  className="group flex flex-col gap-4 rounded-2xl border border-grid bg-surface p-5 shadow-sm transition hover:border-accent/50 hover:shadow"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {exam.code && (
                        <p className="text-xs font-semibold tracking-wide text-accent">{exam.code}</p>
                      )}
                      <h3 className="font-semibold leading-snug">{exam.name}</h3>
                    </div>
                    <ChevronRight className="size-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-accent" />
                  </div>
                  <div className="space-y-2">
                    {savedDrill(exam.category, exam.exam) && (
                      <p className="text-xs font-semibold text-accent">途中の演習があります</p>
                    )}
                    <p className="text-xs text-muted">
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
    </div>
  );
}
