import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import type { AnthropicFederation } from './anthropic-federation';
import { SharedAlarms } from './shared-alerts';
import { type SharedAuthConfig, sharedAuthRegion } from './shared-auth';

const here = path.dirname(fileURLToPath(import.meta.url));

/** agent/scripts/package.sh の出力先（ARM64 向けの依存を同梱したディレクトリ） */
export const AGENT_PACKAGE_DIR = path.resolve(here, '../../agent/dist/package');

/**
 * Bedrock の既定のモデル。Claude API（下の DEFAULT_ANTHROPIC_MODEL_CHAT）が使えないときの控えで、
 * ID 連携の値（context `anthropicFederation`）が無い環境ではこれだけで答える。
 * - Kimi K3 は東京からは Global プロファイルしか無い
 * - Sonnet 5 / Opus 5.5 はアカウント単位のアクセス制限で使えない（利用実績を積むと緩和される）
 * `-c agentModelId=...` / `-c agentFallbackModelId=...` で切り替えられる（予備は空なら使わない）。
 */
export const DEFAULT_MODEL_ID = 'global.moonshotai.kimi-k3';
export const DEFAULT_FALLBACK_MODEL_ID = '';

/**
 * Claude API のモデル（AI チャットの既定の呼び先）。Max プランに付く月々のクレジットで払う。
 * 品質が足りなければ claude-sonnet-5-5 に上げる（`-c agentAnthropicModel=...`）。
 */
export const DEFAULT_ANTHROPIC_MODEL_CHAT = 'claude-haiku-5-5';

/**
 * STS に頼む ID トークン（JWT）の宛先と寿命。agent/src/llm.py の IDENTITY_TOKEN_* と、
 * Claude Console のフェデレーションルールの audience に合わせてある。
 */
export const IDENTITY_TOKEN_AUDIENCE = 'https://api.anthropic.com';
export const IDENTITY_TOKEN_SECONDS = 300;

/** 1 人あたり 1 日（日本時間）に相談できる回数。agent/src/quota.py が数える */
export const CHAT_DAILY_LIMIT = 50;

/** サイト全体の相談回数がこの回数 / 1 時間に達したら通知する */
export const CHAT_INVOCATIONS_ALARM_PER_HOUR = 60;

/** AWS 公式ドキュメントを検索・参照できるリモート MCP サーバー（認証不要） */
export const AWS_KNOWLEDGE_MCP_URL = 'https://knowledge-mcp.global.api.aws';

