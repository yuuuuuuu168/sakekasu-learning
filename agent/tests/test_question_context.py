import pytest

import question_context
from question_context import InvalidRequest, render_question, resolve_question

EXAM = {
    "name": "Test Exam",
    "questions": [
        {
            "id": "Q-1",
            "question": "正しいものを選択してください。（2 つ選択）",
            "choices": ["いち", "に", "さん", "よん"],
            "answers": [0, 3],
            "explanations": [
                "選択肢 4 と組み合わせる。",
                "選択肢 1 と 4 の組み合わせに劣る。",
                "選択肢3は誤り。",
                "選択肢 1 が担う。",
            ],
        }
    ],
}


def _payload(**kw):
    base = {"category": "aws", "exam": "dop-c02", "questionId": "Q-1", "displayOrder": [3, 1, 0, 2], "selected": []}
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _exam(monkeypatch):
    monkeypatch.setattr(question_context, "load_exam", lambda category, exam: EXAM)


def test_relabel_uses_display_order():
    ctx = resolve_question(_payload())
    # 原本の選択肢1 → 画面C、選択肢4 → 画面A
    assert ctx.relabel("選択肢 1 と 4 の組み合わせ") == "選択肢 C と A の組み合わせ"
    assert ctx.relabel("選択肢3は誤り") == "選択肢Dは誤り"
    assert ctx.relabel("選択肢 9") == "選択肢 9"
    # 英語の解説
    assert ctx.relabel("Option 4 covers it") == "Option A covers it"
    assert ctx.relabel("options 1 and 3 only") == "options C and D only"
    assert ctx.relabel("2 options for 3 regions") == "2 options for 3 regions"


def test_render_hides_nothing_but_marks_unanswered():
    text = render_question(resolve_question(_payload()))
    assert "A. よん" in text and "C. いち" in text
    assert "まだ回答していません" in text
    assert "## 正解\nA, C" in text
    # 受験者には通し番号だけを見せる（管理用の番号は AI にも渡さない）
    assert "問題番号: 問1" in text
    assert "Q-1" not in text


def test_render_answered():
    text = render_question(resolve_question(_payload(selected=[0, 1])))
    assert "B, C（不正解）" in text


def test_invalid_input():
    for payload, message in [
        (_payload(category="../etc"), "資格の指定が不正です。"),
        (_payload(questionId="Q 1"), "問題の指定が不正です。"),
        (_payload(questionId="Q-2"), "問題が見つかりませんでした。"),
    ]:
        with pytest.raises(InvalidRequest, match=message):
            resolve_question(payload)


def test_bad_display_order_falls_back():
    ctx = resolve_question(_payload(displayOrder=[0, 0, 1, 2], selected=[9]))
    assert ctx.display_order == [0, 1, 2, 3]
    assert ctx.selected == []


def test_display_order_with_non_int_falls_back():
    # 文字列や null が混じっても例外にせず、原本の順で扱う
    for order in ([0, "1", 2, 3], [0, None, 2, 3], [True, False, 2, 3]):
        ctx = resolve_question(_payload(displayOrder=order))
        assert ctx.display_order == [0, 1, 2, 3]


def test_selected_rejects_bool():
    ctx = resolve_question(_payload(selected=[True]))
    assert ctx.selected == []
