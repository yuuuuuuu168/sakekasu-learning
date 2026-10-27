# sakekasu-learning

資格試験の問題演習サイト。構成とセットアップは README.md を参照。

## 作業ルール

- 作業は feature ブランチで行い、PR を作る。main へのマージは人間様が行う
- AWS へのデプロイは main へのマージ経由（deploy.yml）だけ。ローカルからの `cdkd deploy` / `cdk deploy` は行わない（例外は `sakekasu-learning-github-oidc` スタックの `cdk deploy`）
- github-oidc 以外のスタックは cdkd（CloudFormation を使わない）で管理する。スタックの出力は `npx cdkd state show <スタック名> --json` で読む。cdkd のバージョンは `infra/package.json` で固定している
- ローカルの AWS CLI / CDK は `AWS_PROFILE=sakekasu-builder` を付けて実行する（アプリのアカウント）。クラウドセッションでは下の「AWS 確認作業の認証フロー」の読み取り専用プロファイルを使う

## PR を作ったら watch する

PR を作成したら、ユーザーの指示を待たずにそのまま `subscribe_pr_activity` を呼び、
その PR の CI とレビューコメントを watch する。毎回「watch して」と言わせない。

- watch を始めたら、PR の URL とあわせて一行で報告する
- CI が落ちたら原因を調べて直し、同じブランチに push する。落ちた理由が自分の変更と
  無関係（base ブランチが赤い等）なら、その旨を PR に一度だけ書く
- レビューコメントは対応するか、対応しない理由を返す。黙って終わらせない
- watch はマージまたはクローズまで続ける。止めるのはユーザーに言われたときだけ

PR 作成の直後には [scripts/pr-watch-reminder.mjs](scripts/pr-watch-reminder.mjs)（`PostToolUse`
フック）が PR 番号つきで watch を促す（GitHub の MCP ツールでも `gh pr create` でも）。
長いセッションでこの節が押し流されても効く。

## 応答の言語

応答は日本語で書く。[scripts/japanese-guard/](scripts/japanese-guard/)（`Stop` フック）が
ターンの最終回答を検査し、英語主体なら日本語で書き直させる。コードブロック・インラインコード・
URL は数えないので、英語のコマンドや英文の下書きはコードブロックに入れて見せる。

## AWS のインフラを触るとき

`infra/` の CDK、デプロイのワークフロー、IAM のどれかを触るときは、
[docs/aws-infra-rules.md](docs/aws-infra-rules.md) に従う。5 つのアプリが同じ AWS アカウントに
同居していて、名前とタグ、スタックのつなぎ方、デプロイの手順、デプロイ用ロールのガードレール、
アプリのロールの Permissions Boundary、cdkd の落とし穴をそこにまとめてある。
とくに次の 3 つは、破るとデプロイが止まるか、他のアプリやデータを壊す。

- 手元から `cdkd deploy` / `cdk deploy` を打たない（例外は GitHub Actions のロールのスタックと、builder の管理アカウントの billing-notifier）
- IAM ロールのプロパティを変えるときは、実物のロール名が cdkd の導く名前と一致するかを先に確かめる
- 他のアプリのリソースを、アプリのロールから使わない

## AWS 確認作業の認証フロー

AWS環境の確認が必要になったら、ユーザーの指示を待たずに次を実行する。

```sh
bash scripts/aws-sso-login.sh
```

AWS CLI v2 の導入、読み取り専用プロファイルの配置、SSO ログインの開始までをこれ一つで行う。
認証済みなら何もせず終わる。出力された確認URLとコードは、ツールを呼ぶ前にそのまま
ユーザーへの返答として提示し、承認されたと言われてから
`bash scripts/aws-sso-login.sh --wait` で完了を確かめる。

以降のAWS CLI操作には必ず次のどれかのプロファイルを付ける。1回の承認で全部に入れる。

| プロファイル | アカウント | 使いどころ |
| --- | --- | --- |
| `verify` | Web アプリのデプロイ先 | アプリのログ・メトリクス・リソースの確認 |
| `verify-org` | Organization の管理アカウント | 組織・請求・Identity Center の確認 |
| `verify-ops` | 運用ツール用 | Security Agent / DevOps Agent の確認 |

接続先は [scripts/aws-verify.conf](scripts/aws-verify.conf) にある。Identity Center の開始 URL と、アカウントの ID は公開リポジトリに置かないため、クラウド環境の Environment variables （`SSO_START_URL`、`SSO_ACCOUNT_ID`、`SSO_EXTRA_PROFILES`）で渡す。どれも Permission Set
`AgentVerifyAccess` で、create / update / delete / put 系の変更操作はできない。変更操作は
[scripts/deny-aws-writes.sh](scripts/deny-aws-writes.sh)（`PreToolUse` フック）も止める。
CloudWatch Logs とメトリクスは読めるが、S3 オブジェクト本文・DynamoDB レコード・
Cognito ユーザー・SSM パラメータは IAM 側で拒否される。

セッション開始の時点でログインまで済ませたい場合は、クラウド環境の Environment
variables に `SAKEKASU_AWS_LOGIN=1` を設定する。

認証エラーに見える失敗が出たら、まずクラウド環境のネットワーク設定で `awsapps.com` と
`*.amazonaws.com` への到達が許可されているかを疑う。`No access` が返るときは、承認した
Identity Center のユーザーに `AgentVerifyAccess` が割り当てられているか（割り当て用のグループに
入っているか）を疑う。

`aws-sso-login.sh` と `setup-aws-profile.sh` は `~/.aws/config` を上書きするため、
クラウドセッション（`CLAUDE_CODE_REMOTE=true`）でのみ動作する。ローカルでは何もせず終了する。
これらのスクリプトとフックは sakekasu-template から取り込んだもの。直すときはテンプレート側も直す。

## 規約

- スタック名: `sakekasu-learning-<env>-<役割>`、リソース名: `sakekasu-learning-<env>-<名前>`、固定名の IAM ロール: `sakekasu-learning-*`。
  DynamoDB のテーブル（`<env>-sakekasu-learning-progress`、`<env>-sakekasu-learning-chat-quota`）だけは旧い順序のまま。
  名前を変えると作り直しになり、データを移し替える必要があるため
- IAM ロールの description は ASCII のみ（日本語を入れるとデプロイが 400 で落ちる）
- データ系リソース（DynamoDB、Cognito、問題バケット）は RETAIN
- Lambda の LogGroup は明示的に作り、保持は 1 か月
- API の入出力を変えるときは `shared/types.ts` を直し、web と infra の両方で型チェックを通す
- 問題データ（問題文・選択肢・解説・図解とその設計 JSON）はこのリポジトリに置かない。非公開リポジトリ `yuuuuuuu168/sakekasu-learning-content` に置き、`content/`（.gitignore 済み）に clone して使う。テストやドキュメントの例に本物の問題を写さない（[docs/question-data.md](docs/question-data.md)）
- 問題メモの形式は `docs/question-format.md`、図解の決まりは `docs/question-diagrams.md`。変換ロジックは `infra/scripts/questions/parse.ts`
- 解説中の「選択肢 N」は原本の番号。画面では選択肢をシャッフルするので、表示時に A, B, C... へ置き換える（web: `src/lib/choices.ts`、agent: `question_context.py`）

## テスト

```bash
(cd infra && npm run check:questions && npm run typecheck && npm run package:agent && npm test)
(cd web && npm run typecheck && npm test && npm run build)
(cd agent && uv run --group dev pytest)
```
