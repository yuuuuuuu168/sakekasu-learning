import * as cdk from 'aws-cdk-lib';
import { AgentStack } from '../lib/agent-stack';
import { AuthStack } from '../lib/auth-stack';
import { BackendStack } from '../lib/backend-stack';
import { GithubOidcStack } from '../lib/github-oidc-stack';
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
    repository: 'yuuuuuuu168/sakekasu-learning',
    webRegion,
  });
} else {
  const envName: string = app.node.tryGetContext('env') ?? 'dev';
  const domainName: string = app.node.getContext('domainName');
  const hostedZoneName: string = app.node.getContext('hostedZoneName');
  const siteUrl = `https://${domainName}`;
  const prefix = `sakekasu-learning-${envName}`;
  const env = { account, region };

  const auth = new AuthStack(app, `${prefix}-auth`, { env, envName, siteUrl });

  const backend = new BackendStack(app, `${prefix}-backend`, {
    env,
    envName,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    allowedOrigins: [siteUrl, 'http://localhost:5173'],
  });

  new AgentStack(app, `${prefix}-agent`, {
    env,
    envName,
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    questionsBucket: backend.questionsBucket,
    modelId: app.node.tryGetContext('agentModelId'),
  });

  new WebStack(app, `${prefix}-web`, {
    env: { account, region: webRegion },
    envName,
    domainName,
    hostedZoneName,
    backendRegion: region,
  });
}
