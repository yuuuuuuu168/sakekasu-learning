"""sakekasu-learning の AI 家庭教師（AgentCore Runtime エントリポイント）。

ペイロード（shared/types.ts の ChatPayload）:
    category, exam, questionId  どの問題についての相談か
    displayOrder                画面での選択肢の並び（原本の index）
    selected                    受験者が選んだ選択肢（原本の index）。未回答なら空
    history                     これまでの会話（user / assistant の交互）
    prompt                      今回の相談内容

応答は文字列チャンクのストリーム（SSE）。
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient

from auth import verify_access_token
from question_context import QuestionContext, render_question, resolve_question
from quota import QuotaResult, consume as consume_quota, daily_limit

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tutor")

app = BedrockAgentCoreApp()

MODEL_ID = os.environ.get("MODEL_ID", "global.moonshotai.kimi-k3")
# MODEL_ID が応答を1文字も返さないうちに失敗したときに使うモデル（空なら切り替えない）
FALLBACK_MODEL_ID = os.environ.get("FALLBACK_MODEL_ID", "")
AWS_KNOWLEDGE_MCP_URL = os.environ.get("AWS_KNOWLEDGE_MCP_URL", "https://knowledge-mcp.global.api.aws")
DOC_TOOLS = [
    "aws___search_documentation",
    "aws___read_documentation",
    "aws___get_regional_availability",
]

MAX_PROMPT_LENGTH = 2000
MAX_HISTORY_MESSAGES = 20
MAX_HISTORY_MESSAGE_LENGTH = 8000

SYSTEM_PROMPT = """あなたは IT 資格試験の学習を手伝う家庭教師です。受験者は下記の問題について相談しています。

# 回答の方針
- 日本語で、受験者の理解が深まるように説明してください。結論を先に述べ、そのあと理由を説明します。
- 選択肢は受験者の画面と同じ A, B, C... のラベルで呼んでください（数字の番号は使わない）。
- AWS のサービス仕様・制約・料金・リージョン対応など、事実に関わる説明は、ドキュメント検索ツールで
  AWS 公式ドキュメントを確認してから答えてください。参照したページの URL を回答の最後に「参考」として列挙します。
- ツールで確認できなかったことや自信がないことは、推測であると明示してください。事実をでっち上げてはいけません。
- 公式解説と公式ドキュメントの内容が食い違う場合は、その旨を指摘し、公式ドキュメントの記載を優先して説明してください。
- 試験対策として、似た選択肢を見分けるポイントやキーワードもあわせて伝えると効果的です。
{answer_policy}

