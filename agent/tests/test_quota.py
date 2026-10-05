import asyncio
import os
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError

os.environ.setdefault("AWS_REGION", "ap-northeast-1")

import main  # noqa: E402
import quota  # noqa: E402


class FakeDynamoDB:
    """条件付き UpdateItem だけを真似る。"""

    def __init__(self, error_code=None):
        self.items = {}
        self.calls = []
        self.error_code = error_code

    def update_item(self, **kwargs):
        self.calls.append(kwargs)
        if self.error_code:
            raise ClientError({"Error": {"Code": self.error_code}}, "UpdateItem")
        key = (kwargs["Key"]["userKey"]["S"], kwargs["Key"]["day"]["S"])
        count = self.items.get(key, 0)
        limit = int(kwargs["ExpressionAttributeValues"][":limit"]["N"])
        if count >= limit:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        self.items[key] = count + 1


@pytest.fixture
def ddb(monkeypatch):
    fake = FakeDynamoDB()
    monkeypatch.setattr(quota, "_client", lambda: fake)
    monkeypatch.setenv("CHAT_QUOTA_TABLE_NAME", "quota-table")
    monkeypatch.setenv("CHAT_DAILY_LIMIT", "3")
    return fake


def test_counts_up_to_the_limit(ddb):
    results = [quota.consume("user-a") for _ in range(4)]
    assert results == [quota.QuotaResult.OK] * 3 + [quota.QuotaResult.EXCEEDED]


def test_limit_is_per_user(ddb):
    for _ in range(3):
        quota.consume("user-a")
    assert quota.consume("user-b") is quota.QuotaResult.OK


def test_day_changes_at_midnight_jst(ddb):
    # 2026-10-05 23:59 JST と 2026-10-06 00:00 JST は別の日
    before = datetime(2026, 10, 5, 14, 59, tzinfo=timezone.utc)
    after = datetime(2026, 10, 5, 15, 0, tzinfo=timezone.utc)
    for _ in range(3):
        quota.consume("user-a", now=before)
    assert quota.consume("user-a", now=before) is quota.QuotaResult.EXCEEDED
    assert quota.consume("user-a", now=after) is quota.QuotaResult.OK
    days = sorted({call["Key"]["day"]["S"] for call in ddb.calls})
    assert days == ["2026-10-05", "2026-10-06"]


def test_does_not_store_the_raw_sub(ddb):
    quota.consume("raw-sub-value")
    key = ddb.calls[0]["Key"]["userKey"]["S"]
    assert "raw-sub-value" not in key
    assert len(key) == 64


def test_sets_ttl_after_the_day(ddb):
    now = datetime(2026, 10, 5, 3, 0, tzinfo=timezone.utc)
    quota.consume("user-a", now=now)
    expires = int(ddb.calls[0]["ExpressionAttributeValues"][":expiresAt"]["N"])
    assert expires > now.timestamp() + 24 * 3600


def test_other_errors_are_unavailable(monkeypatch):
    monkeypatch.setattr(quota, "_client", lambda: FakeDynamoDB(error_code="ProvisionedThroughputExceededException"))
    monkeypatch.setenv("CHAT_QUOTA_TABLE_NAME", "quota-table")
    assert quota.consume("user-a") is quota.QuotaResult.UNAVAILABLE


def test_no_table_means_no_limit(monkeypatch):
    monkeypatch.delenv("CHAT_QUOTA_TABLE_NAME", raising=False)
    monkeypatch.setattr(quota, "_client", lambda: pytest.fail("DynamoDB を呼んではいけない"))
    assert quota.consume("user-a") is quota.QuotaResult.OK


def test_invalid_limit_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("CHAT_DAILY_LIMIT", "abc")
    assert quota.daily_limit() == quota.DEFAULT_DAILY_LIMIT
    monkeypatch.setenv("CHAT_DAILY_LIMIT", "0")
    assert quota.daily_limit() == quota.DEFAULT_DAILY_LIMIT


def _invoke(monkeypatch, result):
    built = []
    monkeypatch.setattr(main, "verify_access_token", lambda _: "user")
    monkeypatch.setattr(main, "resolve_question", lambda _: SimpleNamespace(question_id="Q", selected=[]))
    monkeypatch.setattr(main, "consume_quota", lambda _: result)
    monkeypatch.setattr(main, "_build_agent", lambda *a, **k: built.append(1) or pytest.fail("モデルを呼んではいけない"))
    ctx = SimpleNamespace(request_headers={"Authorization": "Bearer x"})

    async def collect():
        return [c async for c in main.invoke({"prompt": "hi"}, ctx)]

    return "".join(asyncio.run(collect())), built


def test_invoke_refuses_when_exceeded(monkeypatch):
    monkeypatch.setenv("CHAT_DAILY_LIMIT", "50")
    out, built = _invoke(monkeypatch, quota.QuotaResult.EXCEEDED)
    assert "上限（50回）" in out
    assert built == []


def test_invoke_refuses_when_quota_unavailable(monkeypatch):
    out, built = _invoke(monkeypatch, quota.QuotaResult.UNAVAILABLE)
    assert "受け付けられません" in out
    assert built == []


def test_invalid_prompt_does_not_consume(monkeypatch):
    consumed = []
    monkeypatch.setattr(main, "verify_access_token", lambda _: "user")
    monkeypatch.setattr(main, "consume_quota", lambda sub: consumed.append(sub) or quota.QuotaResult.OK)
    ctx = SimpleNamespace(request_headers={"Authorization": "Bearer x"})

    async def collect():
        return [c async for c in main.invoke({"prompt": "  "}, ctx)]

    asyncio.run(collect())
    assert consumed == []
