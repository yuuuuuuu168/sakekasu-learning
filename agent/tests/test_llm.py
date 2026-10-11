import httpx
import anthropic
import pytest
from anthropic.lib.credentials import WorkloadIdentityCredentials, WorkloadIdentityError
from botocore.exceptions import ClientError
from strands.types.exceptions import ModelThrottledException

import llm
from llm import ModelChoice, RefusalError, fallback_reason, model_chain

FEDERATION_ENV = {
    "ANTHROPIC_FEDERATION_RULE_ID": "fdrl_test",
    "ANTHROPIC_ORGANIZATION_ID": "00000000-0000-0000-0000-000000000000",
    "ANTHROPIC_SERVICE_ACCOUNT_ID": "svac_test",
    "ANTHROPIC_WORKSPACE_ID": "wrkspc_test",
}

REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")


def status_error(cls, status, message="error"):
    return cls(message, response=httpx.Response(status, request=REQUEST), body=None)


# --- 呼び先の順 ---


def test_claude_api_first_then_bedrock():
    env = {**FEDERATION_ENV, "MODEL_ID": "global.moonshotai.kimi-k3"}
    assert model_chain(env) == [
        ModelChoice("anthropic", "claude-haiku-5-5"),
        ModelChoice("bedrock", "global.moonshotai.kimi-k3"),
    ]


def test_chat_model_can_be_changed():
    env = {**FEDERATION_ENV, "ANTHROPIC_MODEL_CHAT": "claude-sonnet-5-5"}
    assert model_chain(env)[0] == ModelChoice("anthropic", "claude-sonnet-5-5")


def test_bedrock_only_without_federation():
    env = {**FEDERATION_ENV, "ANTHROPIC_FEDERATION_RULE_ID": ""}
    assert [c.provider for c in model_chain(env)] == ["bedrock"]


def test_bedrock_only_when_provider_is_bedrock():
    env = {**FEDERATION_ENV, "LLM_PROVIDER": "bedrock", "FALLBACK_MODEL_ID": "spare"}
    assert model_chain(env) == [
        ModelChoice("bedrock", "global.moonshotai.kimi-k3"),
        ModelChoice("bedrock", "spare"),
    ]


# --- Claude API のクライアント ---


@pytest.fixture
def anthropic_model(monkeypatch):
    for k, v in FEDERATION_ENV.items():
        monkeypatch.setenv(k, v)
    llm._anthropic_model.cache_clear()
    yield llm._anthropic_model("claude-haiku-5-5")
    llm._anthropic_model.cache_clear()


def test_anthropic_model_uses_workload_identity(anthropic_model):
    client = anthropic_model.client
    assert client.api_key is None and client.auth_token is None
    assert isinstance(client.credentials, WorkloadIdentityCredentials)
    assert client.max_retries == llm.ANTHROPIC_MAX_RETRIES


def test_anthropic_model_request(anthropic_model):
    request = anthropic_model.format_request(
        [{"role": "user", "content": [{"text": "質問"}]}], system_prompt="方針"
    )
    assert request["model"] == "claude-haiku-5-5"
    assert request["output_config"] == {"effort": "low"}
    assert "temperature" not in request and "thinking" not in request
    assert request["system"][-1]["cache_control"] == {"type": "ephemeral"}


def test_anthropic_model_is_reused(anthropic_model):
    # 相談ごとに作り直すと、そのたびに STS とトークンの交換が走る
    assert llm._anthropic_model("claude-haiku-5-5") is anthropic_model


def test_identity_token_asks_sts_for_anthropic_audience(monkeypatch):
    calls = []

    class FakeSts:
        def get_web_identity_token(self, **kwargs):
            calls.append(kwargs)
            return {"WebIdentityToken": "jwt"}

    monkeypatch.setattr(llm, "_sts", lambda: FakeSts())
    assert llm._identity_token() == "jwt"
    assert calls == [{"Audience": ["https://api.anthropic.com"], "SigningAlgorithm": "RS256", "DurationSeconds": 300}]


# --- 次のモデルへ回した理由 ---


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (status_error(anthropic.BadRequestError, 400, "Your credit balance is too low to access the Anthropic API."), "credit_balance"),
        (status_error(anthropic.AuthenticationError, 401), "authentication"),
        (status_error(anthropic.PermissionDeniedError, 403), "permission"),
        (status_error(anthropic.InternalServerError, 529), "overloaded"),
        (status_error(anthropic.InternalServerError, 500), "server_error"),
        (status_error(anthropic.BadRequestError, 400, "invalid request"), "http_400"),
        (anthropic.APITimeoutError(request=REQUEST), "timeout"),
        (anthropic.APIConnectionError(request=REQUEST), "connection"),
        (WorkloadIdentityError("Token exchange failed with status 401"), "credentials"),
        (ClientError({"Error": {"Code": "AccessDenied"}}, "GetWebIdentityToken"), "credentials"),
        (RefusalError(), "refusal"),
        (RuntimeError("boom"), "RuntimeError"),
    ],
)
def test_fallback_reason_from_claude_api(error, reason):
    assert fallback_reason(error, "anthropic") == reason


def test_rate_limit_wrapped_by_strands():
    try:
        try:
            raise status_error(anthropic.RateLimitError, 429)
        except anthropic.RateLimitError as e:
            raise ModelThrottledException(str(e)) from e
    except ModelThrottledException as wrapped:
        assert fallback_reason(wrapped, "anthropic") == "rate_limit"


def test_fallback_reason_from_bedrock():
    error = ClientError({"Error": {"Code": "AccessDeniedException"}}, "ConverseStream")
    assert fallback_reason(error, "bedrock") == "AccessDeniedException"
    assert fallback_reason(ModelThrottledException("slow down"), "bedrock") == "throttled"
