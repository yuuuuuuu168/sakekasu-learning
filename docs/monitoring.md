# 監視と通知

アラームはこのリポジトリのスタック（backend、agent）が持ち、通知は共通基盤
（sakekasu-integrated_environment）の SNS トピック `sakekasu-integrated-alerts`（ap-northeast-1）へ送る。
共通基盤がそれを Slack に流す。Slack の見出しには、アラーム名の接頭辞 `dev-sakekasu-learning-` から引いた
「learning」が出る。

送り方の約束（ALARM と OK の両方を送る、接頭辞で始める、ap-northeast-1 に置く、treatMissingData の考え方）は
共通基盤の [docs/monitoring.md](https://github.com/yuuuuuuu168/sakekasu-integrated_environment/blob/main/docs/monitoring.md)
の「各アプリからアラームを送る」節にある。

## 作り

- 共通の作りは [infra/lib/shared-alerts.ts](../infra/lib/shared-alerts.ts) の `SharedAlarms`。
  トピックの ARN はアカウント ID から組み立てる（`arn:aws:sns:ap-northeast-1:<アカウント>:sakekasu-integrated-alerts`）。
  共通基盤のスタックの出力は参照しない
- アラームは監視するリソースと同じスタックに置く。スタックの間の参照を増やさないため
- トピックポリシーは共通基盤の側で CloudWatch からの publish を許している。こちらで SNS の権限は足さない。
  cdkd 用ロール（`sakekasu-learning-cdkd-deploy`）は AdministratorAccess なので、アラームの作成に追加の権限は要らない
- web スタック（us-east-1）にはアラームを置かない。トピックと別のリージョンから届くかは確かめられておらず、
  サイトの死活は共通基盤の外形監視が見ている

## アラーム一覧

名前は `dev` 環境のもの（`${env}-sakekasu-learning-…`）。どれも 5 分間の合計で、1 期間で判定する。
treatMissingData はすべて `NOT_BREACHING`（起きたときだけ値が出る指標なので、利用が無い時間に鳴らさない）。

| アラーム名 | スタック | 指標 | 条件 |
| --- | --- | --- | --- |
| `dev-sakekasu-learning-api-errors` | backend | `AWS/Lambda` Errors（API の Lambda） | 1 回以上 |
| `dev-sakekasu-learning-api-throttles` | backend | `AWS/Lambda` Throttles（API の Lambda） | 1 回以上 |
| `dev-sakekasu-learning-api-5xx` | backend | `AWS/ApiGateway` 5xx（ディメンション ApiId） | 3 回以上 |
| `dev-sakekasu-learning-progress-throttles` | backend | `AWS/DynamoDB` ReadThrottleEvents + WriteThrottleEvents（回答履歴） | 1 回以上 |
| `dev-sakekasu-learning-agent-system-errors` | agent | `AWS/Bedrock-AgentCore` SystemErrors | 1 回以上 |
| `dev-sakekasu-learning-agent-throttles` | agent | `AWS/Bedrock-AgentCore` Throttles | 1 回以上 |
| `dev-sakekasu-learning-agent-auth-unauthorized` | agent | `AWS/Bedrock-AgentCore` InboundAuthorizationFailure（UnauthorizedInboundTokenException） | 3 回以上 |
| `dev-sakekasu-learning-agent-auth-invalid-token` | agent | `AWS/Bedrock-AgentCore` InboundAuthorizationFailure（InvalidInboundTokenException） | 3 回以上 |

補足:

- API の Lambda は想定外の例外を捕まえて 500 を返す。そのため Lambda の Errors に出るのはタイムアウトや
  起動時の失敗だけで、ふつうの失敗は HTTP API の 5xx に出る。5xx は一時的な 1 回で鳴らさないよう 3 回から
- DynamoDB の ThrottledRequests は Operation のディメンションつきでしか出ないため、テーブル単位で出る
  Read/WriteThrottleEvents を足して見る
- AgentCore の指標のディメンションは ResourceId（Runtime の ARN）。認可失敗はさらに ExceptionType で分かれる。
  共通ログインへ移った直後なので、allowedClients の取り違えなどで全員がはじかれる事故を拾うために入れている。
  トークン切れの単発で鳴らないよう、5 分に 3 回から（sakekasu-builder のソムリエと同じ）

## 届いているかを確かめる

アラームの状態ではなく、アクションの履歴を見る（読み取り専用の `verify` プロファイルで読める）。

```sh
aws cloudwatch describe-alarm-history --profile verify --region ap-northeast-1 \
  --alarm-name dev-sakekasu-learning-api-errors \
  --history-item-type Action --query 'AlarmHistoryItems[].[Timestamp,HistorySummary]'
```

`Failed to execute action` が出ていれば、トピックポリシーで拒否されている。
