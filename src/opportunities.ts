import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import type { NormalizedCarrier } from './fmcsa/normalize.js';

export type CarrierOpportunityType = 'EXISTING_INSURED_REVIEW' | 'NEW_AUTHORITY_INSURANCE_NEEDED';

export interface CarrierOpportunityInput {
  opportunityType: CarrierOpportunityType;
  opportunityKey: string;
  priority: number;
  title: string;
  reason: string;
  recommendedAction: string;
  renewalStage: string | null;
  renewalDate: string | null;
  insuranceSignal: Record<string, unknown>;
  opportunityJson: Record<string, unknown>;
}

export interface CarrierOpportunityResult extends CarrierOpportunityInput {
  id: number;
}

const inactiveMarkers = ['INACTIVE', 'REVOKED', 'DISMISSED', 'OUT OF SERVICE'];
const newAuthorityMarkers = ['PENDING', 'NEW', 'APPLICATION', 'NOT AUTHORIZED', 'NOT AUTHORIZED FOR PROPERTY'];
const onFileKeys = ['bipd_on_file', 'cargo_on_file', 'bond_on_file', 'insurance_on_file'];
const requiredKeys = ['bipd_required', 'cargo_required', 'bond_required', 'insurance_required'];
const detailKeys = ['bipd_file', 'cargo_file', 'insurance_company_name', 'policy_number', 'policy_type'];

