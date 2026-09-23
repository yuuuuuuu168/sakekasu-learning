import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import type { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));

/** agent/scripts/package.sh の出力先（ARM64 向けの依存を同梱したディレクトリ） */
export const AGENT_PACKAGE_DIR = path.resolve(here, '../../agent/dist/package');

/**
 * 既定のモデル。Sonnet 5 を優先し、応答前に失敗したら Opus 5.5 で答え直す。
 * - Sonnet 5 は東京からは Global プロファイルしか無い
 * - Opus 5.5 は国内（jp）プロファイルがある
 * どちらも Bedrock のモデル利用契約（create-foundation-model-agreement）が必要。
 * `-c agentModelId=...` / `-c agentFallbackModelId=...` で切り替えられる。
 */
export const DEFAULT_MODEL_ID = 'global.anthropic.claude-sonnet-5';
export const DEFAULT_FALLBACK_MODEL_ID = 'jp.anthropic.claude-opus-5-5';

/** AWS 公式ドキュメントを検索・参照できるリモート MCP サーバー（認証不要） */
export const AWS_KNOWLEDGE_MCP_URL = 'https://knowledge-mcp.global.api.aws';

export interface AgentStackProps extends StackProps {
  envName: string;
  userPool: cognito.IUserPool;
  userPoolClient: cognito.IUserPoolClient;
  questionsBucket: s3.IBucket;
  modelId?: string;
  fallbackModelId?: string;
}

/**
 * AI チャット（AgentCore Runtime + Strands Agents）。
 *
 * ブラウザから Cognito のアクセストークンで直接呼び出す（JWT オーソライザー）。
 * 問題の本文・正解・解説はクライアントから受け取らず、Runtime が非公開バケットから読む。
 */
export class AgentStack extends Stack {
  readonly runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { envName, userPool, userPoolClient, questionsBucket } = props;
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
        sid: 'InvokeClaude',
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        // Global / Geo 推論プロファイルは、呼び出し元リージョンのプロファイルと
        // ルーティング先の全リージョンの基盤モデルの両方に権限が要る
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*.anthropic.claude-*`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
          'arn:aws:bedrock:::foundation-model/anthropic.claude-*',
        ],
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

    const discoveryUrl =
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}` +
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
          allowedClients: [userPoolClient.userPoolClientId],
        },
      },
      // アプリ側でも JWT を検証して sub を取り出すため、Authorization ヘッダーを通す
      requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
      // 会話はクライアントが持つため、セッションを長く温めておく必要はない。
      // アイドル時間を短くしてメモリ課金を抑える
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
      environmentVariables: {
        MODEL_ID: modelId,
        FALLBACK_MODEL_ID: fallbackModelId,
        QUESTIONS_BUCKET_NAME: questionsBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        AWS_KNOWLEDGE_MCP_URL,
      },
    });
    runtime.node.addDependency(role);

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    new CfnOutput(this, 'RuntimeArn', { value: runtime.attrAgentRuntimeArn });
  }
}
