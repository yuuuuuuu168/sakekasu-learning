import re
from pathlib import Path

import question_context

IDS_TS = Path(__file__).resolve().parents[2] / "shared" / "ids.ts"


def _ts_pattern(name: str) -> str:
    m = re.search(rf"export const {name} = /(.+)/;", IDS_TS.read_text(encoding="utf-8"))
    assert m, f"{name} が {IDS_TS} に見つからない"
    return m.group(1)


def test_patterns_match_shared_ids():
    # API と問題ビルドが使う shared/ids.ts と同じ約束で受け付ける
    assert question_context.SLUG.pattern == _ts_pattern("SLUG")
    assert question_context.QUESTION_ID.pattern == _ts_pattern("QUESTION_ID")
