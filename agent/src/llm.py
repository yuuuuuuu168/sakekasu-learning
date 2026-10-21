"""AI チャットが呼ぶモデルの選択。呼び先は 2 つで、どちらも Strands の Model として Agent に渡す。

- anthropic: Claude API（api.anthropic.com）。Max プランに付く月々のクレジットで払う。既定
- bedrock: Amazon Bedrock（Kimi K3）。クレジット切れや障害のときの控え。単純に課金される

Claude API の認証は Workload Identity Federation で、API キーを持たない。Runtime のロールで
STS の GetWebIdentityToken を呼んで AWS が署名した JWT をもらい、SDK が Anthropic の短命の
トークンと交換する（期限の前に自分でやり直す）。設定の手順は docs/claude-api.md にある。

LLM_PROVIDER が anthropic でも、ID 連携の値が揃っていなければ Bedrock だけで答える
（設定前の環境でもチャットを止めない）。
"""

from __future__ import annotations

import functools
import os
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from typing import Literal

import anthropic
import boto3
from anthropic.lib.credentials import WorkloadIdentityCredentials, WorkloadIdentityError
from botocore.exceptions import BotoCoreError, ClientError
from strands.models import CacheConfig, Model
from strands.models.anthropic import AnthropicModel
from strands.models.bedrock import BedrockModel
from strands.types.exceptions import ModelThrottledException

Provider = Literal["anthropic", "bedrock"]

DEFAULT_ANTHROPIC_MODEL_CHAT = "claude-haiku-5-5"
DEFAULT_BEDROCK_MODEL_ID = "global.moonshotai.kimi-k3"

# STS に頼む ID トークン（JWT）の宛先と寿命。infra/lib/agent-runtime-role.ts の
# sts:GetWebIdentityToken の条件と、Claude Console のフェデレーションルールの audience に合わせてある
IDENTITY_TOKEN_AUDIENCE = "https://api.anthropic.com"
IDENTITY_TOKEN_SECONDS = 300

# Bedrock は従来どおり。Claude API は思考も max_tokens に含まれるので、ツールを挟んだ長めの解説でも
# 途中で切れないよう広めにとる（Haiku 5.5 は安いので、上限を上げても費用はほとんど変わらない）
BEDROCK_MAX_TOKENS = 4096
ANTHROPIC_MAX_TOKENS = 8192

# Claude API の 1 回の待ち時間と再試行。SDK が 429・5xx・通信の失敗を再試行する。
# それでも駄目なら Bedrock に回すので、Strands 側の流量制限の再試行（既定は最大 6 回・数分）はさせない
ANTHROPIC_TIMEOUT_SECONDS = 60
ANTHROPIC_MAX_RETRIES = 2


@dataclass(frozen=True)
class ModelChoice:
    provider: Provider
    model_id: str


@dataclass(frozen=True)
class Federation:
    """Claude Console の Settings → Workload identity で作ったルール・組織・サービスアカウント・
    ワークスペースの ID。どれも秘密ではない（鍵に当たるのは毎回 STS が発行する JWT）。"""

    rule_id: str
    organization_id: str
    service_account_id: str
    workspace_id: str | None = None


def read_federation(env: Mapping[str, str] = os.environ) -> Federation | None:
    rule_id = env.get("ANTHROPIC_FEDERATION_RULE_ID")
    organization_id = env.get("ANTHROPIC_ORGANIZATION_ID")
    service_account_id = env.get("ANTHROPIC_SERVICE_ACCOUNT_ID")
    if not (rule_id and organization_id and service_account_id):
        return None
    return Federation(rule_id, organization_id, service_account_id, env.get("ANTHROPIC_WORKSPACE_ID") or None)


def model_chain(env: Mapping[str, str] = os.environ) -> list[ModelChoice]:
    """試す順のモデル。先頭で答えられなければ次へ回す（main.invoke）。"""
    chain: list[ModelChoice] = []
    if env.get("LLM_PROVIDER", "anthropic") != "bedrock" and read_federation(env):
        chain.append(ModelChoice("anthropic", env.get("ANTHROPIC_MODEL_CHAT") or DEFAULT_ANTHROPIC_MODEL_CHAT))
    bedrock_models = [env.get("MODEL_ID", DEFAULT_BEDROCK_MODEL_ID), env.get("FALLBACK_MODEL_ID", "")]
    chain.extend(ModelChoice("bedrock", m) for m in dict.fromkeys(bedrock_models) if m)
    return chain


def create_model(choice: ModelChoice) -> Model:
    if choice.provider == "anthropic":
        return _anthropic_model(choice.model_id)
    return BedrockModel(model_id=choice.model_id, max_tokens=BEDROCK_MAX_TOKENS)


