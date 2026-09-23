/**
 * ログインの門番。未ログインならログイン画面を出し、ログイン済みなら子要素を出す。
 *
 * 招待制なのでサインアップ画面は無い。扱う流れは次のとおり。
 * - ログイン
 * - 初回ログイン時のパスワード変更（管理者が作ったユーザーは仮パスワードで始まる）
 * - 認証アプリ（TOTP）の登録。ユーザープールで MFA を必須にしているため、未登録なら必ず求められる
 * - ログインのたびの TOTP コード入力
 * - パスワードを忘れたときの再設定（メールで確認コード）
 */
import {
  confirmResetPassword,
  confirmSignIn,
  fetchUserAttributes,
  getCurrentUser,
  resetPassword,
  signIn,
  signOut,
  type SignInOutput,
} from 'aws-amplify/auth';
import { GraduationCap, LoaderCircle } from 'lucide-react';
import QRCode from 'qrcode';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

interface AuthContextValue {
  email: string;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthGate の外で useAuth が呼ばれました');
  return value;
}

type View = 'signIn' | 'newPassword' | 'totpSetup' | 'totpCode' | 'forgot' | 'forgotConfirm';

/** 認証アプリに表示されるサービス名 */
const TOTP_ISSUER = 'sakekasu learning';

const ERROR_MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'メールアドレスまたはパスワードが正しくありません',
  SignInException: 'ログインの有効期限が切れました。最初からやり直してください',
  UserNotFoundException: 'メールアドレスまたはパスワードが正しくありません',
  InvalidPasswordException: 'パスワードの条件を満たしていません（12文字以上・大文字・小文字・数字を含む）',
  CodeMismatchException: '確認コードが正しくありません',
  EnableSoftwareTokenMFAException: '認証アプリのコードが正しくありません。表示中の最新のコードを入力してください',
  ExpiredCodeException: '確認コードの有効期限が切れています。もう一度送信してください',
  LimitExceededException: '試行回数が上限に達しました。しばらく待ってからお試しください',
  TooManyRequestsException: '試行回数が上限に達しました。しばらく待ってからお試しください',
};

function toMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name && ERROR_MESSAGES[name]) return ERROR_MESSAGES[name];
  // 想定外のエラーは原因を追えるよう、種類を画面に出して詳細をコンソールに残す
  console.error('サインイン処理でエラーが発生しました', err);
  const detail = name && name !== 'Error' ? name : (err as { message?: string })?.message;
  return `エラーが発生しました。時間をおいてもう一度お試しください${detail ? `（${detail}）` : ''}`;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  const refresh = useCallback(async () => {
    try {
      await getCurrentUser();
      const attrs = await fetchUserAttributes();
      setEmail(attrs.email ?? '');
    } catch {
      setEmail(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSignOut = useCallback(async () => {
    await signOut();
    setEmail(null);
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        <LoaderCircle className="size-6 animate-spin" />
      </div>
    );
  }
  if (email === null) return <SignInScreen onSignedIn={refresh} />;
  return (
    <AuthContext.Provider value={{ email, signOut: handleSignOut }}>{children}</AuthContext.Provider>
  );
}

function SignInScreen({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [view, setView] = useState<View>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpSetup, setTotpSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Cognito が次に求めてきたことに合わせて画面を切り替える */
  const handleNextStep = async ({ isSignedIn, nextStep }: SignInOutput): Promise<void> => {
    if (isSignedIn) return onSignedIn();
    setTotpCode('');
    switch (nextStep.signInStep) {
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        setView('newPassword');
        setNotice('初回ログインです。新しいパスワードを設定してください');
        return;
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': {
        const uri = nextStep.totpSetupDetails.getSetupUri(TOTP_ISSUER, username.trim()).toString();
        setTotpSetup({
          qr: await QRCode.toDataURL(uri, { margin: 1, width: 200 }),
          secret: nextStep.totpSetupDetails.sharedSecret,
        });
        setView('totpSetup');
        setNotice('ログインには認証アプリ（Google Authenticator など）の登録が必要です');
        return;
      }
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
        setView('totpCode');
        setNotice(null);
        return;
      // 2要素目は TOTP だけを有効にしているので、選択を求められたら TOTP を選ぶ
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
      case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
        return handleNextStep(await confirmSignIn({ challengeResponse: 'TOTP' }));
      case 'RESET_PASSWORD':
        setView('forgot');
        setNotice('パスワードの再設定が必要です');
        return;
      default:
        throw new Error(nextStep.signInStep);
    }
  };

  const handleSignIn = run(async () => {
    await handleNextStep(await signIn({ username: username.trim(), password }));
  });

  const handleNewPassword = run(async () => {
    await handleNextStep(await confirmSignIn({ challengeResponse: newPassword }));
  });

  const handleTotp = run(async () => {
    await handleNextStep(await confirmSignIn({ challengeResponse: totpCode.trim() }));
  });

  const backToSignIn = () => {
    setView('signIn');
    setPassword('');
    setTotpSetup(null);
    setNotice(null);
    setError(null);
  };

  const handleForgot = run(async () => {
    await resetPassword({ username: username.trim() });
    setView('forgotConfirm');
    setNotice('確認コードをメールで送信しました');
  });

  const handleForgotConfirm = run(async () => {
    await confirmResetPassword({
      username: username.trim(),
      confirmationCode: code.trim(),
      newPassword,
    });
    setView('signIn');
    setPassword('');
    setNewPassword('');
    setCode('');
    setNotice('パスワードを変更しました。新しいパスワードでログインしてください');
  });

  const input =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';
  const button =
    'flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 font-semibold text-white hover:bg-indigo-700 disabled:opacity-50';
  const link = 'text-sm text-indigo-600 hover:underline';

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-indigo-600 text-white">
            <GraduationCap className="size-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">sakekasu learning</h1>
          <p className="text-sm text-slate-500">資格試験の問題演習</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          {notice && (
            <p className="mb-4 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-700">{notice}</p>
          )}
          {error && (
            <p role="alert" className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}

          {view === 'signIn' && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium">メールアドレス</span>
                <input className={input} type="email" autoComplete="username" required
                  value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium">パスワード</span>
                <input className={input} type="password" autoComplete="current-password" required
                  value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <button className={button} disabled={busy}>
                {busy && <LoaderCircle className="size-4 animate-spin" />}ログイン
              </button>
              <div className="text-center">
                <button type="button" className={link}
                  onClick={() => { setView('forgot'); setNotice(null); setError(null); }}>
                  パスワードを忘れた場合
                </button>
              </div>
            </form>
          )}

          {view === 'newPassword' && (
            <form onSubmit={handleNewPassword} className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium">新しいパスワード</span>
                <input className={input} type="password" autoComplete="new-password" required minLength={12}
                  value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <span className="text-xs text-slate-500">12文字以上で、大文字・小文字・数字を含めてください</span>
              </label>
              <button className={button} disabled={busy}>
                {busy && <LoaderCircle className="size-4 animate-spin" />}パスワードを設定してログイン
              </button>
            </form>
          )}

          {view === 'totpSetup' && totpSetup && (
            <form onSubmit={handleTotp} className="space-y-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
                <li>認証アプリで下の QR コードを読み取る</li>
                <li>アプリに表示された6桁のコードを入力する</li>
              </ol>
              <img src={totpSetup.qr} alt="認証アプリ登録用の QR コード" className="mx-auto size-48 rounded-lg ring-1 ring-slate-200" />
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer">QR コードを読み取れない場合</summary>
                <p className="mt-2">アプリで「セットアップキーを入力」を選び、次のキーを入力してください。</p>
                <code className="mt-1 block break-all rounded bg-slate-100 px-2 py-1.5 font-mono text-slate-700">
                  {totpSetup.secret}
                </code>
              </details>
              <TotpInput className={input} value={totpCode} onChange={setTotpCode} />
              <button className={button} disabled={busy || totpCode.trim().length !== 6}>
                {busy && <LoaderCircle className="size-4 animate-spin" />}登録してログイン
              </button>
            </form>
          )}

          {view === 'totpCode' && (
            <form onSubmit={handleTotp} className="space-y-4">
              <p className="text-sm text-slate-600">認証アプリに表示されている6桁のコードを入力してください。</p>
              <TotpInput className={input} value={totpCode} onChange={setTotpCode} />
              <button className={button} disabled={busy || totpCode.trim().length !== 6}>
                {busy && <LoaderCircle className="size-4 animate-spin" />}ログイン
              </button>
              <div className="text-center">
                <button type="button" className={link} onClick={backToSignIn}>
                  ログインに戻る
                </button>
              </div>
            </form>
          )}

          {view === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium">メールアドレス</span>
                <input className={input} type="email" autoComplete="username" required
                  value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <button className={button} disabled={busy}>
                {busy && <LoaderCircle className="size-4 animate-spin" />}確認コードを送信
              </button>
              <div className="text-center">
                <button type="button" className={link} onClick={() => { setView('signIn'); setNotice(null); setError(null); }}>
                  ログインに戻る
                </button>
              </div>
            </form>
          )}

          {view === 'forgotConfirm' && (
            <form onSubmit={handleForgotConfirm} className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-medium">確認コード</span>
                <input className={input} inputMode="numeric" autoComplete="one-time-code" required
                  value={code} onChange={(e) => setCode(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-medium">新しいパスワード</span>
                <input className={input} type="password" autoComplete="new-password" required minLength={12}
                  value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <span className="text-xs text-slate-500">12文字以上で、大文字・小文字・数字を含めてください</span>
              </label>
              <button className={button} disabled={busy}>
                {busy && <LoaderCircle className="size-4 animate-spin" />}パスワードを変更
              </button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">
          招待制のサイトです。アカウントは管理者が発行します。
        </p>
      </div>
    </div>
  );
}

function TotpInput({
  className,
  value,
  onChange,
}: {
  className: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">認証コード（6桁）</span>
      <input
        className={`${className} text-center font-mono text-lg tracking-[0.4em]`}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );
}
