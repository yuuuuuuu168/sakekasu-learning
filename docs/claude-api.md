# Claude API の ID 連携（AI チャット）

AI チャットは Claude API（`api.anthropic.com`）の Claude Haiku 5.5 を既定にし、答えられなかったら
Bedrock の Kimi K3 で答え直す（`agent/src/llm.py`、`agent/src/main.py`）。

Claude API には API キーではなく
[Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/wif-providers/aws) で入る。
Runtime のロール（`sakekasu-learning-<env>-agent-runtime`）が STS の `GetWebIdentityToken` を呼んで
AWS が署名した JWT をもらい、SDK が Anthropic の短命のトークン（10 分）と交換する。
鍵を Secrets Manager にも環境変数にも置かないので、漏れる鍵が無い。
sakekasu-kakeibo の OCR と同じ方式（あちらの docs/operations.md「Claude API の ID 連携（OCR）」）。

## 設定の手順（人の手で行う）

dev については 2026-10-11 に済んでいる（ID は `infra/cdk.json` の context `anthropicFederation`）。

1. AWS: IAM → アカウント設定 → **Outbound web identity federation** を有効にする。
   アプリのアカウントでは有効にしてある（2026-10-11 に確認）。
   `sts:GetWebIdentityToken` を許したロールしかトークンを取れないので、ほかのアプリには影響しない
2. Claude Console: ワークスペース `sakekasu-learning` を作る（使用量・コスト・利用上限をアプリ別に分ける）
3. Claude Console: Settings → Workload identity で、上の発行者に次を足す
   - ルール `sakekasu-learning-workload`: IAM ロール ARN `arn:aws:iam::<アプリのアカウント ID>:role/sakekasu-learning-dev-agent-runtime`、
     audience `https://api.anthropic.com`、ワークスペース `sakekasu-learning`、スコープ `workspace:developer`、寿命 600 秒
   - サービスアカウント `sakekasu-learning-chat`
4. Claude Console: Settings → Service accounts で `sakekasu-learning-chat` を開き、「ワークスペースに追加」で
   `sakekasu-learning` に役割 Developer で入れる。これを忘れるとトークンの交換が 401 になり、
   認証履歴に `sa_not_in_workspace` が出る（kakeibo で一度踏んだ）
5. （任意）Claude Console: ワークスペース `sakekasu-learning` に利用上限（spend limit）をかける。
   自動チャージを有効にしているときは、Billing の設定も見ておく
6. `infra/cdk.json` の context に ID を書いて PR にする（どれも秘密ではない）

   ```json
   "anthropicFederation": {
     "ruleId": "fdrl_...",
     "organizationId": "<組織の UUID>",
     "serviceAccountId": "svac_...",
     "workspaceId": "wrkspc_..."
   }
   ```

   `workspaceId` は省かずに書く。ルールが複数のワークスペースを認可していると、省いたときに
   どちらへ入るかがサーバー側の判断になる。

同じ Claude の組織をほかのアプリも使うので、ワークスペース・ルール・サービスアカウントはアプリごとに分けてある。

context が無いあいだは、AI チャットは Bedrock（Kimi K3）だけで答える（`LLM_PROVIDER=bedrock`）。
context を消せばいつでもその状態に戻せる。

## 変えたもの

| ファイル | 中身 |
| --- | --- |
| `agent/src/llm.py` | 呼び先の順（Claude API → Bedrock）、ID 連携のクライアント、次のモデルへ回した理由の分類 |
| `agent/src/main.py` | 呼び先を順に試す。返し始める前の失敗とモデルが断ったときだけ次へ回す。消費（トークン数）と回した理由を JSON でログに出す |
| `agent/pyproject.toml` | `anthropic`、`strands-agents[anthropic]` |
| `infra/lib/anthropic-federation.ts` | context `anthropicFederation` の読み取りと形の確認（kakeibo と同じ） |
| `infra/lib/agent-stack.ts` | 環境変数（`runtimeEnvironment`） |
| `infra/lib/agent-runtime-role.ts` | `sts:GetWebIdentityToken` |
| `infra/lib/agent-alarms.ts` | Bedrock に回した回数のメトリクスフィルタとアラーム |

