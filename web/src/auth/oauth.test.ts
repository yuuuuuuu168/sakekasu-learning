import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_SIGN_IN_KEY,
  OAUTH_SCOPES,
  PORTAL_SIGN_OUT_URL,
  PORTAL_TOP_URL,
  amplifyAuthConfig,
  callbackErrorMessage,
  clearAutoSignInMark,
  consumeSsoHint,
  createSignInStarter,
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

  it('サインイン画面の「入口へ」もポータルのトップ', () => {
    expect(PORTAL_TOP_URL).toBe('https://sakekasu-builder.com/');
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

describe('callbackErrorMessage', () => {
  it('?error= 付きで戻ったら、画面に出す文を返す', () => {
    expect(callbackErrorMessage('?error=access_denied&state=xyz')).toBe(
      'ログインが取り消されました。もう一度ログインしてください',
    );
    expect(callbackErrorMessage('?error=server_error&error_description=x')).toBe(
      'ログインに失敗しました。もう一度お試しください（OAuthSignInException）',
    );
  });

  it('エラーが付いていなければ null', () => {
    expect(callbackErrorMessage('')).toBeNull();
    expect(callbackErrorMessage('?code=abc&state=xyz')).toBeNull();
    expect(callbackErrorMessage('?error=')).toBeNull();
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
  it('目印を replaceState で URL から外す（history の state は保つ）', () => {
    const { win, replaceState, href } = fakeWindow('/?sso=1&x=1#h');
    consumeSsoHint(win);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith({ idx: 0 }, '', '/?x=1#h');
    expect(href()).toBe('/?x=1#h');
  });

  it('目印が無ければ URL に触れない', () => {
    const { win, replaceState } = fakeWindow('/?x=1');
    consumeSsoHint(win);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

/** sessionStorage の代わり。タブ（＝ストレージ）をまたいで同じものを渡せば、ページの読み直しを表せる */
function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

/**
 * ページを 1 回開いたときの最初の確認。AuthGate と同じく、読み込みごとに starter を作り直す。
 * StrictMode では確認が 2 回走るので auto も 2 回呼ぶ。戻り値は start が呼ばれた回数と auto の結果
 */
function openPage(storage: ReturnType<typeof fakeStorage> | null, search = '', error = false) {
  const start = vi.fn(() => 'sent');
  const starter = createSignInStarter(storage, start);
  const results = [starter.auto({ search, error }), starter.auto({ search, error })];
  return { start, results, starter };
}

describe('createSignInStarter', () => {
  it('未ログインで開いたら、印を置いてマネージドログインへ 1 回だけ自動で進む', () => {
    const storage = fakeStorage();
    const { start, results } = openPage(storage);
    expect(start).toHaveBeenCalledOnce();
    // 2 回目の確認も「送っている最中」として同じ結果を返す（サインイン画面を一瞬出さない）
    expect(results).toEqual(['sent', 'sent']);
    expect(storage.items.get(AUTO_SIGN_IN_KEY)).toBe('1');
  });

  it('戻ってきてもまだ未ログインなら、2 回目は自動で進まずに画面を出す', () => {
    const storage = fakeStorage();
    openPage(storage);
    const second = openPage(storage);
    expect(second.start).not.toHaveBeenCalled();
    expect(second.results).toEqual([null, null]);
  });

  it('?error= 付きや認可コード付きで戻ったとき、エラーを出しているときは自動で進まない', () => {
    expect(openPage(fakeStorage(), '?error=access_denied&state=xyz').start).not.toHaveBeenCalled();
    expect(openPage(fakeStorage(), '?code=abc&state=xyz').start).not.toHaveBeenCalled();
    expect(openPage(fakeStorage(), '', true).start).not.toHaveBeenCalled();
  });

  it('ログインできたら印を消すので、次に未ログインで開いたときはまた 1 回だけ自動で進む', () => {
    const storage = fakeStorage();
    openPage(storage);
    clearAutoSignInMark(storage);
    expect(storage.items.has(AUTO_SIGN_IN_KEY)).toBe(false);
    expect(openPage(storage).start).toHaveBeenCalledOnce();
  });

  it('新しいタブ（別の sessionStorage）ではまた 1 回だけ自動で進む', () => {
    openPage(fakeStorage());
    expect(openPage(fakeStorage()).start).toHaveBeenCalledOnce();
  });

  it('印を置けない（sessionStorage が使えない）ときは、往復しないよう自動では進まない', () => {
    expect(openPage(null).start).not.toHaveBeenCalled();
    const broken = {
      ...fakeStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(openPage(broken).start).not.toHaveBeenCalled();
    expect(() =>
      clearAutoSignInMark({
        ...broken,
        removeItem: () => {
          throw new Error('SecurityError');
        },
      }),
    ).not.toThrow();
  });

  it('ボタンは印があっても必ず進む', () => {
    const storage = fakeStorage();
    openPage(storage);
    const { starter, start } = openPage(storage);
    expect(start).not.toHaveBeenCalled();
    expect(starter.manual()).toBe('sent');
    expect(starter.manual()).toBe('sent');
    expect(start).toHaveBeenCalledTimes(2);
    expect(openPage(null).starter.manual()).toBe('sent');
  });
});
