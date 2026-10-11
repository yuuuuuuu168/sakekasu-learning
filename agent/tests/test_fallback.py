import asyncio
import json
import os
from types import SimpleNamespace

os.environ.setdefault("AWS_REGION", "ap-northeast-1")

import main  # noqa: E402
from llm import ModelChoice  # noqa: E402


class FakeAgent:
    def __init__(self, chunks, fail_after=None):
        self.chunks = chunks
        self.fail_after = fail_after

    async def stream_async(self, prompt):
        for i, c in enumerate(self.chunks):
            if self.fail_after is not None and i == self.fail_after:
                raise RuntimeError("boom")
            yield {"data": c}
        if self.fail_after is not None and self.fail_after >= len(self.chunks):
            raise RuntimeError("boom")


def _run(monkeypatch, agents):
    used = []

    def build(ctx, history, choice):
        used.append(choice.model_id)
        return agents[choice.model_id]

    models = [ModelChoice("anthropic", "primary"), ModelChoice("bedrock", "fallback")]
    monkeypatch.setattr(main, "MODELS", [m for m in models if m.model_id in agents])
    monkeypatch.setattr(main, "_build_agent", build)
    monkeypatch.setattr(main, "verify_access_token", lambda _: "user")
    monkeypatch.setattr(main, "consume_quota", lambda _: main.QuotaResult.OK)
    monkeypatch.setattr(main, "resolve_question", lambda _: SimpleNamespace(question_id="Q", selected=[]))
    ctx = SimpleNamespace(request_headers={"Authorization": "Bearer x"})

    async def collect():
        return [c async for c in main.invoke({"prompt": "hi"}, ctx)]

    return "".join(asyncio.run(collect())), used


def test_primary_success(monkeypatch):
    out, used = _run(monkeypatch, {"primary": FakeAgent(["a", "b"]), "fallback": FakeAgent(["x"])})
    assert out == "ab"
    assert used == ["primary"]


def test_fallback_when_primary_fails_before_output(monkeypatch):
    out, used = _run(monkeypatch, {"primary": FakeAgent([], fail_after=0), "fallback": FakeAgent(["x"])})
    assert out == "x"
    assert used == ["primary", "fallback"]


def test_no_fallback_after_partial_output(monkeypatch):
    out, used = _run(monkeypatch, {"primary": FakeAgent(["a", "b"], fail_after=1), "fallback": FakeAgent(["x"])})
    assert out.startswith("a") and "エラー" in out and "x" not in out
    assert used == ["primary"]


class ToolAgent:
    """前置き → ツール呼び出し → 本文の順にイベントを返す。"""

    def __init__(self, events):
        self.events = events

    async def stream_async(self, prompt):
        for e in self.events:
            yield e


TOOL_EVENT = {"type": "tool_use_stream", "current_tool_use": {"name": "search"}}


def test_blank_line_after_tool_use(monkeypatch):
    agent = ToolAgent([{"data": "確認します。"}, TOOL_EVENT, TOOL_EVENT, {"data": "## 結論"}, {"data": "\nA です"}])
    out, _ = _run(monkeypatch, {"primary": agent})
    assert out == "確認します。\n\n## 結論\nA です"


def test_no_blank_line_when_tool_used_before_any_text(monkeypatch):
    agent = ToolAgent([TOOL_EVENT, {"data": "## 結論"}])
    out, _ = _run(monkeypatch, {"primary": agent})
    assert out == "## 結論"


class ResultAgent:
    """本文を返さずに、stop_reason だけを持つ結果で終わる。"""

    def __init__(self, stop_reason):
        self.stop_reason = stop_reason

    async def stream_async(self, prompt):
        usage = {"inputTokens": 10, "outputTokens": 0, "cacheReadInputTokens": 5}
        yield {"result": SimpleNamespace(stop_reason=self.stop_reason, metrics=SimpleNamespace(accumulated_usage=usage))}


def test_fallback_when_model_refuses_before_output(monkeypatch, caplog):
    caplog.set_level("INFO", logger="tutor")
    out, used = _run(monkeypatch, {"primary": ResultAgent("refusal"), "fallback": FakeAgent(["x"])})
    assert out == "x"
    assert used == ["primary", "fallback"]
    assert any('"errorType": "refusal"' in r.getMessage() for r in caplog.records)


def test_fallback_is_logged_as_json(monkeypatch, caplog):
    out, _ = _run(monkeypatch, {"primary": FakeAgent([], fail_after=0), "fallback": FakeAgent(["x"])})
    assert out == "x"
    line = next(r.getMessage() for r in caplog.records if r.getMessage().startswith("[chat] fallback "))
    entry = json.loads(line.removeprefix("[chat] fallback "))
    assert entry["fallback"] is True
    assert entry["from"] == "anthropic" and entry["to"] == "bedrock"
    assert entry["errorType"] == "RuntimeError"


def test_usage_is_logged(monkeypatch, caplog):
    caplog.set_level("INFO", logger="tutor")
    _run(monkeypatch, {"primary": ResultAgent("end_turn")})
    line = next(r.getMessage() for r in caplog.records if r.getMessage().startswith("[chat] llm "))
    entry = json.loads(line.removeprefix("[chat] llm "))
    assert entry == {
        "provider": "anthropic",
        "model": "primary",
        "stopReason": "end_turn",
        "input": 10,
        "output": 0,
        "cacheRead": 5,
        "cacheWrite": 0,
    }
