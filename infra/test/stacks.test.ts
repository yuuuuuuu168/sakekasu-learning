import { existsSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PACKAGE_DIR, AgentStack } from '../lib/agent-stack';
import { AuthStack } from '../lib/auth-stack';
import { BackendStack } from '../lib/backend-stack';
import { WebStack } from '../lib/web-stack';

const account = '123456789012';

function synth() {
  const app = new cdk.App();
  const env = { account, region: 'ap-northeast-1' };
  const auth = new AuthStack(app, 'auth', { env, envName: 'test', siteUrl: 'https://learning.example.com' });
  const backend = new BackendStack(app, 'backend', {
    env,
    envName: 'test',
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    allowedOrigins: ['https://learning.example.com'],
  });
  const agent = new AgentStack(app, 'agent', {
    env,
    envName: 'test',
    userPool: auth.userPool,
    userPoolClient: auth.userPoolClient,
    questionsBucket: backend.questionsBucket,
  });
  const web = new WebStack(app, 'web', {
    env: { account, region: 'us-east-1' },
    envName: 'test',
    domainName: 'learning.example.com',
    hostedZoneId: 'Z000TEST',
    backendRegion: 'ap-northeast-1',
  });
  return {
    auth: Template.fromStack(auth),
    backend: Template.fromStack(backend),
    agent: Template.fromStack(agent),
    web: Template.fromStack(web),
  };
}

describe('stacks', () => {
  let t: ReturnType<typeof synth>;
  beforeAll(() => {
    if (!existsSync(AGENT_PACKAGE_DIR)) {
      throw new Error('先に npm run package:agent を実行してください');
    }
    t = synth();
  });

  it('招待制（セルフサインアップ無効）の User Pool を作る', () => {
    t.auth.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
      // MFA は必須で、2要素目は TOTP だけ
      MfaConfiguration: 'ON',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
  });

  it('全ルートに JWT オーソライザーを付ける', () => {
    const routes = t.backend.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes)).toHaveLength(5);
    for (const route of Object.values(routes)) {
      expect(route.Properties.AuthorizationType).toBe('JWT');
    }
  });

  it('回答履歴テーブルは消えないようにする', () => {
    t.backend.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'qkey', KeyType: 'RANGE' },
        ],
      }),
    });
  });

  it('AgentCore Runtime は Cognito の JWT で保護し、Sonnet を使う', () => {
    t.agent.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: Match.objectLike({ AllowedClients: Match.anyValue() }),
      },
      EnvironmentVariables: Match.objectLike({ MODEL_ID: 'global.anthropic.claude-sonnet-5' }),
      AgentRuntimeArtifact: {
        CodeConfiguration: Match.objectLike({ Runtime: 'PYTHON_3_13', EntryPoint: ['main.py'] }),
      },
    });
  });

  it('サイトのバケットは CloudFront の OAC 経由でだけ読める', () => {
    t.web.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    t.web.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });
});
