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

## 切り替え（済み）

切り替えは済んでいる。PR をマージしてデプロイし、共通ログインでログインできることを確かめた。
旧ユーザープールに残っていた回答履歴は 0 件だったので、回答履歴の付け替えは要らなかった。

付け替え用に作ったスクリプト（`infra/scripts/migrate-progress/`）は、旧ユーザープールを外す PR で消した。
付け替える履歴が無く、旧ユーザープールも消すので旧 sub を調べる手段も無くなり、使い道が残らないため。
同じことがまた要るときは、消す前のコミット（`c8a675e`）から取り出せる。

## 引き継がれるデータ・引き継がれないデータ

ユーザーの識別子（`sub`）はユーザープールごとに違うので、同じ人でも共通ログインでは別の sub になる。

| データ | sub との関係 | 扱い |
| --- | --- | --- |
| 回答履歴（DynamoDB `dev-sakekasu-learning-progress`） | PK が `userId`（= sub）、SK が `qkey` | 旧 sub の履歴は 0 件だったので、付け替えなし |
| 問題データ（S3 の非公開バケット） | ユーザーで分けていない | そのまま |
| AI チャットの会話 | 画面のメモリにだけあり、サーバーには残さない（AgentCore Memory は使っていない。セッション ID も画面が毎回作る乱数で sub ではない） | 移すものが無い |
| 「今回解く問題の並び」（ブラウザの sessionStorage） | ユーザーで分けていない | そのまま（タブを閉じれば消える） |
| 旧ログインのトークン（ブラウザの localStorage） | 旧クライアント ID のキーで保存 | 使われなくなる。全員一度ログインし直しになる |

回答履歴テーブルに GSI / LSI は無く、sub が入っているのはキーの `userId` だけ。API（`infra/lambda/api/`）と
エージェント（`agent/src/`）は、トークンの `sub` 以外（`cognito:username`、`email` など）を使っていない。

## 旧ユーザープール（auth スタック）の片付け

切り替えの間は、旧ユーザープール（スタック `sakekasu-learning-dev-auth`、プール ID `ap-northeast-1_h4Uju4jBM`、
名前 `dev-sakekasu-learning-userpool`）を切り戻し用に残し、以前 backend / agent が読んでいた Export も
`exportValue` で出し続けていた。付け替えるデータが無く、利用者も消してよいと判断したので外す。

### コードから外したもの

- `infra/lib/auth-stack.ts`（User Pool・App Client・出力・`exportValue`）と、`infra/bin/app.ts` での生成
- `infra/test/stacks.test.ts` の旧 User Pool のテスト。代わりに「どのスタックもユーザープールを持たない」
  「スタック間の参照は agent → backend の問題バケットだけ」を確かめるテストを置いた
- `infra/scripts/cdkd-stacks.sh` のスタック一覧の auth
- `infra/scripts/migrate-progress/` とそのテスト

合成結果（`cdk synth` / `cdkd synth`）に残る `Fn::ImportValue` は agent が backend の問題バケットを読む 3 つだけで、
旧 auth の Export や名前を参照するものは無い。

### cdkd での扱い（`@go-to-k/cdkd` 0.291.16 で確認）

- **アプリから外しても、`cdkd deploy --all` はスタックを消さない。** `--all` は合成したアプリにあるスタックだけを
  対象にし、状態（S3 の `cdkd-state-232791540685`）にだけ残っているスタックには触れない。
  マージ後のデプロイでは、auth の状態と AWS 上のユーザープール・クライアントがそのまま残る
- 消すには `cdkd state destroy <スタック名>` を手で打つ。アプリを合成せず、状態に記録されたリソースを消して、
  最後に状態の記録と Export の索引からそのスタックを除く
- 状態の各リソースには、デプロイ（と CloudFormation からの取り込み）のときのテンプレートの `DeletionPolicy` が
  記録されている。`state destroy` は `Retain`（`RemovalPolicy.RETAIN`）のリソースを**消さずに飛ばし**
  （`⊘ ... retained — DeletionPolicy: Retain` と出る）、それ以外を消す。飛ばしたリソースが残っていても、
  ほかが消えれば状態の記録は消える。つまりユーザープールは AWS に残り、cdkd の管理からだけ外れる。
  App Client（`DeletionPolicy` 無し）は消える
