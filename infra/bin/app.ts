import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { AuthStack } from '../lib/auth-stack';
import { BackendStack } from '../lib/backend-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
import { parseSharedAuth } from '../lib/shared-auth';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

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

  // 旧ユーザープール。切り戻しとデータの付け替えのために残す（どのスタックからも参照しない）
  new AuthStack(app, `${prefix}-auth`, { env, envName, siteUrl });

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
