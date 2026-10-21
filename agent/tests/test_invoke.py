"""invoke の断る分岐。モデルを呼ばず、相談回数も減らさないことを確かめる
（上限まわりは test_quota.py、モデルの切り替えは test_fallback.py）。"""

import asyncio
import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("AWS_REGION", "ap-northeast-1")

import main  # noqa: E402
from question_context import InvalidRequest  # noqa: E402

HEADERS = SimpleNamespace(request_headers={"Authorization": "Bearer x"})


@pytest.fixture
def calls(monkeypatch):
    """消費した相談回数とモデルの呼び出しを記録する。"""
    recorded = {"quota": [], "agent": []}
    monkeypatch.setattr(main, "verify_access_token", lambda header: "user" if header == "Bearer x" else None)
    monkeypatch.setattr(main, "resolve_question", lambda _: SimpleNamespace(question_id="Q", selected=[]))
    monkeypatch.setattr(main, "consume_quota", lambda sub: recorded["quota"].append(sub) or main.QuotaResult.OK)
    monkeypatch.setattr(
        main, "_build_agent", lambda *a: recorded["agent"].append(a) or pytest.fail("モデルを呼んではいけない")
    )
    return recorded


def _invoke(payload, context=HEADERS):
    async def collect():
        return [c async for c in main.invoke(payload, context)]

    return "".join(asyncio.run(collect()))


def test_rejects_without_valid_token(calls):
    for context in (
        SimpleNamespace(request_headers={}),
        SimpleNamespace(),
        SimpleNamespace(request_headers={"authorization": "Bearer bad"}),
    ):
        assert "ログインし直して" in _invoke({"prompt": "hi"}, context)
    assert calls == {"quota": [], "agent": []}


def test_reads_authorization_header_case_insensitively(monkeypatch, calls):
    seen = []
    monkeypatch.setattr(main, "verify_access_token", lambda header: seen.append(header))
    _invoke({"prompt": "hi"}, SimpleNamespace(request_headers={"AUTHORIZATION": "Bearer y"}))
    assert seen == ["Bearer y"]


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "リクエストの形式が不正です。"),
        (["prompt"], "リクエストの形式が不正です。"),
        ({}, "相談内容を入力してください。"),
        ({"prompt": 1}, "相談内容を入力してください。"),
        ({"prompt": "   "}, "相談内容を入力してください。"),
        ({"prompt": "あ" * (main.MAX_PROMPT_LENGTH + 1)}, f"{main.MAX_PROMPT_LENGTH}文字以内"),
    ],
)
def test_rejects_invalid_payload(calls, payload, message):
    assert message in _invoke(payload)
    assert calls == {"quota": [], "agent": []}


def test_accepts_prompt_at_max_length(monkeypatch, calls):
    async def answer(ctx, history, prompt):
        yield "ok"

    monkeypatch.setattr(main, "_answer", answer)
    assert _invoke({"prompt": "あ" * main.MAX_PROMPT_LENGTH}) == "ok"
    assert calls["quota"] == ["user"]


def test_invalid_question_does_not_consume(monkeypatch, calls):
    def resolve(_):
        raise InvalidRequest("問題が見つかりませんでした。")

    monkeypatch.setattr(main, "resolve_question", resolve)
    assert _invoke({"prompt": "hi"}) == "問題が見つかりませんでした。"
    assert calls == {"quota": [], "agent": []}
