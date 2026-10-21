"""問題データの読み込み（S3）。失敗の種類ごとの扱いと、覚えておく範囲を確かめる。"""

import io
import json

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

import question_context
from question_context import QuestionsUnavailable, load_exam

EXAM = {
    "name": "Test",
    "questions": [{"id": "Q-1", "question": "問", "choices": ["a"], "answers": [0], "explanations": ["x"]}],
}


class FakeS3:
    def __init__(self, *results):
        # 呼ばれるたびに先頭から 1 つずつ返す（例外なら投げる）
        self.results = list(results)
        self.calls = 0

    def get_object(self, Bucket, Key):
        self.calls += 1
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return {"Body": io.BytesIO(result if isinstance(result, bytes) else json.dumps(result).encode())}


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "GetObject")


@pytest.fixture
def s3(monkeypatch):
    monkeypatch.setenv("QUESTIONS_BUCKET_NAME", "bucket")
    monkeypatch.setattr(question_context, "_cache", {})

    def install(*results):
        fake = FakeS3(*results)
        monkeypatch.setattr(question_context, "_client", lambda: fake)
        return fake

    return install


def test_loads_and_caches(s3):
    fake = s3(EXAM)
    assert load_exam("aws", "dop") == EXAM
    assert load_exam("aws", "dop") == EXAM
    assert fake.calls == 1


def test_missing_exam_is_none_and_cached(s3):
    fake = s3(client_error("NoSuchKey"))
    assert load_exam("aws", "nope") is None
    assert load_exam("aws", "nope") is None
    assert fake.calls == 1


@pytest.mark.parametrize(
    "failure",
    [
        client_error("AccessDenied"),
        client_error("SlowDown"),
        EndpointConnectionError(endpoint_url="https://s3"),
        b"{not json",
        b"\xff\xfe",
        {"name": "no questions"},
        {"questions": [{"id": "Q-1"}]},
    ],
)
def test_unreadable_data_raises_and_is_not_cached(s3, caplog, failure):
    fake = s3(failure, EXAM)
    with pytest.raises(QuestionsUnavailable):
        load_exam("aws", "dop")
    assert any("key=aws/dop.json" in r.getMessage() for r in caplog.records)
    # 覚えていないので、次の相談で読み直せる
    assert load_exam("aws", "dop") == EXAM
    assert fake.calls == 2


def test_missing_bucket_env_raises(s3, monkeypatch):
    s3(EXAM)
    monkeypatch.delenv("QUESTIONS_BUCKET_NAME")
    with pytest.raises(QuestionsUnavailable):
        load_exam("aws", "dop")
