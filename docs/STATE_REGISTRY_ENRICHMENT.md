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
curl -s "https://fmcsapull-production.up.railway.app/leads?limit=25&minGrade=B&qualityGate=true"
```

A lead passes the gate only when it has:

- U.S.-based HQ/base signal
- company phone or email
- full HQ/base location
- no inactive/revoked/out-of-service signal
- no passenger/livery flag unless a separate livery campaign is being run
- active/authorized FMCSA signal or state registry confirmation
- decision maker found, or company-level outreach path allowed

ARKON and Google Sheets exports use the quality gate automatically. Raw FMCSA rows should not be exported.

## Texas enrichment

Texas is the first true API adapter.

Set this in Railway before live Texas enrichment:

```bash
TX_COMPTROLLER_API_KEY=your_key_here
```

Optional override only if Texas changes the public-data host:

```bash
TX_COMPTROLLER_API_BASE_URL=https://api.comptroller.texas.gov/public-data/v1/public
```

The adapter now uses the official Texas Comptroller public-data flow:

1. Search FTAS records by entity name:
   - `GET /franchise-tax-list?name=<company>`
2. Retrieve franchise account/officer details by 11-digit taxpayer ID:
   - `GET /franchise-tax/<taxpayerId>`

Both requests send the key as `x-api-key`.

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

## API key / source matrix

Do not paste real API keys into chat or git. Put secrets only in Railway variables.

| State | Variable | Current source strategy |
| --- | --- | --- |
| TX | `TX_COMPTROLLER_API_KEY` | Official Texas Comptroller public-data API. |
| FL | none currently | Official Sunbiz daily/quarterly downloads over public SFTP; no live key in the current adapter. |
| GA | none currently | Official Georgia Corporations Division search; adapter planned. |
| NC | none currently | Official Secretary of State search; adapter planned. |
| AZ | none currently | Arizona Corporation Commission eCorp search; adapter planned. |
| TN | none currently | Tennessee business information search; adapter planned. |

Placeholders exist in `.env.example` for future state-specific keys, but do not set them unless the state actually provides an official key.

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
        "name":"FAST TRUCKING INC",
        "taxpayerId":"12345678901",
        "sosRegistrationStatus":"Active",
        "rightToTransactTX":"Y",
        "registeredOfficeAddressStreet":"123 MAIN ST",
        "registeredOfficeAddressCity":"RIO GRANDE CITY",
        "registeredOfficeAddressState":"TX",
        "registeredOfficeAddressZip":"78582",
        "registeredAgentName":"Example Owner",
        "officerInfo":[
          {"AGNT_NM":"Example Owner", "AGNT_TITL_TX":"PRESIDENT"}
        ]
      }
    ]
  }'
```

## Source review

```bash
curl -s "https://fmcsapull-production.up.railway.app/admin/enrichment/sources" \
  -H "x-admin-api-key: $ADMIN_API_KEY"
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
