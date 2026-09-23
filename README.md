# sakekasu learning

資格試験（AWS / OCI / Terraform ...）の問題演習サイト。<https://learning.sakekasu-builder.com/>

- 招待制のログイン（Cognito）。MFA 必須（認証アプリの TOTP）。回答履歴をユーザーごとに記録し、直近2回の正誤で習熟度を判定する
- 問題文はそのまま、選択肢は毎回シャッフルして出題する。解説は回答後に折りたたみで表示する
- 問題ごとに AI（Claude Sonnet）に相談できる。AWS 公式ドキュメントを MCP で参照しながら答える

## 習熟度の判定

| 直近の結果 | 判定 |
|---|---|
| 正解 → 正解 | バッチリ |
| 正解と不正解が混在 / 1回だけ回答して正解 | あいまい |
| 不正解 → 不正解 / 1回だけ回答して不正解 | 苦手 |
| 回答なし | 未回答 |

判定ロジックは [shared/mastery.ts](shared/mastery.ts)。

## 構成

```
ブラウザ ──> CloudFront (us-east-1, OAC) ──> S3 (静的サイト)
   │
   ├──> Cognito User Pool（招待制・SRP）
   ├──> API Gateway HTTP API (JWT) ──> Lambda ──> DynamoDB（回答履歴）
   │                                        └──> S3（問題データ・非公開）
   └──> AgentCore Runtime (JWT, Strands) ──> Bedrock (Claude Sonnet)
                                         ├──> S3（問題データ・非公開）
                                         └──> AWS Knowledge MCP（公式ドキュメント検索）
```

- すべてサーバーレス。固定費はほぼゼロで、ランニングコストの大半は Bedrock の利用料になる
- 正解と解説は回答を送信するまで API が返さない。採点もサーバーで行う
- AI チャットは問題の本文・正解・解説をクライアントから受け取らず、Runtime が非公開バケットから読む
- CloudFront の証明書は us-east-1 にしか置けないため、配信スタックだけ us-east-1。フロントは起動時に `/config.json` を読んで接続先を知るので、リージョンをまたいだスタック参照は無い

| スタック | リージョン | 内容 |
|---|---|---|
| `sakekasu-learning-dev-auth` | ap-northeast-1 | Cognito User Pool / App Client |
| `sakekasu-learning-dev-backend` | ap-northeast-1 | DynamoDB、問題データ用 S3、HTTP API + Lambda |
| `sakekasu-learning-dev-agent` | ap-northeast-1 | AgentCore Runtime（Python 3.13, CodeZip） |
| `sakekasu-learning-dev-web` | us-east-1 | ACM、S3、CloudFront、Route 53 レコード |
| `sakekasu-learning-github-oidc` | ap-northeast-1 | GitHub Actions 用ロール（手動デプロイ） |

## ディレクトリ

```
content/   問題メモ（Markdown）。<分野>/<資格>/*.md
shared/    web と Lambda で共有する型・習熟度判定
web/       フロントエンド（React 19 / Vite / Tailwind CSS v4 / aws-amplify）
infra/     CDK（TypeScript）、API Lambda、問題ビルドスクリプト
agent/     AI 家庭教師（Strands Agents / AgentCore Runtime）
```

## 問題の追加

1. `content/<分野>/category.json` と `content/<分野>/<資格>/exam.json` を用意する（初回のみ）

   ```json
   // content/aws/category.json
   { "name": "AWS", "description": "AWS 認定資格", "order": 1 }
   // content/aws/sap-c02/exam.json
   { "name": "AWS Certified Solutions Architect - Professional", "code": "SAP-C02", "order": 20 }
   ```

   ディレクトリ名は URL に使うため英小文字・数字・ハイフンのみ。
2. 問題メモ（[content/FORMAT.md](content/FORMAT.md) の形式）を `content/<分野>/<資格>/` に置く。ファイルは複数に分けてよい
3. 形式チェックを通す: `cd infra && npm run check:questions`
4. main にマージすると CI が JSON に変換して S3 に同期する

形式チェックでは、解説の欠け・正解ゼロ・「（2 つ選択）」と正解数の不一致・問題番号の重複を検出して失敗させる。

## 初回セットアップ

前提: sakekasu-builder と同じアカウント（232791540685）で、CDK のブートストラップが ap-northeast-1 と us-east-1 の両方で済んでいること。

### 1. DNS（サブドメインの委任）

