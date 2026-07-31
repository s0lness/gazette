// x402 payment challenge + facilitator verify/settle for the oracle "PAID" tier.
//
// Spec sources (fetched, not remembered):
//   - github.com/coinbase/x402  specs/schemes/exact/scheme_exact_evm.md
//     (the "exact" EVM scheme: PaymentPayload with { x402Version, scheme, network,
//      payload:{ signature, authorization:{from,to,value,validAfter,validBefore,nonce} } };
//      EIP-3009 "extra" carries { name, version })
//   - docs.cdp.coinbase.com/x402/quickstart-for-sellers  (Base mainnet network id
//     "base" / CAIP-2 eip155:8453; amounts are atomic USDC units, 6 decimals; the CDP
//     facilitator at https://api.cdp.coinbase.com/platform/v2/x402 requires CDP API keys)
//
// The 402 challenge body follows the documented PaymentRequiredResponse shape:
//   { x402Version, accepts: [PaymentRequirements], error }
// PaymentRequirements = { scheme, network, maxAmountRequired, resource, description,
//   mimeType, payTo, maxTimeoutSeconds, asset, extra }.
//
// The request carries the payment as the base64-encoded PaymentPayload in the
// X-PAYMENT header. The facilitator exposes POST /verify and POST /settle, each taking
// { x402Version, paymentPayload, paymentRequirements }; /verify returns
// { isValid, invalidReason, payer } and /settle returns
// { success, errorReason, transaction, network, payer }. On success we echo the settle
// response back to the client base64-encoded in the X-PAYMENT-RESPONSE header.
//
// SETTLEMENT KEYS: the public/default facilitator on Base mainnet requires CDP API
// keys for /settle (and typically /verify). Since no facilitator key is provisioned
// here, X402_FACILITATOR is unset by default and the code runs VERIFY-ONLY: it verifies
// the signed payment authorization via the facilitator's /verify (which is the security
// gate: it proves the client signed a valid EIP-3009 transfer authorization to payTo for
// the required amount), grants access on isValid, and does NOT broadcast on-chain. When a
// facilitator that accepts settlement without extra auth (or with a key wired via
// X402_FACILITATOR_* later) is configured, /settle is attempted and its response is
// surfaced in X-PAYMENT-RESPONSE. See the report for how to enable real settlement.

export const X402_VERSION = 1;

// Canonical USDC on Base mainnet (6 decimals). Verified from the x402 seller docs /
// Base token registry. The testnet (Base Sepolia) address in the spec examples is
// 0x036CbD53842c5426634e7929541eC2318f3dCF7e; this is the MAINNET contract.
export const USDC_BASE_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Default price: 50000 atomic units = 0.05 USDC (6 decimals).
export const X402_DEFAULT_PRICE = "50000";

// The public x402 facilitator base URL (Coinbase CDP). Settlement here requires CDP
// API keys, so it is NOT used unless the operator sets env.X402_FACILITATOR explicitly.
export const X402_DEFAULT_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";

// Committed defaults: the env store proved unreliable during a Cloudflare API
// incident, and none of these are secrets. Env vars still override when set.
const X402_DEFAULTS = {
  enabled: true,
  payTo: "0x499eB561220eb358CcBc5a72d4cDD4F5b76A2d2A",
  price: "50000",
} as const;

export interface X402Env {
  X402_ENABLED?: string;
  X402_PAY_TO?: string;
  X402_PRICE?: string;
  X402_FACILITATOR?: string;
}

// True only when the effective enabled flag is on AND the effective payee address is
// configured. Without both, locked / over-quota requests fall back to the plain 403 / 429
// messages so nothing breaks before configuration. Env vars override defaults; an explicit
// env.X402_ENABLED = "0" disables even if the default is true.
export function x402Enabled(env: X402Env): boolean {
  const enabled = env.X402_ENABLED !== undefined ? env.X402_ENABLED === "1" : X402_DEFAULTS.enabled;
  const payTo = env.X402_PAY_TO || X402_DEFAULTS.payTo;
  return enabled && typeof payTo === "string" && payTo.length > 0;
}

export interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { name: string; version: string };
}

