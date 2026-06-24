import dotenv from 'dotenv';

dotenv.config();

export type ImportSource = 'carrier-daily' | 'carrier-all-history' | 'company-census';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intEnv('PORT', 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  dataHost: 'https://data.transportation.gov',
  datasets: {
    carrierDaily: process.env.FMCSA_CARRIER_DAILY_DATASET ?? '6qg9-x4f8',
    carrierAllHistory: process.env.FMCSA_CARRIER_ALL_HISTORY_DATASET ?? '6eyk-hxee',
    companyCensus: process.env.FMCSA_COMPANY_CENSUS_DATASET ?? 'az4n-8mr2'
  },
  importLimit: intEnv('FMCSA_IMPORT_LIMIT', 5000),
  defaultImportSource: (process.env.FMCSA_IMPORT_SOURCE as ImportSource | undefined) ?? 'carrier-daily',
  defaultAgencyId: process.env.DEFAULT_AGENCY_ID ?? 'invicta-capital-group',
  arkonWebhookUrl: process.env.ARKON_WEBHOOK_URL ?? '',
  arkonWebhookSecret: process.env.ARKON_WEBHOOK_SECRET ?? '',
  googleSheetsWebhookUrl: process.env.GOOGLE_SHEETS_WEBHOOK_URL ?? '',
  googleSheetsWebhookSecret: process.env.GOOGLE_SHEETS_WEBHOOK_SECRET ?? ''
};

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required.');
  return config.databaseUrl;
}

export function datasetForSource(source: ImportSource): string {
  if (source === 'carrier-all-history') return config.datasets.carrierAllHistory;
  if (source === 'company-census') return config.datasets.companyCensus;
  return config.datasets.carrierDaily;
}
