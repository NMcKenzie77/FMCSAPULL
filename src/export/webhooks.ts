import { config } from '../config.js';
import { query } from '../db.js';

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
  legal_name: string | null;
  dba_name: string | null;
  docket_number: string | null;
  physical_city: string | null;
  physical_state: string | null;
  physical_zip: string | null;
  phone: string | null;
  email: string | null;
  power_units: number | null;
  drivers: number | null;
  cargo: string[] | null;
}

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

export async function getTopLeads(limit = 100, minGrade = 'B'): Promise<LeadExportRow[]> {
  const gradeRank: Record<string, number> = { 'A+': 5, A: 4, B: 3, C: 2, SKIP: 1 };
  const minRank = gradeRank[minGrade] ?? 3;
  const result = await query<LeadExportRow>(
    `select
       l.id, l.usdot_number, l.lead_grade, l.lead_score, l.lead_status,
       l.scoring_version, l.applied_rule_ids, l.scoring_reasons,
       l.recommended_products, l.outreach_angle,
       c.legal_name, c.dba_name, c.docket_number,
       c.physical_city, c.physical_state, c.physical_zip,
       c.phone, c.email, c.power_units, c.drivers, c.cargo
     from insurance_leads l
     join fmcsa_carriers c on c.id = l.carrier_id
     where case l.lead_grade when 'A+' then 5 when 'A' then 4 when 'B' then 3 when 'C' then 2 else 1 end >= $1
     order by l.lead_score desc, l.updated_at desc
     limit $2`,
    [minRank, limit]
  );
  return result.rows;
}

export async function exportToArkon(limit = 100, minGrade = 'B'): Promise<{ sent: number; skipped: boolean; agencyId?: string }> {
  if (!config.arkonWebhookUrl) return { sent: 0, skipped: true };
  const leads = await getTopLeads(limit, minGrade);
  const payload = {
    agencyId: config.defaultAgencyId,
    source: 'FMCSA_DATAHUB',
    leadType: 'TRUCKING_PNC_INSURANCE',
    leads
  };
  const response = await postJson(config.arkonWebhookUrl, config.arkonWebhookSecret, payload);
  await query(`update insurance_leads set exported_to_arkon_at = now() where id = any($1::bigint[])`, [leads.map((lead) => lead.id)]);
  if (response.status < 200 || response.status >= 300) throw new Error('ARKON export failed');
  return { sent: leads.length, skipped: false, agencyId: config.defaultAgencyId };
}

export async function exportToSheets(limit = 100, minGrade = 'B'): Promise<{ sent: number; skipped: boolean }> {
  if (!config.googleSheetsWebhookUrl) return { sent: 0, skipped: true };
  const leads = await getTopLeads(limit, minGrade);
  const response = await postJson(config.googleSheetsWebhookUrl, config.googleSheetsWebhookSecret, {
    source: 'FMCSA_DATAHUB',
    leadType: 'TRUCKING_PNC_INSURANCE',
    leads
  });
  await query(`update insurance_leads set exported_to_sheets_at = now() where id = any($1::bigint[])`, [leads.map((lead) => lead.id)]);
  if (response.status < 200 || response.status >= 300) throw new Error('Sheets export failed');
  return { sent: leads.length, skipped: false };
}
