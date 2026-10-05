"""AI チャットの利用回数の上限（ユーザーごと・1 日ごと）。

モデルを呼ぶ前に、DynamoDB の条件付き UpdateItem で回数を 1 つ進める。上限に達していれば
条件で弾かれるので、同時に呼ばれても上限を超えない。日付の区切りは日本時間の 0 時。

テーブルのキーは userKey（sub の SHA-256）と day（YYYY-MM-DD）。sub そのものは保存しない。
古い日の記録は TTL（expiresAt）で消える。

環境変数:
    CHAT_QUOTA_TABLE_NAME  テーブル名（infra/lib/agent-stack.ts が入れる）。空なら上限なし（手元での確認用）
    CHAT_DAILY_LIMIT       1 日の上限回数
"""

from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timedelta, timezone
from enum import Enum

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)

JST = timezone(timedelta(hours=9))
DEFAULT_DAILY_LIMIT = 50
# 日付が変わってからも少し残す（TTL の削除は即時ではないので、判定には使わない）
_RETENTION = timedelta(days=2)

_ddb = None


class QuotaResult(Enum):
    OK = "ok"
    EXCEEDED = "exceeded"
    UNAVAILABLE = "unavailable"


def _client():
    global _ddb
    if _ddb is None:
        _ddb = boto3.client("dynamodb")
    return _ddb


def daily_limit() -> int:
    try:
        limit = int(os.environ.get("CHAT_DAILY_LIMIT", DEFAULT_DAILY_LIMIT))
    except ValueError:
        return DEFAULT_DAILY_LIMIT
    return limit if limit > 0 else DEFAULT_DAILY_LIMIT


def user_key(sub: str) -> str:
    return hashlib.sha256(sub.encode()).hexdigest()


def consume(sub: str, now: datetime | None = None) -> QuotaResult:
    """今日の利用回数を 1 つ進める。上限に達していれば EXCEEDED。"""
    table = os.environ.get("CHAT_QUOTA_TABLE_NAME", "")
    if not table:
        return QuotaResult.OK
    now = (now or datetime.now(JST)).astimezone(JST)
    limit = daily_limit()
    try:
        _client().update_item(
            TableName=table,
            Key={"userKey": {"S": user_key(sub)}, "day": {"S": now.strftime("%Y-%m-%d")}},
            UpdateExpression="ADD #count :one SET #expiresAt = :expiresAt",
            ConditionExpression="attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames={"#count": "count", "#expiresAt": "expiresAt"},
            ExpressionAttributeValues={
                ":one": {"N": "1"},
                ":limit": {"N": str(limit)},
                ":expiresAt": {"N": str(int((now + _RETENTION).timestamp()))},
            },
        )
    except ClientError as err:
        if err.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return QuotaResult.EXCEEDED
        log.exception("利用回数を記録できませんでした")
        return QuotaResult.UNAVAILABLE
    except Exception:
        log.exception("利用回数を記録できませんでした")
        return QuotaResult.UNAVAILABLE
    return QuotaResult.OK
