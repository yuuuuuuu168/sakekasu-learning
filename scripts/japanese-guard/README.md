# japanese-guard

Claude Code の応答が英語に切り替わるのを止める Stop フックです。ターンの最終回答が英語主体なら、終了させずに日本語で書き直させます。動きと判定の調整（環境変数）は上流の README を参照してください。

## 出どころ

- 上流: https://github.com/minorun365/claude-code-japanese-guard
- コミット: [`930f05687d333b310740651f022c2b531b5a0aa7`](https://github.com/minorun365/claude-code-japanese-guard/tree/930f05687d333b310740651f022c2b531b5a0aa7)（2026-09-26）
- ライセンス: Apache License 2.0（`LICENSE`、`NOTICE`）

| このディレクトリ | 上流 | 変更 |
|---|---|---|
| `japanese-guard.py` | `hooks/japanese-guard.py` | なし |
| `test_japanese_guard.py` | `tests/test_japanese_guard.py` | 本体を探すパス（`HOOK`）だけ、同じディレクトリを見るように変更 |
| `LICENSE` / `NOTICE` | 同名 | なし |

## 入れ方

上流の README は `~/.claude/` に置く手順ですが、クラウドのコンテナは使い捨てなので、リポジトリに同梱して `.claude/settings.json` の `hooks.Stop` から呼んでいます。

```json
{ "type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR\"/scripts/japanese-guard/japanese-guard.py" }
```

## 更新

上流の `hooks/japanese-guard.py` と `tests/test_japanese_guard.py` を取り直し、テストの `HOOK` のパスを直してから、上のコミットを書き換えます。

## テスト

```bash
python3 scripts/japanese-guard/test_japanese_guard.py
```
