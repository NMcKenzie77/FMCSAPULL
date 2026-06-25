import dotenv from 'dotenv';

dotenv.config();

export type ImportSource = 'carrier-daily' | 'carrier-all-history' | 'company-census';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function env(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

const TEXAS_PUBLIC_DATA_BASE_URL = 'https://api.comptroller.texas.gov/public-data/v1/public';

export const config = {
  port: intEnv('PORT', 3000),
  databaseUrl: env('DATABASE_URL'),
  adminApiKey: env('ADMIN_API_KEY'),
  dataHost: 'https://data.transportation.gov',
  datasets: {
    carrierDaily: env('FMCSA_CARRIER_DAILY_DATASET', '6qg9-x4f8'),
    carrierAllHistory: env('FMCSA_CARRIER_ALL_HISTORY_DATASET', '6eyk-hxee'),
    companyCensus: env('FMCSA_COMPANY_CENSUS_DATASET', 'az4n-8mr2')
  },
  importLimit: intEnv('FMCSA_IMPORT_LIMIT', 5000),
  defaultImportSource: (process.env.FMCSA_IMPORT_SOURCE as ImportSource | undefined) ?? 'carrier-daily',
  defaultAgencyId: env('DEFAULT_AGENCY_ID', 'invicta-capital-group'),
  arkonWebhookUrl: env('ARKON_WEBHOOK_URL'),
  arkonWebhookSecret: env('ARKON_WEBHOOK_SECRET'),
  googleSheetsWebhookUrl: env('GOOGLE_SHEETS_WEBHOOK_URL'),
  googleSheetsWebhookSecret: env('GOOGLE_SHEETS_WEBHOOK_SECRET'),

  // Texas Comptroller public-data API.
  // Preferred: set TX_COMPTROLLER_API_KEY only. The official base URL is the default below.
  // Optional override is here for testing or if Texas changes the public-data host.
  txComptrollerApiKey: env('TX_COMPTROLLER_API_KEY'),
  txComptrollerApiBaseUrl: env('TX_COMPTROLLER_API_BASE_URL', env('TX_COMPTROLLER_API_URL', TEXAS_PUBLIC_DATA_BASE_URL)),
  texasEnrichmentLimit: intEnv('TX_ENRICHMENT_LIMIT', 25),

  // Reserved for future official/state adapters. These are not used until the adapter for that state is implemented.
  // Most states do not publish a simple public API key flow; several are search-page or bulk-download sources.
  stateRegistryApiKeys: {
    fl: env('FL_SUNBIZ_API_KEY'),
    ga: env('GA_CORPORATIONS_API_KEY'),
    nc: env('NC_SECRETARY_OF_STATE_API_KEY'),
    az: env('AZ_CORPORATION_COMMISSION_API_KEY'),
    tn: env('TN_SECRETARY_OF_STATE_API_KEY')
  }
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
