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
import json
import logging
import os
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, ModelRetryStrategy
from strands.tools.mcp import MCPClient

from auth import verify_access_token
from llm import ModelChoice, RefusalError, create_model, fallback_reason, model_chain
from question_context import InvalidRequest, QuestionContext, render_question, resolve_question
from quota import QuotaResult, consume as consume_quota, daily_limit

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("tutor")

app = BedrockAgentCoreApp()

# 試す順のモデル（llm.model_chain）。Claude API → Bedrock の MODEL_ID → FALLBACK_MODEL_ID。
# 前のモデルが応答を1文字も返さないうちに失敗したときだけ、次のモデルで答え直す
MODELS = model_chain()
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


def _build_agent(ctx: QuestionContext, history: list[dict[str, Any]], choice: ModelChoice) -> Agent:
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
        model=create_model(choice),
        system_prompt=system_prompt,
        tools=[docs],
        messages=history,
        callback_handler=None,
        # Claude API は SDK が再試行するので、流量制限で待ち続けずに次のモデルへ回す。
        # Bedrock は従来どおり Strands の既定（数回待って再試行）
        **({"retry_strategy": ModelRetryStrategy(max_attempts=1)} if choice.provider == "anthropic" else {}),
    )


def _log_usage(choice: ModelChoice, result: Any) -> None:
    """1 回の相談の消費（ツールを挟んだ複数回の呼び出しの合計）。1 行の JSON にして、
    CloudWatch Logs Insights で呼び先ごとのトークン数やキャッシュの効きを集計できるようにする。"""
    usage = getattr(getattr(result, "metrics", None), "accumulated_usage", None) or {}
    entry = {
        "provider": choice.provider,
        "model": choice.model_id,
        "stopReason": getattr(result, "stop_reason", None),
        "input": usage.get("inputTokens", 0),
        "output": usage.get("outputTokens", 0),
        "cacheRead": usage.get("cacheReadInputTokens", 0),
        "cacheWrite": usage.get("cacheWriteInputTokens", 0),
    }
    log.info("[chat] llm %s", json.dumps(entry))


def _authorization(context: Any) -> str | None:
    headers = getattr(context, "request_headers", None) or {}
    return next((v for k, v in headers.items() if k.lower() == "authorization"), None)


def _validate_prompt(payload: Any) -> str:
    """今回の相談内容を取り出す。受け付けられない入力なら InvalidRequest を投げる。"""
    if not isinstance(payload, dict):
        raise InvalidRequest("リクエストの形式が不正です。")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise InvalidRequest("相談内容を入力してください。")
    if len(prompt) > MAX_PROMPT_LENGTH:
        raise InvalidRequest(f"相談内容が長すぎます。{MAX_PROMPT_LENGTH}文字以内でお願いします。")
    return prompt


def _quota_refusal(quota: QuotaResult) -> str | None:
    """相談回数の判定で断るときの文言。続けてよいなら None。"""
    if quota is QuotaResult.EXCEEDED:
        log.info("1 日の上限に達したため断りました")
        return f"今日の相談回数の上限（{daily_limit()}回）に達しました。明日（日本時間の 0 時以降）にまたお試しください。"
    if quota is QuotaResult.UNAVAILABLE:
        # 数えられないときは、上限を守れないので呼ばない（費用の上限を優先する）
        return "ただいま相談を受け付けられません。時間をおいてもう一度お試しください。"
    return None


def _log_fallback(choice: ModelChoice, following: ModelChoice, error: Exception) -> None:
    """次のモデルに回したことを 1 行の JSON で残す（アラームのメトリクスフィルターが拾う）。"""
    entry = {
        "fallback": True,
        "from": choice.provider,
        "fromModel": choice.model_id,
        "to": following.provider,
        "toModel": following.model_id,
        "errorType": fallback_reason(error, choice.provider),
        "message": str(error)[:300],
    }
    log.warning("[chat] fallback %s", json.dumps(entry, ensure_ascii=False))


class _Stream:
    """1 つのモデルの応答を流す。何か返したか（started）を呼び出し側が見て、次のモデルに回すかを決める。"""

    def __init__(self, agent: Agent, choice: ModelChoice):
        self.agent = agent
        self.choice = choice
        self.started = False

    async def run(self, prompt: str):
        # ツールを呼ぶ前の前置きと呼んだ後の本文が改行なしでつながると、本文冒頭の見出し（##）が
        # Markdown として崩れるため、ツールを挟んで本文を再開するときは空行を入れる
        break_before_text = False
        async for event in self.agent.stream_async(prompt):
            if not isinstance(event, dict):
                continue
            if self.started and event.get("current_tool_use"):
                break_before_text = True
            data = event.get("data")
            if isinstance(data, str) and data:
                if break_before_text:
                    yield "\n\n"
                    break_before_text = False
                self.started = True
                yield data
            result = event.get("result")
            if result is not None:
                _log_usage(self.choice, result)
                if not self.started and getattr(result, "stop_reason", None) == "refusal":
                    raise RefusalError("モデルが回答を断りました")


async def _answer(ctx: QuestionContext, history: Any, prompt: str):
    """MODELS の順に答えさせる。前のモデルが何も返さないうちに失敗したときだけ次のモデルで答え直す。"""
    for i, choice in enumerate(MODELS):
        # 会話履歴は Agent が書き換えるため、モデルごとに作り直す
        stream = _Stream(_build_agent(ctx, _sanitize_history(history), choice), choice)
        try:
            async for chunk in stream.run(prompt):
                yield chunk
            return
        except Exception as error:
            log.exception("エージェントの実行に失敗しました provider=%s model=%s", choice.provider, choice.model_id)
            # 途中まで返した後に別モデルでやり直すと文章が重複するため、切り替えるのは
            # まだ何も返していないときだけにする
            if stream.started or i == len(MODELS) - 1:
                yield "\n\n（応答の生成中にエラーが発生しました。時間をおいてもう一度お試しください）"
                return
            _log_fallback(choice, MODELS[i + 1], error)


@app.entrypoint
async def invoke(payload: Any, context: Any):
    user = await asyncio.to_thread(verify_access_token, _authorization(context))
    if not user:
        log.warning("認証されていないリクエストを拒否しました")
        yield "認証情報を確認できませんでした。ログインし直してからもう一度お試しください。"
        return

    try:
        prompt = _validate_prompt(payload)
        ctx = await asyncio.to_thread(resolve_question, payload)
    except InvalidRequest as error:
        yield str(error)
        return

    # モデルを呼ぶ直前に数える。入力の誤りや存在しない問題では回数を減らさない
    refusal = _quota_refusal(await asyncio.to_thread(consume_quota, user))
    if refusal:
        yield refusal
        return

    log.info("相談を受け付けました question=%s answered=%s", ctx.question_id, bool(ctx.selected))
    async for chunk in _answer(ctx, payload.get("history"), prompt):
        yield chunk


if __name__ == "__main__":
    app.run()
