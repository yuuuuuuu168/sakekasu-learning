import { existsSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PACKAGE_DIR, AgentStack } from '../lib/agent-stack';
import { AuthStack } from '../lib/auth-stack';
import { BackendStack } from '../lib/backend-stack';
import { parseSharedAuth } from '../lib/shared-auth';
import { WebStack } from '../lib/web-stack';

const account = '123456789012';
const sharedAuth = {
  domain: 'auth.example.com',
  userPoolId: 'ap-northeast-1_TestPool1',
  clientId: 'testclientid0123456789abcd',
};
const issuer = `https://cognito-idp.ap-northeast-1.amazonaws.com/${sharedAuth.userPoolId}`;

function synth() {
  const app = new cdk.App();
  const env = { account, region: 'ap-northeast-1' };
  const auth = new AuthStack(app, 'auth', { env, envName: 'test', siteUrl: 'https://learning.example.com' });
  const backend = new BackendStack(app, 'backend', {
    env,
    envName: 'test',
    sharedAuth,
    allowedOrigins: ['https://learning.example.com'],
  });
  const agent = new AgentStack(app, 'agent', {
    env,
    envName: 'test',
    sharedAuth,
    questionsBucket: backend.questionsBucket,
  });
  const web = new WebStack(app, 'web', {
    env: { account, region: 'us-east-1' },
    envName: 'test',
    domainName: 'learning.example.com',
    hostedZoneId: 'Z000TEST',
    backendRegion: 'ap-northeast-1',
    authDomain: sharedAuth.domain,
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
    // synth は Lambda のバンドルとエージェントのパッケージ（数十 MB）のコピーを含み、CI では 10 秒を超えることがある
  }, 60_000);

  it('旧 User Pool は切り戻し用に消さずに残す', () => {
    t.auth.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
        DeletionProtection: 'ACTIVE',
        // MFA は必須で、2要素目は TOTP だけ
        MfaConfiguration: 'ON',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      }),
    });
    // 以前 backend / agent が使っていた Export を同じ名前で残す
    const exports = Object.values(t.auth.toJSON().Outputs as Record<string, { Export?: unknown }>)
      .filter((o) => o.Export);
    expect(exports).toHaveLength(2);
  });

  it('API・エージェント・サイトは旧 User Pool（auth スタック）を参照しない', () => {
    for (const template of [t.backend, t.agent, t.web]) {
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('auth:Exports');
      expect(json).not.toContain('UserPool6BA7E5F2');
    }
  });

  it('API の JWT オーソライザーは共通ユーザープールの learning クライアントだけを通す', () => {
    t.backend.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: { Issuer: issuer, Audience: [sharedAuth.clientId] },
    });
  });

  it('全ルートに JWT オーソライザーを付ける', () => {
    const routes = t.backend.findResources('AWS::ApiGatewayV2::Route');
    expect(Object.keys(routes)).toHaveLength(6);
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

  it('AgentCore Runtime は共通ログインの JWT で保護し、Kimi K3 だけを使う', () => {
    t.agent.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: {
          DiscoveryUrl: `${issuer}/.well-known/openid-configuration`,
          AllowedClients: [sharedAuth.clientId],
        },
      },
      EnvironmentVariables: Match.objectLike({
        COGNITO_USER_POOL_ID: sharedAuth.userPoolId,
        COGNITO_CLIENT_ID: sharedAuth.clientId,
        MODEL_ID: 'global.moonshotai.kimi-k3',
        FALLBACK_MODEL_ID: Match.absent(),
      }),
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

  it('CSP の connect-src にマネージドログインのドメインを入れる（トークンの交換に使う）', () => {
    const policies = t.web.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const csp: string = Object.values(policies)[0].Properties.ResponseHeadersPolicyConfig
      .SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
    const connectSrc = csp.split('; ').find((d) => d.startsWith('connect-src'));
    expect(connectSrc?.split(' ')).toContain('https://auth.example.com');
  });
});

describe('parseSharedAuth', () => {
  it('cdk.json の値を受け付ける', () => {
    expect(parseSharedAuth(sharedAuth)).toEqual(sharedAuth);
  });

  it('-c で渡された JSON 文字列も受け付ける', () => {
    expect(parseSharedAuth(JSON.stringify(sharedAuth))).toEqual(sharedAuth);
  });

  it('欠けや形の誤りは止める', () => {
    expect(() => parseSharedAuth(undefined)).toThrow('sharedAuth がありません');
    expect(() => parseSharedAuth({ ...sharedAuth, domain: 'https://auth.example.com' })).toThrow('domain');
    expect(() => parseSharedAuth({ ...sharedAuth, userPoolId: 'pool' })).toThrow('userPoolId');
    expect(() => parseSharedAuth({ ...sharedAuth, clientId: '' })).toThrow('clientId');
  });
});
