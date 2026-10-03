"""共通ログインのアクセストークンの検証（auth.verify_access_token）。

署名鍵はテストの中で作り、JWKS の取得は差し替える（ネットワークに出ない）。
"""

import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

import auth

POOL_ID = "ap-northeast-1_TestPool1"
CLIENT_ID = "testclientid0123456789abcd"
ISSUER = f"https://cognito-idp.ap-northeast-1.amazonaws.com/{POOL_ID}"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("COGNITO_USER_POOL_ID", POOL_ID)
    monkeypatch.setenv("COGNITO_CLIENT_ID", CLIENT_ID)
    # Runtime のリージョンとプールのリージョンが違っても、発行者はプール ID から決まる
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    fake = SimpleNamespace(get_signing_key_from_jwt=lambda _token: SimpleNamespace(key=KEY.public_key()))
    monkeypatch.setattr(auth, "_jwks_client", lambda: fake)


def _token(**overrides):
    now = int(time.time())
    claims = {
        "sub": "11111111-2222-3333-4444-555555555555",
        "iss": ISSUER,
        "client_id": CLIENT_ID,
        "token_use": "access",
        "scope": "openid email profile",
        "iat": now,
        "exp": now + 3600,
        **overrides,
    }
    return "Bearer " + jwt.encode(claims, KEY, algorithm="RS256")


def test_returns_sub_for_shared_pool_access_token():
    assert auth.verify_access_token(_token()) == "11111111-2222-3333-4444-555555555555"


def test_rejects_other_client():
    assert auth.verify_access_token(_token(client_id="otherclient0123456789abcd")) is None


def test_rejects_old_pool_issuer():
    old = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_OldPool99"
    assert auth.verify_access_token(_token(iss=old)) is None


def test_rejects_id_token_and_missing_header():
    assert auth.verify_access_token(_token(token_use="id")) is None
    assert auth.verify_access_token(None) is None
    assert auth.verify_access_token("Basic abc") is None


def test_rejects_expired_token():
    assert auth.verify_access_token(_token(exp=int(time.time()) - 10)) is None
