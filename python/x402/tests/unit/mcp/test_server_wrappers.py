"""Regression tests for MCP server wrapper payment-required responses."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from x402 import x402ResourceServer
from x402.mcp.constants import MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY
from x402.mcp.server import (
    _create_settlement_failed_result,
    _payment_required_error_from_verify,
)
from x402.mcp.server import (
    create_payment_wrapper as create_fastmcp_payment_wrapper,
)
from x402.mcp.server_async import (
    PaymentWrapperConfig,
    _create_settlement_failed_result_async,
    create_payment_wrapper,
)
from x402.mcp.server_sync import (
    _create_settlement_failed_result_sync,
    create_payment_wrapper_sync,
)
from x402.mcp.types import SyncPaymentWrapperConfig
from x402.schemas import (
    PaymentPayload,
    PaymentRequired,
    PaymentRequirements,
    ResourceInfo,
    SettleResponse,
    SupportedKind,
    SupportedResponse,
    VerifyError,
    VerifyResponse,
)
from x402.schemas.hooks import AbortResult
from x402.server_base import _payment_requirements_match_accepted


def make_payment_requirements() -> PaymentRequirements:
    """Helper to create valid payment requirements."""
    return PaymentRequirements(
        scheme="exact",
        network="eip155:8453",
        asset="0x0000000000000000000000000000000000000000",
        amount="1000000",
        pay_to="0x1234567890123456789012345678901234567890",
        max_timeout_seconds=300,
    )


class MockAsyncResourceServer:
    """Minimal async resource server for settlement failure helper tests."""

    def __init__(self):
        self.last_extensions = None

    async def create_payment_required_response(  # noqa: PLR0913
        self,
        accepts,
        resource,
        error_message,
        extensions=None,
    ):
        self.last_extensions = extensions
        return {
            "x402Version": 2,
            "accepts": [req.model_dump(by_alias=True) for req in accepts],
            "error": error_message,
            "resource": resource.model_dump(by_alias=True),
            "extensions": extensions,
        }


class MockSyncResourceServer:
    """Minimal sync resource server for settlement failure helper tests."""

    def __init__(self):
        self.last_extensions = None

    def create_payment_required_response(  # noqa: PLR0913
        self,
        accepts,
        resource,
        error_message,
        extensions=None,
    ):
        self.last_extensions = extensions
        return {
            "x402Version": 2,
            "accepts": [req.model_dump(by_alias=True) for req in accepts],
            "error": error_message,
            "resource": resource.model_dump(by_alias=True),
            "extensions": extensions,
        }


@pytest.mark.asyncio
async def test_async_settlement_failure_preserves_extensions() -> None:
    """Settlement failure 402 keeps extensions in async wrapper path."""
    server = MockAsyncResourceServer()
    extensions = {
        "bazaar": {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "get_weather",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {"type": "object"},
        }
    }
    config = PaymentWrapperConfig(
        accepts=[make_payment_requirements()],
        extensions=extensions,
    )

    result = await _create_settlement_failed_result_async(
        server,
        "get_weather",
        config,
        "settle exploded",
    )

    assert server.last_extensions == extensions
    assert result.structured_content is not None
    assert result.structured_content["extensions"] == extensions
    assert result.structured_content[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False


def test_sync_settlement_failure_preserves_extensions() -> None:
    """Settlement failure 402 keeps extensions in sync wrapper path."""
    server = MockSyncResourceServer()
    extensions = {
        "bazaar": {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "get_weather",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {"type": "object"},
        }
    }
    config = SyncPaymentWrapperConfig(
        accepts=[make_payment_requirements()],
        extensions=extensions,
    )

    result = _create_settlement_failed_result_sync(
        server,
        "get_weather",
        config,
        "settle exploded",
    )

    assert server.last_extensions == extensions
    assert result.structured_content is not None
    assert result.structured_content["extensions"] == extensions
    assert result.structured_content[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False


def test_fastmcp_settlement_failure_preserves_extensions() -> None:
    """Settlement failure 402 keeps extensions in FastMCP wrapper path."""
    extensions = {
        "bazaar": {
            "info": {
                "input": {
                    "type": "mcp",
                    "toolName": "get_weather",
                    "inputSchema": {"type": "object"},
                }
            },
            "schema": {"type": "object"},
        }
    }
    result = _create_settlement_failed_result(
        accepts=[make_payment_requirements()],
        resource=ResourceInfo(
            url="mcp://tool/get_weather",
            description="Tool: get_weather",
            mime_type="application/json",
        ),
        error_message="settle exploded",
        extensions=extensions,
    )

    assert result.structuredContent is not None
    assert result.structuredContent["extensions"] == extensions
    assert result.structuredContent[MCP_PAYMENT_RESPONSE_META_KEY]["success"] is False


MISMATCH_REASON = "invalid_batch_settlement_evm_cumulative_amount_mismatch"


def _cash_requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme="cash",
        network="x402:cash",
        asset="USD",
        amount="1000",
        pay_to="test-recipient",
        max_timeout_seconds=300,
        extra={},
    )


def _paid_tool_extra(payload: PaymentPayload) -> dict:
    return {
        "_meta": {MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)},
        "toolName": "paid_tool",
    }


class _MismatchOnlyEnricherMixin:
    """Mirrors batch-settlement: writes recovery extra only on a corrective 402."""

    calls = 0

    def _enrich_if_mismatch(self, accepts, error_msg) -> None:
        if error_msg != MISMATCH_REASON:
            return
        self.calls += 1
        for req in accepts:
            if req.extra is None:
                req.extra = {}
            req.extra["channelState"] = {"chargedCumulativeAmount": "2000"}


class _MismatchSyncServer(_MismatchOnlyEnricherMixin):
    def __init__(self) -> None:
        self.calls = 0
        self.verify_calls = 0
        self._abort_once = True
        self.verify_payment = Mock(side_effect=self._verify)
        self.settle_payment = Mock(
            return_value=SettleResponse(
                success=True,
                transaction="0xtx",
                network="x402:cash",
            )
        )
        self.create_payment_cancellation_dispatcher = Mock(
            return_value=Mock(cancel=Mock(return_value=None), cancel_sync=Mock(return_value=None))
        )
        self.get_payment_flow = Mock(return_value="authorization")

    def _verify(self, payload, requirements, **kwargs):
        if self._abort_once:
            self._abort_once = False
            return Mock(is_valid=False, invalid_reason=MISMATCH_REASON, skip_handler=None)
        self.verify_calls += 1
        return Mock(is_valid=True, skip_handler=None)

    def find_matching_requirements(self, available, payload):
        for req in available:
            if _payment_requirements_match_accepted(req, payload.accepted):
                return req
        return None

    def create_payment_required_response(  # noqa: PLR0913
        self, accepts, resource_info, error_msg, extensions=None, *args, **kwargs
    ):
        self._enrich_if_mismatch(accepts, error_msg)
        return PaymentRequired(
            x402_version=2,
            accepts=accepts,
            error=error_msg,
            resource=resource_info,
        )


class _MismatchAsyncServer(_MismatchOnlyEnricherMixin):
    def __init__(self) -> None:
        self.calls = 0
        self.verify_calls = 0
        self._abort_once = True
        self.verify_payment = AsyncMock(side_effect=self._verify)
        self.settle_payment = AsyncMock(
            return_value=SettleResponse(
                success=True,
                transaction="0xtx",
                network="x402:cash",
            )
        )
        self.create_payment_cancellation_dispatcher = Mock(
            return_value=Mock(
                cancel=AsyncMock(return_value=None),
                cancel_sync=Mock(return_value=None),
            )
        )
        self.get_payment_flow = Mock(return_value="authorization")

    async def _verify(self, payload, requirements, **kwargs):
        if self._abort_once:
            self._abort_once = False
            return Mock(is_valid=False, invalid_reason=MISMATCH_REASON, skip_handler=None)
        self.verify_calls += 1
        return Mock(is_valid=True, skip_handler=None)

    def find_matching_requirements(self, available, payload):
        for req in available:
            if _payment_requirements_match_accepted(req, payload.accepted):
                return req
        return None

    async def create_payment_required_response(  # noqa: PLR0913
        self, accepts, resource_info, error_msg, extensions=None, *args, **kwargs
    ):
        self._enrich_if_mismatch(accepts, error_msg)
        return PaymentRequired(
            x402_version=2,
            accepts=accepts,
            error=error_msg,
            resource=resource_info,
        )


def test_payment_wrapper_payment_required_does_not_mutate_config_accepts() -> None:
    server = _MismatchSyncServer()
    config = SyncPaymentWrapperConfig(accepts=[_cash_requirements()])
    wrapped = create_payment_wrapper_sync(server, config)(
        lambda _args, _ctx: {"content": [{"type": "text", "text": "ok"}]}
    )
    payload = PaymentPayload(
        x402_version=2,
        accepted=_cash_requirements(),
        payload={"signature": "~test-payer"},
    )
    extra = _paid_tool_extra(payload)

    first = wrapped({}, extra)
    assert first.is_error is True
    assert server.calls == 1
    assert "channelState" not in (config.accepts[0].extra or {})

    second = wrapped({}, extra)
    assert second.is_error is False
    assert server.verify_calls == 1


@pytest.mark.asyncio
async def test_async_payment_wrapper_payment_required_does_not_mutate_config_accepts() -> None:
    server = _MismatchAsyncServer()
    config = PaymentWrapperConfig(accepts=[_cash_requirements()])
    wrapped = create_payment_wrapper(server, config)(
        lambda _args, _ctx: {"content": [{"type": "text", "text": "ok"}]}
    )
    payload = PaymentPayload(
        x402_version=2,
        accepted=_cash_requirements(),
        payload={"signature": "~test-payer"},
    )
    extra = _paid_tool_extra(payload)

    first = await wrapped({}, extra)
    assert first.is_error is True
    assert server.calls == 1
    assert "channelState" not in (config.accepts[0].extra or {})

    second = await wrapped({}, extra)
    assert second.is_error is False
    assert server.verify_calls == 1


class MockFastMCPContext:
    """Minimal FastMCP context shape used by the wrapper."""

    def __init__(self, meta: dict):
        self.request_context = SimpleNamespace(
            meta=SimpleNamespace(model_extra=meta),
        )


class _MockFacilitatorClient:
    def __init__(self, verify=None):
        self._verify = verify

    def get_supported(self) -> SupportedResponse:
        return SupportedResponse(
            kinds=[SupportedKind(x402_version=2, scheme="cash", network="x402:cash")],
            extensions=[],
            signers={},
        )

    async def verify(self, payload, requirements) -> VerifyResponse:
        if self._verify is not None:
            return await self._verify(payload, requirements)
        return VerifyResponse(is_valid=True, payer="test-payer")

    async def settle(self, payload, requirements) -> SettleResponse:
        return SettleResponse(
            success=True,
            transaction="tx123",
            network="x402:cash",
            payer="test-payer",
        )


class _MockSchemeNetworkServer:
    default_asset_transfer_method = "default"
    payment_flows = {
        "default": {"supported": ("authorization",), "default": "authorization"},
        "eip3009": {"supported": ("authorization",), "default": "authorization"},
        "permit2": {"supported": ("authorization",), "default": "authorization"},
    }

    def __init__(self, scheme: str = "cash"):
        self.scheme = scheme

    def parse_price(self, price, network):
        return Mock(asset="USD", amount="1000", extra={})

    def enhance_payment_requirements(self, requirements, supported_kind, extensions):
        return requirements


def test_payment_required_error_from_verify_prefers_invalid_reason() -> None:
    ve = VerifyError(
        "invalid_batch_settlement_evm_cumulative_amount_mismatch",
        "Client voucher base does not match server state",
    )
    assert _payment_required_error_from_verify(ve, None) == ve.invalid_reason

    resp = VerifyResponse(is_valid=False, invalid_reason="insufficient_balance")
    assert _payment_required_error_from_verify(None, resp) == "insufficient_balance"

    assert _payment_required_error_from_verify(RuntimeError("network down"), None) == "network down"


@pytest.mark.asyncio
async def test_fastmcp_verify_failure_uses_bare_invalid_reason() -> None:
    reason = "invalid_batch_settlement_evm_cumulative_amount_mismatch"
    requirements = _cash_requirements()
    payload = PaymentPayload(
        x402_version=2,
        accepted=requirements.model_dump(by_alias=True),
        payload={"signature": "~test-payer"},
    )
    resource_server = Mock()
    resource_server.find_matching_requirements = Mock(return_value=requirements)
    resource_server.verify_payment = AsyncMock(
        return_value=Mock(is_valid=False, invalid_reason=reason)
    )

    wrapper = create_fastmcp_payment_wrapper(resource_server, accepts=[requirements])

    @wrapper
    async def paid_tool() -> str:
        return "ok"

    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.isError is True
    assert result.structuredContent["error"] == reason


@pytest.mark.asyncio
async def test_payment_wrapper_verify_abort_uses_invalid_reason() -> None:
    reason = "invalid_batch_settlement_evm_cumulative_amount_mismatch"

    async def verify(_payload, _requirements):
        pytest.fail("facilitator should not run after BeforeVerify abort")

    mock_facilitator = _MockFacilitatorClient(verify=verify)
    server = x402ResourceServer(mock_facilitator)
    server.register("x402:cash", _MockSchemeNetworkServer(scheme="cash"))
    server.initialize()
    server.on_before_verify(
        lambda _ctx: AbortResult(
            reason=reason,
            message="Client voucher base does not match server state",
        )
    )

    requirements = _cash_requirements()
    wrapper = create_fastmcp_payment_wrapper(server, accepts=[requirements])

    @wrapper
    async def paid_tool() -> str:
        return "ok"

    payload = PaymentPayload(
        x402_version=2,
        accepted=requirements.model_dump(by_alias=True),
        payload={"signature": "~test-payer"},
    )
    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.isError is True
    assert result.structuredContent["error"] == reason


@pytest.mark.asyncio
async def test_payment_wrapper_facilitator_verify_error_uses_invalid_reason() -> None:
    reason = "custom_failure_reason"

    async def verify(_payload, _requirements):
        raise VerifyError(reason, "human-readable detail", "0xpayer")

    mock_facilitator = _MockFacilitatorClient(verify=verify)
    server = x402ResourceServer(mock_facilitator)
    server.register("x402:cash", _MockSchemeNetworkServer(scheme="cash"))
    server.initialize()

    requirements = _cash_requirements()
    wrapper = create_fastmcp_payment_wrapper(server, accepts=[requirements])

    @wrapper
    async def paid_tool() -> str:
        return "ok"

    payload = PaymentPayload(
        x402_version=2,
        accepted=requirements.model_dump(by_alias=True),
        payload={"signature": "~test-payer"},
    )
    result = await paid_tool(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )

    assert result.isError is True
    assert result.structuredContent["error"] == reason


@pytest.mark.asyncio
@pytest.mark.parametrize("server_type", [_MismatchSyncServer, _MismatchAsyncServer])
async def test_fastmcp_corrective_response_enriches_a_request_local_copy(server_type):
    server = server_type()
    requirements = _cash_requirements()
    payload = PaymentPayload(x402_version=2, accepted=requirements, payload={"signature": "payer"})
    wrapped = create_fastmcp_payment_wrapper(server, accepts=[requirements])(lambda: "ok")
    context = MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    first = await wrapped(ctx=context)
    assert first.isError
    assert first.structuredContent["accepts"][0]["extra"]["channelState"] == {
        "chargedCumulativeAmount": "2000"
    }
    assert requirements.extra == {}
    assert (await wrapped(ctx=context)).isError is False
    assert server.calls == 1


@pytest.mark.asyncio
async def test_fastmcp_failed_settlement_preserves_pending_receipt():
    server = _MismatchAsyncServer()
    server._abort_once = False
    server.settle_payment.return_value = SettleResponse(
        success=False,
        transaction="submitted-tx",
        network="x402:cash",
        error_reason="transaction_pending",
        extra={"channelId": "channel"},
    )
    requirements = _cash_requirements()
    payload = PaymentPayload(x402_version=2, accepted=requirements, payload={"signature": "payer"})
    wrapped = create_fastmcp_payment_wrapper(server, accepts=[requirements])(lambda: "ok")
    result = await wrapped(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )
    assert result.isError
    assert not result.meta
    assert result.structuredContent[
        MCP_PAYMENT_RESPONSE_META_KEY
    ] == server.settle_payment.return_value.model_dump(
        by_alias=True,
        exclude_none=True,
    )


@pytest.mark.asyncio
async def test_fastmcp_does_not_cancel_uncertain_settlement_exception():
    server = _MismatchAsyncServer()
    server._abort_once = False
    server.settle_payment.side_effect = TimeoutError("submission outcome unknown")
    requirements = _cash_requirements()
    payload = PaymentPayload(x402_version=2, accepted=requirements, payload={"signature": "payer"})
    wrapped = create_fastmcp_payment_wrapper(server, accepts=[requirements])(lambda: "ok")
    result = await wrapped(
        ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
    )
    assert result.isError
    server.create_payment_cancellation_dispatcher.assert_not_called()


async def _run_generic_wrapper(kind, server, requirements, handler, hooks=None):
    payload = PaymentPayload(x402_version=2, accepted=requirements, payload={"signature": "payer"})
    if kind.startswith("fast"):
        wrapped = create_fastmcp_payment_wrapper(server, accepts=[requirements], hooks=hooks)(
            lambda: handler()
        )
        return await wrapped(
            ctx=MockFastMCPContext({MCP_PAYMENT_META_KEY: payload.model_dump(by_alias=True)})
        )
    if kind == "async":
        wrapped = create_payment_wrapper(
            server, PaymentWrapperConfig(accepts=[requirements], hooks=hooks)
        )(lambda *_: handler())
        return await wrapped({}, _paid_tool_extra(payload))
    wrapped = create_payment_wrapper_sync(
        server, SyncPaymentWrapperConfig(accepts=[requirements], hooks=hooks)
    )(lambda *_: handler())
    return wrapped({}, _paid_tool_extra(payload))


def _generic_server(kind):
    server = _MismatchAsyncServer() if kind in ("fast-async", "async") else _MismatchSyncServer()
    server._abort_once = False
    return server


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["fast-async", "fast-sync", "async", "sync"])
@pytest.mark.parametrize("skip", [False, True])
async def test_skip_handler_requires_an_explicit_directive(kind, skip):
    from x402.schemas.hooks import SkipHandlerDirective

    server = _generic_server(kind)
    server.verify_payment.side_effect = None
    # A plain Mock fabricates attributes on lookup. It is not a skip directive.
    verified = Mock(is_valid=True)
    if skip:
        verified.skip_handler = SkipHandlerDirective(body={"closed": True})
    server.verify_payment.return_value = verified
    handler = Mock(return_value="paid output")
    result = await _run_generic_wrapper(kind, server, _cash_requirements(), handler)
    assert not getattr(result, "isError", getattr(result, "is_error", False))
    assert handler.call_count == (0 if skip else 1)
    server.settle_payment.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["fast-async", "fast-sync", "async", "sync"])
async def test_metering_failure_cancels_without_charging_ceiling(kind):
    from x402.mcp.types import PaymentWrapperHooks

    server = _generic_server(kind)
    requirements = _cash_requirements()
    before = requirements.model_dump()

    def meter(context):
        context.payment_requirements.amount = "200"
        context.payment_requirements.pay_to = "unrelated-payee"
        raise ValueError("meter unavailable")

    handler = Mock(return_value="paid output")
    result = await _run_generic_wrapper(
        kind, server, requirements, handler, PaymentWrapperHooks(on_after_execution=meter)
    )
    assert getattr(result, "isError", getattr(result, "is_error", False))
    handler.assert_called_once()
    server.settle_payment.assert_not_called()
    dispatcher = server.create_payment_cancellation_dispatcher.return_value
    cancel = dispatcher.cancel if kind in ("fast-async", "async") else dispatcher.cancel_sync
    cancel.assert_called_once()
    assert requirements.model_dump() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["fast-async", "fast-sync", "async", "sync"])
async def test_metering_only_updates_request_local_settlement_amount(kind):
    from x402.mcp.types import PaymentWrapperHooks

    server = _generic_server(kind)
    requirements = _cash_requirements()
    before = requirements.model_dump()

    def meter(context):
        context.payment_requirements.amount = "200"
        context.payment_requirements.pay_to = "unrelated-payee"

    result = await _run_generic_wrapper(
        kind, server, requirements, lambda: "ok", PaymentWrapperHooks(on_after_execution=meter)
    )
    assert not getattr(result, "isError", getattr(result, "is_error", False))
    settled = server.settle_payment.call_args.args[1]
    assert settled.amount == "200"
    assert settled.pay_to == requirements.pay_to
    assert requirements.model_dump() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["fast-async", "fast-sync", "async", "sync"])
async def test_all_wrappers_preserve_failed_receipt_only_in_error_body(kind):
    from x402.mcp.utils import convert_mcp_result, extract_payment_response_from_result

    server = _generic_server(kind)
    receipt = SettleResponse(
        success=False,
        transaction="pending-tx",
        network="x402:cash",
        error_reason="transaction_pending",
        extra={"channelId": "channel"},
    )
    server.settle_payment.return_value = receipt
    result = await _run_generic_wrapper(kind, server, _cash_requirements(), lambda: "ok")
    normalized = convert_mcp_result(result)
    assert normalized.is_error
    assert MCP_PAYMENT_RESPONSE_META_KEY not in normalized.meta
    assert extract_payment_response_from_result(normalized) == receipt


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["fast-async", "fast-sync", "async", "sync"])
@pytest.mark.parametrize("amount", [True, 200, "1001", "-1", "1.0", "1e2", "١", "", " 1"])
async def test_invalid_metering_amount_cancels_before_settlement(kind, amount):
    from x402.mcp.types import PaymentWrapperHooks

    server = _generic_server(kind)
    requirements = _cash_requirements()

    def meter(context):
        # Hooks are Python callbacks: Pydantic assignment validation is not enabled.
        context.payment_requirements.amount = amount

    result = await _run_generic_wrapper(
        kind, server, requirements, lambda: "ok", PaymentWrapperHooks(on_after_execution=meter)
    )
    assert getattr(result, "isError", getattr(result, "is_error", False))
    server.settle_payment.assert_not_called()
    dispatcher = server.create_payment_cancellation_dispatcher.return_value
    cancel = dispatcher.cancel if kind in ("fast-async", "async") else dispatcher.cancel_sync
    cancel.assert_called_once()
    assert requirements.amount == "1000"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["async", "sync"])
@pytest.mark.parametrize(
    "outcome", ["released", "upfront", "unknown", "upfront-unknown", "no-dispatcher"]
)
async def test_metering_failure_reports_only_known_cancellation_outcomes(kind, outcome):
    from x402.mcp.types import PaymentWrapperHooks
    from x402.mcp.utils import (
        convert_mcp_result,
        extract_payment_required_from_result,
        extract_payment_response_from_result,
    )

    server = _generic_server(kind)
    dispatcher = server.create_payment_cancellation_dispatcher.return_value
    cancel = dispatcher.cancel if kind == "async" else dispatcher.cancel_sync
    if outcome in ("upfront", "upfront-unknown"):
        server.get_payment_flow.return_value = "upfront"
    if outcome in ("unknown", "upfront-unknown"):
        cancel.side_effect = TimeoutError("cancellation outcome unknown")
    elif outcome == "no-dispatcher":
        server.create_payment_cancellation_dispatcher.return_value = None

    def meter(_):
        raise ValueError("meter unavailable")

    result = convert_mcp_result(
        await _run_generic_wrapper(
            kind,
            server,
            _cash_requirements(),
            lambda: "ok",
            PaymentWrapperHooks(on_after_execution=meter),
        )
    )
    assert result.is_error
    receipt = extract_payment_response_from_result(result)
    if outcome == "released":
        assert receipt is not None and not receipt.success
        assert receipt.transaction == ""
        assert receipt.error_reason == "Payment metering failed"
        assert extract_payment_required_from_result(result) is not None
        assert MCP_PAYMENT_RESPONSE_META_KEY not in result.meta
    elif outcome in ("upfront", "upfront-unknown"):
        assert receipt == server.settle_payment.return_value
        assert receipt.success
        server.settle_payment.assert_called_once()
        assert server.settle_payment.call_args.kwargs["phase"] == "before-handler"
    else:
        assert receipt is None
        assert extract_payment_required_from_result(result) is None
    if outcome not in ("upfront", "upfront-unknown"):
        server.settle_payment.assert_not_called()
