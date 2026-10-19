import { ArrowLeft, ArrowRight, Check, ChevronDown, LoaderCircle, MessageCircle, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  /** 開いている解説（原本の index）。最初はすべて閉じておく */
  const [openExplanations, setOpenExplanations] = useState<Set<number>>(new Set());
  /** 選択肢ごとの図解（原本の index → data URL / 読み込み中は null / 失敗は 'error'） */
  const [diagrams, setDiagrams] = useState<Record<number, string | null>>({});
  const [zoomedDiagram, setZoomedDiagram] = useState<string | null>(null);

  const load = useCallback(() => {
    setQuestion(null);
    setError(null);
    setResult(null);
    setSelected([]);
    setOpenExplanations(new Set());
    setDiagrams({});
    setZoomedDiagram(null);
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

  const articleRef = useRef<HTMLElement>(null);
  // 問題を開いたら、一覧から開いたときも次の問題へ進んだときも問題文をヘッダーの直下に出す
  // （戻るリンクや進み具合の行を毎回見せない）。描画前にスクロールしてちらつかせない
  useLayoutEffect(() => {
    if (question) articleRef.current?.scrollIntoView({ block: 'start' });
  }, [question]);

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
    setOpenExplanations(new Set());
    setDisplayOrder(shuffledOrder(question.choices.length));
    articleRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  /** 図解は解説を開いたときに初めて読み込む（1問に数枚あるため、回答時にまとめて取らない） */
  const loadDiagrams = (originals: number[]) => {
    const targets = originals.filter(
      (o) => result?.diagramChoices.includes(o) && !(o in diagrams),
    );
    if (targets.length === 0) return;
    setDiagrams((prev) => ({ ...prev, ...Object.fromEntries(targets.map((o) => [o, null])) }));
    for (const o of targets) {
      api.diagram(category, exam, id, o).then(
        (res) => setDiagrams((prev) => ({ ...prev, [o]: res.image })),
        () => setDiagrams((prev) => ({ ...prev, [o]: 'error' })),
      );
    }
  };

  const toggleExplanation = (original: number) => {
    if (!openExplanations.has(original)) loadDiagrams([original]);
    setOpenExplanations((prev) => {
      const next = new Set(prev);
      if (next.has(original)) next.delete(original);
      else next.add(original);
      return next;
    });
  };
  const allOpen = openExplanations.size === displayOrder.length;

  // 解説の上と下の両方に置く（解説を読まずに進むときも、読み終えてからも押しやすいように）
  const actions = (
    <div className="flex flex-col gap-2 sm:flex-row">
      <button
        onClick={retry}
        className="flex items-center justify-center gap-2 rounded-xl bg-surface px-4 py-3 font-semibold text-ink-2 ring-1 ring-grid hover:bg-plane"
      >
        <RotateCcw className="size-4" />
        もう一度解く
      </button>
      {session.next ? (
        <button
          onClick={() => navigate(`${examPath}/q/${encodeURIComponent(session.next!)}`)}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 font-semibold text-on-fill hover:bg-accent-hover"
        >
          次の問題へ
          <ArrowRight className="size-4" />
        </button>
      ) : (
        <Link
          to={examPath}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 font-semibold text-on-fill hover:bg-accent-hover"
        >
          {session.position ? 'おつかれさまでした！一覧へ戻る' : '問題一覧へ'}
        </Link>
      )}
    </div>
  );

  const choiceState = (original: number) => {
    const picked = selected.includes(original);
    if (!result) return picked ? 'picked' : 'idle';
    const correct = result.answers.includes(original);
    if (correct) return picked ? 'correct-picked' : 'correct-missed';
    return picked ? 'wrong-picked' : 'idle';
  };

  const choiceClass: Record<string, string> = {
    idle: 'ring-grid bg-surface hover:bg-plane',
    picked: 'ring-2 ring-accent bg-accent-weak',
    'correct-picked': 'ring-2 ring-success bg-success/10',
    'correct-missed': 'ring-2 ring-success bg-surface',
    'wrong-picked': 'ring-2 ring-danger bg-danger/10',
  };

  return (
    <div className="space-y-5 pb-24">
      <div className="flex items-center justify-between gap-2">
        <Link to={examPath} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" />
          問題一覧
        </Link>
        {session.position && (
          <span className="text-sm tabular-nums text-muted">
            {session.position} / {session.total}
          </span>
        )}
      </div>

      {/* scroll-mt はヘッダー（h-14 + 枠線）の下に少し余白を残す分 */}
      <article ref={articleRef} className="scroll-mt-16 space-y-4 rounded-2xl border border-grid bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-muted">
            問{question.number}
            <span className="font-normal text-muted"> / {question.total}</span>
          </span>
          <MasteryChip mastery={(result?.progress ?? question.progress).mastery} />
          {multi && (
            <span className="rounded-full bg-accent-weak px-2 py-0.5 text-xs font-medium text-accent">
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
                  state === 'idle' ? 'bg-surface-2 text-ink-2' : state === 'picked' ? 'bg-accent text-on-fill'
                    : state.startsWith('correct') ? 'bg-success text-on-fill' : 'bg-danger text-on-fill'
                }`}
              >
                {state.startsWith('correct') ? <Check className="size-4" /> : state === 'wrong-picked' ? <X className="size-4" /> : LABELS[pos]}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap leading-relaxed">
                {result && <span className="mr-1 font-semibold text-muted">{LABELS[pos]}.</span>}
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
          className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-fill hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? '採点中…' : multi ? `回答する（${selected.length} / ${question.selectCount}）` : '回答する'}
        </button>
      ) : (
        <>
          <div
            className={`flex items-center gap-3 rounded-2xl p-4 ${
              result.correct ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
            }`}
          >
            <span className={`flex size-9 items-center justify-center rounded-full text-on-fill ${result.correct ? 'bg-success' : 'bg-danger'}`}>
              {result.correct ? <Check className="size-5" /> : <X className="size-5" />}
            </span>
            <div>
              <p className="font-bold">{result.correct ? '正解！' : '不正解'}</p>
              <p className="text-sm">
                正解は {result.answers.map((a) => LABELS[displayOrder.indexOf(a)]).sort().join(', ')}
              </p>
            </div>
          </div>

          {actions}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2 px-1">
              <h2 className="font-semibold">解説</h2>
              <button
                onClick={() =>
                  {
                    if (!allOpen) loadDiagrams(displayOrder);
                    setOpenExplanations(allOpen ? new Set() : new Set(displayOrder));
                  }
                }
                className="text-sm text-accent hover:underline"
              >
                {allOpen ? 'すべて閉じる' : 'すべて開く'}
              </button>
            </div>
            {displayOrder.map((original, pos) => {
              const correct = result.answers.includes(original);
              const open = openExplanations.has(original);
              return (
                <div key={original} className="rounded-2xl border border-grid bg-surface shadow-sm">
                  <button
                    onClick={() => toggleExplanation(original)}
                    aria-expanded={open}
                    className="flex w-full items-center gap-2 p-4 text-left"
                  >
                    <span
                      className={`rounded-md px-2 py-0.5 text-xs font-semibold text-on-fill ${correct ? 'bg-success' : 'bg-muted'}`}
                    >
                      {correct ? '正解' : '不正解'}
                    </span>
                    <span className="font-semibold">選択肢 {LABELS[pos]}</span>
                    {selected.includes(original) && (
                      <span className="text-xs text-muted">（あなたの回答）</span>
                    )}
                    <ChevronDown
                      className={`ml-auto size-5 shrink-0 text-muted transition ${open ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {open && (
                    <div className="space-y-3 border-t border-grid p-4">
                      {original in diagrams && (
                        <DiagramImage
                          src={diagrams[original]}
                          alt={`選択肢 ${LABELS[pos]} の図解`}
                          onZoom={setZoomedDiagram}
                        />
                      )}
                      <Markdown className="prose-sm">{relabel(result.explanations[original], displayOrder)}</Markdown>
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {actions}
        </>
      )}

      <button
        onClick={() => setChatOpen(true)}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-semibold text-on-fill shadow-lg hover:bg-ink-2"
      >
        <MessageCircle className="size-5" />
        AI に相談
      </button>

      {zoomedDiagram && (
        <div
          role="dialog"
          aria-label="図解の拡大表示"
          onClick={() => setZoomedDiagram(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-slate-900/80 p-2 sm:p-6"
        >
          <img src={zoomedDiagram} alt="図解" className="max-h-full max-w-full rounded-lg bg-surface" />
          <button
            onClick={() => setZoomedDiagram(null)}
            className="absolute right-4 top-4 rounded-full bg-surface/90 p-2 text-ink-2"
            aria-label="閉じる"
          >
            <X className="size-5" />
          </button>
        </div>
      )}

      <ChatPanel
        // 回答の前後で会話をリセットする（回答前のヒントの会話を回答後に持ち越さない）
        key={`${id}:${displayOrder.join(',')}:${result ? 'answered' : 'unanswered'}`}
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

function DiagramImage({
  src,
  alt,
  onZoom,
}: {
  src: string | null;
  alt: string;
  onZoom: (src: string) => void;
}) {
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
