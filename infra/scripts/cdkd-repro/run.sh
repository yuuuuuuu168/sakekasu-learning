#!/usr/bin/env bash
# cdkd の不具合が最新版でも起きるかを確かめる（issue #9 / #10 の下書きの裏付け）。
#
# 使い方（infra/ で実行）:
#   bash scripts/cdkd-repro/run.sh
#
# 1. 試験用の 2 スタックを cdk deploy（CloudFormation）で作る
# 2. 最新版の cdkd で import --dry-run を実行する（状態は書かない。AWS のリソースも変えない）
# 3. 最後に必ず cdk destroy で消す
# 結果は scripts/cdkd-repro/result.txt に書き出す。
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
export AWS_PROFILE="${AWS_PROFILE:-sakekasu-builder}"
CDKD_VERSION="${CDKD_VERSION:-latest}"
APP="npx tsx scripts/cdkd-repro/app.ts"
OUT=scripts/cdkd-repro/result.txt
cdkd() { npx -y "@go-to-k/cdkd@${CDKD_VERSION}" "$@" --app "$APP" --output cdk.out.repro; }

cleanup() {
  echo "== 試験用スタックを削除する"
  npx cdk destroy --all --force --app "$APP" --output cdk.out.repro
  rm -rf cdk.out.repro
}
trap cleanup EXIT

echo "== 試験用スタックを作る（CloudFormation）"
npx cdk deploy --all --require-approval never --app "$APP" --output cdk.out.repro || exit 1

{
  echo "cdkd version: $(npx -y "@go-to-k/cdkd@${CDKD_VERSION}" --version)"
  echo
  echo "### #9-A 既定のリージョン ap-northeast-1 で、us-east-1 のスタックを import（失敗するはず）"
  AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 cdkd import cdkd-repro-region --dry-run 2>&1
  echo
  echo "### #9-B 既定のリージョンを us-east-1 に合わせて import（成功するはず）"
  AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 cdkd import cdkd-repro-region --dry-run 2>&1
  echo
  echo "### #10-A UserPoolClient を CloudFormation の ID のまま import（失敗するはず）"
  AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 cdkd import cdkd-repro-cognito --dry-run 2>&1
  echo
  echo "### #10-B 同じ UserPoolClient を \"<UserPoolId>|<ClientId>\" で渡して import（成功するはず）"
  ids="$(aws cloudformation describe-stack-resources --region ap-northeast-1 --stack-name cdkd-repro-cognito \
    --query 'StackResources[].[ResourceType,LogicalResourceId,PhysicalResourceId]' --output text)"
  pool="$(awk '$1 == "AWS::Cognito::UserPool" { print $3 }' <<<"$ids")"
  client_id="$(awk '$1 == "AWS::Cognito::UserPoolClient" { print $2 }' <<<"$ids")"
  client="$(awk '$1 == "AWS::Cognito::UserPoolClient" { print $3 }' <<<"$ids")"
  AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1 cdkd import cdkd-repro-cognito --dry-run --auto \
    --resource "${client_id}=${pool}|${client}" 2>&1
} | sed -E 's/\x1b\[[0-9;]*m//g' | tee "$OUT"

echo
echo "== 結果を $OUT に書き出した。要約:"
grep -E '^###|^cdkd version|Resolved [0-9]+ physical|Summary:|✗|Failed to import' "$OUT"