# 対象の問題
{question}
"""

ANSWER_POLICY_UNANSWERED = """- 受験者はまだこの問題に回答していません。正解の選択肢や正誤を明かさず、考え方のヒントだけを伝えてください。
  受験者が「答えを教えて」と明示的に求めた場合も、まず回答してみるよう促してください。"""
ANSWER_POLICY_ANSWERED = """- 受験者は回答済みです。正解・不正解の理由を率直に説明して構いません。"""


def _sanitize_history(history: Any) -> list[dict[str, Any]]:
    """クライアントから届いた会話履歴を、Converse API が受け付ける形に整える。"""
    if not isinstance(history, list):
        return []
    messages: list[dict[str, Any]] = []
    for item in history[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        text = content[:MAX_HISTORY_MESSAGE_LENGTH]
        if messages and messages[-1]["role"] == role:
            # 同じ役割が続いたら1つにまとめる（交互でないとモデルが受け付けない）
            messages[-1]["content"][0]["text"] += f"\n\n{text}"
        else:
            messages.append({"role": role, "content": [{"text": text}]})
    # user で始まり assistant で終わる形にする（直後に今回の user 発言が続くため）
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    while messages and messages[-1]["role"] != "assistant":
        messages.pop()
    return messages


def _build_agent(ctx: QuestionContext, history: list[dict[str, Any]], model_id: str = MODEL_ID) -> Agent:
    docs = MCPClient(
        url=AWS_KNOWLEDGE_MCP_URL,
        tool_filters={"allowed": DOC_TOOLS},
        startup_timeout=10,
        # ドキュメント検索が使えなくても、問題と解説だけで相談は成立させる
        continue_on_error=True,
        application_name="sakekasu-learning",
    )
    system_prompt = SYSTEM_PROMPT.format(
        answer_policy=ANSWER_POLICY_ANSWERED if ctx.selected else ANSWER_POLICY_UNANSWERED,
        question=render_question(ctx),
    )
    return Agent(
        model=BedrockModel(model_id=model_id, max_tokens=4096),
        system_prompt=system_prompt,
        tools=[docs],
        messages=history,
        callback_handler=None,
    )


@app.entrypoint
async def invoke(payload: Any, context: Any):
    headers = getattr(context, "request_headers", None) or {}
    authorization = next((v for k, v in headers.items() if k.lower() == "authorization"), None)
    user = await asyncio.to_thread(verify_access_token, authorization)
    if not user:
        log.warning("認証されていないリクエストを拒否しました")
        yield "認証情報を確認できませんでした。ログインし直してからもう一度お試しください。"
        return

    if not isinstance(payload, dict):
        yield "リクエストの形式が不正です。"
        return

    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        yield "相談内容を入力してください。"
        return
    if len(prompt) > MAX_PROMPT_LENGTH:
        yield f"相談内容が長すぎます。{MAX_PROMPT_LENGTH}文字以内でお願いします。"
        return

    ctx = await asyncio.to_thread(resolve_question, payload)
    if isinstance(ctx, str):
        yield ctx
        return

    # モデルを呼ぶ直前に数える。入力の誤りや存在しない問題では回数を減らさない
    quota = await asyncio.to_thread(consume_quota, user)
    if quota is QuotaResult.EXCEEDED:
        log.info("1 日の上限に達したため断りました")
        yield f"今日の相談回数の上限（{daily_limit()}回）に達しました。明日（日本時間の 0 時以降）にまたお試しください。"
        return
    if quota is QuotaResult.UNAVAILABLE:
        # 数えられないときは、上限を守れないので呼ばない（費用の上限を優先する）
        yield "ただいま相談を受け付けられません。時間をおいてもう一度お試しください。"
        return

    log.info("相談を受け付けました question=%s answered=%s", ctx.question_id, bool(ctx.selected))
    models = [m for m in dict.fromkeys([MODEL_ID, FALLBACK_MODEL_ID]) if m]
    for i, model_id in enumerate(models):
        # 会話履歴は Agent が書き換えるため、モデルごとに作り直す
        agent = _build_agent(ctx, _sanitize_history(payload.get("history")), model_id)
        started = False
        # ツールを呼ぶ前の前置きと呼んだ後の本文が改行なしでつながると、本文冒頭の見出し（##）が
        # Markdown として崩れるため、ツールを挟んで本文を再開するときは空行を入れる
        break_before_text = False
        try:
            async for event in agent.stream_async(prompt):
                if not isinstance(event, dict):
                    continue
                if started and event.get("current_tool_use"):
                    break_before_text = True
                data = event.get("data")
                if isinstance(data, str) and data:
                    if break_before_text:
                        yield "\n\n"
                        break_before_text = False
                    started = True
                    yield data
            return
        except Exception:
            log.exception("エージェントの実行に失敗しました model=%s", model_id)
            # 途中まで返した後に別モデルでやり直すと文章が重複するため、切り替えるのは
            # まだ何も返していないときだけにする
            if started or i == len(models) - 1:
                yield "\n\n（応答の生成中にエラーが発生しました。時間をおいてもう一度お試しください）"
                return
            log.warning("次のモデルで再試行します model=%s", models[i + 1])


if __name__ == "__main__":
    app.run()
