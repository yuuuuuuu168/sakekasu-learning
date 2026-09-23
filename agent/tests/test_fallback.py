import asyncio
import os
from types import SimpleNamespace

os.environ.setdefault("AWS_REGION", "ap-northeast-1")

import main  # noqa: E402


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

    def build(ctx, history, model_id=None):
        used.append(model_id)
        return agents[model_id]

    monkeypatch.setattr(main, "MODEL_ID", "primary")
    monkeypatch.setattr(main, "FALLBACK_MODEL_ID", "fallback")
    monkeypatch.setattr(main, "_build_agent", build)
    monkeypatch.setattr(main, "verify_access_token", lambda _: "user")
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
