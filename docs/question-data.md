# 問題データの置き場所

問題文・選択肢・正解・解説・図解（PNG と設計 JSON）は、このリポジトリには置かない。
非公開リポジトリ [sakekasu-learning-content](https://github.com/yuuuuuuu168/sakekasu-learning-content) にだけ置き、
デプロイ時に取得して非公開の S3 バケットへ同期する。このリポジトリを public にしても問題データが見えないようにするため。

このリポジトリに残すのは、形式の説明（[question-format.md](question-format.md)、[question-diagrams.md](question-diagrams.md)）、
変換ロジック（`infra/scripts/questions/`）、図解の生成スクリプト（`scripts/make-diagram.py`）だけ。

## 仕組み

```
sakekasu-learning-content (private)
  │  PR: check.yml が sakekasu-learning を取得して npm run check:questions
  │  main への push: check.yml が repository_dispatch（questions-updated）を送る
  ▼
sakekasu-learning の deploy.yml（main への push / questions-updated / 手動）
  │  deploy key で content/ に取得 → build:questions → 非公開バケットへ同期
  ▼
s3://sakekasu-learning-dev-questions-<アプリのアカウント ID>（API Lambda と AI チャットだけが読む）
```

- `content/` は `.gitignore` で外してある。手元やクラウドセッションでは、content リポジトリを `content/` に clone して使う
- `npm run build:questions` は `content/` が無いと失敗する。問題が空のまま同期（`--delete`）してバケットの問題を消さないため
- test.yml の `no-question-data` ジョブ（`infra/scripts/questions/check-not-in-repo.sh`）が、`content/` の追跡ファイル・
  `*.drawio.png`・問題メモ形式の Markdown・図解の設計 JSON がこのリポジトリに入っていたら失敗させる。`git add -f` の誤りもここで止まる
- test.yml の infra ジョブは、deploy key が使えるとき（このリポジトリのブランチからの PR と main）だけ問題データを取得して
  形式チェックする。フォークからの PR ではダミーの問題でパーサーのテストだけ動く

## 初期設定（一度だけ。人間様が行う）

### 1. sakekasu-learning → content の読み取り（deploy key）

```bash
ssh-keygen -t ed25519 -N '' -C sakekasu-learning-questions -f questions_deploy_key
```

- content リポジトリの Settings → Deploy keys に `questions_deploy_key.pub` を登録する（**Allow write access は付けない**）
- sakekasu-learning の Settings → Secrets and variables → Actions に、秘密鍵 `questions_deploy_key` の中身を
  `QUESTIONS_DEPLOY_KEY` として登録する
- 手元の鍵ファイルは登録後に消す

### 2. content → sakekasu-learning の取得とデプロイの呼び出し（fine-grained PAT）

- GitHub の Settings → Developer settings → Fine-grained tokens で作る
  - Repository access: Only select repositories → `sakekasu-learning` だけ
  - Permissions: Contents → Read and write（repository_dispatch に Write が要る）
- content リポジトリの Actions secrets に `APP_REPO_TOKEN` として登録する
- 有効期限が切れると content の CI が落ちるので、期限前に作り直す

### 3. 切り替えの順番

1. content リポジトリに問題データを入れる（済み。main の `content/aws` とツリーのハッシュが一致することを確かめた）
2. 上の 1 と 2 の Secrets を登録する
3. このリポジトリの「問題データを content リポジトリへ移す」PR をマージする。deploy が content から取得して同期する。
   サイトで問題と図解が出ることを確かめる
4. content リポジトリの CI の PR をマージする
5. 下の「履歴から消す」を行ってから public にする

Secrets を登録する前に 3 をマージすると、deploy は問題データの取得で失敗して止まる（バケットの問題は消えない）。

## 問題を追加・修正する

1. content リポジトリでブランチを切り、問題メモ・図解を足す（形式は [question-format.md](question-format.md)）
2. 手元では `cd infra && npm run check:questions` で確かめる（sakekasu-learning の `content/` に clone しておく）
3. PR を作る。content の CI が形式チェックする
4. main にマージすると sakekasu-learning の deploy が呼ばれて反映される

クラウドセッション（Claude Code on the web）で作業するときは、セッションに content リポジトリを追加し、
`/home/user/sakekasu-learning/content` に clone する（`git clone https://github.com/yuuuuuuu168/sakekasu-learning-content content`）。

## 履歴から消す（public にする前に必ず行う）

> **このリポジトリでは実施済み。** 以下は、同じことをもう一度行うときの手順。

ファイルを消しても、過去のコミットには問題データが残る。
public にする前に、すべてのブランチとタグの履歴から `content/aws/` を取り除く。

GitHub では、PR の参照（`refs/pull/*`）が書き換え前のコミットを指したまま残り、利用者が消せない。
そのため、このリポジトリの公開範囲をそのまま public に切り替えるのではなく、**書き換えた履歴を新しいリポジトリに push して、
そちらを public にする**のが確実。今のリポジトリは private のまま archive するか、新しい方の動作を確かめてから消す。

```bash
pip install git-filter-repo

# 1. 書き換え用の clone（作業用。すべてのブランチとタグを取る）
git clone --mirror git@github.com:yuuuuuuu168/sakekasu-learning.git learning-filtered.git
cd learning-filtered.git
git for-each-ref --format='delete %(refname)' refs/pull | git update-ref --stdin   # PR の参照は持ち込まない

# 2. 問題データを全履歴から取り除く（形式の説明 content/FORMAT.md・DIAGRAMS.md は問題データではないので残す）
git filter-repo --path content/aws --invert-paths

# 3. 残っていないことを確かめる（どちらも何も出なければよい）
git log --all --format= --name-only | grep -E '^content/aws/|\.drawio\.png$'
git log --all -p | grep -m1 -E '^\+### 【(不)?正解】選択肢'

# 4. 新しいリポジトリ（例: sakekasu-learning-public。空で作る）に push する
git push --mirror git@github.com:yuuuuuuu168/sakekasu-learning-public.git
```

リポジトリ名を変えずに済ませたいときは、今のリポジトリを別名に変えてから、元の名前で新しいリポジトリを作って push する。
名前が同じでもリポジトリ ID は変わるので、次の付け替えが要る。

- OIDC ロールの信頼先: `infra/bin/app.ts` の `subjectPrefix` の末尾（`@<リポジトリ ID>`）を新しい ID に変え、
  `sakekasu-learning-github-oidc` を手元から `cdk deploy` する。ID は `gh api repos/yuuuuuuu168/sakekasu-learning --jq .id` で引ける
- GitHub Actions の Secrets（`QUESTIONS_DEPLOY_KEY`。「初期設定」の 1 の手順で作り直し、content 側の deploy key も入れ替える）と Environments
- content 側の `APP_REPO_TOKEN`: PAT の Repository access で `sakekasu-learning` を選び直す（PAT もリポジトリ ID で紐付く）
- AWS Security Agent: エージェントスペースでリポジトリを削除して追加し直す
- Issue: `gh issue transfer <番号> yuuuuuuu168/sakekasu-learning --repo <改名した前のリポジトリ>` で番号順に移し、
  本文の `#N` の参照が正しいか見直す

どうしても今のリポジトリをそのまま public にする場合は、2 の後に `git push --force --all` と `git push --force --tags` で
上書きし、GitHub Support に「機密データの削除」として、PR の参照とキャッシュされたビューの削除を依頼する
（[Removing sensitive data from a repository](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)）。
