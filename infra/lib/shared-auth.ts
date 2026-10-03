/**
 * 共通ログイン（sakekasu-integrated_environment の共通ユーザープール）の接続先。
 *
 * 値は `cdk.json` の context `sharedAuth` に置く。共通基盤のスタックとは参照でつながない
 * （別のリポジトリでデプロイしているため）。値はどれも秘密ではない（ブラウザに配る値）。
 *
 *   "sharedAuth": {
 *     "domain": "auth.sakekasu-builder.com",   // マネージドログインのドメイン（https:// は付けない）
 *     "userPoolId": "ap-northeast-1_xxxxxxxxx",
 *     "clientId": "xxxxxxxxxxxxxxxxxxxxxxxxxx"   // learning 用のアプリクライアント
 *   }
 *
 * 画面の設定（config.json）を書き出す scripts/write-web-config.ts もこの関数で読む。
 */
export interface SharedAuthConfig {
  /** マネージドログインのドメイン（例: auth.sakekasu-builder.com） */
  domain: string;
  /** 共通ユーザープールの ID（例: ap-northeast-1_xxxxxxxxx） */
  userPoolId: string;
  /** learning 用のアプリクライアント ID */
  clientId: string;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const USER_POOL_ID = /^[a-z]{2}(-[a-z]+)+-\d_[A-Za-z0-9]+$/;
const CLIENT_ID = /^[a-z0-9]{20,128}$/;

/** context の `sharedAuth` を検証して返す。欠けや形の誤りは synth の時点で止める */
export function parseSharedAuth(raw: unknown): SharedAuthConfig {
  // `-c sharedAuth='{"domain":...}'` で渡されたときは文字列で届く
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('context の sharedAuth を JSON として読めません');
    }
  }
  if (!value || typeof value !== 'object') {
    throw new Error('context の sharedAuth がありません（cdk.json に domain / userPoolId / clientId を置く）');
  }
  const { domain, userPoolId, clientId } = value as Record<string, unknown>;
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) {
    throw new Error(`sharedAuth.domain が不正です（https:// を付けないホスト名）: ${String(domain)}`);
  }
  if (typeof userPoolId !== 'string' || !USER_POOL_ID.test(userPoolId)) {
    throw new Error(`sharedAuth.userPoolId が不正です: ${String(userPoolId)}`);
  }
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new Error(`sharedAuth.clientId が不正です: ${String(clientId)}`);
  }
  return { domain, userPoolId, clientId };
}

/** ユーザープール ID の頭にあるリージョン（ap-northeast-1_xxx → ap-northeast-1） */
export function sharedAuthRegion(auth: SharedAuthConfig): string {
  return auth.userPoolId.split('_')[0];
}
