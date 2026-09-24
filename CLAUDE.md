# sakekasu-learning

資格試験の問題演習サイト。構成とセットアップは README.md を参照。

## 作業ルール

- 作業は feature ブランチで行い、PR を作る。main へのマージは人間様が行う
- AWS へのデプロイは main へのマージ経由（deploy.yml）だけ。ローカルからの `cdkd deploy` / `cdk deploy` は行わない（例外は `sakekasu-learning-github-oidc` スタックの `cdk deploy`）
- github-oidc 以外のスタックは cdkd（CloudFormation を使わない）で管理する。スタックの出力は `npx cdkd state show <スタック名> --json` で読む。cdkd のバージョンは `infra/package.json` で固定している
- AWS CLI / CDK は `AWS_PROFILE=sakekasu-builder` を付けて実行する（アカウント 232791540685）

## 規約

- スタック名: `sakekasu-learning-<env>-<役割>`、リソース名: `<env>-sakekasu-learning-<名前>`、固定名の IAM ロール: `sakekasu-learning-*`
- IAM ロールの description は ASCII のみ（日本語を入れるとデプロイが 400 で落ちる）
- データ系リソース（DynamoDB、Cognito、問題バケット）は RETAIN
- Lambda の LogGroup は明示的に作り、保持は 1 か月
- API の入出力を変えるときは `shared/types.ts` を直し、web と infra の両方で型チェックを通す
- 問題メモの形式は `content/FORMAT.md`。変換ロジックは `infra/scripts/questions/parse.ts`
- 解説中の「選択肢 N」は原本の番号。画面では選択肢をシャッフルするので、表示時に A, B, C... へ置き換える（web: `src/lib/choices.ts`、agent: `question_context.py`）

## テスト

```bash
(cd infra && npm run check:questions && npm run typecheck && npm run package:agent && npm test)
(cd web && npm run typecheck && npm test && npm run build)
(cd agent && uv run --group dev pytest)
```
