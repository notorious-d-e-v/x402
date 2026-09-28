import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  x402HTTPResourceServer,
  HTTPAdapter,
  PaywallProvider,
} from "../../../src/http/x402HTTPResourceServer";
import { x402ResourceServer } from "../../../src/server/x402ResourceServer";
import {
  MockFacilitatorClient,
  MockSchemeNetworkServer,
  buildSupportedResponse,
} from "../../mocks";
import { Network, Price } from "../../../src/types";

// Stands in for an installed @x402/paywall. Without this mock the package is
// not resolvable from core, which the fallback tests in
// x402HTTPResourceService.test.ts rely on.
const paywall = vi.hoisted(() => {
  const generateHtml = vi.fn();
  const builder = {
    withNetwork: vi.fn(() => builder),
    build: vi.fn(() => ({ generateHtml })),
  };
  return {
    generateHtml,
    builder,
    module: {
      createPaywall: vi.fn(() => builder),
      evmPaywall: { network: "evm" },
      svmPaywall: { network: "svm" },
      avmPaywall: { network: "avm" },
    },
  };
});

vi.mock("@x402/paywall", () => paywall.module);

const network = "eip155:8453" as Network;

const browserAdapter: HTTPAdapter = {
  getHeader: () => undefined,
  getMethod: () => "GET",
  getPath: () => "/api/protected",
  getUrl: () => "https://example.com/api/protected",
  getAcceptHeader: () => "text/html,application/xhtml+xml",
  getUserAgent: () => "Mozilla/5.0",
};

describe("x402HTTPResourceServer paywall", () => {
  let httpServer: x402HTTPResourceServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    paywall.generateHtml.mockReturnValue("<html>@x402/paywall</html>");

    const resourceServer = new x402ResourceServer(
      new MockFacilitatorClient(
        buildSupportedResponse({ kinds: [{ x402Version: 2, scheme: "exact", network }] }),
      ),
    );
    resourceServer.register(network, new MockSchemeNetworkServer("exact"));
    await resourceServer.initialize();

    httpServer = new x402HTTPResourceServer(resourceServer, {
      "/api/protected": {
        accepts: { scheme: "exact", payTo: "0xabc", price: "$1.00" as Price, network },
      },
    });
  });

  /**
   * Sends an unpaid browser request and returns the HTML body.
   *
   * @returns The paywall HTML
   */
  async function renderPaywall(): Promise<string> {
    const result = await httpServer.processHTTPRequest(
      { adapter: browserAdapter, path: "/api/protected", method: "GET" },
      { appName: "Test App", testnet: true },
    );
    if (result.type !== "payment-error" || !result.response.isHtml) {
      throw new Error(`expected HTML payment-error, got ${JSON.stringify(result)}`);
    }
    return String(result.response.body);
  }

  it("renders @x402/paywall when it is installed and no provider is registered", async () => {
    const html = await renderPaywall();

    expect(html).toBe("<html>@x402/paywall</html>");
    expect(paywall.builder.withNetwork.mock.calls).toEqual([
      [paywall.module.evmPaywall],
      [paywall.module.svmPaywall],
      [paywall.module.avmPaywall],
    ]);
    expect(paywall.generateHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        accepts: [expect.objectContaining({ scheme: "exact", network, payTo: "0xabc" })],
      }),
      { appName: "Test App", testnet: true },
    );
  });

  it("prefers a registered paywall provider over @x402/paywall", async () => {
    const provider: PaywallProvider = { generateHtml: () => "<html>custom</html>" };
    httpServer.registerPaywallProvider(provider);

    expect(await renderPaywall()).toBe("<html>custom</html>");
    expect(paywall.module.createPaywall).not.toHaveBeenCalled();
  });

  it("falls back to the static page when @x402/paywall has no handler for the network", async () => {
    paywall.generateHtml.mockImplementation(() => {
      throw new Error("No paywall handler supports networks");
    });

    const html = await renderPaywall();

    expect(html).toMatch(/Payment Required/);
    expect(html).toContain("install <code>@x402/paywall</code>");
  });
});
