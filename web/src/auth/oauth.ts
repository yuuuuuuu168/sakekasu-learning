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
 * 本番でログアウトしたあとに着く先。4 アプリ共通のポータルのトップ。
 * このアプリのログイン画面に戻すと、ログアウトしたのにまたログインを促されるだけなので、ポータルに帰す。
 * 共通のアプリクライアントの logout_uri に登録してある値と、末尾の / まで一致させる
 * （sakekasu-integrated_environment の infra/cdk.json の logoutUrls）
 */
export const PORTAL_SIGN_OUT_URL = 'https://sakekasu-builder.com/';

/** 4 アプリ共通のポータルのトップ。サインイン画面の「← sakekasu の入口へ」の行き先 */
export const PORTAL_TOP_URL = PORTAL_SIGN_OUT_URL;

/**
 * 4 アプリの入口の一覧（ポータル）。ヘッダーの「アプリ一覧」の行き先。
 * 共通ログインのセッションがあれば、入力なしで一覧が出る
 */
export const PORTAL_APPS_URL = 'https://sakekasu-builder.com/apps';

/** 手元の開発サーバー（http://localhost:5173 など）か */
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * ログアウト後の戻り先。本番はポータルのトップ、手元はそのオリジンの / 。
 * Amplify の signOut は戻り先を指定しないと redirectSignOut から「今と同じオリジン」の URL しか選ばない
 * （別オリジンだけだと InvalidOriginException）。ポータルは別オリジンなので、
 * redirectSignOut に入れたうえで signOut({ oauth: { redirectUrl } }) に同じ値を渡す
 */
export function signOutRedirectUrl(origin: string): string {
  return isLocalOrigin(origin) ? `${origin.replace(/\/+$/, '')}/` : PORTAL_SIGN_OUT_URL;
}

/**
 * Amplify の Auth 設定。ログインの戻り先は「今開いているオリジン + /」で、共通ログイン側に
 * 登録してある URL（https://learning.sakekasu-builder.com/ と http://localhost:5173/）と
 * 末尾の / まで一致させる。ログアウトの戻り先は signOutRedirectUrl。
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
          redirectSignOut: [signOutRedirectUrl(origin)],
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

/**
 * マネージドログインから `?error=` 付きで戻ってきたときに画面に出す文。エラーでなければ null。
 * Amplify が知らせる失敗（OAuthSignInException、message にエラーの種類）と同じ文にそろえる
 */
export function callbackErrorMessage(search: string): string | null {
  const error = new URLSearchParams(search).get('error');
  if (!error) return null;
  return redirectErrorMessage({ name: 'OAuthSignInException', message: error });
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
 * ポータル（https://sakekasu-builder.com/apps）のリンクに付く「共通ログインでログイン済み」の目印 `?sso=1`。
 * 今は目印が無くても未ログインなら自動でマネージドログインへ進むので、付いていても動きは変わらない。URL から外すだけ
 */
export const SSO_HINT_PARAM = 'sso';

/**
 * URL から目印 `sso` を読み、目印を外した URL（パス・ほかのパラメータ・ハッシュは残す）を返す。
 * 目印が無ければ url は null（書き換え不要）。hint は `sso=1` が付いていたか
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

/** 目印をすぐに URL から外す（history.replaceState。ログイン済みかどうかに関係なく外す） */
export function consumeSsoHint(win: {
  location: { pathname: string; search: string; hash: string };
  history: Pick<History, 'state' | 'replaceState'>;
}): void {
  const { url } = stripSsoHint(win.location);
  if (url !== null) win.history.replaceState(win.history.state, '', url);
}

/**
 * 「このタブではもう自動でマネージドログインへ送った」という印の sessionStorage のキー。
 * 送る前に置き、ログインできたら消す。sessionStorage なので、新しいタブではまた 1 回だけ自動で進む
 */
export const AUTO_SIGN_IN_KEY = 'sakekasu-learning:auto-sign-in';

/** 印を置く場所。sessionStorage が使えない（プライベートブラウズの制限など）ときは null */
export type MarkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

/** window.sessionStorage を読む。触るだけで例外になるブラウザがあるので、そのときは null */
export function sessionMarkStorage(): MarkStorage {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** ログインできたら印を消す。消せなくても困らないので、例外は握りつぶす */
export function clearAutoSignInMark(storage: MarkStorage): void {
  try {
    storage?.removeItem(AUTO_SIGN_IN_KEY);
  } catch {
    // 何もしない
  }
}

/** 印を置く。置けたかどうかを返す（置けないまま自動で送ると、戻るたびに送り直して往復が止まらない） */
function putAutoSignInMark(storage: MarkStorage): boolean {
  try {
    if (!storage || storage.getItem(AUTO_SIGN_IN_KEY) !== null) return false;
    storage.setItem(AUTO_SIGN_IN_KEY, '1');
    return storage.getItem(AUTO_SIGN_IN_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * マネージドログインへの送り出し（start、signInWithRedirect）を、自動とボタンの 2 通りで呼ぶ。
 *
 * - auto: 未ログインと分かったときに呼ぶ。このタブでまだ自動で送っていなければ、印を置いてから start を呼び、
 *   その結果を返す。送らないときは null（呼んだ側はサインイン画面を出す）。
 *   マネージドログインからの戻り（認可コードやエラーが付いている）や、エラーを出している最中も送らない。
 *   同じ画面で 2 回呼ばれても（StrictMode で確認が二重に走る）、送るのは 1 回で、2 回目も同じ結果を返す
 * - manual: ボタン。印があっても必ず start を呼ぶ
 */
export function createSignInStarter<T>(
  storage: MarkStorage,
  start: () => T,
): {
  auto: (context: { search: string; error: boolean }) => T | null;
  manual: () => T;
} {
  let sent: { result: T } | null = null;
  return {
    auto: ({ search, error }) => {
      if (sent) return sent.result;
      if (isOAuthCallback(search) || error) return null;
      if (!putAutoSignInMark(storage)) return null;
      sent = { result: start() };
      return sent.result;
    },
    manual: () => start(),
  };
}
