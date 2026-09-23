#!/usr/bin/env bash
# AgentCore Runtime（CodeZip, PYTHON_3_13, ARM64）向けにエージェントを梱包する。
# 出力: agent/dist/package/（CDK がこのディレクトリを zip にして S3 に上げる）
#
# 開発機が Mac でも Linux ARM64 用の wheel を取るよう、プラットフォームを指定して入れる。
# ソース配布しか無いパッケージはここで失敗する（Runtime 上でビルドできないため、それで正しい）。
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist/package
mkdir -p dist/package

uv export --frozen --no-dev --no-hashes --no-emit-project --quiet -o dist/requirements.txt
uv pip install \
  --quiet \
  --target dist/package \
  --python-platform aarch64-manylinux_2_28 \
  --python-version 3.13 \
  --only-binary=:all: \
  -r dist/requirements.txt

cp src/*.py dist/package/
# 別アーキテクチャでコンパイルされたバイトコードは持ち込まない
find dist/package -name '__pycache__' -type d -prune -exec rm -rf {} +

echo "packaged: $(du -sh dist/package | cut -f1) -> $(pwd)/dist/package"
