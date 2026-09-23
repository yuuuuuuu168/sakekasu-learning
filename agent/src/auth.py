"""Cognito アクセストークンの検証。

Runtime の JWT オーソライザーでも検証済みだが、アプリ側でも検証して sub を取り出す
（オーソライザーの設定ミスで素通しになっても、ここで止める）。
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache

import jwt
from jwt import PyJWKClient

log = logging.getLogger(__name__)


def _issuer() -> str:
    region = os.environ.get("AWS_REGION", "ap-northeast-1")
    return f"https://cognito-idp.{region}.amazonaws.com/{os.environ['COGNITO_USER_POOL_ID']}"


@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    return PyJWKClient(f"{_issuer()}/.well-known/jwks.json", cache_keys=True, lifespan=3600)


def verify_access_token(authorization: str | None) -> str | None:
    """Authorization ヘッダーを検証し、sub を返す。不正なら None。"""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization[len("Bearer ") :].strip()
    try:
        key = _jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key.key,
            algorithms=["RS256"],
            issuer=_issuer(),
            options={"require": ["exp", "iss", "sub", "token_use", "client_id"]},
        )
    except jwt.PyJWTError as err:
        log.warning("アクセストークンの検証に失敗しました: %s", type(err).__name__)
        return None
    if claims.get("token_use") != "access":
        return None
    if claims.get("client_id") != os.environ["COGNITO_CLIENT_ID"]:
        return None
    sub = claims.get("sub")
    return sub if isinstance(sub, str) and sub else None