- `--remove-protection` は削除保護を外してから消すオプションだが、`Retain` で飛ばすリソースには効かない
  （削除の判定より前に飛ばす）。ユーザープールは下の手順で AWS CLI から消す
- `cdkd state orphan` でも状態は消せるが、こちらは Export の索引を掃除しない。`state destroy` を使う
- 別のスタックの状態が auth の Export を読んでいると、`state destroy` は `StackHasActiveImportsError` で止まる。
  backend と agent は共通ログインに移した時点で読まなくなっているので、止まらないはず

### マージした後に打つコマンド

**この PR をマージし、deploy ワークフローが成功した後に**、手元の Mac で上から順に打つ。
デプロイより前に消すと、マージ前のコード（auth スタックを含む）で走ったデプロイが作り直してしまう。
どれも変更操作なので、エージェント用の読み取り専用プロファイル（`verify`）では打てない。

1. 状態に記録された auth のリソースと `DeletionPolicy` を確かめる（読み取りだけ）

   ```bash
   cd infra
   AWS_PROFILE=sakekasu-builder npx cdkd state show sakekasu-learning-dev-auth --json \
     | jq '.state.resources | map_values({resourceType, physicalId, deletionPolicy})'
   ```

   `AWS::Cognito::UserPool` の `physicalId` が `ap-northeast-1_h4Uju4jBM`、`deletionPolicy` が `"Retain"` であること。
   `deletionPolicy` が `"Retain"` でなければ、次の `state destroy` が削除保護に当たって失敗し、状態が残る
   （それでもプールは消えない）。その場合は 2 を飛ばし、`npx cdkd state orphan sakekasu-learning-dev-auth` で
   状態だけ外してから 3 へ進む

2. auth スタックを cdkd から外す（App Client を消し、ユーザープールは残し、状態の記録を消す）

   ```bash
   AWS_PROFILE=sakekasu-builder npx cdkd state destroy sakekasu-learning-dev-auth
   AWS_PROFILE=sakekasu-builder npx cdkd state list   # sakekasu-learning-dev-auth が無いこと
   ```

   確認を求められたら `y`。`UserPool... retained — DeletionPolicy: Retain` と出ればよい

3. 消す前に、相手が旧ユーザープールで合っていることを確かめる（読み取りだけ）

   ```bash
   OLD_POOL=ap-northeast-1_h4Uju4jBM
   AWS_PROFILE=sakekasu-builder aws cognito-idp describe-user-pool --region ap-northeast-1 \
     --user-pool-id "$OLD_POOL" \
     --query 'UserPool.{Name:Name,DeletionProtection:DeletionProtection,Domain:Domain,CustomDomain:CustomDomain,Users:EstimatedNumberOfUsers}'
   ```

   `Name` が `dev-sakekasu-learning-userpool` であること。共通ログインのプール（`ap-northeast-1_yw1VDKtxW`）と
   取り違えない

4. 削除保護を外す（CDK で `deletionProtection: true` にしていたので `ACTIVE` のはず）

   ```bash
   AWS_PROFILE=sakekasu-builder aws cognito-idp update-user-pool --region ap-northeast-1 \
     --user-pool-id "$OLD_POOL" --deletion-protection INACTIVE
   ```

   `update-user-pool` は指定しなかった設定を既定値に戻すが、このあと消すので構わない

5. ドメインがあれば消す（3 の `Domain` / `CustomDomain` が `null` なら飛ばす。CDK ではドメインを作っていない）

   ```bash
   AWS_PROFILE=sakekasu-builder aws cognito-idp delete-user-pool-domain --region ap-northeast-1 \
     --user-pool-id "$OLD_POOL" --domain <3 で出たドメイン>
   ```

6. ユーザープールを消す（中のユーザーとクライアントも一緒に消える。元に戻せない）

   ```bash
   AWS_PROFILE=sakekasu-builder aws cognito-idp delete-user-pool --region ap-northeast-1 \
     --user-pool-id "$OLD_POOL"
   AWS_PROFILE=sakekasu-builder aws cognito-idp describe-user-pool --region ap-northeast-1 \
     --user-pool-id "$OLD_POOL"   # ResourceNotFoundException になればよい
   ```

回答履歴テーブル（`dev-sakekasu-learning-progress`）は backend スタックのもので、この片付けでは触らない。
