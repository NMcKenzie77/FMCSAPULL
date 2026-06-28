import type { PoolClient } from 'pg';
import { config, datasetForSource, type ImportSource } from './config.js';
import { query, withTransaction } from './db.js';
import { normalizeCarrier, type NormalizedCarrier } from './fmcsa/normalize.js';
import { fetchSocrataRecords } from './fmcsa/socrata.js';
import { scoreCarrier } from './leads/score.js';
import { upsertCarrierOpportunity } from './opportunities.js';
import { upsertCarrierSafetyProfile } from './safety/profile.js';

export interface ImportResult {
  runId: number;
  source: ImportSource;
  datasetId: string;
  fetchedCount: number;
  normalizedCount: number;
  insertedCount: number;
  updatedCount: number;
  leadCount: number;
}

async function startRun(source: ImportSource, datasetId: string, limit: number): Promise<number> {
  const result = await query<{ id: string }>(
    `insert into import_runs (source, dataset_id, requested_limit) values ($1, $2, $3) returning id`,
    [source, datasetId, limit]
  );
  return Number(result.rows[0].id);
}

async function finishRun(runId: number, values: Partial<ImportResult>, error?: unknown): Promise<void> {
  await query(
    `update import_runs
       set status = $2,
           fetched_count = coalesce($3, fetched_count),
           inserted_count = coalesce($4, inserted_count),
           updated_count = coalesce($5, updated_count),
           lead_count = coalesce($6, lead_count),
           error_message = $7,
           finished_at = now()
     where id = $1`,
    [
      runId,
      error ? 'failed' : 'completed',
      values.fetchedCount ?? null,
      values.insertedCount ?? null,
      values.updatedCount ?? null,
      values.leadCount ?? null,
      error ? error instanceof Error ? error.message : String(error) : null
    ]
  );
}

async function upsertCarrier(client: PoolClient, carrier: NormalizedCarrier, source: ImportSource, datasetId: string): Promise<{ carrierId: number; inserted: boolean }> {
  const result = await client.query<{ id: string; inserted: boolean }>(
    `insert into fmcsa_carriers (
      usdot_number, docket_number, docket_prefix, legal_name, dba_name, entity_type,
      carrier_operation, authority_status, usdot_status, allowed_to_operate,
      physical_street, physical_city, physical_state, physical_zip,
      mailing_street, mailing_city, mailing_state, mailing_zip,
      phone, email, power_units, drivers, mcs150_date, mcs150_mileage, mcs150_mileage_year,
      cargo, insurance_on_file, raw, source_dataset, source_updated_at
    ) values (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
      $21,$22,$23,$24,$25,$26,$27,$28,$29,now()
    )
    on conflict (usdot_number) do update set
      docket_number = coalesce(excluded.docket_number, fmcsa_carriers.docket_number),
      docket_prefix = coalesce(excluded.docket_prefix, fmcsa_carriers.docket_prefix),
      legal_name = coalesce(excluded.legal_name, fmcsa_carriers.legal_name),
      dba_name = coalesce(excluded.dba_name, fmcsa_carriers.dba_name),
      entity_type = coalesce(excluded.entity_type, fmcsa_carriers.entity_type),
      carrier_operation = coalesce(excluded.carrier_operation, fmcsa_carriers.carrier_operation),
      authority_status = coalesce(excluded.authority_status, fmcsa_carriers.authority_status),
      usdot_status = coalesce(excluded.usdot_status, fmcsa_carriers.usdot_status),
      allowed_to_operate = coalesce(excluded.allowed_to_operate, fmcsa_carriers.allowed_to_operate),
      physical_street = coalesce(excluded.physical_street, fmcsa_carriers.physical_street),
      physical_city = coalesce(excluded.physical_city, fmcsa_carriers.physical_city),
      physical_state = coalesce(excluded.physical_state, fmcsa_carriers.physical_state),
      physical_zip = coalesce(excluded.physical_zip, fmcsa_carriers.physical_zip),
      mailing_street = coalesce(excluded.mailing_street, fmcsa_carriers.mailing_street),
      mailing_city = coalesce(excluded.mailing_city, fmcsa_carriers.mailing_city),
      mailing_state = coalesce(excluded.mailing_state, fmcsa_carriers.mailing_state),
      mailing_zip = coalesce(excluded.mailing_zip, fmcsa_carriers.mailing_zip),
      phone = coalesce(excluded.phone, fmcsa_carriers.phone),
      email = coalesce(excluded.email, fmcsa_carriers.email),
      power_units = coalesce(excluded.power_units, fmcsa_carriers.power_units),
      drivers = coalesce(excluded.drivers, fmcsa_carriers.drivers),
      mcs150_date = coalesce(excluded.mcs150_date, fmcsa_carriers.mcs150_date),
      mcs150_mileage = coalesce(excluded.mcs150_mileage, fmcsa_carriers.mcs150_mileage),
      mcs150_mileage_year = coalesce(excluded.mcs150_mileage_year, fmcsa_carriers.mcs150_mileage_year),
      cargo = case when cardinality(excluded.cargo) > 0 then excluded.cargo else fmcsa_carriers.cargo end,
      insurance_on_file = excluded.insurance_on_file,
      raw = excluded.raw,
      source_dataset = excluded.source_dataset,
      source_updated_at = now(),
      last_seen_at = now()
    returning id, (xmax = 0) as inserted`,
    [
      carrier.usdotNumber, carrier.docketNumber, carrier.docketPrefix, carrier.legalName, carrier.dbaName, carrier.entityType,
      carrier.carrierOperation, carrier.authorityStatus, carrier.usdotStatus, carrier.allowedToOperate,
      carrier.physicalStreet, carrier.physicalCity, carrier.physicalState, carrier.physicalZip,
      carrier.mailingStreet, carrier.mailingCity, carrier.mailingState, carrier.mailingZip,
      carrier.phone, carrier.email, carrier.powerUnits, carrier.drivers, carrier.mcs150Date, carrier.mcs150Mileage, carrier.mcs150MileageYear,
      carrier.cargo, carrier.insuranceOnFile, carrier.raw, `${source}:${datasetId}`
    ]
  );
  return { carrierId: Number(result.rows[0].id), inserted: result.rows[0].inserted };
}

