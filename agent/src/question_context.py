"""問題データの読み込みと、システムプロンプトに載せる問題の文脈づくり。

問題の本文・正解・解説はクライアントから受け取らず、非公開バケットから読む。
クライアントが送るのは「どの問題か」「画面の並び順」「何を選んだか」だけ。
"""

from __future__ import annotations

import json
import os
import re
import string
import threading
import time
from dataclasses import dataclass
from typing import Any

import boto3

# shared/ids.ts と同じ（tests/test_shared_ids.py で一致を確かめる）
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
QUESTION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
LABELS = string.ascii_uppercase



class InvalidRequest(Exception):
    """相談を受け付けられない入力。message はそのまま受験者に返す。"""


_TTL_SECONDS = 300
_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}
_lock = threading.Lock()
_s3 = None


def _client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


def load_exam(category: str, exam: str) -> dict[str, Any] | None:
    key = f"{category}/{exam}.json"
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    try:
        res = _client().get_object(Bucket=os.environ["QUESTIONS_BUCKET_NAME"], Key=key)
        value = json.loads(res["Body"].read())
    except _client().exceptions.NoSuchKey:
        value = None
    with _lock:
        _cache[key] = (now + _TTL_SECONDS, value)
    return value


@dataclass(frozen=True)
class QuestionContext:
    exam_name: str
    question_id: str
    # 画面に出す通し番号（1 始まり）。管理用の question_id は受験者に見せない
    number: int
    question: str
    choices: list[str]
    answers: list[int]
    explanations: list[str]
    display_order: list[int]
    selected: list[int]

    def label(self, original_index: int) -> str:
        return LABELS[self.display_order.index(original_index)]

    def relabel(self, text: str) -> str:
        """解説中の「選択肢 3」「選択肢 1 と 3」（英語の解説では「Option 3」「options 1 and 3」）を画面の表示ラベルに置き換える。"""

        def replace_number(m: re.Match[str]) -> str:
            n = int(m.group(0))
            return self.label(n - 1) if 1 <= n <= len(self.choices) else m.group(0)

        def replace_ref(m: re.Match[str]) -> str:
            return re.sub(r"\d+", replace_number, m.group(0))

        return re.sub(
            r"(?:選択肢|[Oo]ptions?)\s*\d+(?:\s*(?:と|、|,\s*and|,\s*or|,|および|及び|や|・|and|or)\s*\d+)*",
            replace_ref,
            text,
        )


def resolve_question(payload: dict[str, Any]) -> QuestionContext:
    """ペイロードを検証して問題の文脈を返す。不正なら InvalidRequest を投げる。"""
    category = payload.get("category")
    exam = payload.get("exam")
    question_id = payload.get("questionId")
    if not (isinstance(category, str) and SLUG.match(category)):
        raise InvalidRequest("資格の指定が不正です。")
    if not (isinstance(exam, str) and SLUG.match(exam)):
        raise InvalidRequest("資格の指定が不正です。")
    if not (isinstance(question_id, str) and QUESTION_ID.match(question_id)):
        raise InvalidRequest("問題の指定が不正です。")

    exam_file = load_exam(category, exam)
    if not exam_file:
        raise InvalidRequest("資格が見つかりませんでした。")
    index = next((i for i, q in enumerate(exam_file["questions"]) if q["id"] == question_id), None)
    if index is None:
        raise InvalidRequest("問題が見つかりませんでした。")
    question = exam_file["questions"][index]

    n = len(question["choices"])
    display_order = payload.get("displayOrder")
    # 型を先に確かめる（文字列や null が混じると sorted が TypeError を投げる）。
    # bool は int の派生なので type で比べて弾く
    if not (
        isinstance(display_order, list)
        and all(type(v) is int for v in display_order)
        and sorted(display_order) == list(range(n))
    ):
        # 並び順が不正なら原本の順で扱う（相談自体は続けられる）
        display_order = list(range(n))

    selected = payload.get("selected") or []
    if not (
        isinstance(selected, list)
        and all(type(v) is int and 0 <= v < n for v in selected)
        and len(set(selected)) == len(selected)
    ):
        selected = []

    return QuestionContext(
        exam_name=exam_file.get("name", exam),
        question_id=question_id,
        number=index + 1,
        question=question["question"],
        choices=question["choices"],
        answers=question["answers"],
        explanations=question["explanations"],
        display_order=display_order,
        selected=selected,
    )


def render_question(ctx: QuestionContext) -> str:
    """システムプロンプトに載せる問題の文脈（画面と同じ A, B, C... の並び）。"""
    lines = [
        f"資格: {ctx.exam_name}",
        f"問題番号: 問{ctx.number}",
        "",
        "## 問題文",
        ctx.question,
        "",
        "## 選択肢（受験者の画面の表示順）",
    ]
    for pos, original in enumerate(ctx.display_order):
        lines.append(f"{LABELS[pos]}. {ctx.choices[original]}")

    answered = bool(ctx.selected)
    correct_labels = ", ".join(sorted(ctx.label(i) for i in ctx.answers))
    lines += ["", "## 正解", correct_labels]

    if answered:
        chosen = ", ".join(sorted(ctx.label(i) for i in ctx.selected))
        is_correct = sorted(ctx.selected) == sorted(ctx.answers)
        lines += ["", "## 受験者の回答", f"{chosen}（{'正解' if is_correct else '不正解'}）"]
    else:
        lines += ["", "## 受験者の回答", "まだ回答していません"]

    lines += ["", "## 公式解説（選択肢ごと）"]
    for pos, original in enumerate(ctx.display_order):
        mark = "正解" if original in ctx.answers else "不正解"
        lines += [f"### 選択肢{LABELS[pos]}（{mark}）", ctx.relabel(ctx.explanations[original]), ""]
    return "\n".join(lines)
