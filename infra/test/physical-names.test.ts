/**
 * 名前を固定したリソースの論理 ID と物理名を固定するテスト。
 *
 * cdkd は論理 ID が変わったリソースを「新しく作って古いものを消す」として扱う。
 * 物理名を固定したリソースは同じ名前がまだあるうちに作ろうとして失敗し、RETAIN のものは
 * 古い方が管理外として残る（docs/aws-infra-rules.md）。コンストラクトで包む・名前の組み立てを
 * 共通化する、といったリファクタでこれが起きないよう、今の論理 ID と物理名をここに書いておく。
 *
 * このテストが落ちたら、作り直しになってよい変更かを先に確かめる。よいなら下の表を直す。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PACKAGE_DIR, AgentStack } from '../lib/agent-stack';
import { parseAnthropicFederation } from '../lib/anthropic-federation';
import { BackendStack } from '../lib/backend-stack';
import { parseSharedAuth } from '../lib/shared-auth';
import { WebStack } from '../lib/web-stack';

const account = '123456789012';

/** 物理名を持つプロパティ（リソースの種類ごと） */
const NAME_PROPERTY: Record<string, (props: Record<string, any>) => unknown> = {
  'AWS::S3::Bucket': (p) => p.BucketName,
  'AWS::DynamoDB::GlobalTable': (p) => p.TableName,
  'AWS::Logs::LogGroup': (p) => p.LogGroupName,
  'AWS::Logs::MetricFilter': (p) => p.FilterName,
  'AWS::Lambda::Function': (p) => p.FunctionName,
  'AWS::Events::Rule': (p) => p.Name,
  'AWS::ApiGatewayV2::Api': (p) => p.Name,
  'AWS::IAM::Role': (p) => p.RoleName,
  'AWS::CloudWatch::Alarm': (p) => p.AlarmName,
  'AWS::BedrockAgentCore::Runtime': (p) => p.AgentRuntimeName,
  'AWS::CloudFront::ResponseHeadersPolicy': (p) => p.ResponseHeadersPolicyConfig?.Name,
};

/**
 * 本番と同じスタック ID・環境名・context で組み立てる（bin/app.ts と同じ）。
 * アカウントだけは仮の値
 */
function synth() {
  const context = JSON.parse(readFileSync(resolve(__dirname, '../cdk.json'), 'utf8')).context;
  const sharedAuth = parseSharedAuth(context.sharedAuth);
  const app = new cdk.App();
  const env = { account, region: 'ap-northeast-1' };
  const prefix = 'sakekasu-learning-dev';
  const backend = new BackendStack(app, `${prefix}-backend`, {
    env,
    envName: 'dev',
    sharedAuth,
    allowedOrigins: [`https://${context.domainName}`],
  });
  const agent = new AgentStack(app, `${prefix}-agent`, {
    env,
    envName: 'dev',
    sharedAuth,
    questionsBucket: backend.questionsBucket,
    anthropicFederation: parseAnthropicFederation(context.anthropicFederation),
  });
  const web = new WebStack(app, `${prefix}-web`, {
    env: { account, region: 'us-east-1' },
    envName: 'dev',
    domainName: context.domainName,
    hostedZoneId: context.hostedZoneId,
    backendRegion: 'ap-northeast-1',
    authDomain: sharedAuth.domain,
  });
  return { backend, agent, web };
}

/** 論理 ID → [種類, 物理名, DeletionPolicy]。物理名が null のものは cdkd が論理 ID から名前を導く */
type Named = Record<string, [type: string, name: string | null, deletion: 'Retain' | 'Delete']>;

function namedResources(stack: cdk.Stack): Named {
  const resources = Template.fromStack(stack).toJSON().Resources as Record<string, any>;
  const out: Named = {};
  for (const [id, r] of Object.entries(resources)) {
    const name = NAME_PROPERTY[r.Type];
    if (!name) continue;
    out[id] = [r.Type, (name(r.Properties ?? {}) as string | undefined) ?? null, r.DeletionPolicy ?? 'Delete'];
  }
  return out;
}

