# 共通ログインへの切り替え

ログインを、このアプリ専用のユーザープール（`sakekasu-learning-dev-auth`）から、4 アプリ共通のログイン
（[sakekasu-integrated_environment](https://github.com/yuuuuuuu168/sakekasu-integrated_environment) の
共通ユーザープール。ログイン画面は `https://auth.sakekasu-builder.com`）に移した。

## 何が変わったか

| 場所 | 変更 |
| --- | --- |
| `infra/cdk.json` | context `sharedAuth`（`domain`・`userPoolId`・`clientId`）を追加。共通基盤とはスタック参照でつながない |
| API（`infra/lib/backend-stack.ts`） | JWT オーソライザーの発行者を共通ユーザープール、audience を learning のクライアントに |
| AI チャット（`infra/lib/agent-stack.ts`、`agent/src/auth.py`） | Runtime の JWT オーソライザー（discovery URL・allowedClients）とアプリ側の検証を共通ユーザープールに |
| サイト（`infra/lib/web-stack.ts`） | CSP の `connect-src` にログイン画面のドメインを追加（認可コードとトークンの交換に使う） |
| 画面（`web/src/auth/`） | 独自のサインイン・MFA の画面をやめ、マネージドログインへリダイレクト（認可コード + PKCE） |
| `config.json`（`infra/scripts/write-web-config.ts`） | ログインの値を `cdk.json` の `sharedAuth` から書く。`authDomain` を追加 |

パスワードの入力・初回のパスワード変更・認証アプリ（TOTP）の登録・パスワードの再設定は、どれも
マネージドログインの画面が行う。1 つのアプリでログインすれば、ほかのアプリは入力なしで入れる。

共通ログインのクライアントのスコープは `openid` `email` `profile` だけで、`aws.cognito.signin.user.admin` が無い。
Amplify の `fetchUserAttributes` / `updatePassword` / `setUpTOTP` などは使えない（画面はユーザー名もメールも表示しない）。

## 旧ユーザープール（auth スタック）

`sakekasu-learning-dev-auth` は消さずに残している（ユーザープールは RETAIN・削除保護のまま）。
API・エージェント・画面からはもう参照しない。残している理由は 2 つ。

- 回答履歴の付け替えで、旧 sub を調べるのに使う
- 切り戻し（`git revert` してデプロイすれば元のログインに戻る。旧 sub の回答履歴も消していない）

以前 backend / agent が参照していたときに CDK が作った Export は、`exportValue` で同じ名前のまま残してある。

**データの付け替えが全員分済んだら、別の PR で auth スタックを外す**（`exportValue` もそのとき一緒に消す）。
ユーザープールは RETAIN なので、スタックを外しても AWS 上には残る。要らなくなったら削除保護を外して別に消す。
cdkd で管理しているので、それまでは論理 ID を変える変更や、スタックを消す変更を入れない。

## 引き継がれるデータ・引き継がれないデータ

ユーザーの識別子（`sub`）はユーザープールごとに違うので、同じ人でも共通ログインでは別の sub になる。

| データ | sub との関係 | 扱い |
| --- | --- | --- |
| 回答履歴（DynamoDB `dev-sakekasu-learning-progress`） | PK が `userId`（= sub）、SK が `qkey` | **スクリプトでコピーする**（下の手順） |
| 問題データ（S3 の非公開バケット） | ユーザーで分けていない | そのまま |
| AI チャットの会話 | 画面のメモリにだけあり、サーバーには残さない（AgentCore Memory は使っていない。セッション ID も画面が毎回作る乱数で sub ではない） | 移すものが無い |
| 「今回解く問題の並び」（ブラウザの sessionStorage） | ユーザーで分けていない | そのまま（タブを閉じれば消える） |
| 旧ログインのトークン（ブラウザの localStorage） | 旧クライアント ID のキーで保存 | 使われなくなる。全員一度ログインし直しになる |

回答履歴テーブルに GSI / LSI は無く、sub が入っているのはキーの `userId` だけ。API（`infra/lambda/api/`）と
エージェント（`agent/src/`）は、トークンの `sub` 以外（`cognito:username`、`email` など）を使っていない。

## 切り替えの手順

1. PR をマージする。deploy ワークフローが cdkd でデプロイし、新しい `config.json` を置く
2. `https://learning.sakekasu-builder.com/` を開き、「ログイン」から共通ログインでログインする
   （ユーザーは共通ユーザープールにある必要がある。作り方は sakekasu-integrated_environment の `docs/identity.md`）
   - 付け替えが済むまで問題を解かないほうがよい。新しい sub で先に答えた問題は、旧 sub の履歴で上書きしない
3. 旧 sub と新 sub を調べる（手元の Mac から。読み取りだけ）

   ```bash
   # 旧ユーザープール（このアプリの auth スタック）
   OLD_POOL=$(cd infra && AWS_PROFILE=sakekasu-builder npx cdkd state show sakekasu-learning-dev-auth --json \
     | jq -r '.state.outputs.UserPoolId')
   AWS_PROFILE=sakekasu-builder aws cognito-idp list-users --user-pool-id "$OLD_POOL" \
     --filter 'email = "user@example.com"' --query 'Users[].Attributes[?Name==`sub`].Value' --output text

   # 共通ユーザープール（infra/cdk.json の sharedAuth.userPoolId）
   NEW_POOL=$(jq -r '.context.sharedAuth.userPoolId' infra/cdk.json)
   AWS_PROFILE=sakekasu-builder aws cognito-idp list-users --user-pool-id "$NEW_POOL" \
     --filter 'email = "user@example.com"' --query 'Users[].Attributes[?Name==`sub`].Value' --output text
   ```

4. スクリプトを dry-run で流し、件数と例を確かめる（書き込まない）

   ```bash
   cd infra
   AWS_PROFILE=sakekasu-builder npx tsx scripts/migrate-progress/migrate.ts \
     --table dev-sakekasu-learning-progress --old-sub <旧 sub> --new-sub <新 sub>
   ```

5. よければ `--apply` を付けて流す

   ```bash
   AWS_PROFILE=sakekasu-builder npx tsx scripts/migrate-progress/migrate.ts \
     --table dev-sakekasu-learning-progress --old-sub <旧 sub> --new-sub <新 sub> --apply
   ```

6. 画面を読み直し、習熟度が戻っていることを確かめる。ユーザーごとに 3〜6 を繰り返す

スクリプト（`infra/scripts/migrate-progress/`）の性質:

- 既定は dry-run。`--apply` を付けたときだけ書く
- 新 sub に同じ問題（`qkey`）の項目が既にあれば上書きしない（条件付きの Put）。何度流しても安全
- 旧 sub の項目は消さない。切り戻せば旧ログインでそのまま使える
- 書き込みには DynamoDB の書き込み権限が要る。エージェント用の読み取り専用プロファイル（`verify`）では流せない