@functools.cache
def _anthropic_model(model_id: str) -> AnthropicModel:
    """Claude API のモデル。クライアントがトークンを持つので、相談ごとに作らず使い回す
    （作り直すと、相談のたびに STS とトークンの交換が走る）。"""
    federation = read_federation()
    if federation is None:
        raise RuntimeError("Claude API の ID 連携の値（ANTHROPIC_FEDERATION_RULE_ID など）がありません")
    credentials = WorkloadIdentityCredentials(
        identity_token_provider=_identity_token,
        federation_rule_id=federation.rule_id,
        organization_id=federation.organization_id,
        service_account_id=federation.service_account_id,
        workspace_id=federation.workspace_id,
    )
    return AnthropicModel(
        # ログの水準は既定のまま。debug にすると本文とヘッダがログに出る
        client_args={
            "credentials": credentials,
            "timeout": ANTHROPIC_TIMEOUT_SECONDS,
            "max_retries": ANTHROPIC_MAX_RETRIES,
        },
        model_id=model_id,
        max_tokens=ANTHROPIC_MAX_TOKENS,
        # 思考は止められない世代なので、effort を low にして浅く速くする（会話の用途の推奨値）。
        # temperature は今の世代では既定値以外を受け付けないので渡さない
        params={"output_config": {"effort": "low"}},
        # システムプロンプト（方針と問題本文）・ツール定義・それまでの会話をキャッシュする。
        # 同じ会話の 2 ターン目以降と、ツールを挟んで 1 ターンに何度も呼ぶときに効く
        cache_config=CacheConfig(strategy="anthropic", tools_ttl=True),
    )


@functools.cache
def _sts():
    # GetWebIdentityToken は地域ごとの STS にしかない。発行者 URL は global なので、どの地域で呼んでも同じ
    return boto3.client("sts", region_name=os.environ.get("AWS_REGION"))


def _identity_token() -> str:
    """交換のたびに新しい JWT を取る（jti は使い回すと弾かれる）。"""
    out = _sts().get_web_identity_token(
        Audience=[IDENTITY_TOKEN_AUDIENCE],
        SigningAlgorithm="RS256",
        DurationSeconds=IDENTITY_TOKEN_SECONDS,
    )
    token = out.get("WebIdentityToken")
    if not token:
        raise RuntimeError("STS が ID トークンを返しませんでした")
    return token


class RefusalError(Exception):
    """モデルが断った（stop_reason が refusal）。Haiku 5.5 はサーバー側で別モデルに回せないので、こちらで回す"""


def _causes(error: BaseException) -> Iterator[BaseException]:
    """Strands が包んだ例外（ModelThrottledException など）の元までたどる。"""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def fallback_reason(error: BaseException, provider: Provider) -> str:
    """次のモデルへ回した理由。ログ（[chat] fallback）にそのまま出し、CloudWatch で数える。

    返し始める前の失敗はどれも次のモデルで答え直す（利用者にはエラーより答えを返す）。
    ここで決めるのは理由の名前だけで、docs/claude-api.md の表と合わせてある。
    """
    for e in _causes(error):
        if isinstance(e, RefusalError):
            return "refusal"
        if isinstance(e, WorkloadIdentityError):
            # トークンの交換を Anthropic が断った（ルール・サービスアカウント・ワークスペースの設定）
            return "credentials"
        if isinstance(e, anthropic.APITimeoutError):
            return "timeout"
        if isinstance(e, anthropic.APIConnectionError):
            return "connection"
        if isinstance(e, anthropic.AuthenticationError):
            return "authentication"
        if isinstance(e, anthropic.PermissionDeniedError):
            return "permission"
        if isinstance(e, anthropic.RateLimitError):
            return "rate_limit"
        if isinstance(e, anthropic.APIStatusError):
            if e.status_code == 529:
                return "overloaded"
            if e.status_code >= 500:
                return "server_error"
            # 残高不足は 400 で返り、本文の文言でしか見分けられない
            if e.status_code == 400 and "credit balance is too low" in str(e).lower():
                return "credit_balance"
            return f"http_{e.status_code}"
        if provider == "anthropic" and isinstance(e, BotoCoreError | ClientError):
            # Claude API の経路で AWS を呼ぶのは STS（ID トークンの発行）だけ
            return "credentials"
        if isinstance(e, ClientError):
            # Bedrock の失敗（AccessDeniedException、ThrottlingException など）
            return e.response.get("Error", {}).get("Code") or "ClientError"
    # Strands が包んだ流量制限（元が Claude API の 429 なら上で rate_limit になっている）
    if isinstance(error, ModelThrottledException):
        return "throttled"
    return type(error).__name__