describe('名前を固定したリソースの論理 ID と物理名', () => {
  let stacks: ReturnType<typeof synth>;
  beforeAll(() => {
    if (!existsSync(AGENT_PACKAGE_DIR)) {
      throw new Error('先に npm run package:agent を実行してください');
    }
    stacks = synth();
    // synth は Lambda のバンドルとエージェントのパッケージのコピーを含み、CI では 10 秒を超えることがある
  }, 60_000);

  it('backend', () => {
    expect(namedResources(stacks.backend)).toEqual({
      QuestionsBucket1602B14C: ['AWS::S3::Bucket', `sakekasu-learning-dev-questions-${account}`, 'Retain'],
      ProgressTableAA2111E9: ['AWS::DynamoDB::GlobalTable', 'dev-sakekasu-learning-progress', 'Retain'],
      ApiFunctionLogs0D7A2434: ['AWS::Logs::LogGroup', '/aws/lambda/sakekasu-learning-dev-api', 'Retain'],
      // roleName を持たない。実物のロール名は論理 ID から導かれるので、論理 ID が変わると作り直しになり Lambda が止まる
      ApiFunctionServiceRole52B9747B: ['AWS::IAM::Role', null, 'Delete'],
      ApiFunctionCE271BD4: ['AWS::Lambda::Function', 'sakekasu-learning-dev-api', 'Delete'],
      ApiWarmerRule880BD7F7: ['AWS::Events::Rule', 'sakekasu-learning-dev-api-warmer', 'Delete'],
      HttpApiF5A9A8A7: ['AWS::ApiGatewayV2::Api', 'sakekasu-learning-dev-api', 'Delete'],
      AlarmsApiErrorsEE9D1F1D: ['AWS::CloudWatch::Alarm', 'sakekasu-learning-dev-api-errors', 'Delete'],
      AlarmsApiThrottles0E721B72: ['AWS::CloudWatch::Alarm', 'sakekasu-learning-dev-api-throttles', 'Delete'],
      AlarmsApi5xxFE885FB1: ['AWS::CloudWatch::Alarm', 'sakekasu-learning-dev-api-5xx', 'Delete'],
      AlarmsProgressTableThrottles7B5928CC: [
        'AWS::CloudWatch::Alarm',
        'sakekasu-learning-dev-progress-throttles',
        'Delete',
      ],
    });
  });

  it('agent', () => {
    expect(namedResources(stacks.agent)).toEqual({
      RuntimeRoleFD8790A4: ['AWS::IAM::Role', 'sakekasu-learning-dev-agent-runtime', 'Delete'],
      ChatQuotaTableFD848C55: ['AWS::DynamoDB::GlobalTable', 'dev-sakekasu-learning-chat-quota', 'Retain'],
      // 作り直すと ARN が変わり、web の config.json も変わる
      Runtime: ['AWS::BedrockAgentCore::Runtime', 'sakekasu_learning_dev_tutor', 'Delete'],
      AlarmsAgentSystemErrorsE1D75547: ['AWS::CloudWatch::Alarm', 'sakekasu-learning-dev-agent-system-errors', 'Delete'],
      AlarmsAgentThrottles1868DBA3: ['AWS::CloudWatch::Alarm', 'sakekasu-learning-dev-agent-throttles', 'Delete'],
      AlarmsAgentAuthUnauthorizedF290ED05: [
        'AWS::CloudWatch::Alarm',
        'sakekasu-learning-dev-agent-auth-unauthorized',
        'Delete',
      ],
      AlarmsAgentAuthInvalidToken5319D796: [
        'AWS::CloudWatch::Alarm',
        'sakekasu-learning-dev-agent-auth-invalid-token',
        'Delete',
      ],
      AlarmsAgentInvocationsHigh27EB9AC7: [
        'AWS::CloudWatch::Alarm',
        'sakekasu-learning-dev-agent-invocations-high',
        'Delete',
      ],
      // Claude API の ID 連携（cdk.json の anthropicFederation）があるときだけ作る
      ChatFallbackFilterE17BA7CD: ['AWS::Logs::MetricFilter', 'sakekasu-learning-dev-chat-fallbacks', 'Delete'],
      AlarmsAgentChatFallbacksC32103DA: ['AWS::CloudWatch::Alarm', 'sakekasu-learning-dev-agent-chat-fallbacks', 'Delete'],
    });
  });

  it('web', () => {
    expect(namedResources(stacks.web)).toEqual({
      SiteBucket397A1860: ['AWS::S3::Bucket', `sakekasu-learning-dev-web-${account}`, 'Delete'],
      SecurityHeadersE66B69D3: [
        'AWS::CloudFront::ResponseHeadersPolicy',
        'sakekasu-learning-dev-security-headers',
        'Delete',
      ],
    });
  });
});
