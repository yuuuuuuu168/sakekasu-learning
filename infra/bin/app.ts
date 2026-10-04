import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { BackendStack } from '../lib/backend-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { parseSharedAuth } from '../lib/shared-auth';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

// 全リソースに App タグを付ける。アプリごとのコストを Cost Explorer で分けるため。
// デプロイ用ロールに「他のアプリのタグが付いたリソースには触れない」ガードレールを足す
// 予定で、その判定にもこのタグを使う。ガードレールはまだ無い（次の段で足す）ので、
// それまではタグを付けただけでは何も守られない。4 アプリと共通基盤が同じアカウントに
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
  new GithubOidcStack(app, 'sakekasu-learning-github-oidc', {
    env: { account: '232791540685', region },
    envName: 'dev',
    subjectPrefix: 'repo:yuuuuuuu168@173623628/sakekasu-learning@1382792992',
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
    allowedOrigins: [siteUrl, 'http://localhost:5173'],
  });

  new AgentStack(app, `${prefix}-agent`, {
    env,
    envName,
    sharedAuth,
    questionsBucket: backend.questionsBucket,
    modelId: app.node.tryGetContext('agentModelId'),
    fallbackModelId: app.node.tryGetContext('agentFallbackModelId'),
  });

  new WebStack(app, `${prefix}-web`, {
    env: { account, region: webRegion },
    envName,
    domainName,
    hostedZoneId,
    backendRegion: region,
    authDomain: sharedAuth.domain,
  });
}
