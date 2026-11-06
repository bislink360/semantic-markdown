# ADR-0012: Pagination for list endpoints

List endpoints use cursor pagination. Offset pagination was rejected.

## Decision

Cursor pagination

List endpoints return a `next_cursor` token. Clients pass it back to get the next page.

Offset pagination

Clients pass `offset` and `limit` on every request.

## Limits

The page size must not exceed 100 items. The default page size is 25.

Do not write cursors to logs, because they encode customer ids.

## Open questions

Should cursors expire?

Until this is decided, cursors stay valid for 24 hours.
