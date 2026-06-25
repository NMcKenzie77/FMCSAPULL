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
alter table insurance_leads add column if not exists hq_name text;
alter table insurance_leads add column if not exists hq_street text;
alter table insurance_leads add column if not exists hq_city text;
alter table insurance_leads add column if not exists hq_state text;
alter table insurance_leads add column if not exists hq_zip text;
alter table insurance_leads add column if not exists hq_country text;
alter table insurance_leads add column if not exists hq_source text;
alter table insurance_leads add column if not exists hq_confidence integer;
alter table insurance_leads add column if not exists registered_agent_name text;
alter table insurance_leads add column if not exists registered_agent_type text;
alter table insurance_leads add column if not exists registered_agent_address text;
alter table insurance_leads add column if not exists officer_name text;
alter table insurance_leads add column if not exists officer_title text;
alter table insurance_leads add column if not exists officer_source text;
alter table insurance_leads add column if not exists decision_maker_name text;
alter table insurance_leads add column if not exists decision_maker_title text;
alter table insurance_leads add column if not exists decision_maker_email text;
alter table insurance_leads add column if not exists decision_maker_phone text;
alter table insurance_leads add column if not exists decision_maker_source text;
alter table insurance_leads add column if not exists decision_maker_confidence integer;
alter table insurance_leads add column if not exists personalization_name text;
alter table insurance_leads add column if not exists personalization_mode text not null default 'UNQUALIFIED';
alter table insurance_leads add column if not exists sales_ready boolean not null default false;
alter table insurance_leads add column if not exists sales_ready_reason text;

create index if not exists idx_insurance_leads_grade_score on insurance_leads (lead_grade, lead_score desc);
create index if not exists idx_insurance_leads_status on insurance_leads (lead_status);
create index if not exists idx_insurance_leads_scoring_version on insurance_leads (scoring_version);
create index if not exists idx_insurance_leads_sales_ready on insurance_leads (sales_ready, lead_score desc);
create index if not exists idx_insurance_leads_hq_state on insurance_leads (hq_state);

create table if not exists state_registry_sources (
  id bigserial primary key,
  state_code text not null,
  source_name text not null,
  source_type text not null default 'STATE_REGISTRY',
  base_url text,
  requires_api_key boolean not null default false,
  status text not null default 'ACTIVE',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (state_code, source_name)
);

insert into state_registry_sources (state_code, source_name, source_type, base_url, requires_api_key, status, notes)
values
  ('TX', 'TX_COMPTROLLER', 'API', null, true, 'NEEDS_CONFIGURATION', 'Texas should be first enrichment adapter. Set TX_COMPTROLLER_API_KEY and TX_COMPTROLLER_API_URL in Railway.'),
  ('FL', 'FL_SUNBIZ', 'DOWNLOAD_OR_SEARCH', 'https://search.sunbiz.org', false, 'PLANNED', 'Florida is wave 1, likely best as a download/import adapter rather than a simple live API.'),
  ('GA', 'GA_CORPORATIONS', 'STATE_REGISTRY', null, false, 'PLANNED', 'Wave 1 commercial P&C enrichment target.'),
  ('NC', 'NC_SECRETARY_OF_STATE', 'STATE_REGISTRY', null, false, 'PLANNED', 'Wave 1 commercial P&C enrichment target.'),
  ('AZ', 'AZ_CORPORATION_COMMISSION', 'STATE_REGISTRY', null, false, 'PLANNED', 'Wave 1 commercial P&C enrichment target.'),
  ('TN', 'TN_SECRETARY_OF_STATE', 'STATE_REGISTRY', null, false, 'PLANNED', 'Wave 1 commercial P&C enrichment target.')
on conflict (state_code, source_name) do update set
  source_type = excluded.source_type,
  base_url = coalesce(state_registry_sources.base_url, excluded.base_url),
  requires_api_key = excluded.requires_api_key,
  status = excluded.status,
  notes = excluded.notes,
  updated_at = now();

create table if not exists state_registry_matches (
  id bigserial primary key,
  carrier_id bigint not null references fmcsa_carriers(id) on delete cascade,
  state_code text not null,
  source_name text not null,
  registry_record_key text not null,
  search_name text,
  matched_name text,
  entity_id text,
  entity_status text,
  right_to_transact text,
  registered_office_street text,
  registered_office_city text,
  registered_office_state text,
  registered_office_zip text,
  registered_agent_name text,
  registered_agent_type text,
  registered_agent_address text,
  match_confidence integer not null default 0,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (carrier_id, state_code, source_name, registry_record_key)
);

create index if not exists idx_state_registry_matches_carrier on state_registry_matches (carrier_id);
create index if not exists idx_state_registry_matches_state on state_registry_matches (state_code, source_name);
create index if not exists idx_state_registry_matches_raw_gin on state_registry_matches using gin (raw);

create table if not exists decision_maker_contacts (
  id bigserial primary key,
  carrier_id bigint not null references fmcsa_carriers(id) on delete cascade,
  registry_match_id bigint references state_registry_matches(id) on delete set null,
  source text not null,
  contact_key text not null,
  person_name text not null,
  title text,
  email text,
  phone text,
  contact_type text not null default 'OFFICER',
  confidence integer not null default 0,
  priority_rank integer not null default 99,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (carrier_id, source, contact_key)
);

create index if not exists idx_decision_maker_contacts_carrier on decision_maker_contacts (carrier_id, priority_rank, confidence desc);
create index if not exists idx_decision_maker_contacts_type on decision_maker_contacts (contact_type);

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
