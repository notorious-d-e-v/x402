import { ChainIdToNetwork, PaymentRequirementsSchema, Wallet } from "x402/types";
import { evm } from "x402/types";
import {
  createPaymentHeader,
  PaymentRequirementsSelector,
  selectPaymentRequirements,
} from "x402/client";

/**
 * Enables the payment of APIs using the x402 payment protocol.
 *
 * This function wraps the native fetch API to automatically handle 402 Payment Required responses
 * by creating and sending a payment header. It will:
 * 1. Make the initial request
 * 2. If a 402 response is received, parse the payment requirements
 * 3. Verify the payment amount is within the allowed maximum
 * 4. Create a payment header using the provided wallet client
 * 5. Retry the request with the payment header
 *
 * @param fetch - The fetch function to wrap (typically globalThis.fetch)
 * @param walletClient - The wallet client used to sign payment messages
 * @param maxValue - The maximum allowed payment amount in base units (defaults to 0.1 USDC)
 * @param paymentRequirementsSelector - A function that selects the payment requirements from the response
 * @returns A wrapped fetch function that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * const wallet = new SignerWallet(...);
 * const fetchWithPay = wrapFetchWithPayment(fetch, wallet);
 *
 * // Make a request that may require payment
 * const response = await fetchWithPay('https://api.example.com/paid-endpoint');
 * ```
 *
 * @throws {Error} If the payment amount exceeds the maximum allowed value
 * @throws {Error} If the request configuration is missing
 * @throws {Error} If a payment has already been attempted for this request
 * @throws {Error} If there's an error creating the payment header
 */
export function wrapFetchWithPayment(
  fetch: typeof globalThis.fetch,
  walletClient: Wallet,
  maxValue: bigint = BigInt(0.1 * 10 ** 6), // Default to 0.10 USDC
  paymentRequirementsSelector: PaymentRequirementsSelector = selectPaymentRequirements,
) {
  return async (input: RequestInfo, init?: RequestInit) => {
    const response = await fetch(input, init);

    if (response.status !== 402) {
      return response;
    }

    const { x402Version, accepts } = (await response.json()) as {
      x402Version: number;
      accepts: unknown[];
    };
    const parsedPaymentRequirements = accepts.map(x => PaymentRequirementsSchema.parse(x));

    const chainId = evm.isSignerWallet(walletClient) ? walletClient.chain?.id : undefined;
    const selectedPaymentRequirements = paymentRequirementsSelector(
      parsedPaymentRequirements,
      chainId ? ChainIdToNetwork[chainId] : undefined,
      "exact",
    );

    if (BigInt(selectedPaymentRequirements.maxAmountRequired) > maxValue) {
      throw new Error("Payment amount exceeds maximum allowed");
    }

    const paymentHeader = await createPaymentHeader(
      walletClient,
      x402Version,
      selectedPaymentRequirements,
    );

    if (!init) {
      throw new Error("Missing fetch request configuration");
    }

    if ((init as { __is402Retry?: boolean }).__is402Retry) {
      throw new Error("Payment already attempted");
    }

    const newInit = {
      ...init,
      headers: {
        ...(init.headers || {}),
        "X-PAYMENT": paymentHeader,
        "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
      },
      __is402Retry: true,
    };

    const secondResponse = await fetch(input, newInit);
    return secondResponse;
  };
}

export { decodeXPaymentResponse } from "x402/shared";
