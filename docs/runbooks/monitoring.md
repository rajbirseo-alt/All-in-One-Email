# Runbook: monitoring and alerts

## Where to look

- **Admin → System health** (Super Admin): every check, refreshed on demand.
- **Alerts:** the worker runs the same checks every 5 minutes. Active Super Admins get a notification (bell and browser push, type "System alerts") once when a check gets worse, and once when it recovers. Nothing repeats while the state stays the same.
- **`GET /api/v1/health`** (public): `{"status":"ok"}` when the API is up and the database answers. Render uses it, and an external uptime monitor should poll it every minute.
- **`GET /api/v1/metrics`**: Prometheus text format for Grafana Cloud, Better Stack or similar. It is off unless `METRICS_TOKEN` is set. Send `Authorization: Bearer <METRICS_TOKEN>`.
  - `crm_check_status{check="…"}` is 0 (ok), 1 (warning) or 2 (failing).
  - `crm_check_value{check="…"}` is the measured value.
  - `crm_up` is 1 unless something is failing.
- **Render dashboard:** CPU, memory, restarts and logs per service; disk and connections for `crm-db`. Set Render's own alerts for failed deploys and restarts.

## The checks

| Check | Warning | Failing | Value |
|---|---|---|---|
| Database | answers slower than 500 ms | does not answer | latency, ms |
| Background worker | — | no scheduled job finished for 5 min (sync, sending and SLA alerts are stopped) | seconds since the last one |
| Job queues | a job waited 10 min, or jobs failed in the last hour | a job waited 30 min | oldest wait, s |
| Mailbox sync | a mailbox needs reconnecting or has an error, or one is 15 min behind | one is 60 min behind | worst lag, s |
| Sending | emails failed to send in the last 24 h | emails stuck in the queue for more than 15 min | count |
| Report figures | not updated for 2 h | — | age, s |
| Virus scanning | off in production (`CLAMAV_HOST` unset) | scanner not answering (uploads and downloads are refused) | 1 = up |
| Attachment storage | — | — | information only |

The thresholds are in `apps/api/src/health/system-health.service.ts` (`HEALTH_LIMITS`).

## Suggested external alerts

1. **Uptime:** `https://<domain>/api/v1/health` is not 200 for 2 minutes. Tell the on-call person.
2. **Metrics:**
   - `crm_check_status{check="worker"} == 2` for 5 min;
   - `crm_check_status{check="mailbox-sync"} == 2`;
   - `crm_up == 0`.
3. **Render:**
   - `crm-db` disk above 80%;
   - API memory above 90%;
   - more than 3 restarts in an hour.

What to do for each alert: [incidents.md](incidents.md).
