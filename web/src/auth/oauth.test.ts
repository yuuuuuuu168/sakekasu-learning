import { describe, expect, it, vi } from 'vitest';
import {
  OAUTH_SCOPES,
  PORTAL_SIGN_OUT_URL,
  amplifyAuthConfig,
  consumeSsoHint,
  createSsoAutoSignIn,
  isOAuthCallback,
  redirectErrorMessage,
  signOutRedirectUrl,
  stripSsoHint,
} from './oauth';

const config = {
  userPoolId: 'ap-northeast-1_TestPool1',
  userPoolClientId: 'testclientid0123456789abcd',
  authDomain: 'auth.example.com',
};

describe('amplifyAuthConfig', () => {
  it('マネージドログインへ認可コードで送り、ログインの戻り先はオリジン + /、ログアウトの戻り先はポータルにする', () => {
    const auth = amplifyAuthConfig(config, 'https://learning.example.com');
    expect(auth.Cognito).toMatchObject({
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      loginWith: {
        oauth: {
          domain: 'auth.example.com',
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: ['https://learning.example.com/'],
          redirectSignOut: ['https://sakekasu-builder.com/'],
          responseType: 'code',
        },
      },
    });
  });

  it('ユーザー操作の API 用のスコープは求めない（共通ログインのクライアントに無い）', () => {
    expect(OAUTH_SCOPES).not.toContain('aws.cognito.signin.user.admin');
  });

  it('戻り先の / を二重にせず、ドメインの https:// は外す', () => {
    const auth = amplifyAuthConfig({ ...config, authDomain: 'https://auth.example.com/' }, 'http://localhost:5173/');
    const oauth = auth.Cognito.loginWith?.oauth;
    expect(oauth?.domain).toBe('auth.example.com');
    expect(oauth?.redirectSignIn).toEqual(['http://localhost:5173/']);
    expect(oauth?.redirectSignOut).toEqual(['http://localhost:5173/']);
  });
});

