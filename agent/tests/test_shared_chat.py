import os
import re
from pathlib import Path

os.environ.setdefault("AWS_REGION", "ap-northeast-1")

import main  # noqa: E402

CHAT_TS = Path(__file__).resolve().parents[2] / "shared" / "chat.ts"


def _ts_number(name: str) -> int:
    m = re.search(rf"export const {name} = (\d+);", CHAT_TS.read_text(encoding="utf-8"))
    assert m, f"{name} が {CHAT_TS} に見つからない"
    return int(m.group(1))


def test_limits_match_shared_chat():
    # 画面の入力欄の上限と、送る履歴の件数を agent と揃える
    assert main.MAX_PROMPT_LENGTH == _ts_number("MAX_PROMPT_LENGTH")
    assert main.MAX_HISTORY_MESSAGES == _ts_number("MAX_HISTORY_MESSAGES")
