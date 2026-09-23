import question_context
from question_context import render_question, resolve_question

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


def setup_function():
    question_context.load_exam = lambda category, exam: EXAM


def test_relabel_uses_display_order():
    ctx = resolve_question(_payload())
    # 原本の選択肢1 → 画面C、選択肢4 → 画面A
    assert ctx.relabel("選択肢 1 と 4 の組み合わせ") == "選択肢 C と A の組み合わせ"
    assert ctx.relabel("選択肢3は誤り") == "選択肢Dは誤り"
    assert ctx.relabel("選択肢 9") == "選択肢 9"


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
    assert resolve_question(_payload(category="../etc")) == "資格の指定が不正です。"
    assert resolve_question(_payload(questionId="Q 1")) == "問題の指定が不正です。"
    assert resolve_question(_payload(questionId="Q-2")) == "問題が見つかりませんでした。"


def test_bad_display_order_falls_back():
    ctx = resolve_question(_payload(displayOrder=[0, 0, 1, 2], selected=[9]))
    assert ctx.display_order == [0, 1, 2, 3]
    assert ctx.selected == []
