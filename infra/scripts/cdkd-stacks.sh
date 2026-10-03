#!/usr/bin/env bash
# CloudFormation で管理していたスタックを cdkd に移す（migrate）、または PR 向けに変更を表示する（preview）。
#
# 使い方（infra/ で実行）:
#   bash scripts/cdkd-stacks.sh migrate   # 未移行のスタックを cdkd に取り込み、CloudFormation のスタックを消す
#   bash scripts/cdkd-stacks.sh preview   # 移行済みのスタックの cdkd diff（PR 用。読み取りだけ）
#
# migrate は手元で実行する（AWS_PROFILE=sakekasu-builder）。移行済みのスタックには何もしない。
# dev 環境は移行済みのため、deploy ワークフローからは呼ばない（毎回の確認に 10 秒ほどかかっていた）。
# CloudFormation のスタックを消すときは全リソースを Retain にしてから消すため、AWS のリソースは残る。
# 前提: cdkd bootstrap が済んでいること（scripts/setup-cdkd.sh）
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != migrate && "$mode" != preview ]]; then
  echo "使い方: $0 migrate|preview" >&2
  exit 2
fi

env_name="${ENV_NAME:-dev}"
prefix="sakekasu-learning-${env_name}"
# スタック名:リージョン。CloudFormation は使用中の Export を持つスタックを消せないため、
# 参照する側を先に移す（移行した時点では agent → backend → auth の順に参照していた。
# いまの auth は共通ログインへの移行でどこからも参照されていない）
stacks=(
  "${prefix}-agent:ap-northeast-1"
  "${prefix}-backend:ap-northeast-1"
  "${prefix}-auth:ap-northeast-1"
  "${prefix}-web:us-east-1"
)

# cdkd の状態に載っているスタック（"<スタック名> (<リージョン>)" の行）
cdkd_stacks="$(npx cdkd state list)"

has_cdkd_state() {
  grep -qxF "$1 ($2)" <<<"$cdkd_stacks"
}

# CloudFormation のスタックがあれば 0、無ければ 1。権限エラーなどは「無い」と取り違えないように止める
has_cfn_stack() {
  local out
  if out="$(aws cloudformation describe-stacks --region "$2" --stack-name "$1" \
    --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
    return 0
  fi
  if grep -q 'does not exist' <<<"$out"; then
    return 1
  fi
  echo "$out" >&2
  exit 1
}

# cdkd import に渡す追加の引数。cdkd 0.291.16 の import の不具合を避ける
#
# - Cloud Control 経由で扱う AWS::Cognito::UserPoolClient は、識別子が "<UserPoolId>|<ClientId>" の組だが、
#   CloudFormation から引いた物理 ID（ClientId だけ）をそのまま使って失敗する。組を --resource で渡す
#   （--resource だけだと指定したものしか取り込まないので、残りを自動で解決させる --auto も付ける）
import_args() {
  local resources pools pool
  resources="$(aws cloudformation describe-stack-resources --region "$2" --stack-name "$1" \
    --query 'StackResources[].[LogicalResourceId,ResourceType,PhysicalResourceId]' --output text)"
  pools="$(awk '$2 == "AWS::Cognito::UserPool" { print $3 }' <<<"$resources")"
  if ! grep -q $'\tAWS::Cognito::UserPoolClient\t' <<<"$resources"; then
    return
  fi
  if [[ "$(wc -l <<<"$pools")" -ne 1 || -z "$pools" ]]; then
    echo "::error::$1 の UserPoolClient に対応する User Pool を 1 つに決められません" >&2
    exit 1
  fi
  pool="$pools"
  echo "--auto"
  awk -v pool="$pool" '$2 == "AWS::Cognito::UserPoolClient" { print "--resource\n" $1 "=" pool "|" $3 }' <<<"$resources"
}

migrated=()
for entry in "${stacks[@]}"; do
  stack="${entry%%:*}"
  region="${entry##*:}"
  if has_cdkd_state "$stack" "$region"; then
    if has_cfn_stack "$stack" "$region"; then
      # 取り込みの後、CloudFormation のスタックを消す前に失敗した状態。二重管理になるので先へ進まない
      echo "::error::${stack} は cdkd と CloudFormation の両方にあります。" \
        "CloudFormation 側を消すには: npx cdkd import ${stack} --migrate-from-cloudformation --force --yes" >&2
      exit 1
    fi
    migrated+=("$stack")
    continue
  fi
  if ! has_cfn_stack "$stack" "$region"; then
    # どちらにも無い（新しい環境）。cdkd deploy が作る
    migrated+=("$stack")
    continue
  fi
  if [[ "$mode" == preview ]]; then
    # import --dry-run はロックを書くため、読み取り専用の PR 用ロールでは実行しない
    echo "== ${stack}: 未移行（main へのマージで CloudFormation から cdkd に取り込む）"
    continue
  fi
  args="$(import_args "$stack" "$region")"
  extra=()
  if [[ -n "$args" ]]; then
    mapfile -t extra <<<"$args"
  fi
  # cdkd import は、スタックのリージョンではなく既定のリージョンで CloudFormation と各リソースを引くため、
  # スタックごとに AWS_REGION を合わせる（us-east-1 の web スタックが取り込めない）
  echo "== ${stack}: CloudFormation から cdkd へ移行する"
  AWS_REGION="$region" AWS_DEFAULT_REGION="$region" \
    npx cdkd import "$stack" --migrate-from-cloudformation --yes "${extra[@]}"
done

if [[ "$mode" == preview && ${#migrated[@]} -gt 0 ]]; then
  echo "== cdkd diff"
  npx cdkd diff "${migrated[@]}"
fi