### 環境変数（Runtime）

| 環境変数 | 値 | 意味 |
| --- | --- | --- |
| `LLM_PROVIDER` | `anthropic` / `bedrock` | 既定の呼び先。ID 連携の値が無ければ `bedrock` |
| `ANTHROPIC_MODEL_CHAT` | `claude-haiku-5-5` | Claude API のモデル。品質が足りなければ `-c agentAnthropicModel=claude-sonnet-5-5` |
| `ANTHROPIC_FEDERATION_RULE_ID` ほか 3 つ | `cdk.json` の値 | ID 連携で交換するルール・組織・サービスアカウント・ワークスペース |
| `MODEL_ID` / `FALLBACK_MODEL_ID` | `global.moonshotai.kimi-k3` / なし | 控えの Bedrock のモデル（従来どおり） |

### IAM の差分

- Runtime のロールに `sts:GetWebIdentityToken` を足した。宛先は `https://api.anthropic.com`、寿命は 300 秒まで、
  署名は RS256 に条件で絞る。ID 連携の context があるときだけ付く
- `bedrock:InvokeModel*` は控えのために残す
- Secrets Manager は使わない

## モデルの設定

- thinking は止められない世代なので、`output_config.effort` を `low` にする（会話の用途の推奨値）
- `max_tokens` は 8192（思考も含むため Bedrock の 4096 より広くとる）
- システムプロンプト・ツール定義・それまでの会話に `cache_control` を付ける（Strands の `CacheConfig`）。
  同じ会話の 2 ターン目以降と、ツールを挟んで 1 ターンに何度も呼ぶときに効く。システムプロンプトには
  問題本文が入るので、問題をまたいでは効かない
- 429・5xx・通信の失敗は SDK が 2 回まで再試行し、それでも駄目なら Bedrock に回す

## 確かめ方

相談のたびに Runtime のログ（`/aws/bedrock-agentcore/runtimes/sakekasu_learning_dev_tutor-*-DEFAULT`）へ
`[chat] llm {...}` が 1 行出る（呼び先・モデル・トークン数・キャッシュの読み書き）。
`provider` が `anthropic` なら Claude API で答えている。

Claude API で答えられず Bedrock に回したときは `[chat] fallback {"fallback": true, ..., "errorType": ...}` が出て、
アラーム `sakekasu-learning-dev-agent-chat-fallbacks` が鳴る。

| `errorType` | 疑うところ |
| --- | --- |
| `credit_balance` | Claude Console のクレジットと Billing |
| `authentication` / `permission` | Claude Console のルール（ロールの ARN・audience・ワークスペース）。[認証履歴](https://platform.claude.com/settings/workload-identity-federation?tab=history)に拒否の理由が出る |
| `credentials` | メッセージが `Token exchange failed with status 401` なら、JWT は取れていて Anthropic 側で断られている。認証履歴の `status.reason` を見る（`sa_not_in_workspace` ならサービスアカウントをワークスペースに入れる）。それ以外は STS で JWT を取れていない（Outbound web identity federation が無効、ロールの権限の条件と頼み方が合わない、など） |
| `rate_limit` / `overloaded` / `server_error` / `timeout` / `connection` | Claude API 側の混雑や障害。続かなければ放っておいてよい |
| `refusal` | モデルが回答を断った（Haiku 5.5 はサーバー側で別モデルに回せないので、こちらで回す） |
| `http_400` など | こちらの頼み方の誤り。Bedrock では答えられているはずなので、ログのメッセージを見て直す |

トークン数とキャッシュの効きは CloudWatch Logs Insights で次を流す。

```
fields @timestamp, @message
| filter @message like /\[chat\] llm/
| parse @message '"provider": "*"' as provider
| parse @message '"input": *,' as input
| parse @message '"output": *,' as output
| parse @message '"cacheRead": *,' as cacheRead
| stats count() as n, avg(input) as avgInput, avg(output) as avgOutput, avg(cacheRead) as avgCacheRead by provider
```
