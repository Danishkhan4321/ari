// dashboard/lib/dodo.ts
// Thin Dodo Payments REST client. Server-side only — never imported into
// "use client" components since it touches DODO_API_KEY.
import { dodoApiBase } from "./products";

function apiKey(): string {
  const key = process.env.DODO_API_KEY;
  if (!key) throw new Error("DODO_API_KEY is not set on the dashboard server");
  return key;
}

type CheckoutSessionResponse = {
  session_id: string;
  checkout_url: string;
};

// Create a Dodo checkout session for a single subscription product. The
// customer will be sent to checkout_url; on success Dodo redirects them
// to return_url with subscription_id/status/email query params appended.
export async function createCheckoutSession(opts: {
  productId: string;
  returnUrl: string;
  customerEmail?: string;
  metadata?: Record<string, string>;
}): Promise<CheckoutSessionResponse | null> {
  const body: Record<string, unknown> = {
    product_cart: [{ product_id: opts.productId, quantity: 1 }],
    return_url: opts.returnUrl,
  };
  if (opts.customerEmail) body.customer = { email: opts.customerEmail };
  if (opts.metadata) body.metadata = opts.metadata;

  const res = await fetch(`${dodoApiBase()}/checkouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()) as CheckoutSessionResponse;
}

// Look up a subscription by id. Used by the onboarding page to verify
// that subscription_id from the return URL is real and active.
type SubscriptionResponse = {
  subscription_id: string;
  status: string;          // "active" | "pending" | "cancelled" | …
  customer?: { email?: string; customer_id?: string };
  product_id?: string;
};

export async function getSubscription(subscriptionId: string): Promise<SubscriptionResponse | null> {
  const res = await fetch(`${dodoApiBase()}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as SubscriptionResponse;
}
