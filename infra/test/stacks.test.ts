import { existsSync } from 'node:fs';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PACKAGE_DIR, AgentStack } from '../lib/agent-stack';
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

  it('このアプリはユーザープールを持たない（ログインは共通ログイン。旧 auth スタックは外した）', () => {
    for (const template of [t.backend, t.agent, t.web]) {
      template.resourceCountIs('AWS::Cognito::UserPool', 0);
      template.resourceCountIs('AWS::Cognito::UserPoolClient', 0);
    }
  });

  it('スタック間の参照はエージェントから backend の問題バケットへの分だけ', () => {
    const imports = (template: Template) =>
      [...JSON.stringify(template.toJSON()).matchAll(/"Fn::ImportValue":"([^"]+)"/g)].map((m) => m[1]);
    expect(imports(t.backend)).toEqual([]);
    expect(imports(t.web)).toEqual([]);
    const agentImports = imports(t.agent);
    expect(agentImports.length).toBeGreaterThan(0);
    for (const name of agentImports) {
      expect(name).toMatch(/^backend:ExportsOutput.*QuestionsBucket/);
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

  describe('監視（共通基盤の通知先へ送るアラーム）', () => {
    // スタックの account は実値なので、組み立てた ARN は文字列になる（スタックの出力は参照しない）
    const topicArn = `arn:aws:sns:ap-northeast-1:${account}:sakekasu-integrated-alerts`;

    function alarmsOf(template: Template) {
      return Object.values(
        template.findResources('AWS::CloudWatch::Alarm') as Record<
          string,
          { Properties: Record<string, unknown> }
        >,
      ).map((r) => r.Properties);
    }
    function alarmNamed(template: Template, name: string) {
      const alarm = alarmsOf(template).find((a) => a.AlarmName === name);
      expect(alarm, name).toBeDefined();
      return alarm as Record<string, unknown>;
    }

    it('全アラームが共通基盤のトピックへ ALARM と OK を送り、名前が learning の接頭辞で始まる', () => {
      const all = [...alarmsOf(t.backend), ...alarmsOf(t.agent)];
      expect(all.length).toBeGreaterThanOrEqual(8);
      for (const alarm of all) {
        expect(alarm.AlarmName).toMatch(/^test-sakekasu-learning-/);
        expect(alarm.AlarmActions, String(alarm.AlarmName)).toEqual([topicArn]);
        expect(alarm.OKActions, String(alarm.AlarmName)).toEqual([topicArn]);
        expect(alarm.AlarmDescription).toEqual(expect.any(String));
      }
    });

    it('トピックはこのリポジトリで作らない（通知先の ARN は上のテストで文字列のまま確かめている）', () => {
      for (const template of [t.backend, t.agent]) {
        template.resourceCountIs('AWS::SNS::Topic', 0);
      }
    });

    it('サイト（us-east-1）にはアラームを置かない', () => {
      t.web.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });

    it('API の Lambda のエラーとスロットリング', () => {
      for (const [name, metricName] of [
        ['test-sakekasu-learning-api-errors', 'Errors'],
        ['test-sakekasu-learning-api-throttles', 'Throttles'],
      ]) {
        expect(alarmNamed(t.backend, name)).toMatchObject({
          Namespace: 'AWS/Lambda',
          MetricName: metricName,
          Statistic: 'Sum',
          Period: 300,
          Threshold: 1,
          EvaluationPeriods: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
        });
      }
    });

    it('HTTP API の 5xx は ApiId で 5 分に 3 回から', () => {
      const alarm = alarmNamed(t.backend, 'test-sakekasu-learning-api-5xx');
      expect(alarm).toMatchObject({
        Namespace: 'AWS/ApiGateway',
        MetricName: '5xx',
        Threshold: 3,
        TreatMissingData: 'notBreaching',
      });
      expect((alarm.Dimensions as { Name: string }[]).map((d) => d.Name)).toEqual(['ApiId']);
    });

    it('回答履歴のテーブルのスロットリングは読みと書きを足して見る', () => {
      const alarm = alarmNamed(t.backend, 'test-sakekasu-learning-progress-throttles');
      expect(alarm).toMatchObject({ Threshold: 1, TreatMissingData: 'notBreaching' });
      const metrics = alarm.Metrics as {
        Expression?: string;
        MetricStat?: { Metric: { MetricName: string; Dimensions: { Name: string }[] } };
      }[];
      expect(metrics.find((m) => m.Expression)?.Expression).toBe('FILL(r, 0) + FILL(w, 0)');
      const names = metrics.flatMap((m) => (m.MetricStat ? [m.MetricStat.Metric.MetricName] : []));
      expect(names.sort()).toEqual(['ReadThrottleEvents', 'WriteThrottleEvents']);
    });

    it('AI チャットの Runtime のシステムエラー・スロットリング・認可失敗', () => {
      for (const [name, metricName, threshold] of [
        ['test-sakekasu-learning-agent-system-errors', 'SystemErrors', 1],
        ['test-sakekasu-learning-agent-throttles', 'Throttles', 1],
        ['test-sakekasu-learning-agent-auth-unauthorized', 'InboundAuthorizationFailure', 3],
        ['test-sakekasu-learning-agent-auth-invalid-token', 'InboundAuthorizationFailure', 3],
      ] as const) {
        const alarm = alarmNamed(t.agent, name);
        expect(alarm).toMatchObject({
          Namespace: 'AWS/Bedrock-AgentCore',
          MetricName: metricName,
          Threshold: threshold,
          TreatMissingData: 'notBreaching',
        });
        // ResourceId は同じスタックの Runtime の ARN
        expect(JSON.stringify(alarm.Dimensions)).toContain('"Name":"ResourceId"');
        expect(JSON.stringify(alarm.Dimensions)).toContain('AgentRuntimeArn');
      }
    });
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
