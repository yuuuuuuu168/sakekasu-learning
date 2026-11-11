import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { parseAnthropicFederation } from '../lib/anthropic-federation';
import { BackendStack } from '../lib/backend-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { applyRoleBoundary } from '../lib/role-boundary';
import { parseSharedAuth } from '../lib/shared-auth';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

// 全リソースに App タグを付ける。アプリごとのコストを Cost Explorer で分けるため。
// cdkd 用ロールのガードレール（deploy-guardrail.ts）の「他のアプリのタグが付いたリソースには
// 触れない」の判定にもこのタグを使う。4 アプリと共通基盤が同じアカウントに
// 同居していて、名前の接頭辞では分けきれないためタグで見分ける。
//
// IAM ロールには付けない。CloudFormation から cdkd へ移したロールは物理名が CFN の命名のままで、
// cdkd はロールを更新するたびに名前が変わったとみなして作り直す（2026-10-04 にタグを足しただけで
// 作り直しが起き、Lambda が消えたロールを指して止まった）。ロールはガードレールでも
// 名前の接頭辞で範囲を絞る。
//
// AgentCore の Runtime にも付けない。CloudFormation の時代に付いた aws:cloudformation:* のタグが
// 残っていて、cdkd はタグを更新するとそれも一緒に送り直し、aws: で始まるキーは付けられないと
// 断られる（2026-10-04、sakekasu-learning-dev-agent のデプロイが失敗した）
cdk.Tags.of(app).add('App', 'learning', {
  excludeResourceTypes: ['AWS::IAM::Role', 'AWS::BedrockAgentCore::Runtime'],
});

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = 'ap-northeast-1';
/** CloudFront 用の ACM 証明書は us-east-1 にしか置けない */
const webRegion = 'us-east-1';

// CI 用ロールは CI 自身の権限を変えるため、手動でだけデプロイする
if (app.node.tryGetContext('github-oidc') === 'true') {
  // アカウント ID はリポジトリに書かない（公開リポジトリなので）。AWS_PROFILE を付けて合成すると CDK が入れる
  if (!account) {
    throw new Error('github-oidc スタックにはデプロイ先のアカウントが要る。AWS_PROFILE を付けて合成するか、環境変数 CDK_DEFAULT_ACCOUNT を入れる');
  }
  new GithubOidcStack(app, 'sakekasu-learning-github-oidc', {
    env: { account, region },
    envName: 'dev',
    subjectPrefix: 'repo:yuuuuuuu168@173623628/sakekasu-learning@1415173262',
    webRegion,
  });
} else {
  const envName: string = app.node.tryGetContext('env') ?? 'dev';
  const domainName: string = app.node.getContext('domainName');
  const hostedZoneId: string = app.node.getContext('hostedZoneId');
  // ログインは共通ログイン（共通ユーザープール）。スタック間の参照ではなく context で受け取る
  const sharedAuth = parseSharedAuth(app.node.tryGetContext('sharedAuth'));
  const siteUrl = `https://${domainName}`;
  const prefix = `sakekasu-learning-${envName}`;
  const env = { account, region };

  const backend = new BackendStack(app, `${prefix}-backend`, {
    env,
    envName,
    sharedAuth,
    // 手元の開発サーバーは web/vite.config.ts の中継で呼ぶので、localhost は許さない
    allowedOrigins: [siteUrl],
  });

  new AgentStack(app, `${prefix}-agent`, {
    env,
    envName,
    sharedAuth,
    questionsBucket: backend.questionsBucket,
    modelId: app.node.tryGetContext('agentModelId'),
    fallbackModelId: app.node.tryGetContext('agentFallbackModelId'),
    anthropicModel: app.node.tryGetContext('agentAnthropicModel'),
    // Claude API の ID 連携（Claude Console のルール・組織・サービスアカウント・ワークスペースの ID。秘密ではない）
    anthropicFederation: parseAnthropicFederation(app.node.tryGetContext('anthropicFederation')),
  });

  new WebStack(app, `${prefix}-web`, {
    env: { account, region: webRegion },
    envName,
    domainName,
    hostedZoneId,
    backendRegion: region,
    authDomain: sharedAuth.domain,
  });

  // アプリのロールはすべて Permissions Boundary の内側に置く（理由は lib/role-boundary.ts）。
  // 境界は github-oidc のスタックが作り、cdkd 用ロールは境界の無いロールを作れない
  for (const stack of app.node.children) {
    if (stack instanceof cdk.Stack) applyRoleBoundary(stack);
  }
}
