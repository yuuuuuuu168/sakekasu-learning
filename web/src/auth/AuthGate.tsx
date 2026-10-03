/**
 * ログインの門番。未ログインならログインの入口を出し、ログイン済みなら子要素を出す。
 *
 * ログインは 4 アプリ共通のログイン（Cognito のマネージドログイン）に任せる。
 * パスワードの入力・初回のパスワード変更・認証アプリ（TOTP）の登録と入力・パスワードの再設定は、
 * どれもマネージドログインの画面が行う。この画面はそこへ送り出し（signInWithRedirect）、
 * 戻ってきたら Amplify が認可コードをトークンに換えるのを待つだけ。
 *
 * ログイン中のユーザー名やメールアドレスは画面に出さない。
 */
import { Hub } from 'aws-amplify/utils';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { GraduationCap, LoaderCircle, LogIn } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { isOAuthCallback, redirectErrorMessage } from './oauth';

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

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      await getCurrentUser();
      setStatus('signedIn');
    } catch {
      // マネージドログインから戻った直後は、トークンの交換が終わるまで Hub の知らせを待つ
      if (isOAuthCallback(window.location.search)) return;
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
    try {
      // 成功するとマネージドログインへページごと移る
      await signInWithRedirect();
    } catch (err) {
      // 別のタブでログイン済みなど。状態を読み直せば中に入れる
      if ((err as { name?: string })?.name === 'UserAlreadyAuthenticatedException') {
        window.location.reload();
        return;
      }
      setMessage(redirectErrorMessage(err));
      setBusy(false);
    }
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
