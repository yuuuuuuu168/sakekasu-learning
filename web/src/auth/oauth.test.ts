import { describe, expect, it } from 'vitest';
import { OAUTH_SCOPES, amplifyAuthConfig, isOAuthCallback, redirectErrorMessage } from './oauth';

const config = {
  userPoolId: 'ap-northeast-1_TestPool1',
  userPoolClientId: 'testclientid0123456789abcd',
  authDomain: 'auth.example.com',
};

describe('amplifyAuthConfig', () => {
  it('マネージドログインへ認可コードで送り、戻り先はオリジン + / にする', () => {
    const auth = amplifyAuthConfig(config, 'https://learning.example.com');
    expect(auth.Cognito).toMatchObject({
      userPoolId: config.userPoolId,
      userPoolClientId: config.userPoolClientId,
      loginWith: {
        oauth: {
          domain: 'auth.example.com',
          scopes: ['openid', 'email', 'profile'],
          redirectSignIn: ['https://learning.example.com/'],
          redirectSignOut: ['https://learning.example.com/'],
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
