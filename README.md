# FMCSAPULL — FMCSA Insurance Lead Engine

Railway-ready Node/TypeScript service that imports FMCSA / DOT DataHub records, parses trucking carrier data, scores the companies as P&C insurance leads, and prepares them for ARKON or Google Sheets export.

## What this does

- Pulls FMCSA public data from DOT DataHub Socrata endpoints.
- Imports new/updated trucking carrier records.
- Normalizes USDOT, MC/docket, company name, address, phone, fleet size, driver count, cargo, authority, and insurance-related fields.
- Scores each carrier for P&C insurance opportunity.
- Adds life/health cross-sell signals based on owner-operator/small-fleet/driver-count patterns.
- Exposes an API for lead review and manual import.
- Supports Railway Cron for automatic daily imports.

## Data sources

Default dataset IDs:

| Source | Dataset | Use |
|---|---:|---|
| `carrier-daily` | `6qg9-x4f8` | Daily difference carrier authority records |
| `carrier-all-history` | `6eyk-hxee` | Full carrier authority history |
| `company-census` | `az4n-8mr2` | Company Census File |

The first Railway cron should use `carrier-daily`. Use `company-census` or `carrier-all-history` for backfill/testing only because those files can be large.

## Railway setup

1. Create a new Railway project.
2. Connect this GitHub repo: `NMcKenzie77/FMCSAPULL`.
3. Add a Railway Postgres database.
4. Set environment variables from `.env.example`.
5. Deploy.
6. Run the database initializer once:

```bash
npm run db:init
```

7. Test a small import:

```bash
npm run import -- carrier-daily 100
```

8. Add a Railway Cron job:

```bash
npm run import -- carrier-daily 5000
```

Recommended schedule: daily after DOT/FMCSA updates are expected to be available. Use UTC in Railway. A safe starting schedule is around `18:00 UTC`.

## Commands

```bash
npm run build
npm run start
npm run db:init
npm run import -- carrier-daily 5000
npm run import -- company-census 1000
npm run score:refresh
```

## API

### Health

```http
GET /health
```

### Stats

```http
GET /stats
```

### Get top leads

```http
GET /leads?limit=100&minGrade=B
```

### Initialize database

```http
POST /admin/db/init
x-admin-api-key: your-key
```

### Run import

```http
POST /admin/import
x-admin-api-key: your-key
content-type: application/json

{
  "source": "carrier-daily",
  "limit": 5000
}
```

### Export to ARKON webhook

```http
POST /admin/export/arkon
x-admin-api-key: your-key
content-type: application/json

{
  "limit": 100,
  "minGrade": "B"
}
```

## Environment variables

```bash
DATABASE_URL=postgresql://...
ADMIN_API_KEY=long-random-string
FMCSA_CARRIER_DAILY_DATASET=6qg9-x4f8
FMCSA_CARRIER_ALL_HISTORY_DATASET=6eyk-hxee
FMCSA_COMPANY_CENSUS_DATASET=az4n-8mr2
FMCSA_IMPORT_LIMIT=5000
FMCSA_IMPORT_SOURCE=carrier-daily
ARKON_WEBHOOK_URL=
ARKON_WEBHOOK_SECRET=
GOOGLE_SHEETS_WEBHOOK_URL=
GOOGLE_SHEETS_WEBHOOK_SECRET=
```

## Lead scoring summary

The scoring engine prioritizes:

- Active/authorized status signals.
- For-hire/property carrier signals.
- Power units from 1 to 25.
- Driver count, especially 3+ or 6+ drivers.
- Phone and usable address.
- Docket/MC number.
- Insurance/authority triggers.
- Cargo types that usually create stronger trucking insurance conversations.

Grades:

| Grade | Meaning |
|---|---|
| A+ | Call first |
| A | Strong lead |
| B | Add to campaign |
| C | Nurture |
| SKIP | Low-value or bad status |

## Recommended Railway structure

Use one Railway service for the API plus one cron execution:

- Web service: `npm run start`
- Cron command: `npm run import -- carrier-daily 5000`
- Database: Railway Postgres

## ARKON integration note

This repo does not assume ARKON's final lead endpoint yet. When the ARKON insurance CRM has a lead intake endpoint, set:

```bash
ARKON_WEBHOOK_URL=https://your-arkon-url/api/leads/fmcsa
ARKON_WEBHOOK_SECRET=shared-secret
```

The payload includes:

- company name / DBA
- USDOT number
- docket number
- phone/email/address
- fleet size
- driver count
- cargo
- lead grade
- lead score
- recommended products
- outreach angle
