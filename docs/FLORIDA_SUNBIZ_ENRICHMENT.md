# Florida Sunbiz Enrichment

Florida does not need a Texas-style API key for the first enrichment build.

The adapter uses the official Sunbiz corporation search and enriches Florida FMCSA targets by company name.

## Why this works

Sunbiz corporation records expose the fields needed for commercial P&C lead enrichment:

- Document number
- Entity name
- Status
- Principal address
- Registered agent name and address
- Officer/director/manager names and titles

Florida also publishes fixed-width daily and quarterly data downloads. Those are better for a later bulk cache. The first adapter is intentionally search-based so we can enrich targeted Florida FMCSA leads without downloading the very large quarterly files.

## Endpoint

```bash
curl -X POST "https://fmcsapull-production.up.railway.app/admin/enrich/fl" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":25}'
```

Run for one USDOT:

```bash
curl -X POST "https://fmcsapull-production.up.railway.app/admin/enrich/fl" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"usdotNumber":"123456"}'
```

## What it does

1. Pulls Florida FMCSA targets from `fmcsa_carriers`.
2. Searches Sunbiz by legal name or DBA.
3. Opens the best matching Sunbiz entity detail pages.
4. Parses principal address, registered agent, entity status, document number, and officer/director detail.
5. Sends normalized registry records into the shared enrichment engine.
6. Writes to:
   - `state_registry_matches`
   - `decision_maker_contacts`
   - enrichment fields on `insurance_leads`
7. Re-evaluates the sales-ready quality gate.

## No Railway variables required

Do not add a fake Florida API key. The search adapter does not require one.

## Later bulk cache

A later version should add a Florida bulk-cache job using:

- Quarterly corporate filings: `doc/quarterly/cor/cordata.zip`
- Quarterly corporate events: `doc/quarterly/cor/corevent.zip`
- Daily corporate filings: `doc/cor/yyyyMMddc.txt`
- Daily corporate events: `doc/cor/events/yyyyMMddce.txt`

The quarterly files are very large and fixed-width, so they should be streamed into a cache table instead of held in memory.
