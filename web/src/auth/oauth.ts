/**
 * 共通ログイン（Cognito マネージドログイン）につなぐための設定と、リダイレクトまわりの判定。
 * 画面（AuthGate.tsx）から切り出した純粋関数で、テストはこちらに書く。
 */
import type { ResourcesConfig } from 'aws-amplify';
import type { AppConfig } from '../config';

/**
 * 共通ユーザープールのクライアントに許されているスコープ。
 * `aws.cognito.signin.user.admin` は無いので、fetchUserAttributes などのユーザー操作の API は使えない
 */
export const OAUTH_SCOPES = ['openid', 'email', 'profile'];

/**
 * Amplify の Auth 設定。戻り先は「今開いているオリジン + /」で、共通ログイン側に
 * 登録してある URL（https://learning.sakekasu-builder.com/ と http://localhost:5173/）と
 * 末尾の / まで一致させる。
 */
export function amplifyAuthConfig(
  config: Pick<AppConfig, 'userPoolId' | 'userPoolClientId' | 'authDomain'>,
  origin: string,
): NonNullable<ResourcesConfig['Auth']> {
  const redirect = `${origin.replace(/\/+$/, '')}/`;
  return {
    Cognito: {
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      loginWith: {
        oauth: {
          domain: config.authDomain.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
          scopes: OAUTH_SCOPES,
          redirectSignIn: [redirect],
          redirectSignOut: [redirect],
          responseType: 'code',
        },
      },
    },
  };
}

/**
 * マネージドログインから戻ってきた直後か（URL に認可コードかエラーが付いている）。
 * この間は Amplify がトークンを交換しているので、未ログインと決めつけずに結果を待つ
 */
export function isOAuthCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  return (params.has('code') && params.has('state')) || params.has('error');
}

/** リダイレクトでのログインの失敗を、画面に出す文に直す */
export function redirectErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? '';
  if (name === 'OAuthSignInException' && /access_denied/i.test(message)) {
    return 'ログインが取り消されました。もう一度ログインしてください';
  }
  const detail = name && name !== 'Error' ? name : message;
  return `ログインに失敗しました。もう一度お試しください${detail ? `（${detail}）` : ''}`;
}

/**
 * ポータル（https://sakekasu-builder.com/apps）からのリンクに付く「共通ログインでログイン済み」の目印。
 * `?sso=1` で来たときだけ、ログインボタンを押させずにマネージドログインへ送る。
 */
export const SSO_HINT_PARAM = 'sso';

/**
 * URL から目印 `sso=1` を読み、目印を外した URL（パス・ほかのパラメータ・ハッシュは残す）を返す。
 * 目印が無ければ url は null（書き換え不要）。`sso` が 1 以外のときも目印とはみなさないが、URL からは外す
 */
export function stripSsoHint(location: { pathname: string; search: string; hash: string }): {
  hint: boolean;
  url: string | null;
} {
  const params = new URLSearchParams(location.search);
  if (!params.has(SSO_HINT_PARAM)) return { hint: false, url: null };
  const hint = params.getAll(SSO_HINT_PARAM).includes('1');
  params.delete(SSO_HINT_PARAM);
  const search = params.toString();
  return { hint, url: `${location.pathname}${search ? `?${search}` : ''}${location.hash}` };
}

/**
 * 目印を読んで、すぐに URL から外す（history.replaceState。ログイン済みかどうかに関係なく外す）。
 * 外してからマネージドログインへ送るので、戻り（戻り先は素の / ）で目印が復活して往復し続けることはない
 */
export function consumeSsoHint(win: {
  location: { pathname: string; search: string; hash: string };
  history: Pick<History, 'state' | 'replaceState'>;
}): boolean {
  const { hint, url } = stripSsoHint(win.location);
  if (url !== null) win.history.replaceState(win.history.state, '', url);
  return hint;
}

/**
 * 目印つきで来て、最初の確認で未ログインと分かったときに 1 回だけ start（signInWithRedirect）を呼ぶ関数を作る。
 * 返り値の関数は呼ぶたびに「今回送り出したか」を返す。2 回目以降は何もしない（StrictMode で確認が二重に走っても 1 回）。
 * マネージドログインからの戻り（認可コードやエラーが付いている）や、エラーを出している最中は送らない
 */
export function createSsoAutoSignIn(
  hint: boolean,
  start: () => void,
): (context: { search: string; error: boolean }) => boolean {
  let pending = hint;
  return ({ search, error }) => {
    if (!pending) return false;
    pending = false;
    if (isOAuthCallback(search) || error) return false;
    start();
    return true;
  };
}
