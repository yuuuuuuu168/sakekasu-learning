/**
 * ログインの門番。未ログインならログインの入口を出し、ログイン済みなら子要素を出す。
 *
 * ログインは 4 アプリ共通のログイン（Cognito のマネージドログイン）に任せる。
 * パスワードの入力・初回のパスワード変更・認証アプリ（TOTP）の登録と入力・パスワードの再設定は、
 * どれもマネージドログインの画面が行う。この画面はそこへ送り出し（signInWithRedirect）、
 * 戻ってきたら Amplify が認可コードをトークンに換えるのを待つだけ。
 *
 * ログイン中のユーザー名やメールアドレスは画面に出さない。
 *
 * 未ログインでもマネージドログインへは勝手に送らず、ログインボタンを押してもらうのが原則
 * （送り出しと戻りで行き来し続けないため）。例外はポータル（https://sakekasu-builder.com/apps）から
 * `?sso=1` 付きで来たときだけ。共通ログインでログインした直後なので、送ればそのまま認可コードが返ってくる。
 * このときはボタンを出さずに 1 回だけ自動で送る。目印は読み込み時に URL から外し、戻り先も素の / なので、
 * 戻ってきた後に再び自動で送ることはない。
 */
import { Hub } from 'aws-amplify/utils';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { GraduationCap, LoaderCircle, LogIn } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { consumeSsoHint, createSsoAutoSignIn, isOAuthCallback, redirectErrorMessage } from './oauth';

interface AuthContextValue {
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthGate の外で useAuth が呼ばれました');
  return value;
}

type Status = 'checking' | 'signedOut' | 'signedIn';

/** マネージドログインから戻った後、トークンの交換を待つ上限 */
const CALLBACK_TIMEOUT_MS = 15_000;

/**
 * ポータルからの目印（?sso=1）。読み込み時に 1 度だけ読み、ログイン済みかどうかに関係なく URL から外す。
 * マネージドログインへ送る前に外れているので、目印つきの URL で往復することはない
 */
const ssoHint = consumeSsoHint(window);

/**
 * マネージドログインへ送る（成功するとページごと移る）。送れなかったときは画面に出す文を返す。
 * ボタンと、目印つきで来たときの自動の送り出しで共通
 */
async function redirectToSignIn(): Promise<string | null> {
  try {
    await signInWithRedirect();
    return null;
  } catch (err) {
    // 別のタブでログイン済みなど。状態を読み直せば中に入れる
    if ((err as { name?: string })?.name === 'UserAlreadyAuthenticatedException') {
      window.location.reload();
      return null;
    }
    return redirectErrorMessage(err);
  }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState<string | null>(null);
  const failed = useRef(false);
  // 目印つきで来て最初の確認で未ログインなら、ボタンの代わりに 1 回だけ自動で送る。
  // 送っている間は 'checking' のまま（読み込み中の表示）にして、ボタンを一瞬見せない
  const autoSignIn = useRef<ReturnType<typeof createSsoAutoSignIn> | null>(null);
  autoSignIn.current ??= createSsoAutoSignIn(ssoHint, () => {
    void redirectToSignIn().then((message) => {
      if (message === null) return;
      setError(message);
      setStatus('signedOut');
    });
  });

  const refresh = useCallback(async () => {
    try {
      await getCurrentUser();
      setStatus('signedIn');
    } catch {
      const search = window.location.search;
      // 目印つきで来たときの例外。マネージドログインからの戻りやエラーのときは送らない
      if (autoSignIn.current?.({ search, error: failed.current })) return;
      // マネージドログインから戻った直後は、トークンの交換が終わるまで Hub の知らせを待つ
      if (isOAuthCallback(search)) return;
      setStatus('signedOut');
    }
  }, []);

  useEffect(() => {
    const stop = Hub.listen('auth', ({ payload }) => {
      switch (payload.event) {
        case 'signInWithRedirect':
        case 'signedIn':
          setError(null);
          void refresh();
          return;
        case 'signInWithRedirect_failure':
          console.error('共通ログインからの戻りでエラーが発生しました', payload.data);
          failed.current = true;
          setError(redirectErrorMessage(payload.data?.error ?? payload.data));
          setStatus('signedOut');
          return;
        case 'signedOut':
        case 'tokenRefresh_failure':
          setStatus('signedOut');
          return;
      }
    });
    void refresh();
    // 戻りの知らせが届かないまま固まらないよう、一定時間で入口に戻す
    const timer = window.setTimeout(() => {
      setStatus((current) => (current === 'checking' ? 'signedOut' : current));
    }, CALLBACK_TIMEOUT_MS);
    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const handleSignOut = useCallback(async () => {
    // マネージドログインのログアウト（/logout）へ移り、戻り先の / に帰ってくる。
    // ログイン画面のセッションも消えるので、ほかのアプリも次はログインし直しになる
    await signOut();
    setStatus('signedOut');
  }, []);

  if (status === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">
        <LoaderCircle className="size-6 animate-spin" />
      </div>
    );
  }
  if (status === 'signedOut') return <SignInScreen error={error} />;
  return <AuthContext.Provider value={{ signOut: handleSignOut }}>{children}</AuthContext.Provider>;
}

function SignInScreen({ error }: { error: string | null }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error);

  const handleSignIn = async () => {
    setBusy(true);
    setMessage(null);
    // 成功するとマネージドログインへページごと移るので、busy のままにしておく
    const failure = await redirectToSignIn();
    if (failure === null) return;
    setMessage(failure);
    setBusy(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-accent text-on-fill">
            <GraduationCap className="size-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">sakekasu learning</h1>
          <p className="text-sm text-muted">資格試験の問題演習</p>
        </div>

        <div className="space-y-4 rounded-2xl border border-grid bg-surface p-6 shadow-sm">
          {message && (
            <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              {message}
            </p>
          )}
          <p className="text-sm text-ink-2">
            sakekasu の共通ログインでログインします。認証アプリ（TOTP）のコードも求められます。
          </p>
          <button
            type="button"
            onClick={() => void handleSignIn()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 font-semibold text-on-fill hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            ログイン
          </button>
        </div>
        <p className="mt-6 text-center text-xs text-muted">
          招待制のサイトです。アカウントは管理者が発行します。
        </p>
      </div>
    </div>
  );
}
