#!/usr/bin/env bash
# cdkd でデプロイするための下準備。CI 自身の権限を変えるので、手元で一度だけ実行する。
#
# 使い方（infra/ で実行）:
#   npm ci && bash scripts/setup-cdkd.sh
#
# 1. GitHub Actions 用ロール（sakekasu-learning-github-oidc）を更新し、cdkd 用ロールを作る
# 2. cdkd bootstrap で状態を置くバケット（cdkd-state-<アカウント ID>）と資産置き場を作る
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_PROFILE="${AWS_PROFILE:-sakekasu-builder}"

npx cdk deploy sakekasu-learning-github-oidc -c github-oidc=true
npx cdkd bootstrap --region ap-northeast-1
