/**
 * フロントエンドが起動時に読む config.json を作る。
 *
 * - ログインの接続先: infra/cdk.json の context `sharedAuth`（共通ログイン）
 * - API と AI チャットの接続先: デプロイ済みスタックの出力（cdkd の状態に記録されている）
 *
 * 使い方（infra/ で実行）:
 *   AWS_PROFILE=sakekasu-builder npx tsx scripts/write-web-config.ts ../web/public/config.json
 *
 * 値はどれも秘密情報ではない（呼び出しには Cognito のトークンが必須）。
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseSharedAuth, sharedAuthRegion } from '../lib/shared-auth';

const envName = process.env.ENV_NAME ?? 'dev';
const region = 'ap-northeast-1';
const out = process.argv[2];
if (!out) {
  console.error('出力先のパスを指定してください');
  process.exit(1);
}

async function outputs(stackName: string): Promise<Record<string, string>> {
  const { stdout } = await promisify(execFile)('npx', ['cdkd', 'state', 'show', stackName, '--json']);
  const record = JSON.parse(stdout) as { state?: { outputs?: Record<string, string> } };
  return record.state?.outputs ?? {};
}

function required(values: Record<string, string>, key: string, stack: string): string {
  const v = values[key];
  if (!v) throw new Error(`${stack} に出力 ${key} がありません`);
  return v;
}

const cdkJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../cdk.json'), 'utf8'),
) as { context?: Record<string, unknown> };
const sharedAuth = parseSharedAuth(cdkJson.context?.sharedAuth);
if (sharedAuthRegion(sharedAuth) !== region) {
  // 画面は API・AI チャット・ログインを同じリージョン（config.region）として扱う
  throw new Error(`共通ログインのリージョン（${sharedAuthRegion(sharedAuth)}）が ${region} と違います`);
}

const prefix = `sakekasu-learning-${envName}`;
const [backend, agent] = await Promise.all([
  outputs(`${prefix}-backend`),
  outputs(`${prefix}-agent`),
]);

const config = {
  region,
  userPoolId: sharedAuth.userPoolId,
  userPoolClientId: sharedAuth.clientId,
  authDomain: sharedAuth.domain,
  apiUrl: required(backend, 'ApiUrl', `${prefix}-backend`),
  agentRuntimeArn: required(agent, 'RuntimeArn', `${prefix}-agent`),
};
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`${out} を書き出しました`);