`sakekasu-builder.com` の権威ゾーンは管理アカウント（<管理アカウント ID>）にある。sakekasu-kakeibo と同じく、
このアカウントに `learning.sakekasu-builder.com` のゾーンを作り、親ゾーンから NS で委任する。

```bash
# 232791540685 にサブドメインのゾーンを作る（出力のゾーン ID と NS を控える）
AWS_PROFILE=sakekasu-builder aws route53 create-hosted-zone \
  --name learning.sakekasu-builder.com --caller-reference sakekasu-learning-$(date +%Y%m%d) \
  --hosted-zone-config '{"Comment":"sakekasu-learning delivery zone - delegated from parent"}' \
  --query "[HostedZone.Id,DelegationSet.NameServers]"

# 管理アカウントの親ゾーン（Z0378029DKDVAJ2VE475）に NS レコードを足す
AWS_PROFILE=yuuuuuuuki7749 aws route53 change-resource-record-sets \
  --hosted-zone-id Z0378029DKDVAJ2VE475 --change-batch file://ns-delegation.json
```

`ns-delegation.json` の例（NS は上で控えた4つ）:

```json
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "learning.sakekasu-builder.com",
      "Type": "NS",
      "TTL": 3600,
      "ResourceRecords": [{ "Value": "ns-xxx.awsdns-xx.org" }, { "Value": "..." }, { "Value": "..." }, { "Value": "..." }]
    }
  }]
}
```

最後に、控えたゾーン ID（`Z` から始まる部分）を `infra/cdk.json` の `hostedZoneId` に入れてコミットする。

### 2. GitHub Actions 用ロール（CI 自身の権限なので手動）

```bash
cd infra && npm ci
AWS_PROFILE=sakekasu-builder npx cdk deploy sakekasu-learning-github-oidc -c github-oidc=true
```

その後 main に push すると deploy ワークフローが全スタックと問題データ・フロントエンドをデプロイする。

### Bedrock のモデル

既定は Sonnet 5（`global.anthropic.claude-sonnet-5`、東京からは Global プロファイルのみ）。
応答を返し始める前に失敗したときは Opus 5.5（`jp.anthropic.claude-opus-5-5`、国内プロファイル）で答え直す。
`infra/cdk.json` の context の `agentModelId` / `agentFallbackModelId` で変更できる。

Bedrock の Anthropic の新しいモデルは、モデルごとに利用契約が必要（未契約だと `AccessDeniedException: ... is not available for this account`）。

```bash
M=anthropic.claude-sonnet-5
T=$(AWS_PROFILE=sakekasu-builder aws bedrock list-foundation-model-agreement-offers --model-id $M --query 'offers[0].offerToken' --output text)
AWS_PROFILE=sakekasu-builder aws bedrock create-foundation-model-agreement --model-id $M --offer-token "$T"
AWS_PROFILE=sakekasu-builder aws bedrock get-foundation-model-availability --model-id $M   # agreementAvailability が AVAILABLE になれば利用可
```

## ユーザーの招待

セルフサインアップは無効。管理者がユーザーを作ると、仮パスワードがメールで届く。
初回ログインではパスワードの変更と、認証アプリ（Google Authenticator など）の登録を求められる。

```bash
USER_POOL_ID=$(AWS_PROFILE=sakekasu-builder aws cloudformation describe-stacks \
  --stack-name sakekasu-learning-dev-auth \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

AWS_PROFILE=sakekasu-builder aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Cognito の既定のメール送信は1日あたりの上限が小さいため、大人数を招待する場合は SES の設定を検討する。

## ローカル開発

```bash
# 依存
(cd infra && npm ci) && (cd web && npm ci) && (cd agent && uv sync --group dev)

# デプロイ済みの dev 環境に接続する config.json を作る
cd infra && AWS_PROFILE=sakekasu-builder npx tsx scripts/write-web-config.ts ../web/public/config.json

# フロントエンド（http://localhost:5173 は API の CORS で許可済み）
cd web && npm run dev

# テスト
(cd infra && npm test) && (cd web && npm test) && (cd agent && uv run --group dev pytest)
```

## CI/CD

| ワークフロー | トリガー | 内容 |
|---|---|---|
| `test.yml` | PR / main | 問題の形式チェック、infra / web / agent のテスト |
| `cdk-diff.yml` | PR（infra・agent） | `cdk diff` を PR にコメント |
| `deploy.yml` | main | cdk deploy → 問題データ同期 → フロント同期 → キャッシュ削除 |

AWS へは GitHub OIDC で入る。deploy ロールは main ブランチからだけ、diff ロールは PR からだけ引き受けられる。
