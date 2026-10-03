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
