/**
 * 接続先の設定。ビルドに埋め込まず、起動時に /config.json を読む。
 * （CloudFront のスタックは us-east-1、API などは東京にあるため、
 *   デプロイ後に CI がスタックの出力から config.json を作って置く）
 *
 * ローカル開発では infra/scripts/write-web-config.ts で public/config.json を作る。
 */
export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiUrl: string;
  agentRuntimeArn: string;
}

let current: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`config.json を読み込めませんでした（${res.status}）`);
  current = (await res.json()) as AppConfig;
  return current;
}

export function config(): AppConfig {
  if (!current) throw new Error('設定が読み込まれていません');
  return current;
}