async function upsertLead(client: PoolClient, carrierId: number, carrier: NormalizedCarrier): Promise<void> {
  const score = scoreCarrier(carrier);
  await client.query(
    `insert into insurance_leads (
      carrier_id, usdot_number, lead_grade, lead_score, commercial_pnc_score,
      life_health_score, urgency_score, risk_adjustment, recommended_products,
      outreach_angle, scoring_reasons, scoring_version, applied_rule_ids
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    on conflict (usdot_number) do update set
      carrier_id = excluded.carrier_id,
      lead_grade = excluded.lead_grade,
      lead_score = excluded.lead_score,
      commercial_pnc_score = excluded.commercial_pnc_score,
      life_health_score = excluded.life_health_score,
      urgency_score = excluded.urgency_score,
      risk_adjustment = excluded.risk_adjustment,
      recommended_products = excluded.recommended_products,
      outreach_angle = excluded.outreach_angle,
      scoring_reasons = excluded.scoring_reasons,
      scoring_version = excluded.scoring_version,
      applied_rule_ids = excluded.applied_rule_ids,
      updated_at = now()`,
    [
      carrierId,
      carrier.usdotNumber,
      score.leadGrade,
      score.leadScore,
      score.commercialPncScore,
      score.lifeHealthScore,
      score.urgencyScore,
      score.riskAdjustment,
      score.recommendedProducts,
      score.outreachAngle,
      score.scoringReasons,
      score.scoringVersion,
      score.appliedRuleIds
    ]
  );
}

export async function importFmcsa(source: ImportSource = config.defaultImportSource, limit = config.importLimit): Promise<ImportResult> {
  const datasetId = datasetForSource(source);
  const runId = await startRun(source, datasetId, limit);
  let fetchedCount = 0;
  let normalizedCount = 0;
  let insertedCount = 0;
  let updatedCount = 0;
  let leadCount = 0;

  try {
    const records = await fetchSocrataRecords(source, limit);
    fetchedCount = records.length;
    const carriers = records.map(normalizeCarrier).filter((item): item is NormalizedCarrier => item !== null);
    normalizedCount = carriers.length;

    await withTransaction(async (client) => {
      for (const carrier of carriers) {
        const saved = await upsertCarrier(client, carrier, source, datasetId);
        if (saved.inserted) insertedCount += 1;
        else updatedCount += 1;
        await upsertLead(client, saved.carrierId, carrier);
        await upsertCarrierOpportunity(client, saved.carrierId, carrier, saved.inserted);
        await upsertCarrierSafetyProfile(client, saved.carrierId, carrier as unknown as Record<string, unknown>);
        leadCount += 1;
      }
    });

    const result = { runId, source, datasetId, fetchedCount, normalizedCount, insertedCount, updatedCount, leadCount };
    await finishRun(runId, result);
    return result;
  } catch (error) {
    await finishRun(runId, { fetchedCount, insertedCount, updatedCount, leadCount }, error);
    throw error;
  }
}

export async function refreshScores(): Promise<{ refreshed: number }> {
  const carriers = await query<{
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

  await withTransaction(async (client) => {
    for (const row of carriers.rows) {
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
        raw: row.raw ?? {}
      };
      await upsertLead(client, Number(row.id), carrier);
      await upsertCarrierOpportunity(client, Number(row.id), carrier, false);
      await upsertCarrierSafetyProfile(client, Number(row.id), row as unknown as Record<string, unknown>);
    }
  });

  return { refreshed: carriers.rowCount ?? 0 };
}
