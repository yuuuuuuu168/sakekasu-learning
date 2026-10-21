import { Duration, type Stack } from 'aws-cdk-lib';
import type * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import { SharedAlarms } from './shared-alerts';

/** サイト全体の相談回数がこの回数 / 1 時間に達したら通知する */
export const CHAT_INVOCATIONS_ALARM_PER_HOUR = 60;

/**
 * AI チャットの監視（共通基盤のトピックへ ALARM と OK を送る。docs/monitoring.md）。
 *
 * 論理 ID を変えないよう、アラームとメトリクスフィルターはスタックの直下に作る
 * （コンストラクトで包まない。test/physical-names.test.ts）
 */
export function addAgentAlarms(
  stack: Stack,
  props: {
    envName: string;
    runtime: agentcore.CfnRuntime;
    /** Bedrock のモデル（説明文に出す） */
    modelId: string;
    /** Claude API のモデル。ID 連携が無い環境では undefined */
    anthropicModel?: string;
  },
): void {
  const { envName, runtime, modelId, anthropicModel } = props;
  // AgentCore Runtime の指標は名前空間 AWS/Bedrock-AgentCore、ディメンション ResourceId（Runtime の ARN）。
  // sakekasu-builder のソムリエと同じ形で、builder では実際にこの形で出ている
  const alarms = new SharedAlarms(stack, 'Alarms', { envName });
  const runtimeLogs = 'ロググループ /aws/bedrock-agentcore/runtimes/sakekasu_learning_*';
  const agentCoreMetric = (metricName: string, extra: Record<string, string> = {}, period = Duration.minutes(5)) =>
    new cloudwatch.Metric({
      namespace: 'AWS/Bedrock-AgentCore',
      metricName,
      dimensionsMap: { ResourceId: runtime.attrAgentRuntimeArn, ...extra },
      statistic: 'Sum',
      period,
    });

  alarms.add('AgentSystemErrors', {
    name: 'agent-system-errors',
    description:
      'AI チャットの Runtime がシステムエラーを返しています（チャットが応答しません）。' +
      `まず ${runtimeLogs} と、モデル（${anthropicModel ? `${anthropicModel} / ` : ''}${modelId}）の利用制限を見る`,
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
    metric: agentCoreMetric('Invocations', {}, Duration.hours(1)),
    threshold: CHAT_INVOCATIONS_ALARM_PER_HOUR,
  });

  // Claude API で答えられず Bedrock に回した相談（agent/src/main.py の「[chat] fallback」の行）。
  // クレジット切れや ID 連携の設定の誤りに気づくため。理由はログの errorType を見る（docs/claude-api.md）。
  // ロググループは AgentCore が最初の呼び出しで作る（Runtime ID と DEFAULT エンドポイントの名前）
  if (anthropicModel) {
    const runtimeLogGroup = logs.LogGroup.fromLogGroupName(
      stack,
      'RuntimeLogGroup',
      `/aws/bedrock-agentcore/runtimes/${runtime.attrAgentRuntimeId}-DEFAULT`,
    );
    const fallbacks = new logs.MetricFilter(stack, 'ChatFallbackFilter', {
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
}
