/**
 * デプロイ済みスタックの出力から、フロントエンドが起動時に読む config.json を作る。
 *
 * 使い方（infra/ で実行）:
 *   AWS_PROFILE=sakekasu-builder npx tsx scripts/write-web-config.ts ../web/public/config.json
 *
 * 値はどれも秘密情報ではない（呼び出しには Cognito のトークンが必須）。
 */
import { writeFileSync } from 'node:fs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const envName = process.env.ENV_NAME ?? 'dev';
const region = 'ap-northeast-1';
const out = process.argv[2];
if (!out) {
  console.error('出力先のパスを指定してください');
  process.exit(1);
}

const cfn = new CloudFormationClient({ region });

async function outputs(stackName: string): Promise<Record<string, string>> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  return Object.fromEntries(
    (res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']),
  );
}

function required(values: Record<string, string>, key: string, stack: string): string {
  const v = values[key];
  if (!v) throw new Error(`${stack} に出力 ${key} がありません`);
  return v;
}

const prefix = `sakekasu-learning-${envName}`;
const [auth, backend, agent] = await Promise.all([
  outputs(`${prefix}-auth`),
  outputs(`${prefix}-backend`),
  outputs(`${prefix}-agent`),
]);

const config = {
  region,
  userPoolId: required(auth, 'UserPoolId', `${prefix}-auth`),
  userPoolClientId: required(auth, 'UserPoolClientId', `${prefix}-auth`),
  apiUrl: required(backend, 'ApiUrl', `${prefix}-backend`),
  agentRuntimeArn: required(agent, 'RuntimeArn', `${prefix}-agent`),
};
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(`${out} を書き出しました`);
