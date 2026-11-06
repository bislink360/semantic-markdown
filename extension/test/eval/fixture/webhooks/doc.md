# Webhook delivery

How the platform delivers webhook events to customer endpoints, retries failures and handles payload limits.

Delivery rules

- Sign every payload with HMAC-SHA256 using the endpoint secret.
- Never log payload bodies.

## Endpoints

Customers register endpoints in the dashboard. Only HTTPS endpoints receive events. Plain HTTP endpoints are rejected at registration.

## Retries

A failed delivery is retried up to 8 times. Retries are not attempted for 4xx responses, except 429.

Exponential backoff with jitter

Retries wait 30 seconds, then double each time, with up to 20% random jitter.

Fixed 60-second interval

Every retry waits 60 seconds.

## Payloads

| Field | Limit |
|-|-|
| Payload size | 256 KB |
| Event types per endpoint | 50 |

Payloads over 256 KB are dropped, not truncated.

## Replays

Should failed deliveries be replayable from the dashboard?

Until this is decided, failed deliveries are kept for 7 days and can be replayed only through the API.

Support contacts

Escalate delivery incidents in the #webhooks-oncall channel.

## Incident history

The March 2026 outage lasted 3 hours and led to the switch away from fixed retry intervals.