describe('signOutRedirectUrl', () => {
  it('本番のオリジンからはポータルのトップに帰す', () => {
    expect(PORTAL_SIGN_OUT_URL).toBe('https://sakekasu-builder.com/');
    expect(signOutRedirectUrl('https://learning.sakekasu-builder.com')).toBe('https://sakekasu-builder.com/');
  });

  it('手元の開発サーバーからはそのオリジンの / に戻す', () => {
    expect(signOutRedirectUrl('http://localhost:5173')).toBe('http://localhost:5173/');
    expect(signOutRedirectUrl('http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(signOutRedirectUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/');
  });

  it('localhost を名前に含むだけのホストは本番扱いにする', () => {
    expect(signOutRedirectUrl('https://localhost.example.com')).toBe(PORTAL_SIGN_OUT_URL);
  });
});

describe('isOAuthCallback', () => {
  it('認可コードと state が付いていれば戻りとみなす', () => {
    expect(isOAuthCallback('?code=abc&state=xyz')).toBe(true);
  });

  it('エラーで戻ったときも戻りとみなす', () => {
    expect(isOAuthCallback('?error=access_denied&state=xyz')).toBe(true);
  });

  it('普通の URL は戻りではない', () => {
    expect(isOAuthCallback('')).toBe(false);
    expect(isOAuthCallback('?code=abc')).toBe(false);
    expect(isOAuthCallback('?q=1')).toBe(false);
  });
});

describe('redirectErrorMessage', () => {
  it('ログイン画面で取り消したときは専用の文にする', () => {
    const err = { name: 'OAuthSignInException', message: 'access_denied' };
    expect(redirectErrorMessage(err)).toBe('ログインが取り消されました。もう一度ログインしてください');
  });

  it('それ以外はエラーの種類を添える', () => {
    expect(redirectErrorMessage({ name: 'OAuthSignInException', message: 'invalid_grant' })).toContain(
      'OAuthSignInException',
    );
    expect(redirectErrorMessage(new Error('boom'))).toContain('boom');
    expect(redirectErrorMessage(undefined)).toBe('ログインに失敗しました。もう一度お試しください');
  });
});

/** consumeSsoHint に渡す window の代わり。replaceState で URL を書き換える */
function fakeWindow(url: string) {
  const parsed = new URL(url, 'https://learning.example.com');
  const location = { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
  const replaceState = vi.fn((_state: unknown, _unused: string, next?: string | URL | null) => {
    const moved = new URL(String(next), 'https://learning.example.com');
    Object.assign(location, { pathname: moved.pathname, search: moved.search, hash: moved.hash });
  });
  return {
    win: { location, history: { state: { idx: 0 }, replaceState } },
    replaceState,
    href: () => `${location.pathname}${location.search}${location.hash}`,
  };
}

describe('stripSsoHint', () => {
  it('sso=1 を目印として読み、パス・ほかのパラメータ・ハッシュは残して外す', () => {
    expect(stripSsoHint({ pathname: '/exams/a/b', search: '?x=1&sso=1&y=2', hash: '#top' })).toEqual({
      hint: true,
      url: '/exams/a/b?x=1&y=2#top',
    });
  });

  it('sso だけなら ? ごと外す', () => {
    expect(stripSsoHint({ pathname: '/', search: '?sso=1', hash: '' })).toEqual({ hint: true, url: '/' });
  });

  it('目印が無ければ書き換えない', () => {
    expect(stripSsoHint({ pathname: '/', search: '?x=1', hash: '' })).toEqual({ hint: false, url: null });
    expect(stripSsoHint({ pathname: '/', search: '', hash: '' })).toEqual({ hint: false, url: null });
  });

  it('sso が 1 以外なら目印とはみなさないが、URL からは外す', () => {
    expect(stripSsoHint({ pathname: '/', search: '?sso=0', hash: '' })).toEqual({ hint: false, url: '/' });
  });
});

describe('consumeSsoHint', () => {
  it('目印を読んだら replaceState で URL から外す（history の state は保つ）', () => {
    const { win, replaceState, href } = fakeWindow('/?sso=1&x=1#h');
    expect(consumeSsoHint(win)).toBe(true);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ idx: 0 }, '', '/?x=1#h');
    expect(href()).toBe('/?x=1#h');
  });

  it('目印が無ければ URL に触れない', () => {
    const { win, replaceState } = fakeWindow('/?x=1');
    expect(consumeSsoHint(win)).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

/**
 * AuthGate の最初の確認と同じ順で、目印の読み取り → ログイン状態の確認 → 自動の送り出しを行う。
 * 戻り値は自動で送り出したかどうか
 */
function initialCheck(url: string, signedIn: boolean, error = false) {
  const { win, href } = fakeWindow(url);
  const signInWithRedirect = vi.fn();
  const auto = createSsoAutoSignIn(consumeSsoHint(win), signInWithRedirect);
  // StrictMode では最初の確認が 2 回走る
  for (let i = 0; i < 2; i++) {
    if (!signedIn) auto({ search: win.location.search, error });
  }
  return { signInWithRedirect, href: href() };
}

describe('createSsoAutoSignIn', () => {
  it('目印つきで未ログインなら、マネージドログインへ 1 回だけ自動で送り、URL から目印を外す', () => {
    const { signInWithRedirect, href } = initialCheck('/?sso=1', false);
    expect(signInWithRedirect).toHaveBeenCalledOnce();
    expect(href).toBe('/');
  });

  it('目印が無ければ自動では送らない（ボタンを押してもらう）', () => {
    expect(initialCheck('/', false).signInWithRedirect).not.toHaveBeenCalled();
    expect(initialCheck('/?sso=0', false).signInWithRedirect).not.toHaveBeenCalled();
  });

  it('目印つきでもログイン済みなら送らず、URL から目印は外す', () => {
    const { signInWithRedirect, href } = initialCheck('/exams/a/b?sso=1#q', true);
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(href).toBe('/exams/a/b#q');
  });

  it('マネージドログインからの戻りやエラーのときは送らない', () => {
    expect(initialCheck('/?sso=1&code=abc&state=xyz', false).signInWithRedirect).not.toHaveBeenCalled();
    expect(initialCheck('/?sso=1&error=access_denied', false).signInWithRedirect).not.toHaveBeenCalled();
    expect(initialCheck('/?sso=1', false, true).signInWithRedirect).not.toHaveBeenCalled();
  });

  it('一度見送ったら、その後に未ログインになっても送らない', () => {
    const start = vi.fn();
    const auto = createSsoAutoSignIn(true, start);
    expect(auto({ search: '?code=abc&state=xyz', error: false })).toBe(false);
    expect(auto({ search: '', error: false })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });
});
