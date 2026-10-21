/**
 * 資格・問題の識別子に使える文字。問題ビルドで通した名前と、API が受け付ける名前を一致させる。
 * agent/src/question_context.py にも同じ正規表現がある（agent/tests/test_shared_ids.py で一致を確かめる）。
 */

/** 分野・資格のディレクトリ名。URL と S3 キーに載るため、英小文字・数字・ハイフンに限る */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** 問題番号。URL のパスと DynamoDB のキーに載るため、使える文字を絞る */
export const QUESTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
