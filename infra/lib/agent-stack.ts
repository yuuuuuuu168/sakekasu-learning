import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import { SharedAlarms } from './shared-alerts';
import { type SharedAuthConfig, sharedAuthRegion } from './shared-auth';

const here = path.dirname(fileURLToPath(import.meta.url));

/** agent/scripts/package.sh の出力先（ARM64 向けの依存を同梱したディレクトリ） */
export const AGENT_PACKAGE_DIR = path.resolve(here, '../../agent/dist/package');

/**
 * 既定のモデル。Kimi K3 だけを使い、予備のモデルは置かない。
 * - Kimi K3 は東京からは Global プロファイルしか無い
 * - Sonnet 5 / Opus 5.5 はアカウント単位のアクセス制限で使えない（利用実績を積むと緩和される）
 * `-c agentModelId=...` / `-c agentFallbackModelId=...` で切り替えられる（予備は空なら使わない）。
 */
export const DEFAULT_MODEL_ID = 'global.moonshotai.kimi-k3';
export const DEFAULT_FALLBACK_MODEL_ID = '';

/** AWS 公式ドキュメントを検索・参照できるリモート MCP サーバー（認証不要） */
export const AWS_KNOWLEDGE_MCP_URL = 'https://knowledge-mcp.global.api.aws';

export interface AgentStackProps extends StackProps {
  envName: string;
  /** 共通ログインの接続先（cdk.json の context `sharedAuth`） */
  sharedAuth: SharedAuthConfig;
  questionsBucket: s3.IBucket;
  modelId?: string;
  fallbackModelId?: string;
}

/**
 * AI チャット（AgentCore Runtime + Strands Agents）。
 *
 * ブラウザから共通ログイン（Cognito）のアクセストークンで直接呼び出す（JWT オーソライザー）。
 * 問題の本文・正解・解説はクライアントから受け取らず、Runtime が非公開バケットから読む。
 */
export class AgentStack extends Stack {
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { envName, sharedAuth, questionsBucket } = props;
    const modelId = props.modelId ?? DEFAULT_MODEL_ID;
    const fallbackModelId = props.fallbackModelId ?? DEFAULT_FALLBACK_MODEL_ID;

    if (!existsSync(path.join(AGENT_PACKAGE_DIR, 'main.py'))) {
      throw new Error(
        `エージェントのパッケージがありません: ${AGENT_PACKAGE_DIR}\n` +
          '先に `npm run package:agent`（infra/ で実行）を実行してください',
      );
    }
    const code = new Asset(this, 'AgentCode', { path: AGENT_PACKAGE_DIR });

