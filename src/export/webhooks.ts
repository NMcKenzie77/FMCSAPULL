import { config } from '../config.js';
import { query } from '../db.js';
import type { CarrierSafetyProfile } from '../safety/profile.js';

export interface LeadExportRow {
  id: string;
  usdot_number: string;
  lead_grade: string;
  lead_score: number;
  lead_status: string;
  scoring_version: string;
  applied_rule_ids: string[];
  scoring_reasons: string[];
  recommended_products: string[];
  outreach_angle: string | null;
  sales_ready: boolean;
  sales_ready_reason: string | null;
  hq_name: string | null;
  hq_street: string | null;
  hq_city: string | null;
  hq_state: string | null;
  hq_zip: string | null;
  hq_country: string | null;
  hq_source: string | null;
  hq_confidence: number | null;
  registered_agent_name: string | null;
  registered_agent_type: string | null;
  registered_agent_address: string | null;
  officer_name: string | null;
  officer_title: string | null;
  officer_source: string | null;
  decision_maker_name: string | null;
  decision_maker_title: string | null;
  decision_maker_email: string | null;
  decision_maker_phone: string | null;
  decision_maker_source: string | null;
  decision_maker_confidence: number | null;
  personalization_name: string | null;
  personalization_mode: string;
  legal_name: string | null;
  dba_name: string | null;
  docket_number: string | null;
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
  cargo: string[] | null;
  carrierSafetyProfile: CarrierSafetyProfile | null;
  carrier_safety_profile: CarrierSafetyProfile | null;
}

const activeCarrierSql = `
       and upper(coalesce(c.authority_status, '')) not like '%INACTIVE%'
       and upper(coalesce(c.authority_status, '')) not like '%REVOKED%'
       and upper(coalesce(c.authority_status, '')) not like '%DISMISSED%'
       and upper(coalesce(c.authority_status, '')) not like '%OUT OF SERVICE%'
       and upper(coalesce(c.usdot_status, '')) not like '%INACTIVE%'
       and upper(coalesce(c.usdot_status, '')) not like '%REVOKED%'
       and upper(coalesce(c.usdot_status, '')) not like '%DISMISSED%'
       and upper(coalesce(c.usdot_status, '')) not like '%OUT OF SERVICE%'`;

async function postJson(url: string, apiKey: string, payload: unknown): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-fmcsapull-secret': apiKey } : {})
    },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.text() };
}

export async function getTopLeads(limit = 100, minGrade = 'B', qualityGate = false): Promise<LeadExportRow[]> {
  const gradeRank: Record<string, number> = { 'A+': 5, A: 4, B: 3, C: 2, SKIP: 1 };
  const minRank = gradeRank[minGrade] ?? 3;
  const qualityGateSql = qualityGate ? 'and l.sales_ready = true' : '';
  const result = await query<LeadExportRow & { carrier_safety_profile: CarrierSafetyProfile | null }>(
    `select
       l.id, l.usdot_number, l.lead_grade, l.lead_score, l.lead_status,
       l.scoring_version, l.applied_rule_ids, l.scoring_reasons,
       l.recommended_products, l.outreach_angle,
       l.sales_ready, l.sales_ready_reason,
       l.hq_name, l.hq_street, l.hq_city, l.hq_state, l.hq_zip, l.hq_country, l.hq_source, l.hq_confidence,
       l.registered_agent_name, l.registered_agent_type, l.registered_agent_address,
       l.officer_name, l.officer_title, l.officer_source,
       l.decision_maker_name, l.decision_maker_title, l.decision_maker_email, l.decision_maker_phone,
       l.decision_maker_source, l.decision_maker_confidence,
       l.personalization_name, l.personalization_mode,
       c.legal_name, c.dba_name, c.docket_number,
       c.entity_type, c.carrier_operation, c.authority_status,
       c.usdot_status, c.allowed_to_operate,
       c.physical_street, c.physical_city, c.physical_state, c.physical_zip,
       c.mailing_street, c.mailing_city, c.mailing_state, c.mailing_zip,
       c.phone, c.email, c.power_units, c.drivers, c.cargo,
       sp.profile_json as carrier_safety_profile
     from insurance_leads l
     join fmcsa_carriers c on c.id = l.carrier_id
     left join carrier_safety_profiles sp on sp.carrier_id = c.id
     where case l.lead_grade when 'A+' then 5 when 'A' then 4 when 'B' then 3 when 'C' then 2 else 1 end >= $1
       ${qualityGateSql}
       ${activeCarrierSql}
     order by l.lead_score desc, l.updated_at desc
     limit $2`,
    [minRank, limit]
  );
  return result.rows.map((row) => ({
    ...row,
    carrierSafetyProfile: row.carrier_safety_profile ?? null,
  }));
}

export async function exportToArkon(limit = 100, minGrade = 'B'): Promise<{ sent: number; skipped: boolean; agencyId?: string; qualityGate: boolean }> {
  if (!config.arkonWebhookUrl) return { sent: 0, skipped: true, qualityGate: true };
  const leads = await getTopLeads(limit, minGrade, true);
  const payload = {
    agencyId: config.defaultAgencyId,
    source: 'COMMERCIAL_PNC_LEAD_ENGINE',
    leadType: 'COMMERCIAL_PNC_LEAD',
    qualityGate: true,
    leads
  };
  const response = await postJson(config.arkonWebhookUrl, config.arkonWebhookSecret, payload);
  await query(`update insurance_leads set exported_to_arkon_at = now() where id = any($1::bigint[])`, [leads.map((lead) => lead.id)]);
  if (response.status < 200 || response.status >= 300) throw new Error('ARKON export failed');
  return { sent: leads.length, skipped: false, agencyId: config.defaultAgencyId, qualityGate: true };
}

export async function exportToSheets(limit = 100, minGrade = 'B'): Promise<{ sent: number; skipped: boolean; qualityGate: boolean }> {
  if (!config.googleSheetsWebhookUrl) return { sent: 0, skipped: true, qualityGate: true };
  const leads = await getTopLeads(limit, minGrade, true);
  const response = await postJson(config.googleSheetsWebhookUrl, config.googleSheetsWebhookSecret, {
    source: 'COMMERCIAL_PNC_LEAD_ENGINE',
    leadType: 'COMMERCIAL_PNC_LEAD',
    qualityGate: true,
    leads
  });
  await query(`update insurance_leads set exported_to_sheets_at = now() where id = any($1::bigint[])`, [leads.map((lead) => lead.id)]);
  if (response.status < 200 || response.status >= 300) throw new Error('Sheets export failed');
  return { sent: leads.length, skipped: false, qualityGate: true };
}
