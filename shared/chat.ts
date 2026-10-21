/**
 * AI チャットの上限。agent/src/main.py にも同じ値がある（agent/tests/test_shared_chat.py で一致を確かめる）。
 */

/** 1 回の相談内容の最大文字数 */
export const MAX_PROMPT_LENGTH = 2000;

/** モデルに渡す会話履歴の最大件数（古いものから捨てる） */
export const MAX_HISTORY_MESSAGES = 20;
