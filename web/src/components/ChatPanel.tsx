/**
 * 問題についての AI 相談パネル。
 *
 * 会話はこの問題（と今の選択肢の並び）を開いている間だけ保持し、回答すると新しい会話になる。
 * 未回答のうちに相談すると、AI は答えを明かさずヒントだけを返す。
 */
import { Bot, LoaderCircle, Send, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_PROMPT_LENGTH } from '../../../shared/chat';
import type { ChatMessage } from '../../../shared/types';
import { Markdown } from './Markdown';
import { useChatSession } from './useChatSession';

const SUGGESTIONS_ANSWERED = [
  'なぜこれが正解なのか、ポイントを整理して',
  '不正解の選択肢を選ばないための見分け方は？',
  '関連するサービスの違いを表で比較して',
];
const SUGGESTIONS_UNANSWERED = ['考え方のヒントをください', '問題文のキーワードを解説して'];

interface Props {
  open: boolean;
  onClose: () => void;
  category: string;
  exam: string;
  questionId: string;
  questionNumber: number;
  displayOrder: number[];
  selected: number[];
}

export function ChatPanel({
  open,
  onClose,
  category,
  exam,
  questionId,
  questionNumber,
  displayOrder,
  selected,
}: Props) {
  const { messages, streaming, error, send: sendPrompt, abort } = useChatSession({
    category,
    exam,
    questionId,
    displayOrder,
    selected,
  });
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, open]);

  const answered = selected.length > 0;

  const send = (prompt: string) => {
    if (sendPrompt(prompt)) setInput('');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(input);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 変換中の Enter は送信しない
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  };

  const suggestions = answered ? SUGGESTIONS_ANSWERED : SUGGESTIONS_UNANSWERED;

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-slate-900/30 transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={onClose}
      />
      {/* 閉じている間は画面の外にあるだけなので、inert で Tab の移動先や読み上げから外す */}
      <aside
        inert={!open}
        className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface shadow-2xl transition-transform sm:max-w-lg ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <header className="flex items-center justify-between gap-2 border-b border-grid px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-accent text-on-fill">
              <Bot className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">AI に相談</p>
              <p className="text-xs text-muted">
                問{questionNumber}・{answered ? '回答済み' : '未回答（答えは伏せてヒントを出します）'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-surface-2" aria-label="閉じる">
            <X className="size-5" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-3 text-sm text-ink-2">
              <p>
                この問題について何でも聞いてください。AWS の仕様は公式ドキュメントを確認しながら答えます。
                選択肢は画面と同じ A, B, C... で呼べます。
              </p>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-full bg-surface-2 px-3 py-1.5 text-left text-xs text-ink-2 hover:bg-accent-weak hover:text-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
          {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={onSubmit} className="border-t border-grid p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              maxLength={MAX_PROMPT_LENGTH}
              placeholder="質問を入力（Shift + Enter で改行）"
              className="min-h-11 flex-1 resize-none rounded-xl border border-grid px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent-weak sm:text-sm"
            />
            {streaming ? (
              <button
                type="button"
                onClick={abort}
                className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-ink-2 hover:bg-grid"
                aria-label="停止"
              >
                <Square className="size-4" />
              </button>
            ) : (
              <button
                disabled={!input.trim()}
                className="flex size-11 items-center justify-center rounded-xl bg-accent text-on-fill hover:bg-accent-hover disabled:opacity-40"
                aria-label="送信"
              >
                <Send className="size-4" />
              </button>
            )}
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            AI の回答は誤りを含むことがあります。重要な点は参考リンク先の公式ドキュメントで確認してください。
          </p>
        </form>
      </aside>
    </>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-on-fill">
          {message.content}
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl rounded-bl-sm bg-plane px-3.5 py-2.5">
      {message.content ? (
        <Markdown className="prose-sm">{message.content}</Markdown>
      ) : (
        <span className="flex items-center gap-2 text-sm text-muted">
          <LoaderCircle className="size-4 animate-spin" />
          ドキュメントを確認しながら考えています…
        </span>
      )}
    </div>
  );
}
