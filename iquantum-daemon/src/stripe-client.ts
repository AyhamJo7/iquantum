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

  constructWebhookEvent(
    payload: string | Uint8Array,
    signature: string,
    secret: string,
  ): Stripe.Event {
    return this.#client.webhooks.constructEvent(payload, signature, secret);
  }
}
