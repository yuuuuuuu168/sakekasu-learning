import type { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * STS に頼む ID トークン（JWT）の宛先と寿命。agent/src/llm.py の IDENTITY_TOKEN_* と、
 * Claude Console のフェデレーションルールの audience に合わせてある。
 */
export const IDENTITY_TOKEN_AUDIENCE = 'https://api.anthropic.com';
export const IDENTITY_TOKEN_SECONDS = 300;

/**
 * AgentCore Runtime の実行ロール。
 *
 * 論理 ID を変えないよう、スタックの直下に作る（コンストラクトで包まない。test/physical-names.test.ts）。
 * 権限はロール本体ではなく DefaultPolicy に入れる（ロールのプロパティを変えると作り直しの判定に関わる）
 */
export function createRuntimeRole(stack: Stack, props: { envName: string; anthropicFederation: boolean }): iam.Role {
  const { region, account } = stack;
  const role = new iam.Role(stack, 'RuntimeRole', {
    roleName: `sakekasu-learning-${props.envName}-agent-runtime`,
    description: 'Execution role for the sakekasu-learning AgentCore Runtime',
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': account },
        ArnLike: {
          'aws:SourceArn': `arn:aws:bedrock-agentcore:${region}:${account}:*`,
        },
      },
    }),
  });

  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'InvokeModels',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      // Claude API が使えないときの控え（Kimi K3）にも使うので、ID 連携を入れても残す。
      // Global / Geo 推論プロファイルは、呼び出し元リージョンのプロファイルと
      // ルーティング先の全リージョンの基盤モデルの両方に権限が要る。
      // Claude はアクセス制限が解けたら context で戻せるように残しておく
      resources: ['anthropic.claude-*', 'moonshotai.kimi-*'].flatMap((model) => [
        `arn:aws:bedrock:${region}:${account}:inference-profile/*.${model}`,
        `arn:aws:bedrock:*::foundation-model/${model}`,
        `arn:aws:bedrock:::foundation-model/${model}`,
      ]),
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'Logs',
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'DescribeLogGroups',
      actions: ['logs:DescribeLogGroups'],
      resources: [`arn:aws:logs:${region}:${account}:log-group:*`],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'Tracing',
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
      ],
      resources: ['*'],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'Metrics',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
      conditions: { StringEquals: { 'cloudwatch:namespace': 'bedrock-agentcore' } },
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'WorkloadIdentity',
      actions: [
        'bedrock-agentcore:GetWorkloadAccessToken',
        'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/*`,
      ],
    }),
  );
  /*
   * Claude API に入るための ID トークン（JWT）を STS からもらう権限。宛先は Anthropic だけ、
   * 寿命はエージェントが頼む長さまで、署名は RS256 に絞る。JWT は短命で、Anthropic の側でも
   * ルール（発行者・このロールの ARN・宛先）に合うものしか交換されない。API キーは持たない
   */
  if (props.anthropicFederation) {
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AnthropicIdentityToken',
        actions: ['sts:GetWebIdentityToken'],
        resources: ['*'],
        conditions: {
          'ForAllValues:StringEquals': { 'sts:IdentityTokenAudience': [IDENTITY_TOKEN_AUDIENCE] },
          NumericLessThanEquals: { 'sts:DurationSeconds': IDENTITY_TOKEN_SECONDS },
          StringEquals: { 'sts:SigningAlgorithm': 'RS256' },
        },
      }),
    );
  }
  return role;
}