function upper(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function hasMarker(value: unknown, markers: string[]) {
  const text = upper(value);
  return Boolean(text && markers.some((marker) => text.includes(marker)));
}

function yes(value: unknown) {
  const text = upper(value);
  return ['Y', 'YES', 'TRUE', 'T', '1', 'X', 'ON FILE', 'FILED', 'ACTIVE'].includes(text);
}

function hasText(value: unknown) {
  return String(value ?? '').trim().length > 0;
}

function insuranceRecord(carrier: NormalizedCarrier): Record<string, unknown> {
  return carrier.insuranceOnFile && typeof carrier.insuranceOnFile === 'object' && !Array.isArray(carrier.insuranceOnFile)
    ? carrier.insuranceOnFile
    : {};
}

export function isInactiveCarrier(carrier: NormalizedCarrier) {
  return [carrier.authorityStatus, carrier.usdotStatus, carrier.allowedToOperate].some((value) => hasMarker(value, inactiveMarkers));
}

export function hasInsuranceOnFileSignal(carrier: NormalizedCarrier) {
  const insurance = insuranceRecord(carrier);
  return onFileKeys.some((key) => yes(insurance[key])) || detailKeys.some((key) => hasText(insurance[key]));
}

export function hasInsuranceRequiredSignal(carrier: NormalizedCarrier) {
  const insurance = insuranceRecord(carrier);
  return requiredKeys.some((key) => yes(insurance[key]));
}

function isNewAuthorityCandidate(carrier: NormalizedCarrier, isNewRecord: boolean) {
  return isNewRecord || [carrier.authorityStatus, carrier.usdotStatus, carrier.allowedToOperate].some((value) => hasMarker(value, newAuthorityMarkers));
}

function targetFleetForExisting(carrier: NormalizedCarrier) {
  const units = Number(carrier.powerUnits ?? 0);
  return units >= 2 && units <= 50;
}

function targetFleetForNewAuthority(carrier: NormalizedCarrier) {
  const units = Number(carrier.powerUnits ?? 0);
  return units <= 50;
}

function insuranceSignal(carrier: NormalizedCarrier) {
  const insurance = insuranceRecord(carrier);
  return {
    hasInsuranceOnFile: hasInsuranceOnFileSignal(carrier),
    hasInsuranceRequired: hasInsuranceRequiredSignal(carrier),
    bipdRequired: insurance.bipd_required ?? null,
    bipdOnFile: insurance.bipd_on_file ?? null,
    cargoRequired: insurance.cargo_required ?? null,
    cargoOnFile: insurance.cargo_on_file ?? null,
    bondRequired: insurance.bond_required ?? null,
    bondOnFile: insurance.bond_on_file ?? null,
    insuranceCompanyName: insurance.insurance_company_name ?? null,
    policyNumber: insurance.policy_number ?? null,
    policyType: insurance.policy_type ?? null,
  };
}

export function classifyCarrierOpportunity(carrier: NormalizedCarrier, isNewRecord = false): CarrierOpportunityInput | null {
  if (!carrier.usdotNumber || isInactiveCarrier(carrier)) return null;

  const units = Number(carrier.powerUnits ?? 0);
  const insured = hasInsuranceOnFileSignal(carrier);
  const required = hasInsuranceRequiredSignal(carrier);
  const newAuthority = isNewAuthorityCandidate(carrier, isNewRecord);
  const signal = insuranceSignal(carrier);
  const company = carrier.dbaName || carrier.legalName || `USDOT ${carrier.usdotNumber}`;

  if (newAuthority && targetFleetForNewAuthority(carrier) && (insured || required)) {
    return {
      opportunityType: 'NEW_AUTHORITY_INSURANCE_NEEDED',
      opportunityKey: 'new-authority-current',
      priority: insured ? 82 : 74,
      title: 'New Authority — Insurance Needed',
      reason: insured
        ? `${company} appears to be a new or pending authority with insurance activity already showing.`
        : `${company} appears to be a new or pending authority where insurance is required before operating cleanly.`,
      recommendedAction: 'Confirm authority status, current filing, effective date, and what coverage is needed to activate or stay compliant.',
      renewalStage: null,
      renewalDate: null,
      insuranceSignal: signal,
      opportunityJson: {
        targetLane: 'NEW_MC',
        powerUnits: units,
        drivers: carrier.drivers ?? null,
        authorityStatus: carrier.authorityStatus,
        usdotStatus: carrier.usdotStatus,
        allowedToOperate: carrier.allowedToOperate,
      },
    };
  }

  if (targetFleetForExisting(carrier) && insured) {
    return {
      opportunityType: 'EXISTING_INSURED_REVIEW',
      opportunityKey: 'active-insured-current',
      priority: units >= 10 ? 92 : 86,
      title: 'Existing Carrier — Insurance Review',
      reason: `${company} has ${units} power unit${units === 1 ? '' : 's'} and an insurance-on-file signal, making it a market-check or renewal review opportunity.`,
      recommendedAction: 'Lead with a trucking insurance review: current carrier, renewal date, units/drivers, cargo, radius, loss runs, and whether coverage is still priced correctly.',
      renewalStage: null,
      renewalDate: null,
      insuranceSignal: signal,
      opportunityJson: {
        targetLane: 'EXISTING_CARRIER',
        powerUnits: units,
        drivers: carrier.drivers ?? null,
        authorityStatus: carrier.authorityStatus,
        usdotStatus: carrier.usdotStatus,
        allowedToOperate: carrier.allowedToOperate,
      },
    };
  }

  return null;
}

export async function upsertCarrierOpportunity(
  client: PoolClient,
  carrierId: number,
  carrier: NormalizedCarrier,
  isNewRecord = false
): Promise<CarrierOpportunityResult | null> {
  const opportunity = classifyCarrierOpportunity(carrier, isNewRecord);

  if (!opportunity) {
    await client.query(
      `update carrier_opportunities
          set status = 'SUPPRESSED', updated_at = now(), last_seen_at = now()
        where usdot_number = $1
          and status = 'OPEN'`,
      [carrier.usdotNumber]
    );
    return null;
  }

  const result = await client.query<{ id: string }>(
    `insert into carrier_opportunities (
       carrier_id, usdot_number, opportunity_type, opportunity_key, status, priority,
       title, reason, recommended_action, renewal_stage, renewal_date,
       insurance_signal_json, opportunity_json
     ) values ($1,$2,$3,$4,'OPEN',$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (usdot_number, opportunity_type, opportunity_key) do update set
       carrier_id = excluded.carrier_id,
       status = 'OPEN',
       priority = excluded.priority,
       title = excluded.title,
       reason = excluded.reason,
       recommended_action = excluded.recommended_action,
       renewal_stage = excluded.renewal_stage,
       renewal_date = excluded.renewal_date,
       insurance_signal_json = excluded.insurance_signal_json,
       opportunity_json = excluded.opportunity_json,
       last_seen_at = now(),
       updated_at = now(),
       closed_at = null
     returning id`,
    [
      carrierId,
      carrier.usdotNumber,
      opportunity.opportunityType,
      opportunity.opportunityKey,
      opportunity.priority,
      opportunity.title,
      opportunity.reason,
      opportunity.recommendedAction,
      opportunity.renewalStage,
      opportunity.renewalDate,
      JSON.stringify(opportunity.insuranceSignal),
      JSON.stringify(opportunity.opportunityJson),
    ]
  );

  return { ...opportunity, id: Number(result.rows[0].id) };
}

export async function refreshCarrierOpportunities(): Promise<{ refreshed: number; open: number; suppressed: number }> {
  const rows = await query<{
    id: string;
    usdot_number: string;
    docket_number: string | null;
    docket_prefix: string | null;
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
    mcs150_date: string | null;
    mcs150_mileage: number | null;
    mcs150_mileage_year: number | null;
    cargo: string[] | null;
    insurance_on_file: Record<string, unknown>;
    raw: Record<string, unknown>;
  }>(`select * from fmcsa_carriers`);

  let open = 0;
  let suppressed = 0;

  await withTransaction(async (client) => {
    for (const row of rows.rows) {
      const carrier: NormalizedCarrier = {
        usdotNumber: row.usdot_number,
        docketNumber: row.docket_number,
        docketPrefix: row.docket_prefix,
        legalName: row.legal_name,
        dbaName: row.dba_name,
        entityType: row.entity_type,
        carrierOperation: row.carrier_operation,
        authorityStatus: row.authority_status,
        usdotStatus: row.usdot_status,
        allowedToOperate: row.allowed_to_operate,
        physicalStreet: row.physical_street,
        physicalCity: row.physical_city,
        physicalState: row.physical_state,
        physicalZip: row.physical_zip,
        mailingStreet: row.mailing_street,
        mailingCity: row.mailing_city,
        mailingState: row.mailing_state,
        mailingZip: row.mailing_zip,
        phone: row.phone,
        email: row.email,
        powerUnits: row.power_units,
        drivers: row.drivers,
        mcs150Date: row.mcs150_date,
        mcs150Mileage: row.mcs150_mileage,
        mcs150MileageYear: row.mcs150_mileage_year,
        cargo: row.cargo ?? [],
        insuranceOnFile: row.insurance_on_file ?? {},
        raw: row.raw ?? {},
      };
      const saved = await upsertCarrierOpportunity(client, Number(row.id), carrier, false);
      if (saved) open += 1;
      else suppressed += 1;
    }
  });

  return { refreshed: rows.rowCount ?? 0, open, suppressed };
}
