"""MCP client tool-call timeouts follow accept maxTimeoutSeconds."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from x402.mcp.client import x402MCPClientSync, x402MCPSession
from x402.mcp.client_async import x402MCPClient
from x402.schemas import PaymentPayload


def _payment_required_text(max_timeout_seconds: int = 300) -> str:
    return (
        '{"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:84532",'
        f'"amount":"1000","asset":"USDC","payTo":"0xrecipient",'
        f'"maxTimeoutSeconds":{max_timeout_seconds}}}]}}'
    )


def _payload(max_timeout_seconds: int = 300) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        accepted={
            "scheme": "exact",
            "network": "eip155:84532",
            "amount": "1000",
            "asset": "USDC",
            "pay_to": "0xrecipient",
            "max_timeout_seconds": max_timeout_seconds,
        },
        payload={"signature": "0x123"},
    )


class _Text:
    def __init__(self, text: str) -> None:
        self.text = text


class _SessionResult:
    def __init__(self, *, is_error: bool, text: str, meta: dict | None = None) -> None:
        self.isError = is_error
        self.content = [_Text(text)]
        self.meta = meta
        self.structuredContent = None


class _McpResult:
    def __init__(self, *, is_error: bool, text: str, meta: dict | None = None) -> None:
        self.content = [{"type": "text", "text": text}]
        self.isError = is_error
        self._meta = meta or {}
        self.structuredContent = None


def _read_timeout(call) -> timedelta:
    return call.kwargs["read_timeout_seconds"]


@pytest.mark.asyncio
async def test_session_probe_uses_300s_ceiling() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(return_value=_SessionResult(is_error=False, text="pong"))
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock())

    result = await x402MCPSession(session, x402_client).call_tool("ping", {})

    assert result.payment_made is False
    assert result.content[0].text == "pong"
    assert _read_timeout(session.call_tool.await_args) == timedelta(seconds=300)
    x402_client.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_session_paid_timeout_uses_accept_max_timeout_seconds() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(600)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(600)))

    result = await x402MCPSession(session, x402_client).call_tool("paid_tool", {})

    assert result.payment_made is True
    assert result.content[0].text == "ok"
    probe_call, paid_call = session.call_tool.await_args_list
    assert _read_timeout(probe_call) == timedelta(seconds=300)
    assert _read_timeout(paid_call) == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_session_paid_timeout_defaults_to_300s_without_accept() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text()),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    payload = SimpleNamespace(accepted=None, model_dump=lambda **_kwargs: {"payload": {}})
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=payload))

    result = await x402MCPSession(session, x402_client).call_tool("paid_tool", {})

    assert result.payment_made is True
    probe_call, paid_call = session.call_tool.await_args_list
    assert _read_timeout(probe_call) == timedelta(seconds=300)
    assert _read_timeout(paid_call) == timedelta(seconds=300)


@pytest.mark.asyncio
async def test_session_explicit_timeout_overrides_accept() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(600)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(600)))
    override = timedelta(seconds=12)

    await x402MCPSession(session, x402_client).call_tool(
        "paid_tool", {}, read_timeout_seconds=override
    )

    probe_call, paid_call = session.call_tool.await_args_list
    assert _read_timeout(probe_call) == override
    assert _read_timeout(paid_call) == override


@pytest.mark.asyncio
async def test_async_client_probe_uses_300s_ceiling() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(return_value=_McpResult(is_error=False, text="pong"))
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock())

    result = await x402MCPClient(mock_mcp, mock_payment).call_tool("ping", {})

    assert result.payment_made is False
    assert result.content[0]["text"] == "pong"
    assert mock_mcp.call_tool.await_args.kwargs["read_timeout_seconds"] == timedelta(seconds=300)
    mock_payment.create_payment_payload.assert_not_called()


@pytest.mark.asyncio
async def test_async_client_paid_timeout_uses_accept_max_timeout_seconds() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(600)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(600)))

    result = await x402MCPClient(mock_mcp, mock_payment).call_tool("paid_tool", {})

    assert result.payment_made is True
    probe_call, paid_call = mock_mcp.call_tool.await_args_list
    assert probe_call.kwargs["read_timeout_seconds"] == timedelta(seconds=300)
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_async_client_call_tool_with_payment_uses_accept_timeout() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(return_value=_McpResult(is_error=False, text="ok"))
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock())

    await x402MCPClient(mock_mcp, mock_payment).call_tool_with_payment(
        "paid_tool", {}, _payload(90)
    )

    assert mock_mcp.call_tool.await_args.kwargs["read_timeout_seconds"] == timedelta(seconds=90)


def test_sync_client_paid_timeout_uses_accept_max_timeout_seconds() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=Mock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(600)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(create_payment_payload=Mock(return_value=_payload(600)))

    result = x402MCPClientSync(mock_mcp, mock_payment).call_tool("paid_tool", {})

    assert result.payment_made is True
    probe_call, paid_call = mock_mcp.call_tool.call_args_list
    assert probe_call.kwargs["read_timeout_seconds"] == timedelta(seconds=300)
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_session_paid_timeout_clamps_huge_accept_to_default_cap() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(1_000_000)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=_payload(1_000_000))
    )

    result = await x402MCPSession(session, x402_client).call_tool("paid_tool", {})

    assert result.payment_made is True
    _, paid_call = session.call_tool.await_args_list
    assert _read_timeout(paid_call) == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_session_paid_timeout_under_cap_uses_accept() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(120)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(120)))

    await x402MCPSession(session, x402_client).call_tool("paid_tool", {})

    _, paid_call = session.call_tool.await_args_list
    assert _read_timeout(paid_call) == timedelta(seconds=120)


@pytest.mark.asyncio
async def test_session_paid_timeout_honours_raised_cap() -> None:
    session = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _SessionResult(is_error=True, text=_payment_required_text(900)),
                _SessionResult(is_error=False, text="ok"),
            ]
        )
    )
    x402_client = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(900)))

    await x402MCPSession(session, x402_client, max_request_timeout_seconds=900).call_tool(
        "paid_tool", {}
    )

    _, paid_call = session.call_tool.await_args_list
    assert _read_timeout(paid_call) == timedelta(seconds=900)


@pytest.mark.asyncio
async def test_async_client_paid_timeout_clamps_huge_accept() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(1_000_000)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=_payload(1_000_000))
    )

    await x402MCPClient(mock_mcp, mock_payment).call_tool("paid_tool", {})

    _, paid_call = mock_mcp.call_tool.await_args_list
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=600)


@pytest.mark.asyncio
async def test_async_client_paid_timeout_under_cap() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(120)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(create_payment_payload=AsyncMock(return_value=_payload(120)))

    await x402MCPClient(mock_mcp, mock_payment).call_tool("paid_tool", {})

    _, paid_call = mock_mcp.call_tool.await_args_list
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=120)


def test_sync_client_paid_timeout_clamps_huge_accept() -> None:
    mock_mcp = SimpleNamespace(
        call_tool=Mock(
            side_effect=[
                _McpResult(is_error=True, text=_payment_required_text(1_000_000)),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    mock_payment = SimpleNamespace(create_payment_payload=Mock(return_value=_payload(1_000_000)))

    x402MCPClientSync(mock_mcp, mock_payment).call_tool("paid_tool", {})

    _, paid_call = mock_mcp.call_tool.call_args_list
    assert paid_call.kwargs["read_timeout_seconds"] == timedelta(seconds=600)


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["session", "async", "sync"])
@pytest.mark.parametrize("settled", [False, True])
async def test_paid_response_dispatches_core_hooks(client_kind, settled):
    """Both successful and pending/failed settlements reach scheme state hooks."""
    result_type = _SessionResult if client_kind == "session" else _McpResult
    receipt = {"success": settled, "network": "eip155:84532", "transaction": "pending-tx"}
    if not settled:
        receipt["errorReason"] = "transaction_pending"
    results = [
        result_type(is_error=True, text=_payment_required_text()),
        result_type(is_error=not settled, text="response", meta={"x402/payment-response": receipt}),
    ]
    mock_type = Mock if client_kind == "sync" else AsyncMock
    transport = SimpleNamespace(call_tool=mock_type(side_effect=results))
    payment = SimpleNamespace(
        create_payment_payload=mock_type(return_value=_payload()),
        handle_payment_response=mock_type(return_value=None),
    )
    wrapper = {"session": x402MCPSession, "async": x402MCPClient, "sync": x402MCPClientSync}[
        client_kind
    ]
    result = wrapper(transport, payment).call_tool("paid_tool", {})
    if client_kind != "sync":
        result = await result
    assert (result.payment_response is not None) is settled
    assert result.payment_made is settled
    context = payment.handle_payment_response.call_args.args[0]
    assert context.payment_payload is payment.create_payment_payload.return_value
    assert context.requirements == context.payment_payload.accepted
    assert context.settle_response.transaction == "pending-tx"
    assert context.settle_response.success is settled
    assert payment.handle_payment_response.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["session", "async", "sync"])
@pytest.mark.parametrize("recovered", [False, True])
async def test_corrective_recovery_requires_hook_and_retries_once(client_kind, recovered):
    from x402.schemas.hooks import RecoveredResponseResult

    result_type = _SessionResult if client_kind == "session" else _McpResult
    mock_type = Mock if client_kind == "sync" else AsyncMock
    transport = SimpleNamespace(
        call_tool=mock_type(
            side_effect=[
                result_type(is_error=True, text=_payment_required_text()) for _ in range(3)
            ]
        )
    )
    first = _payload()
    second = first.model_copy(update={"payload": {"signature": "fresh"}})
    payment = SimpleNamespace(
        create_payment_payload=mock_type(side_effect=[first, second]),
        handle_payment_response=mock_type(
            return_value=RecoveredResponseResult() if recovered else None
        ),
    )
    wrapper = {"session": x402MCPSession, "async": x402MCPClient, "sync": x402MCPClientSync}[
        client_kind
    ]
    result = wrapper(transport, payment).call_tool("paid_tool", {})
    if client_kind != "sync":
        result = await result
    attempts = 2 if recovered else 1
    assert result.is_error
    assert transport.call_tool.call_count == attempts + 1
    assert payment.create_payment_payload.call_count == attempts
    assert payment.handle_payment_response.call_count == attempts
    assert payment.handle_payment_response.call_args.args[0].payment_required is not None
    if recovered:
        assert payment.handle_payment_response.call_args.args[0].payment_payload is second
        original, retry = [call.args[0] for call in payment.create_payment_payload.call_args_list]
        assert retry.accepts == original.accepts


@pytest.mark.asyncio
async def test_async_recovery_reuses_original_server_extensions():
    import json

    from x402.schemas.hooks import RecoveredResponseResult

    advertised = json.loads(_payment_required_text())
    advertised["extensions"] = {"server": {"nonce": "original"}}
    payload = _payload().model_copy(update={"extensions": {"server": {"nonce": "client-enriched"}}})
    transport = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[
                _McpResult(is_error=True, text=json.dumps(advertised)),
                _McpResult(is_error=True, text=_payment_required_text()),
                _McpResult(is_error=False, text="ok"),
            ]
        )
    )
    payment = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=payload),
        handle_payment_response=AsyncMock(return_value=RecoveredResponseResult()),
    )
    assert not (await x402MCPClient(transport, payment).call_tool("paid_tool", {})).is_error
    original, retry = [call.args[0] for call in payment.create_payment_payload.call_args_list]
    assert retry is original
    assert retry.extensions == advertised["extensions"]


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["session", "async", "sync"])
@pytest.mark.parametrize("structured", [False, True])
async def test_failed_receipt_in_error_body_reaches_hooks_not_success_field(
    client_kind, structured
):
    import json

    result_type = _SessionResult if client_kind == "session" else _McpResult
    receipt = {
        "success": False,
        "transaction": "already-submitted",
        "network": "eip155:84532",
        "errorReason": "transaction_pending",
        "extra": {"channelId": "channel", "submitted": True},
    }
    body = json.loads(_payment_required_text())
    body["x402/payment-response"] = receipt
    failed = result_type(is_error=True, text="structured" if structured else json.dumps(body))
    if structured:
        failed.structuredContent = body
    mock_type = Mock if client_kind == "sync" else AsyncMock
    transport = SimpleNamespace(
        call_tool=mock_type(
            side_effect=[
                result_type(is_error=True, text=_payment_required_text()),
                failed,
            ]
        )
    )
    payment = SimpleNamespace(
        create_payment_payload=mock_type(return_value=_payload()),
        handle_payment_response=mock_type(return_value=None),
    )
    wrapper = {"session": x402MCPSession, "async": x402MCPClient, "sync": x402MCPClientSync}[
        client_kind
    ]
    result = wrapper(transport, payment).call_tool("paid_tool", {})
    if client_kind != "sync":
        result = await result
    assert result.is_error
    assert result.payment_response is None
    assert result.payment_made is False
    assert result.raw_result is not None
    received = payment.handle_payment_response.call_args.args[0].settle_response
    assert received.model_dump(by_alias=True, exclude_none=True) == receipt
    assert transport.call_tool.call_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("gate", ["approval", "before", "required"])
async def test_corrective_retry_reruns_every_payment_gate(gate):
    from x402.mcp.types import PaymentRequiredError, PaymentRequiredHookResult
    from x402.schemas.hooks import RecoveredResponseResult

    transport = SimpleNamespace(
        call_tool=AsyncMock(
            side_effect=[_McpResult(is_error=True, text=_payment_required_text()) for _ in range(3)]
        )
    )
    payment = SimpleNamespace(
        create_payment_payload=AsyncMock(return_value=_payload()),
        handle_payment_response=AsyncMock(return_value=RecoveredResponseResult()),
    )
    approval = AsyncMock(side_effect=[True, gate != "approval"])
    before = AsyncMock(
        side_effect=[None, ValueError("before denied") if gate == "before" else None]
    )
    required = AsyncMock(side_effect=[None, PaymentRequiredHookResult(abort=gate == "required")])
    client = x402MCPClient(transport, payment, on_payment_requested=approval)
    client.on_before_payment(before).on_payment_required(required)
    with pytest.raises(ValueError if gate == "before" else PaymentRequiredError):
        await client.call_tool("paid_tool", {"input": 1})
    assert required.call_count == 2
    assert approval.call_count == (1 if gate == "required" else 2)
    assert before.call_count == (2 if gate == "before" else 1)
    payment.create_payment_payload.assert_called_once()
    assert transport.call_tool.call_count == 2


def test_sync_corrective_retry_rechecks_approval():
    from x402.schemas.hooks import RecoveredResponseResult

    transport = SimpleNamespace(
        call_tool=Mock(
            side_effect=[_McpResult(is_error=True, text=_payment_required_text()) for _ in range(3)]
        )
    )
    payment = SimpleNamespace(
        create_payment_payload=Mock(return_value=_payload()),
        handle_payment_response=Mock(return_value=RecoveredResponseResult()),
    )
    approval = Mock(side_effect=[True, False])
    result = x402MCPClientSync(transport, payment, on_payment_requested=approval).call_tool(
        "tool", {}
    )
    assert result.is_error
    assert approval.call_count == 2
    payment.create_payment_payload.assert_called_once()
    assert transport.call_tool.call_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("client_kind", ["session", "async", "sync"])
async def test_response_validation_error_preserves_paid_output_without_retry(client_kind):
    from x402.mcp import PaymentResponseError

    result_type = _SessionResult if client_kind == "session" else _McpResult
    mock_type = Mock if client_kind == "sync" else AsyncMock
    receipt = {"success": True, "transaction": "claimed-tx", "network": "eip155:84532"}
    transport = SimpleNamespace(
        call_tool=mock_type(
            side_effect=[
                result_type(is_error=True, text=_payment_required_text()),
                result_type(
                    is_error=False, text="paid output", meta={"x402/payment-response": receipt}
                ),
            ]
        )
    )
    cause = ValueError("untrusted receipt")
    payment = SimpleNamespace(
        create_payment_payload=mock_type(return_value=_payload()),
        handle_payment_response=mock_type(side_effect=cause),
    )
    wrapper = {"session": x402MCPSession, "async": x402MCPClient, "sync": x402MCPClientSync}[
        client_kind
    ]
    client = wrapper(transport, payment)
    observer = AsyncMock()
    if client_kind == "async":
        client.on_after_payment(AsyncMock(side_effect=RuntimeError("observer failed")))
        client.on_after_payment(observer)
    with pytest.raises(PaymentResponseError) as error:
        outcome = client.call_tool("paid_tool", {})
        if client_kind != "sync":
            await outcome
    assert error.value.__cause__ is cause
    result = error.value.result
    assert result.is_error
    assert result.payment_response is None
    text = result.content[0].text if client_kind == "session" else result.content[0]["text"]
    assert text == "paid output"
    assert result.raw_result is not None
    assert transport.call_tool.call_count == 2
    if client_kind == "async":
        observer.assert_awaited_once()
        assert observer.call_args.args[0].settle_response is None
        assert observer.call_args.args[0].result.content[0]["text"] == "paid output"


def test_failed_receipt_parser_searches_past_unrelated_structured_and_text_content():
    import json

    from x402.mcp.types import MCPToolResult
    from x402.mcp.utils import extract_payment_response_from_result

    receipt = {"success": False, "transaction": "pending", "network": "eip155:84532"}
    result = MCPToolResult(
        is_error=True,
        structured_content={"unrelated": True},
        content=[
            {"type": "text", "text": json.dumps({"unrelated": "text"})},
            {"type": "text", "text": "not JSON"},
            {"type": "text", "text": json.dumps({"x402/payment-response": receipt})},
        ],
    )
    assert extract_payment_response_from_result(result).transaction == "pending"
