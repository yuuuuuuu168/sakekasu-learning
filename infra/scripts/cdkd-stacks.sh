#!/usr/bin/env bash
# CloudFormation で管理していたスタックを cdkd に移す（migrate）、または PR 向けに変更を表示する（preview）。
#
# 使い方（infra/ で実行）:
#   bash scripts/cdkd-stacks.sh migrate   # 未移行のスタックを cdkd に取り込み、CloudFormation のスタックを消す
#   bash scripts/cdkd-stacks.sh preview   # 移行済みは cdkd diff、未移行は cdkd import --dry-run
#
# migrate は移行済みなら何もしないので、deploy ワークフローで毎回実行してよい。
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
# 参照する側（agent → backend → auth の順に参照している）を先に移す
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
  if [[ "$mode" == migrate ]]; then
    echo "== ${stack}: CloudFormation から cdkd へ移行する"
    npx cdkd import "$stack" --migrate-from-cloudformation --yes
  else
    echo "== ${stack}: 未移行（main へのマージで cdkd に取り込む）。取り込みの予定:"
    npx cdkd import "$stack" --dry-run
  fi
done

if [[ "$mode" == preview && ${#migrated[@]} -gt 0 ]]; then
  echo "== cdkd diff"
  npx cdkd diff "${migrated[@]}"
fi
