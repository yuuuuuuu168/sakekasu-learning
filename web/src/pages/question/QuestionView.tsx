import { ArrowLeft, MessageCircle } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AnswerResponse, QuestionDetailResponse } from '../../../../shared/types';
import { ChatPanel } from '../../components/ChatPanel';
import { Markdown } from '../../components/Markdown';
import { MasteryChip } from '../../components/MasteryBar';
import { toggleSelection } from '../../lib/answer';
import { api } from '../../lib/api';
import { shuffledOrder } from '../../lib/choices';
import { nextInSession } from '../../lib/study-session';
import { ChoiceList } from './ChoiceList';
import { DiagramZoomDialog } from './DiagramZoomDialog';
import { ExplanationList } from './ExplanationList';
import { NextActions } from './NextActions';
import { ResultBanner } from './ResultBanner';
import { useDiagrams } from './useDiagrams';

/**
 * 1 問分の画面。QuestionPage が問題ごとに key を替えて作り直すので、選択・採点結果・図解などの
 * 状態は問題が替わると初めからになる。前の問題で出した通信の応答は外された画面に届いて捨てられる
 */
export function QuestionView({
  category,
  exam,
  question,
}: {
  category: string;
  exam: string;
  question: QuestionDetailResponse;
}) {
  const { id } = question;
  /** 画面の並び（原本の index）。問題を開くたび・解き直すたびに並べ替える */
  const [displayOrder, setDisplayOrder] = useState(() => shuffledOrder(question.choices.length));
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [zoomedDiagram, setZoomedDiagram] = useState<string | null>(null);
  const diagrams = useDiagrams(category, exam, id, result?.diagramChoices ?? []);
  /** 「回答する」の前に API を一度呼んだか */
  const warmed = useRef(false);

  const articleRef = useRef<HTMLElement>(null);
  // 問題を開いたら、一覧から開いたときも次の問題へ進んだときも問題文をヘッダーの直下に出す
  // （戻るリンクの行を毎回見せない）。描画前にスクロールしてちらつかせない
  useLayoutEffect(() => {
    articleRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  const multi = question.selectCount > 1;
  const session = nextInSession(category, exam, id, []);
  const examPath = `/exams/${category}/${exam}`;

  const toggle = (original: number) => {
    if (result) return;
    // 考えている間に止まっていた通信の準備（トークンの更新、API への接続、Lambda の起動）を、
    // 選択肢を選んだ時点で済ませておき、「回答する」を押してからの待ちを減らす
    if (!warmed.current) {
      warmed.current = true;
      api.question(category, exam, id).catch(() => {});
    }
    setSelected((prev) => toggleSelection(prev, original, question.selectCount));
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      setResult(await api.answer(category, exam, id, selected));
    } catch (err) {
      // 画面ごと差し替えず、選んだ選択肢を残したまま送り直せるようにする
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const retry = () => {
    setResult(null);
    setSelected([]);
    setDisplayOrder(shuffledOrder(question.choices.length));
    articleRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const actions = (
    <NextActions examPath={examPath} next={session.next} inSession={session.position !== null} onRetry={retry} />
  );

  return (
    <div className="space-y-5 pb-24">
      <Link to={examPath} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" />
        問題一覧
      </Link>

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

      <ChoiceList
        choices={question.choices}
        displayOrder={displayOrder}
        selected={selected}
        multi={multi}
        answers={result?.answers ?? null}
        onToggle={toggle}
      />

      {!result ? (
        <div className="space-y-2">
          <button
            onClick={() => void submit()}
            disabled={selected.length !== question.selectCount || submitting}
            className="w-full rounded-xl bg-accent px-4 py-3 font-semibold text-on-fill hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '採点中…' : multi ? `回答する（${selected.length} / ${question.selectCount}）` : '回答する'}
          </button>
          {submitError && (
            <p role="alert" className="text-center text-sm text-danger">
              {submitError}
            </p>
          )}
        </div>
      ) : (
        <>
          <ResultBanner correct={result.correct} answers={result.answers} displayOrder={displayOrder} />
          {actions}
          <ExplanationList
            result={result}
            displayOrder={displayOrder}
            selected={selected}
            diagrams={diagrams.diagrams}
            loadDiagrams={diagrams.load}
            onZoom={setZoomedDiagram}
          />
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

      {zoomedDiagram && <DiagramZoomDialog src={zoomedDiagram} onClose={() => setZoomedDiagram(null)} />}

      <ChatPanel
        // 回答の前後で会話をリセットする（回答前のヒントの会話を回答後に持ち越さない）
        key={`${displayOrder.join(',')}:${result ? 'answered' : 'unanswered'}`}
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
