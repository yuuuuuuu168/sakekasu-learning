import { ArrowLeft, ArrowRight, Check, ChevronDown, MessageCircle, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AnswerResponse, QuestionDetailResponse } from '../../../shared/types';
import { ChatPanel } from '../components/ChatPanel';
import { Markdown } from '../components/Markdown';
import { MasteryChip } from '../components/MasteryBar';
import { ErrorMessage, Loading } from '../components/Status';
import { api } from '../lib/api';
import { LABELS, relabel, shuffledOrder } from '../lib/choices';
import { nextInSession } from '../lib/study-session';

export function QuestionPage() {
  const { category = '', exam = '', id = '' } = useParams();
  const navigate = useNavigate();

  const [question, setQuestion] = useState<QuestionDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 画面の並び（原本の index）。問題を開くたび・解き直すたびに並べ替える */
  const [displayOrder, setDisplayOrder] = useState<number[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const load = useCallback(() => {
    setQuestion(null);
    setError(null);
    setResult(null);
    setSelected([]);
    setChatOpen(false);
    api.question(category, exam, id).then(
      (q) => {
        setQuestion(q);
        setDisplayOrder(shuffledOrder(q.choices.length));
      },
      (err: Error) => setError(err.message),
    );
  }, [category, exam, id]);
  useEffect(load, [load]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [id]);

  if (error) return <ErrorMessage message={error} onRetry={load} />;
  if (!question) return <Loading />;

  const multi = question.selectCount > 1;
  const session = nextInSession(category, exam, id, []);
  const examPath = `/exams/${category}/${exam}`;

  const toggle = (original: number) => {
    if (result) return;
    setSelected((prev) => {
      if (!multi) return [original];
      if (prev.includes(original)) return prev.filter((v) => v !== original);
      // 選べる数を超えたら、最初に選んだものを外す
      return [...prev, original].slice(-question.selectCount);
    });
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      setResult(await api.answer(category, exam, id, selected));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const retry = () => {
    setResult(null);
    setSelected([]);
    setDisplayOrder(shuffledOrder(question.choices.length));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const choiceState = (original: number) => {
    const picked = selected.includes(original);
    if (!result) return picked ? 'picked' : 'idle';
    const correct = result.answers.includes(original);
    if (correct) return picked ? 'correct-picked' : 'correct-missed';
    return picked ? 'wrong-picked' : 'idle';
  };

  const choiceClass: Record<string, string> = {
    idle: 'ring-slate-200 bg-white hover:bg-slate-50',
    picked: 'ring-2 ring-indigo-500 bg-indigo-50',
    'correct-picked': 'ring-2 ring-emerald-500 bg-emerald-50',
    'correct-missed': 'ring-2 ring-emerald-500 bg-white',
    'wrong-picked': 'ring-2 ring-rose-500 bg-rose-50',
  };

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center justify-between gap-2">
        <Link to={examPath} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-4" />
          問題一覧
        </Link>
        {session.position && (
          <span className="text-sm tabular-nums text-slate-500">
            {session.position} / {session.total}
          </span>
        )}
      </div>

      <article className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-500">
            問{question.number}
            <span className="font-normal text-slate-400"> / {question.total}</span>
          </span>
          <MasteryChip mastery={(result?.progress ?? question.progress).mastery} />
          {multi && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
              {question.selectCount} つ選択
            </span>
          )}
        </div>
        <Markdown>{question.question}</Markdown>
      </article>

      <div role={multi ? 'group' : 'radiogroup'} className="space-y-2.5">
        {displayOrder.map((original, pos) => {
          const state = choiceState(original);
          return (
            <button
              key={original}
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={selected.includes(original)}
              disabled={!!result}
              onClick={() => toggle(original)}
              className={`flex w-full items-start gap-3 rounded-xl p-4 text-left ring-1 transition disabled:cursor-default ${choiceClass[state]}`}
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                  state === 'idle' ? 'bg-slate-100 text-slate-600' : state === 'picked' ? 'bg-indigo-600 text-white'
                    : state.startsWith('correct') ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                }`}
              >
                {state.startsWith('correct') ? <Check className="size-4" /> : state === 'wrong-picked' ? <X className="size-4" /> : LABELS[pos]}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed">
                {result && <span className="mr-1 font-semibold text-slate-500">{LABELS[pos]}.</span>}
                {question.choices[original]}
              </span>
            </button>
          );
        })}
      </div>

      {!result ? (
        <button
          onClick={() => void submit()}
          disabled={selected.length !== question.selectCount || submitting}
          className="w-full rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? '採点中…' : multi ? `回答する（${selected.length} / ${question.selectCount}）` : '回答する'}
        </button>
      ) : (
        <>
          <div
            className={`flex items-center gap-3 rounded-2xl p-4 ${
              result.correct ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
            }`}
          >
            <span className={`flex size-9 items-center justify-center rounded-full text-white ${result.correct ? 'bg-emerald-600' : 'bg-rose-600'}`}>
              {result.correct ? <Check className="size-5" /> : <X className="size-5" />}
            </span>
            <div>
              <p className="font-bold">{result.correct ? '正解！' : '不正解'}</p>
              <p className="text-sm">
                正解は {result.answers.map((a) => LABELS[displayOrder.indexOf(a)]).sort().join(', ')}
              </p>
            </div>
          </div>

          <details className="group rounded-2xl border border-slate-200 bg-white shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 font-semibold [&::-webkit-details-marker]:hidden">
              解説を表示
              <ChevronDown className="size-5 text-slate-400 transition group-open:rotate-180" />
            </summary>
            <div className="space-y-5 border-t border-slate-100 p-4">
              {displayOrder.map((original, pos) => {
                const correct = result.answers.includes(original);
                return (
                  <section key={original} className="space-y-2">
                    <h3 className="flex items-center gap-2 font-semibold">
                      <span className={`rounded-md px-2 py-0.5 text-xs text-white ${correct ? 'bg-emerald-600' : 'bg-slate-400'}`}>
                        {correct ? '正解' : '不正解'}
                      </span>
                      選択肢 {LABELS[pos]}
                    </h3>
                    <Markdown className="prose-sm">{relabel(result.explanations[original], displayOrder)}</Markdown>
                  </section>
                );
              })}
            </div>
          </details>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              onClick={retry}
              className="flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              <RotateCcw className="size-4" />
              もう一度解く
            </button>
            {session.next ? (
              <button
                onClick={() => navigate(`${examPath}/q/${encodeURIComponent(session.next!)}`)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700"
              >
                次の問題へ
                <ArrowRight className="size-4" />
              </button>
            ) : (
              <Link
                to={examPath}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 font-semibold text-white hover:bg-indigo-700"
              >
                {session.position ? 'おつかれさまでした！一覧へ戻る' : '問題一覧へ'}
              </Link>
            )}
          </div>
        </>
      )}

      <button
        onClick={() => setChatOpen(true)}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-slate-800"
      >
        <MessageCircle className="size-5" />
        AI に相談
      </button>

      <ChatPanel
        key={`${id}:${displayOrder.join(',')}`}
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        category={category}
        exam={exam}
        questionId={id}
        questionNumber={question.number}
        displayOrder={displayOrder}
        selected={result ? selected : []}
      />
    </div>
  );
}
