import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db.js';
import { parseRegistryRecord } from './registryParser.js';
import type { EnrichmentResult, EnrichmentRunResult, ParsedRegistryRecord, PersonalizationMode, StateRegistryRecordInput } from './registryTypes.js';

interface CarrierRow {
  id: string;
  usdot_number: string | null;
  legal_name: string | null;
  dba_name: string | null;
  entity_type: string | null;
  carrier_operation: string | null;
  authority_status: string | null;
  usdot_status: string | null;
  allowed_to_operate: string | null;
  physical_street: string | null;
  physical_city: string | null;
  physical_state: string | null;
  physical_zip: string | null;
  mailing_street: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_zip: string | null;
  phone: string | null;
  email: string | null;
  power_units: number | null;
  drivers: number | null;
}

interface DecisionMakerRow {
  person_name: string | null;
  title: string | null;
  source: string | null;
  confidence: number | null;
  priority_rank: number | null;
  phone: string | null;
  email: string | null;
}

const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY',
  'LA', 'MA', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY',
  'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY', 'DC'
]);

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length ? text : null;
}

function safeKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 240) || 'unknown';
}

function normalizeState(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function companyName(carrier: CarrierRow): string | null {
  return carrier.dba_name || carrier.legal_name || (carrier.usdot_number ? `USDOT ${carrier.usdot_number}` : null);
}

function textIncludesAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function hasFullAddress(street: string | null, city: string | null, state: string | null, zip: string | null): boolean {
  return Boolean(street && city && state && zip);
}

function buildHq(parsed: ParsedRegistryRecord, carrier: CarrierRow) {
  const hasRegistryOffice = hasFullAddress(parsed.registeredOfficeStreet, parsed.registeredOfficeCity, parsed.registeredOfficeState, parsed.registeredOfficeZip);
  if (hasRegistryOffice) {
    return {
      hqName: parsed.matchedName || companyName(carrier),
      hqStreet: parsed.registeredOfficeStreet,
      hqCity: parsed.registeredOfficeCity,
      hqState: normalizeState(parsed.registeredOfficeState),
      hqZip: parsed.registeredOfficeZip,
      hqCountry: 'US',
      hqSource: 'STATE_REGISTRY',
      hqConfidence: 90
    };
  }

  return {
    hqName: companyName(carrier),
    hqStreet: carrier.physical_street,
    hqCity: carrier.physical_city,
    hqState: normalizeState(carrier.physical_state),
    hqZip: carrier.physical_zip,
    hqCountry: normalizeState(carrier.physical_state) ? 'US' : null,
    hqSource: 'FMCSA_PHYSICAL',
    hqConfidence: hasFullAddress(carrier.physical_street, carrier.physical_city, carrier.physical_state, carrier.physical_zip) ? 65 : 35
  };
}

function isUsBased(carrier: CarrierRow, hqState: string | null): boolean {
  const state = normalizeState(hqState || carrier.physical_state || carrier.mailing_state);
  return US_STATES.has(state);
}

function isBadStatus(carrier: CarrierRow, parsed: ParsedRegistryRecord): boolean {
  const text = `${carrier.usdot_status ?? ''} ${carrier.allowed_to_operate ?? ''} ${carrier.authority_status ?? ''} ${parsed.entityStatus ?? ''} ${parsed.rightToTransact ?? ''}`;
  return textIncludesAny(text, ['out-of-service', 'out of service', 'inactive', 'revoked', 'not authorized', 'not allowed', 'forfeited', 'terminated', 'suspended']);
}

function hasActiveSignal(carrier: CarrierRow, parsed: ParsedRegistryRecord): boolean {
  const text = `${carrier.usdot_status ?? ''} ${carrier.allowed_to_operate ?? ''} ${carrier.authority_status ?? ''} ${parsed.entityStatus ?? ''} ${parsed.rightToTransact ?? ''}`;
  return textIncludesAny(text, ['active', 'allowed', 'authorized', 'granted', 'in good standing', 'right to transact']) || Boolean(parsed.entityId);
}

function isLiveryOrPassenger(carrier: CarrierRow): boolean {
  const text = `${carrier.legal_name ?? ''} ${carrier.dba_name ?? ''} ${carrier.entity_type ?? ''} ${carrier.carrier_operation ?? ''}`;
  return textIncludesAny(text, ['limo', 'limousine', 'passenger', 'taxi', 'bus', 'shuttle', 'chauffeur']);
}

function chooseMode(best: DecisionMakerRow | null, companyOnlyAllowed: boolean, salesReady: boolean): PersonalizationMode {
  if (!salesReady) return 'UNQUALIFIED';
  if (best?.person_name && (best.confidence ?? 0) >= 70) return 'DECISION_MAKER';
  if (best?.person_name && best.source === 'registered_agent') return 'REGISTERED_AGENT_CLUE';
  if (companyOnlyAllowed) return 'COMPANY_ONLY';
  return 'UNQUALIFIED';
}

async function getCarrier(client: PoolClient, input: StateRegistryRecordInput): Promise<CarrierRow | null> {
  if (input.carrierId) {
    const result = await client.query<CarrierRow>('select * from fmcsa_carriers where id = $1', [input.carrierId]);
    return result.rows[0] ?? null;
  }
  if (input.usdotNumber) {
    const result = await client.query<CarrierRow>('select * from fmcsa_carriers where usdot_number = $1', [input.usdotNumber]);
    return result.rows[0] ?? null;
  }

  const stateCode = normalizeState(input.stateCode);
  const names = [input.legalName, input.searchName].map(clean).filter((item): item is string => Boolean(item));
  for (const name of names) {
    const result = await client.query<CarrierRow>(
      `select * from fmcsa_carriers
        where upper(coalesce(physical_state, mailing_state, '')) = $1
          and (legal_name ilike $2 or dba_name ilike $2)
        order by last_seen_at desc
        limit 1`,
      [stateCode, `%${name}%`]
    );
    if (result.rows[0]) return result.rows[0];
  }
  return null;
}

function registryRecordKey(input: StateRegistryRecordInput, parsed: ParsedRegistryRecord): string {
  return safeKey(parsed.entityId || parsed.matchedName || input.searchName || input.legalName || JSON.stringify(parsed.raw).slice(0, 200));
}

async function upsertRegistryMatch(client: PoolClient, carrierId: number, input: StateRegistryRecordInput, parsed: ParsedRegistryRecord): Promise<number> {
  const result = await client.query<{ id: string }>(
    `insert into state_registry_matches (
       carrier_id, state_code, source_name, registry_record_key, search_name, matched_name, entity_id, entity_status, right_to_transact,
       registered_office_street, registered_office_city, registered_office_state, registered_office_zip,
       registered_agent_name, registered_agent_type, registered_agent_address, match_confidence, raw
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     on conflict (carrier_id, state_code, source_name, registry_record_key) do update set
       search_name = excluded.search_name,
       matched_name = coalesce(excluded.matched_name, state_registry_matches.matched_name),
       entity_status = coalesce(excluded.entity_status, state_registry_matches.entity_status),
       right_to_transact = coalesce(excluded.right_to_transact, state_registry_matches.right_to_transact),
       registered_office_street = coalesce(excluded.registered_office_street, state_registry_matches.registered_office_street),
       registered_office_city = coalesce(excluded.registered_office_city, state_registry_matches.registered_office_city),
       registered_office_state = coalesce(excluded.registered_office_state, state_registry_matches.registered_office_state),
       registered_office_zip = coalesce(excluded.registered_office_zip, state_registry_matches.registered_office_zip),
       registered_agent_name = coalesce(excluded.registered_agent_name, state_registry_matches.registered_agent_name),
       registered_agent_type = excluded.registered_agent_type,
       registered_agent_address = coalesce(excluded.registered_agent_address, state_registry_matches.registered_agent_address),
       match_confidence = greatest(state_registry_matches.match_confidence, excluded.match_confidence),
       raw = excluded.raw,
       updated_at = now()
     returning id`,
    [
      carrierId,
      normalizeState(input.stateCode),
      input.sourceName,
      registryRecordKey(input, parsed),
      input.searchName ?? input.legalName ?? null,
      parsed.matchedName,
      parsed.entityId,
      parsed.entityStatus,
      parsed.rightToTransact,
      parsed.registeredOfficeStreet,
      parsed.registeredOfficeCity,
      parsed.registeredOfficeState ? normalizeState(parsed.registeredOfficeState) : null,
      parsed.registeredOfficeZip,
      parsed.registeredAgentName,
      parsed.registeredAgentType,
      parsed.registeredAgentAddress,
      parsed.matchedName ? 85 : 60,
      parsed.raw
    ]
  );
  return Number(result.rows[0].id);
}

async function upsertDecisionMakers(client: PoolClient, carrierId: number, registryMatchId: number, parsed: ParsedRegistryRecord): Promise<void> {
  for (const officer of parsed.officers) {
    const contactKey = safeKey(`${officer.name}|${officer.title ?? ''}`);
    await client.query(
      `insert into decision_maker_contacts (
         carrier_id, registry_match_id, source, contact_key, person_name, title, contact_type, confidence, priority_rank, raw
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (carrier_id, source, contact_key) do update set
         registry_match_id = excluded.registry_match_id,
         confidence = greatest(decision_maker_contacts.confidence, excluded.confidence),
         priority_rank = least(decision_maker_contacts.priority_rank, excluded.priority_rank),
         raw = excluded.raw,
         updated_at = now()`,
      [
        carrierId,
        registryMatchId,
        officer.source,
        contactKey,
        officer.name,
        officer.title,
        officer.source === 'registered_agent' ? 'REGISTERED_AGENT' : 'OFFICER',
        officer.confidence,
        officer.priorityRank,
        officer.raw
      ]
    );
  }
}

async function bestDecisionMaker(client: PoolClient, carrierId: number): Promise<DecisionMakerRow | null> {
  const result = await client.query<DecisionMakerRow>(
    `select person_name, title, source, confidence, priority_rank, phone, email
       from decision_maker_contacts
      where carrier_id = $1
      order by priority_rank asc, confidence desc, updated_at desc
      limit 1`,
    [carrierId]
  );
  return result.rows[0] ?? null;
}

function qualityReason(parts: string[]): string {
  return parts.length ? parts.join('; ') : 'Sales-ready commercial P&C lead.';
}

async function updateLeadEnrichment(client: PoolClient, carrier: CarrierRow, parsed: ParsedRegistryRecord, best: DecisionMakerRow | null): Promise<{
  salesReady: boolean;
  salesReadyReason: string;
  personalizationMode: PersonalizationMode;
}> {
  const hq = buildHq(parsed, carrier);
  const fullHq = hasFullAddress(hq.hqStreet, hq.hqCity, hq.hqState, hq.hqZip);
  const contactable = Boolean(carrier.phone || carrier.email || best?.phone || best?.email);
  const decisionMakerFound = Boolean(best?.person_name && (best.confidence ?? 0) >= 70);
  const companyOnlyAllowed = !decisionMakerFound && contactable;
  const reasons: string[] = [];

  if (!isUsBased(carrier, hq.hqState)) reasons.push('EXCLUDE_NON_US_COMPANY');
  if (!contactable) reasons.push('MISSING_COMPANY_PHONE_OR_EMAIL');
  if (!fullHq) reasons.push('MISSING_FULL_HQ_OR_BASE_LOCATION');
  if (isLiveryOrPassenger(carrier)) reasons.push('SEPARATE_LIVERY_OR_PASSENGER_CAMPAIGN');
  if (isBadStatus(carrier, parsed)) reasons.push('EXCLUDE_INACTIVE_REVOKED_OR_OUT_OF_SERVICE');
  if (!hasActiveSignal(carrier, parsed)) reasons.push('MISSING_ACTIVE_AUTHORIZED_OR_STATE_REGISTRY_SIGNAL');
  if (!decisionMakerFound && !companyOnlyAllowed) reasons.push('NO_DECISION_MAKER_OR_ALLOWED_COMPANY_PATH');

  const salesReady = reasons.length === 0;
  const personalizationMode = chooseMode(best, companyOnlyAllowed, salesReady);
  const salesReadyReason = salesReady
    ? decisionMakerFound
      ? 'Sales-ready: decision maker found with verified HQ/base and contact path.'
      : 'Sales-ready company-only path: no decision maker found yet, but company contact, HQ/base, and active/state signal are present.'
    : qualityReason(reasons);

  await client.query(
    `update insurance_leads set
       hq_name = $2,
       hq_street = $3,
       hq_city = $4,
       hq_state = $5,
       hq_zip = $6,
       hq_country = $7,
       hq_source = $8,
       hq_confidence = $9,
       registered_agent_name = $10,
       registered_agent_type = $11,
       registered_agent_address = $12,
       officer_name = $13,
       officer_title = $14,
       officer_source = $15,
       decision_maker_name = $16,
       decision_maker_title = $17,
       decision_maker_email = $18,
       decision_maker_phone = $19,
       decision_maker_source = $20,
       decision_maker_confidence = $21,
       personalization_name = $22,
       personalization_mode = $23,
       sales_ready = $24,
       sales_ready_reason = $25,
       updated_at = now()
     where carrier_id = $1`,
    [
      Number(carrier.id),
      hq.hqName,
      hq.hqStreet,
      hq.hqCity,
      hq.hqState,
      hq.hqZip,
      hq.hqCountry,
      hq.hqSource,
      hq.hqConfidence,
      parsed.registeredAgentName,
      parsed.registeredAgentType,
      parsed.registeredAgentAddress,
      best?.person_name ?? null,
      best?.title ?? null,
      best?.source ?? null,
      decisionMakerFound ? best?.person_name ?? null : null,
      decisionMakerFound ? best?.title ?? null : null,
      decisionMakerFound ? best?.email ?? null : null,
      decisionMakerFound ? best?.phone ?? null : null,
      decisionMakerFound ? best?.source ?? null : null,
      decisionMakerFound ? best?.confidence ?? null : null,
      decisionMakerFound ? best?.person_name ?? null : companyName(carrier),
      personalizationMode,
      salesReady,
      salesReadyReason
    ]
  );

  return { salesReady, salesReadyReason, personalizationMode };
}

export async function getEnrichmentSources() {
  const result = await query(
    `select state_code, source_name, source_type, base_url, requires_api_key, status, notes, updated_at
       from state_registry_sources
      order by state_code, source_name`
  );
  return result.rows;
}

export async function listCarrierTargetsForState(stateCode: string, limit: number, usdotNumbers: string[] = []): Promise<CarrierRow[]> {
  const normalizedState = normalizeState(stateCode);
  if (usdotNumbers.length) {
    const result = await query<CarrierRow>(
      `select * from fmcsa_carriers
        where upper(coalesce(physical_state, mailing_state, '')) = $1
          and usdot_number = any($2::text[])
        order by last_seen_at desc
        limit $3`,
      [normalizedState, usdotNumbers, limit]
    );
    return result.rows;
  }

  const result = await query<CarrierRow>(
    `select * from fmcsa_carriers
      where upper(coalesce(physical_state, mailing_state, '')) = $1
      order by last_seen_at desc
      limit $2`,
    [normalizedState, limit]
  );
  return result.rows;
}

export async function ingestStateRegistryRecords(records: StateRegistryRecordInput[]): Promise<EnrichmentRunResult> {
  const warnings: string[] = [];
  const results: EnrichmentResult[] = [];
  let skipped = 0;

  await withTransaction(async (client) => {
    for (const input of records) {
      const carrier = await getCarrier(client, input);
      if (!carrier) {
        skipped += 1;
        warnings.push(`No FMCSA carrier match found for ${input.usdotNumber ?? input.legalName ?? input.searchName ?? 'registry record'}.`);
        continue;
      }

      const parsed = parseRegistryRecord(input.raw);
      const registryMatchId = await upsertRegistryMatch(client, Number(carrier.id), input, parsed);
      await upsertDecisionMakers(client, Number(carrier.id), registryMatchId, parsed);
      const best = await bestDecisionMaker(client, Number(carrier.id));
      const quality = await updateLeadEnrichment(client, carrier, parsed, best);

      results.push({
        carrierId: Number(carrier.id),
        usdotNumber: carrier.usdot_number,
        companyName: companyName(carrier),
        registryMatchId,
        stateCode: normalizeState(input.stateCode),
        sourceName: input.sourceName,
        decisionMakerName: best?.person_name ?? null,
        decisionMakerTitle: best?.title ?? null,
        decisionMakerConfidence: best?.confidence ?? null,
        personalizationMode: quality.personalizationMode,
        salesReady: quality.salesReady,
        salesReadyReason: quality.salesReadyReason
      });
    }
  });

  return {
    ok: true,
    sourceName: records[0]?.sourceName ?? 'STATE_REGISTRY',
    stateCode: normalizeState(records[0]?.stateCode ?? ''),
    attempted: records.length,
    enriched: results.length,
    skipped,
    results,
    warnings
  };
}
