import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';
import { addAgentAlarms } from './agent-alarms';
import { createRuntimeRole } from './agent-runtime-role';
import type { AnthropicFederation } from './anthropic-federation';
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

/** 1 人あたり 1 日（日本時間）に相談できる回数。agent/src/quota.py が数える */
export const CHAT_DAILY_LIMIT = 50;

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

    const role = createRuntimeRole(this, { envName, anthropicFederation: !!federation });
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
      environmentVariables: runtimeEnvironment({
        modelId,
        fallbackModelId,
        anthropicModel,
        federation,
        questionsBucketName: questionsBucket.bucketName,
        sharedAuth,
        quotaTableName: quotaTable.tableName,
      }),
    });
    runtime.node.addDependency(role);

    addAgentAlarms(this, { envName, runtime, modelId, anthropicModel: federation ? anthropicModel : undefined });

    new CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
    new CfnOutput(this, 'ChatQuotaTableName', { value: quotaTable.tableName });
  }
}

/** Runtime の環境変数（agent/src の各モジュールが読む） */
export function runtimeEnvironment(props: {
  modelId: string;
  fallbackModelId: string;
  anthropicModel: string;
  federation?: AnthropicFederation;
  questionsBucketName: string;
  sharedAuth: SharedAuthConfig;
  quotaTableName: string;
}): Record<string, string> {
  const { federation } = props;
  return {
    MODEL_ID: props.modelId,
    ...(props.fallbackModelId ? { FALLBACK_MODEL_ID: props.fallbackModelId } : {}),
    ...(federation
      ? {
          LLM_PROVIDER: 'anthropic',
          ANTHROPIC_MODEL_CHAT: props.anthropicModel,
          ANTHROPIC_FEDERATION_RULE_ID: federation.ruleId,
          ANTHROPIC_ORGANIZATION_ID: federation.organizationId,
          ANTHROPIC_SERVICE_ACCOUNT_ID: federation.serviceAccountId,
          ...(federation.workspaceId ? { ANTHROPIC_WORKSPACE_ID: federation.workspaceId } : {}),
        }
      : { LLM_PROVIDER: 'bedrock' }),
    QUESTIONS_BUCKET_NAME: props.questionsBucketName,
    COGNITO_USER_POOL_ID: props.sharedAuth.userPoolId,
    COGNITO_CLIENT_ID: props.sharedAuth.clientId,
    AWS_KNOWLEDGE_MCP_URL,
    CHAT_QUOTA_TABLE_NAME: props.quotaTableName,
    CHAT_DAILY_LIMIT: String(CHAT_DAILY_LIMIT),
  };
}
