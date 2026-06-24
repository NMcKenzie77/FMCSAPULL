create table if not exists import_runs (
  id bigserial primary key,
  source text not null,
  dataset_id text not null,
  status text not null default 'running',
  requested_limit integer,
  fetched_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  lead_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists fmcsa_carriers (
  id bigserial primary key,
  usdot_number text not null unique,
  docket_number text,
  docket_prefix text,
  legal_name text,
  dba_name text,
  entity_type text,
  carrier_operation text,
  authority_status text,
  usdot_status text,
  allowed_to_operate text,
  physical_street text,
  physical_city text,
  physical_state text,
  physical_zip text,
  mailing_street text,
  mailing_city text,
  mailing_state text,
  mailing_zip text,
  phone text,
  email text,
  power_units integer,
  drivers integer,
  mcs150_date date,
  mcs150_mileage integer,
  mcs150_mileage_year integer,
  cargo text[],
  insurance_on_file jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  source text not null default 'FMCSA',
  source_dataset text,
  source_updated_at timestamptz
);

create index if not exists idx_fmcsa_carriers_state on fmcsa_carriers (physical_state);
create index if not exists idx_fmcsa_carriers_power_units on fmcsa_carriers (power_units);
create index if not exists idx_fmcsa_carriers_last_seen on fmcsa_carriers (last_seen_at desc);
create index if not exists idx_fmcsa_carriers_raw_gin on fmcsa_carriers using gin (raw);

create table if not exists insurance_leads (
  id bigserial primary key,
  carrier_id bigint not null references fmcsa_carriers(id) on delete cascade,
  usdot_number text not null unique,
  lead_status text not null default 'NEW',
  lead_source text not null default 'FMCSA_DATAHUB',
  lead_grade text not null,
  lead_score integer not null,
  commercial_pnc_score integer not null default 0,
  life_health_score integer not null default 0,
  urgency_score integer not null default 0,
  risk_adjustment integer not null default 0,
  recommended_products text[] not null default '{}',
  outreach_angle text,
  scoring_reasons text[] not null default '{}',
  scoring_version text not null default 'TRUCKING_INSURANCE_V1_2026_06_24',
  applied_rule_ids text[] not null default '{}',
  exported_to_arkon_at timestamptz,
  exported_to_sheets_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table insurance_leads add column if not exists scoring_version text not null default 'TRUCKING_INSURANCE_V1_2026_06_24';
alter table insurance_leads add column if not exists applied_rule_ids text[] not null default '{}';

create index if not exists idx_insurance_leads_grade_score on insurance_leads (lead_grade, lead_score desc);
create index if not exists idx_insurance_leads_status on insurance_leads (lead_status);
create index if not exists idx_insurance_leads_scoring_version on insurance_leads (scoring_version);

create table if not exists export_events (
  id bigserial primary key,
  lead_id bigint not null references insurance_leads(id) on delete cascade,
  target text not null,
  status text not null default 'pending',
  response_status integer,
  response_body text,
  error_message text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
