# FMCSAPULL Scoring Rules

Scoring is deterministic. There is no AI or randomness in the lead score.

For the same normalized carrier input and the same `SCORING_VERSION`, the score, grade, applied rule IDs, products, and reasons will be the same every time.

Current scoring version:

```text
TRUCKING_INSURANCE_V1_2026_06_24
```

## Grade bands

| Grade | Minimum Score | Meaning |
|---|---:|---|
| A+ | 110 | Call first |
| A | 85 | Strong lead |
| B | 60 | Add to campaign |
| C | 40 | Nurture |
| SKIP | Below 40 | Low priority / skip |

## Rule table

| Rule ID | Bucket | Points | What it means |
|---|---:|---:|---|
| STATUS_ACTIVE_AUTHORIZED | Commercial P&C | +25 | Active, allowed, authorized, or granted status signal |
| OPERATION_FOR_HIRE_PROPERTY | Commercial P&C | +25 | For-hire/property/common/contract carrier signal |
| CONTACT_PHONE_PRESENT | Commercial P&C | +10 | Phone number available |
| ADDRESS_CITY_STATE_PRESENT | Commercial P&C | +10 | Physical city and state available |
| POWER_UNITS_6_TO_25 | Commercial P&C | +30 | 6-25 power units; strong commercial P&C premium potential |
| POWER_UNITS_3_TO_5 | Commercial P&C | +20 | 3-5 power units; good small-fleet opportunity |
| POWER_UNITS_1_TO_2 | Commercial P&C | +12 | 1-2 power units; owner-operator opportunity |
| POWER_UNITS_ZERO | Risk Adjustment | -20 | No power units found |
| DRIVERS_6_PLUS | Life/Health | +25 | 6+ drivers; workers comp, benefits, key-person opportunity |
| DRIVERS_3_TO_5 | Life/Health | +18 | 3-5 drivers; small employer cross-sell opportunity |
| DRIVERS_1_TO_2 | Life/Health | +12 | 1-2 drivers; owner-operator or small operator cross-sell opportunity |
| CARGO_TEMPERATURE_SENSITIVE | Commercial P&C | +15 | Refrigerated, fresh produce, or meat cargo |
| CARGO_SPECIALTY_HIGHER_PREMIUM | Commercial P&C | +15 | Motor vehicles, machinery, building materials, intermodal, or household goods |
| CARGO_GENERAL_FREIGHT_DRY_BULK | Commercial P&C | +8 | General freight or dry bulk |
| DOCKET_NUMBER_PRESENT | Urgency | +10 | Docket/MC number available |
| INSURANCE_OR_AUTHORITY_TRIGGER | Urgency | +20 | Insurance/authority trigger detected in source data |
| MCS150_DATE_PRESENT | Urgency | +8 | MCS-150 date available |
| BAD_STATUS_SIGNAL | Risk Adjustment | -45 | Inactive, revoked, not authorized, not allowed, or out-of-service signal |
| BROKER_ONLY_NO_TRUCKS | Risk Adjustment | -30 | Broker-only/no truck signal |

## Default product tags

These tags are added deterministically after scoring:

| Product Rule | Product | Condition |
|---|---|---|
| DEFAULT_COMMERCIAL_AUTO | Commercial Auto | Always |
| DEFAULT_PHYSICAL_DAMAGE | Physical Damage | Power units > 0 |
| DEFAULT_UMBRELLA_EXCESS | Umbrella / Excess | Power units > 1 |
| DEFAULT_OCC_ACC | Occupational Accident | Drivers > 0 |
| DEFAULT_KEY_PERSON | Key Person Life | Power units >= 3 or drivers >= 3 |

## Audit fields stored on every lead

The database stores:

| Field | Purpose |
|---|---|
| scoring_version | Shows which scoring version ranked the lead |
| applied_rule_ids | Exact rules that fired for that carrier |
| scoring_reasons | Human-readable explanation with point values |
| lead_score | Final score |
| lead_grade | A+, A, B, C, or SKIP |

## API endpoint

After deployment:

```http
GET /scoring/rules
```

This returns the active scoring version, grade bands, scoring rules, and default product rules.
