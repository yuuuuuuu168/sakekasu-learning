import { Stack, Token } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * 共通基盤（sakekasu-integrated_environment）の通知先トピック。固定名で ap-northeast-1 にある。
 * 届いたアラームは共通基盤の Lambda が Slack に流す。
 */
export const SHARED_ALERT_TOPIC_NAME = 'sakekasu-integrated-alerts';
export const SHARED_ALERT_REGION = 'ap-northeast-1';

/**
 * アラーム名の接頭辞。共通基盤の Slack 通知はこの接頭辞からアプリ名（learning）を引く。
 * 当たらないと Slack に「不明なアプリ」と出る
 */
export function alarmPrefix(envName: string): string {
  return `${envName}-sakekasu-learning-`;
}

export interface SharedAlarmOptions {
  /** 接頭辞より後ろの部分（例: `api-errors`） */
  name: string;
  /** 何が起きているか・まず見るところ。Slack にそのまま出る */
  description: string;
  metric: cloudwatch.IMetric;
  threshold: number;
  evaluationPeriods?: number;
  /**
   * データが無い期間の扱い。既定は NOT_BREACHING（起きたときだけ値が出る指標向け）。
   * 呼び出しが無い夜中に「データ不足」で鳴らさないため
   */
  treatMissingData?: cloudwatch.TreatMissingData;
  comparisonOperator?: cloudwatch.ComparisonOperator;
}

/**
 * スタックごとに共通基盤のトピックを取り込み、ALARM と OK の両方を送るアラームを作る。
 *
 * ARN はアカウント ID から組み立て、共通基盤のスタックの出力は参照しない
 * （参照でつなぐと、向こうのスタックを作り直せなくなる）。
 * トピックポリシーは共通基盤の側で CloudWatch からの publish を許してあるので、ここでは権限を足さない。
 */
export class SharedAlarms extends Construct {
  readonly topic: sns.ITopic;
  readonly alarms: cloudwatch.Alarm[] = [];
  private readonly prefix: string;

  constructor(scope: Construct, id: string, props: { envName: string }) {
    super(scope, id);
    const stack = Stack.of(this);
    // トピックと同じリージョンに置く約束。us-east-1 のアラームから届くかは確かめられていない
    if (!Token.isUnresolved(stack.region) && stack.region !== SHARED_ALERT_REGION) {
      throw new Error(
        `共通基盤の通知先は ${SHARED_ALERT_REGION} にあるため、アラームは ${SHARED_ALERT_REGION} のスタックに置く（このスタックは ${stack.region}）`,
      );
    }
    this.prefix = alarmPrefix(props.envName);
    this.topic = sns.Topic.fromTopicArn(
      this,
      'Topic',
      `arn:aws:sns:${SHARED_ALERT_REGION}:${stack.account}:${SHARED_ALERT_TOPIC_NAME}`,
    );
  }

  add(id: string, options: SharedAlarmOptions): cloudwatch.Alarm {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: `${this.prefix}${options.name}`,
      alarmDescription: options.description,
      metric: options.metric,
      threshold: options.threshold,
      evaluationPeriods: options.evaluationPeriods ?? 1,
      comparisonOperator:
        options.comparisonOperator ??
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: options.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // 復旧の通知が無いと、直ったかどうかが Slack だけでは分からないので OK も送る
    const action = new actions.SnsAction(this.topic);
    alarm.addAlarmAction(action);
    alarm.addOkAction(action);
    this.alarms.push(alarm);
    return alarm;
  }
}
