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

未ログインで開いたときは、ボタンを押させずにマネージドログインへ自動で進む。自動で進むのはタブごとに 1 回だけで、
送る前に sessionStorage に印（`sakekasu-learning:auto-sign-in`）を置き、ログインできたら消す。戻ってきてもまだ未ログイン
（ログイン画面で戻った・取り消した、`?error=` 付きで戻った等）なら、自動では送らずにサインイン画面を出す。
サインイン画面は sakekasu の入口の表紙と同じ見た目で、OS の設定に関係なく黒に固定している。「パスキーでログイン」は印に関係なく必ず送る。
ポータル（`https://sakekasu-builder.com/apps`）のリンクに付く `?sso=1` は、付いていても動きは変わらず、読み込み時に URL から外すだけ
（`web/src/auth/oauth.ts`）。

ログアウトはマネージドログインの `/logout` を通し、本番ではポータルのトップ（`https://sakekasu-builder.com/`）に着く。
手元（`http://localhost:5173`）では今までどおりそのオリジンの `/` に戻る。ポータルの URL は共通のアプリクライアントの
`logoutUrls`（sakekasu-integrated_environment の `infra/cdk.json`）に登録してあるものと末尾の `/` まで一致させる。
Amplify v6 の `signOut` は、戻り先を指定しないと `redirectSignOut` から今と同じオリジンの URL しか選ばないので、
`signOut({ global: false, oauth: { redirectUrl } })` で明示している（`signOutRedirectUrl`）。

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

## 旧ユーザープール（auth スタック）の片付け（済み）

旧ユーザープールの auth スタック（`sakekasu-learning-dev-auth`）は、アプリから外し、cdkd の状態から外したうえで、
プールごと削除した。回答履歴テーブル（`dev-sakekasu-learning-progress`）は backend スタックのもので、この片付けでは触っていない。