    const role = new iam.Role(this, 'RuntimeRole', {
      roleName: `sakekasu-learning-${envName}-agent-runtime`,
      description: 'Execution role for the sakekasu-learning AgentCore Runtime',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeModels',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        // Global / Geo 推論プロファイルは、呼び出し元リージョンのプロファイルと
        // ルーティング先の全リージョンの基盤モデルの両方に権限が要る。
        // Claude はアクセス制限が解けたら context で戻せるように残しておく
        resources: ['anthropic.claude-*', 'moonshotai.kimi-*'].flatMap((model) => [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*.${model}`,
          `arn:aws:bedrock:*::foundation-model/${model}`,
          `arn:aws:bedrock:::foundation-model/${model}`,
        ]),
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Logs',
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeLogGroups',
        actions: ['logs:DescribeLogGroups'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`],
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
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
        ],
      }),
    );
    questionsBucket.grantRead(role);

    // 共通ユーザープールが learning のクライアントに発行したトークンだけを通す。
    const discoveryUrl =
      `https://cognito-idp.${sharedAuthRegion(sharedAuth)}.amazonaws.com/${sharedAuth.userPoolId}` +
      '/.well-known/openid-configuration';

    const runtime = new agentcore.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: `sakekasu_learning_${envName}_tutor`,
      description: 'sakekasu-learning AI tutor (Strands Agents)',
      roleArn: role.roleArn,
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: code.s3BucketName, prefix: code.s3ObjectKey } },
          entryPoint: ['main.py'],
          runtime: 'PYTHON_3_13',
        },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'HTTP',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl,
          allowedClients: [sharedAuth.clientId],
        },
      },
      // アプリ側でも JWT を検証して sub を取り出すため、Authorization ヘッダーを通す
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      // 会話はクライアントが持つため、セッションを長く温めておく必要はない。
      // アイドル時間を短くしてメモリ課金を抑える
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
      environmentVariables: {
        MODEL_ID: modelId,
        ...(fallbackModelId ? { FALLBACK_MODEL_ID: fallbackModelId } : {}),
        QUESTIONS_BUCKET_NAME: questionsBucket.bucketName,
        COGNITO_USER_POOL_ID: sharedAuth.userPoolId,
        COGNITO_CLIENT_ID: sharedAuth.clientId,
        AWS_KNOWLEDGE_MCP_URL,
      },
    });
    runtime.node.addDependency(role);

    // --- 監視（共通基盤のトピックへ ALARM と OK を送る。docs/monitoring.md）---
    // AgentCore Runtime の指標は名前空間 AWS/Bedrock-AgentCore、ディメンション ResourceId（Runtime の ARN）。
    // sakekasu-builder のソムリエと同じ形で、builder では実際にこの形で出ている
    const alarms = new SharedAlarms(this, 'Alarms', { envName });
    const runtimeLogs = 'ロググループ /aws/bedrock-agentcore/runtimes/sakekasu_learning_*';
    const agentCoreMetric = (metricName: string, extra: Record<string, string> = {}) =>
      new cloudwatch.Metric({
        namespace: 'AWS/Bedrock-AgentCore',
        metricName,
        dimensionsMap: { ResourceId: runtime.attrAgentRuntimeArn, ...extra },
        statistic: 'Sum',
        period: Duration.minutes(5),
      });

    alarms.add('AgentSystemErrors', {
      name: 'agent-system-errors',
      description:
        'AI チャットの Runtime がシステムエラーを返しています（チャットが応答しません）。' +
        `まず ${runtimeLogs} と、モデル（${modelId}）の利用制限を見る`,
      metric: agentCoreMetric('SystemErrors'),
      threshold: 1,
    });

    alarms.add('AgentThrottles', {
      name: 'agent-throttles',
      description:
        'AI チャットの Runtime がスロットリングされています。' +
        'まず AgentCore のクォータ（同時セッション数・呼び出しレート）と、短時間に連続して呼ばれていないかを見る',
      metric: agentCoreMetric('Throttles'),
      threshold: 1,
    });

    // 認可の失敗。共通ログインへ移った直後なので、allowedClients やユーザープールの取り違えで
    // 正規の利用者が全員はじかれる事故をここで拾う。トークン切れの単発で鳴らないよう、5 分に 3 回から
    // （builder のソムリエと同じ閾値）。例外の種類はディメンション ExceptionType で分かれて出る
    for (const [id, name, exceptionType] of [
      ['AgentAuthUnauthorized', 'agent-auth-unauthorized', 'UnauthorizedInboundTokenException'],
      ['AgentAuthInvalidToken', 'agent-auth-invalid-token', 'InvalidInboundTokenException'],
    ] as const) {
      alarms.add(id, {
        name,
        description:
          `AI チャットの Runtime がトークンを拒否しています（${exceptionType}）。` +
          '利用者はチャットを使えません。まず Runtime の allowedClients と discoveryUrl が ' +
          'cdk.json の sharedAuth（共通ログインのユーザープールと learning のクライアント ID）と合っているかを見る',
        metric: agentCoreMetric('InboundAuthorizationFailure', { ExceptionType: exceptionType }),
        threshold: 3,
      });
    }

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    new CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
  }
}
