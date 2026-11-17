/**
 * Per-IP limit for sign-in endpoints. Resolved at request time so it can come from config
 * (`LOGIN_RATE_LIMIT_PER_MIN`, default 10) even though decorators are evaluated at import.
 */
let limitPerMinute = 10;

export function setLoginRateLimit(n: number) {
  limitPerMinute = n;
}

export const LOGIN_THROTTLE = { default: { limit: () => limitPerMinute, ttl: 60_000 } };
