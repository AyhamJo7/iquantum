import Stripe from "stripe";

export class StripeClient {
  readonly #client: Stripe;

  constructor(secretKey: string, client?: Stripe) {
    this.#client = client ?? new Stripe(secretKey);
  }

  async reportUsage(
    stripeCustomerId: string,
    containerMinutes: number,
  ): Promise<void> {
    await this.#client.billing.meterEvents.create({
      event_name: "iquantum_container_minutes",
      payload: {
        stripe_customer_id: stripeCustomerId,
        value: String(containerMinutes),
      },
    });
  }

  async createPortalSession(
    stripeCustomerId: string,
    returnUrl: string,
  ): Promise<string> {
    const session = await this.#client.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl,
    });
    return session.url;
  }

  constructWebhookEvent(
    payload: string | Uint8Array,
    signature: string,
    secret: string,
  ): Stripe.Event {
    return this.#client.webhooks.constructEvent(payload, signature, secret);
  }
}
