/**
 * ログインの門番。未ログインならログインへ進め、ログイン済みなら子要素を出す。
 *
 * ログインは 4 アプリ共通のログイン（Cognito のマネージドログイン）に任せる。
 * パスワードの入力・初回のパスワード変更・認証アプリ（TOTP）の登録と入力・パスワードの再設定は、
 * どれもマネージドログインの画面が行う。この画面はそこへ送り出し（signInWithRedirect）、
 * 戻ってきたら Amplify が認可コードをトークンに換えるのを待つだけ。
 *
 * ログイン中のユーザー名やメールアドレスは画面に出さない。
 *
 * 未ログインで開いたら、ボタンを押させずにマネージドログインへ自動で進む。ただし自動で進むのはタブごとに 1 回だけ。
 * sessionStorage に印を置いてから送り、戻ってきてもまだ未ログイン（ログイン画面で戻った・取り消した、
 * `?error=` 付きで戻った等）なら、自動では送らずにサインイン画面を出す。ログインできたら印を消す。
 * ポータルのリンクに付く `?sso=1` は、付いていても動きは変わらない（読み込み時に URL から外すだけ）。
 */
import { Hub } from 'aws-amplify/utils';
import { getCurrentUser, signInWithRedirect, signOut } from 'aws-amplify/auth';
import { LoaderCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  PORTAL_TOP_URL,
  callbackErrorMessage,
  clearAutoSignInMark,
  consumeSsoHint,
  createSignInStarter,
  isOAuthCallback,
  redirectErrorMessage,
  sessionMarkStorage,
  signOutRedirectUrl,
} from './oauth';

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

/** ポータルからの目印（?sso=1）は、読み込み時にログイン済みかどうかに関係なく URL から外す */
consumeSsoHint(window);

/** 自動で送ったかの印を置く場所（sessionStorage） */
const markStorage = sessionMarkStorage();

/**
 * マネージドログインへ送る（成功するとページごと移る）。送れなかったときは画面に出す文を返す。
 * ボタンと、未ログインで開いたときの自動の送り出しで共通
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
  // 未ログインと分かったら、このタブで 1 回だけ自動で送る。ボタンは印に関係なく必ず送る。
  // 自動で送っている間は 'checking' のまま（読み込み中の表示）にして、サインイン画面を一瞬見せない
  const starter = useRef<ReturnType<typeof createSignInStarter<Promise<string | null>>> | null>(null);
  starter.current ??= createSignInStarter(markStorage, redirectToSignIn);

  const refresh = useCallback(async () => {
    try {
      await getCurrentUser();
      clearAutoSignInMark(markStorage);
      setStatus('signedIn');
    } catch {
      const search = window.location.search;
      // ?error= 付きで戻ったときは、Amplify の知らせを待たずにエラー文つきでサインイン画面を出す
      const callbackError = callbackErrorMessage(search);
      if (callbackError !== null) {
        setError((current) => current ?? callbackError);
        setStatus('signedOut');
        return;
      }
      // マネージドログインから戻った直後は、トークンの交換が終わるまで Hub の知らせを待つ
      if (isOAuthCallback(search)) return;
      const sending = starter.current?.auto({ search, error: failed.current });
      if (sending) {
        void sending.then((message) => {
          if (message === null) return;
          setError(message);
          setStatus('signedOut');
        });
        return;
      }
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
    // マネージドログインのログアウト（/logout）へ移り、本番はポータルのトップ、手元は / に着く。
    // ログイン画面のセッションも消えるので、ほかのアプリも次はログインし直しになる
    await signOut({ global: false, oauth: { redirectUrl: signOutRedirectUrl(window.location.origin) } });
    setStatus('signedOut');
  }, []);

  if (status === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted">
        <LoaderCircle className="size-6 animate-spin" />
      </div>
    );
  }
  if (status === 'signedOut') {
    return <SignInScreen error={error} onSignIn={() => starter.current!.manual()} />;
  }
  return <AuthContext.Provider value={{ signOut: handleSignOut }}>{children}</AuthContext.Provider>;
}

/**
 * 自動で進めなかったときだけ出るサインイン画面。見た目は sakekasu の入口の表紙（ポータルのトップ）と同じ。
 * OS がライトでもこの画面だけは黒に固定する（index.css の .signin と、出している間の <html> に color-scheme: dark を付け、共通テーマのダークの値を使う）
 */
function SignInScreen({ error, onSignIn }: { error: string | null; onSignIn: () => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(error);

  const handleSignIn = async () => {
    setBusy(true);
    setMessage(null);
    // 成功するとマネージドログインへページごと移るので、busy のままにしておく
    const failure = await onSignIn();
    if (failure === null) return;
    setMessage(failure);
    setBusy(false);
  };

  return (
    <main className="signin">
      <div className="signin-mark" aria-hidden="true">
        📚
      </div>
      <h1 className="signin-title">learning</h1>
      <div className="signin-rule" aria-hidden="true">
        ◆
      </div>
      <p className="signin-lead">資格試験の問題演習</p>
      <button type="button" className="signin-button" onClick={() => void handleSignIn()} disabled={busy}>
        パスキーでログイン
      </button>
      {message && (
        <p role="alert" className="signin-error">
          {message}
        </p>
      )}
      <p className="signin-note">共通ログインの画面へ移動します</p>
      <a className="signin-back" href={PORTAL_TOP_URL}>
        ← sakekasu の入口へ
      </a>
    </main>
  );
}
