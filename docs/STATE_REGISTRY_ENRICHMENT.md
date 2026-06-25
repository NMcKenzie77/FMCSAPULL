# State Registry Enrichment Engine

FMCSA records are raw company/carrier records. They are useful, but they are not sales-ready insurance leads until the system confirms HQ/base, status, contactability, and a decision-maker or approved company-only contact path.

This enrichment layer turns raw FMCSA records into Invicta commercial P&C leads.

## New database objects

Run the initializer after deployment:

```bash
npm run db:init
```

Or through the deployed service:

```bash
curl -X POST "https://fmcsapull-production.up.railway.app/admin/db/init" \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

The initializer adds:

- `state_registry_sources`
- `state_registry_matches`
- `decision_maker_contacts`
- enrichment columns on `insurance_leads`

## Quality gate

Use this when reviewing leads that should be eligible for ARKON/export:

```bash
curl -s "https://fmcsapull-production.up.railway.app/leads?limit=25&minGrade=B&qualityGate=true" | jq
```

A lead passes the gate only when it has:

- U.S.-based HQ/base signal
- company phone or email
- full HQ/base location
- no inactive/revoked/out-of-service signal
- no passenger/livery flag unless a separate livery campaign is being run
- active/authorized FMCSA signal or state registry confirmation
- decision maker found, or company-level outreach path allowed

ARKON and Google Sheets exports now use the quality gate automatically. Raw FMCSA rows should not be exported.

## Texas enrichment

Set these in Railway before live Texas API enrichment:

```bash
TX_COMPTROLLER_API_KEY=your_key_here
TX_COMPTROLLER_API_URL=https://the-texas-endpoint/search?name={name}
```

The adapter sends the key as `x-api-key` and replaces `{name}` or `{query}` in the URL with the company name. If neither token exists, it appends `?search=<company>` or `&search=<company>`.

Run Texas enrichment:

```bash
curl -X POST "https://fmcsapull-production.up.railway.app/admin/enrich/texas" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"limit":25}'
```

Run Texas enrichment for one USDOT:

```bash
curl -X POST "https://fmcsapull-production.up.railway.app/admin/enrich/texas" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"usdotNumber":"284491"}'
```

## Manual state registry import

Use this endpoint when a state is better handled by download/search instead of live API, such as early Florida Sunbiz work.

```bash
curl -X POST "https://fmcsapull-production.up.railway.app/admin/enrich/state-records" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "stateCode":"TX",
    "sourceName":"TX_COMPTROLLER",
    "usdotNumber":"284491",
    "searchName":"FAST TRUCKING INC",
    "records":[
      {
        "entity_name":"FAST TRUCKING INC",
        "entity_id":"example-entity-id",
        "entity_status":"ACTIVE",
        "right_to_transact":"ACTIVE",
        "registered_office_street":"123 MAIN ST",
        "registered_office_city":"RIO GRANDE CITY",
        "registered_office_state":"TX",
        "registered_office_zip":"78582",
        "registered_agent_name":"Example Owner",
        "officers":[
          {"name":"Example Owner", "title":"President"}
        ]
      }
    ]
  }'
```

## Source review

```bash
curl -s "https://fmcsapull-production.up.railway.app/admin/enrichment/sources" \
  -H "x-admin-api-key: $ADMIN_API_KEY" | jq
```

## Next adapter order

Wave 1 target order:

1. Texas
2. Florida
3. Georgia
4. North Carolina
5. Arizona
6. Tennessee

Do not pick states only because the API is clean. Pick them because they have commercial P&C premium potential, business-owner pain, vertical density, carrier appetite, decision-maker enrichment availability, Spanish/bilingual opportunity, and a repeatable process.
