#!/usr/bin/env bash
# 問題データ（問題文・選択肢・解説・図解）がこのリポジトリに入っていないことを確かめる。
#
# 問題データは非公開リポジトリ sakekasu-learning-content に置く（docs/question-data.md）。
# content/ は .gitignore で外しているが、`git add -f` や別の場所への置き間違いは止められないので、
# CI で追跡中のファイルを見て、入っていたら失敗させる。
#
# 使い方: bash infra/scripts/questions/check-not-in-repo.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

found=0
report() {
  echo "::error::問題データはこのリポジトリに置かない（docs/question-data.md）: $1"
  found=1
}

# 1. content/ の下に追跡中のファイルがある
while IFS= read -r f; do report "$f"; done < <(git ls-files -- 'content/')

# 2. 図解の PNG（<問題番号>_選択肢<番号>_<正解|不正解>.drawio.png）
while IFS= read -r f; do report "$f"; done < <(git ls-files -- '*.drawio.png')

# 3. 問題メモの形式（## 選択肢 と ### 【正解】 の見出し）を持つ Markdown。形式の説明だけは除く
while IFS= read -r f; do
  [[ "$f" == docs/question-format.md ]] && continue
  if git grep -q -e '^## 選択肢' -- "$f" && git grep -q -e '^### 【\(不\)\?正解】' -- "$f"; then
    report "$f"
  fi
done < <(git grep -l -e '^## 選択肢' -- '*.md' || true)

# 4. 図解の設計 JSON（verdict と nodes を持つ）
while IFS= read -r f; do
  if git grep -q -e '"nodes"' -- "$f"; then report "$f"; fi
done < <(git grep -l -e '"verdict": *"\(in\)\?correct"' -- '*.json' || true)

if [[ $found -ne 0 ]]; then
  echo "問題データは sakekasu-learning-content に移し、このリポジトリからは git rm --cached で外す"
  exit 1
fi
echo "問題データは入っていない"
