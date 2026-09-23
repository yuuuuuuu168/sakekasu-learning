import os

os.environ.setdefault("AWS_REGION", "ap-northeast-1")

from main import _sanitize_history  # noqa: E402


def test_history_is_normalized():
    history = [
        {"role": "assistant", "content": "先頭のassistantは捨てる"},
        {"role": "user", "content": "質問1"},
        {"role": "user", "content": "質問1の続き"},
        {"role": "assistant", "content": "回答1"},
        {"role": "system", "content": "不正な役割"},
        {"role": "user", "content": "末尾のuserは捨てる"},
    ]
    messages = _sanitize_history(history)
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[0]["content"][0]["text"] == "質問1\n\n質問1の続き"


def test_history_rejects_garbage():
    assert _sanitize_history("x") == []
    assert _sanitize_history([{"role": "user", "content": 1}]) == []