export interface AgentStackProps extends StackProps {
  envName: string;
  /** 共通ログインの接続先（cdk.json の context `sharedAuth`） */
  sharedAuth: SharedAuthConfig;
  questionsBucket: s3.IBucket;
  modelId?: string;
  fallbackModelId?: string;
  /** Claude API のモデル。省略時は DEFAULT_ANTHROPIC_MODEL_CHAT */
  anthropicModel?: string;
  /** Claude API の ID 連携（cdk.json の context `anthropicFederation`）。無ければ Bedrock だけで答える */
  anthropicFederation?: AnthropicFederation;
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
    const anthropicModel = props.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL_CHAT;
    const federation = props.anthropicFederation;

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
        // Claude API が使えないときの控え（Kimi K3）にも使うので、ID 連携を入れても残す。
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
    /*
     * Claude API に入るための ID トークン（JWT）を STS からもらう権限。宛先は Anthropic だけ、
     * 寿命はエージェントが頼む長さまで、署名は RS256 に絞る。JWT は短命で、Anthropic の側でも
     * ルール（発行者・このロールの ARN・宛先）に合うものしか交換されない。API キーは持たない
     */
    if (federation) {
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

    questionsBucket.grantRead(role);

    // 相談回数の上限（ユーザーごと・1 日ごと）。Runtime はブラウザから直接呼ばれ、API のスロットリングが
    // 効かないため、アカウントの乗っ取りや連続呼び出しで Bedrock の費用がかさまないよう、モデルを呼ぶ前に数える。
    // キーは sub の SHA-256 と日付。古い日の記録は TTL で消える
    const quotaTable = new dynamodb.TableV2(this, 'ChatQuotaTable', {
      tableName: `${envName}-sakekasu-learning-chat-quota`,
      partitionKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'day', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // 条件付きの加算だけを行う。読み取りや削除の権限は渡さない
    quotaTable.grant(role, 'dynamodb:UpdateItem');

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
        ...(federation
          ? {
              LLM_PROVIDER: 'anthropic',
              ANTHROPIC_MODEL_CHAT: anthropicModel,
              ANTHROPIC_FEDERATION_RULE_ID: federation.ruleId,
              ANTHROPIC_ORGANIZATION_ID: federation.organizationId,
              ANTHROPIC_SERVICE_ACCOUNT_ID: federation.serviceAccountId,
              ...(federation.workspaceId ? { ANTHROPIC_WORKSPACE_ID: federation.workspaceId } : {}),
            }
          : { LLM_PROVIDER: 'bedrock' }),
        QUESTIONS_BUCKET_NAME: questionsBucket.bucketName,
        COGNITO_USER_POOL_ID: sharedAuth.userPoolId,
        COGNITO_CLIENT_ID: sharedAuth.clientId,
        AWS_KNOWLEDGE_MCP_URL,
        CHAT_QUOTA_TABLE_NAME: quotaTable.tableName,
        CHAT_DAILY_LIMIT: String(CHAT_DAILY_LIMIT),
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
        `まず ${runtimeLogs} と、モデル（${federation ? `${anthropicModel} / ` : ''}${modelId}）の利用制限を見る`,
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

    // 相談が急に増えたとき（1 人の上限を短時間で使い切る動き、利用者の急増）に気づくため。
    // 上限で断った相談も Runtime の呼び出しとして数える（費用はほぼかからないが、異常な呼び出しの兆候になる）
    alarms.add('AgentInvocationsHigh', {
      name: 'agent-invocations-high',
      description:
        `AI チャットへの相談が 1 時間に ${CHAT_INVOCATIONS_ALARM_PER_HOUR} 回を超えています。` +
        `Bedrock の費用が増えます。まず ${runtimeLogs} で、同じ利用者から連続して呼ばれていないか` +
        `（「1 日の上限に達したため断りました」が続いていないか）を見る`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock-AgentCore',
        metricName: 'Invocations',
        dimensionsMap: { ResourceId: runtime.attrAgentRuntimeArn },
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: CHAT_INVOCATIONS_ALARM_PER_HOUR,
    });

    // Claude API で答えられず Bedrock に回した相談（agent/src/main.py の「[chat] fallback」の行）。
    // クレジット切れや ID 連携の設定の誤りに気づくため。理由はログの errorType を見る（docs/claude-api.md）。
    // ロググループは AgentCore が最初の呼び出しで作る（Runtime ID と DEFAULT エンドポイントの名前）
    if (federation) {
      const runtimeLogGroup = logs.LogGroup.fromLogGroupName(
        this,
        'RuntimeLogGroup',
        `/aws/bedrock-agentcore/runtimes/${runtime.attrAgentRuntimeId}-DEFAULT`,
      );
      const fallbacks = new logs.MetricFilter(this, 'ChatFallbackFilter', {
        logGroup: runtimeLogGroup,
        filterName: `sakekasu-learning-${envName}-chat-fallbacks`,
        filterPattern: logs.FilterPattern.literal('"[chat] fallback"'),
        metricNamespace: 'sakekasu-learning',
        metricName: `${envName}-chat-fallbacks`,
        metricValue: '1',
      });
      alarms.add('AgentChatFallbacks', {
        name: 'agent-chat-fallbacks',
        description:
          `AI チャットが Claude API（${anthropicModel}）で答えられず、Bedrock（${modelId}）に回しています。` +
          `Bedrock の費用が増えます。まず ${runtimeLogs} の「[chat] fallback」の errorType を見る` +
          '（credit_balance ならクレジット切れ、credentials / authentication なら Claude Console の ID 連携の設定）',
        metric: fallbacks.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
        threshold: 1,
      });
    }

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    new CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, 'ChatQuotaTableName', { value: quotaTable.tableName });
  }
}