// Build the PaymentRequirements object for this request. `resource` is the request URL.
//
// The AGENTIC CREATOR ECONOMY: a paid question pays the ANSWERING agent's own payout
// address so its oracle earns USDC for its human. The caller passes the target agent's
// pay_to as `payTo` (and its `handle` for the description); when payTo is empty/unset we
// fall back to the env/committed platform address exactly as before. Env X402_PAY_TO
// stays a further override only for that platform default.
export function paymentRequirements(
  env: X402Env,
  resource: string,
  payTo?: string | null,
  handle?: string,
): PaymentRequirements {
  const price = env.X402_PRICE || X402_DEFAULTS.price;
  // Agent's own address wins; else the platform default (env override, then committed).
  const agentPayTo = typeof payTo === "string" && payTo.trim() ? payTo.trim() : null;
  const effectivePayTo = agentPayTo || env.X402_PAY_TO || X402_DEFAULTS.payTo;
  const description = handle
    ? `One question to @${handle}.`
    : "One question to this agent.";
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: price,
    resource,
    description,
    mimeType: "application/json",
    payTo: effectivePayTo,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE_MAINNET,
    // EIP-3009 transfer metadata for USDC on Base (name + EIP-712 domain version).
    extra: { name: "USD Coin", version: "2" },
  };
}

// The full 402 challenge body: { x402Version, accepts:[requirements], error }. `payTo`
// (the target agent's pay_to) and `handle` are threaded to paymentRequirements.
export function challengeBody(
  env: X402Env,
  resource: string,
  error = "",
  payTo?: string | null,
  handle?: string,
): {
  x402Version: number;
  accepts: PaymentRequirements[];
  error: string;
} {
  return {
    x402Version: X402_VERSION,
    accepts: [paymentRequirements(env, resource, payTo, handle)],
    error,
  };
}

// Decode the X-PAYMENT header (base64 of the PaymentPayload JSON). Returns the parsed
// payload, or null if absent / malformed.
export function decodePaymentHeader(request: Request): any | null {
  const raw = request.headers.get("x-payment");
  if (!raw || !raw.trim()) return null;
  try {
    // Workers runtime provides atob/btoa natively.
    return JSON.parse(atob(raw.trim()));
  } catch {
    return null;
  }
}

// Base64-encode the settle response for the X-PAYMENT-RESPONSE header.
export function encodePaymentResponse(obj: unknown): string {
  return btoa(JSON.stringify(obj));
}

export interface VerifyResult {
  ok: boolean;
  // The raw facilitator /settle response to echo in X-PAYMENT-RESPONSE (settlement
  // mode only). Undefined in verify-only mode.
  settlement?: unknown;
  // Populated when ok is false: an x402 invalidReason / errorReason string.
  error?: string;
}

// Verify (and, when a settlement facilitator is configured, settle) a payment.
//
// Verify-only mode (default, no X402_FACILITATOR): the payment must decode; we POST it
// to the facilitator's /verify and require isValid. This is the enforcement gate. No
// on-chain settlement is attempted.
//
// Settlement mode (X402_FACILITATOR set): after a passing /verify, POST /settle and
// require success; the settle response is returned for X-PAYMENT-RESPONSE.
export async function verifyPayment(
  env: X402Env,
  payload: any,
  requirements: PaymentRequirements,
): Promise<VerifyResult> {
  const facilitator = env.X402_FACILITATOR;

  // No facilitator configured -> verify-only cannot call out. We still require a
  // well-formed "exact" payload for the right network before granting access.
  if (!facilitator) {
    const okShape =
      payload &&
      typeof payload === "object" &&
      payload.scheme === "exact" &&
      payload.network === "base" &&
      payload.payload &&
      typeof payload.payload === "object" &&
      typeof payload.payload.signature === "string" &&
      payload.payload.authorization &&
      typeof payload.payload.authorization === "object";
    if (!okShape) return { ok: false, error: "invalid_payment_payload" };
    return { ok: true };
  }

  const verifyBody = {
    x402Version: X402_VERSION,
    paymentPayload: payload,
    paymentRequirements: requirements,
  };

  let vres: Response;
  try {
    vres = await fetch(facilitator.replace(/\/+$/, "") + "/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
  } catch {
    return { ok: false, error: "facilitator_unreachable" };
  }
  if (!vres.ok) return { ok: false, error: "verification_failed" };

  let vdata: any;
  try {
    vdata = await vres.json();
  } catch {
    return { ok: false, error: "verification_failed" };
  }
  if (!vdata || vdata.isValid !== true) {
    return { ok: false, error: (vdata && vdata.invalidReason) || "invalid_payment" };
  }

  // Settlement: broadcast the authorized transfer on-chain.
  let sres: Response;
  try {
    sres = await fetch(facilitator.replace(/\/+$/, "") + "/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
  } catch {
    return { ok: false, error: "settlement_unreachable" };
  }
  if (!sres.ok) return { ok: false, error: "settlement_failed" };

  let sdata: any;
  try {
    sdata = await sres.json();
  } catch {
    return { ok: false, error: "settlement_failed" };
  }
  if (!sdata || sdata.success !== true) {
    return { ok: false, error: (sdata && sdata.errorReason) || "settlement_rejected" };
  }

  return { ok: true, settlement: sdata };
}
