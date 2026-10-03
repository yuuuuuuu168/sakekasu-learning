import { ArrowLeft, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { QuestionListResponse } from '../../../shared/types';
import { MasteryBar } from '../components/MasteryBar';
import { ErrorMessage, Loading } from '../components/Status';
import { api } from '../lib/api';
import { shuffledOrder } from '../lib/choices';
import { MASTERY_UI } from '../lib/mastery-ui';
import { FILTERS, startSession, type StudyFilter, type StudyOrder } from '../lib/study-session';

export function ExamPage() {
  const { category = '', exam = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<QuestionListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StudyFilter>('all');
  const [order, setOrder] = useState<StudyOrder>('random');

  const load = useCallback(() => {
    setError(null);
    api.questions(category, exam).then(setData, (err: Error) => setError(err.message));
  }, [category, exam]);
  useEffect(load, [load]);

  const targets = useMemo(
    () => data?.questions.filter((q) => FILTERS[filter].includes(q.mastery)).map((q) => q.id) ?? [],
    [data, filter],
  );

  if (error) return <ErrorMessage message={error} onRetry={load} />;
  if (!data) return <Loading />;

  const questionPath = (id: string) => `/exams/${category}/${exam}/q/${encodeURIComponent(id)}`;

  const start = () => {
    const queue = order === 'random' ? shuffledOrder(targets.length).map((i) => targets[i]) : targets;
    if (queue.length === 0) return;
    startSession(category, exam, queue);
    navigate(questionPath(queue[0]));
  };

  const openQuestion = (id: string) => {
    // 一覧から選んだときは、その問題から順番に解き進める
    const ids = data.questions.map((q) => q.id);
    startSession(category, exam, ids.slice(ids.indexOf(id)));
    navigate(questionPath(id));
  };

  const reset = async () => {
    if (!window.confirm(`${data.exam.name} の回答履歴をすべて消去します。よろしいですか？`)) return;
    try {
      await api.resetProgress(category, exam);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const option = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm ring-1 transition ${
      active ? 'bg-accent text-on-fill ring-accent' : 'bg-surface text-ink-2 ring-grid hover:bg-plane'
    }`;

  return (
    <div className="space-y-6">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        資格一覧
      </Link>

      <section className="space-y-4 rounded-2xl border border-grid bg-surface p-5 shadow-sm">
        <div>
          {data.exam.code && <p className="text-xs font-semibold tracking-wide text-accent">{data.exam.code}</p>}
          <h1 className="text-xl font-bold leading-snug">{data.exam.name}</h1>
          <p className="text-sm text-muted">全 {data.questions.length} 問</p>
        </div>
        <MasteryBar counts={data.mastery} total={data.questions.length} />
      </section>

      <section className="space-y-4 rounded-2xl border border-grid bg-surface p-5 shadow-sm">
        <h2 className="font-semibold">演習を始める</h2>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">出題する問題</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FILTERS) as StudyFilter[]).map((f) => (
              <button key={f} className={option(filter === f)} onClick={() => setFilter(f)}>
                {FILTERS[f].label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">出題順</p>
          <div className="flex flex-wrap gap-2">
            <button className={option(order === 'random')} onClick={() => setOrder('random')}>ランダム</button>
            <button className={option(order === 'sequential')} onClick={() => setOrder('sequential')}>番号順</button>
          </div>
        </div>
        <button
          onClick={start}
          disabled={targets.length === 0}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 font-semibold text-on-fill hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
        >
          <Play className="size-4" />
          {targets.length > 0 ? `${targets.length} 問を解く` : '該当する問題がありません'}
        </button>
      </section>

      <section className="space-y-3 rounded-2xl border border-grid bg-surface p-5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">問題マップ</h2>
          <button onClick={() => void reset()} className="flex items-center gap-1 text-xs text-muted hover:text-danger">
            <RotateCcw className="size-3.5" />
            履歴をリセット
          </button>
        </div>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
          {data.questions.map((q) => (
            <button
              key={q.id}
              onClick={() => openQuestion(q.id)}
              title={`問${q.number}：${MASTERY_UI[q.mastery].label}（回答 ${q.attempts} 回）`}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs ring-1 ring-grid hover:bg-plane"
            >
              <span className={`size-2.5 shrink-0 rounded-full ${MASTERY_UI[q.mastery].dot}`} />
              <span className="truncate tabular-nums">問{q.number}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
