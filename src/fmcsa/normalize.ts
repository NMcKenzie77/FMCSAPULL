import type { SocrataRecord } from './socrata.js';

export interface NormalizedCarrier {
  usdotNumber: string;
  docketNumber: string | null;
  docketPrefix: string | null;
  legalName: string | null;
  dbaName: string | null;
  entityType: string | null;
  carrierOperation: string | null;
  authorityStatus: string | null;
  usdotStatus: string | null;
  allowedToOperate: string | null;
  physicalStreet: string | null;
  physicalCity: string | null;
  physicalState: string | null;
  physicalZip: string | null;
  mailingStreet: string | null;
  mailingCity: string | null;
  mailingState: string | null;
  mailingZip: string | null;
  phone: string | null;
  email: string | null;
  powerUnits: number | null;
  drivers: number | null;
  mcs150Date: string | null;
  mcs150Mileage: number | null;
  mcs150MileageYear: number | null;
  cargo: string[];
  insuranceOnFile: Record<string, unknown>;
  raw: SocrataRecord;
}

const cargoAliases: Array<[string, string[]]> = [
  ['General Freight', ['genfreight', 'general_freight']],
  ['Household Goods', ['household_goods', 'hhg']],
  ['Motor Vehicles', ['motor_vehicles', 'motor_vehicle']],
  ['Building Materials', ['building_materials']],
  ['Machinery / Large Objects', ['machinery_large_objects', 'machinery']],
  ['Fresh Produce', ['fresh_produce']],
  ['Refrigerated Food', ['refrigerated_food', 'cold_food']],
  ['Intermodal Containers', ['intermodal_containers', 'intermodal_cont']],
  ['Livestock', ['livestock']],
  ['Grain / Feed / Hay', ['grain_feed_hay']],
  ['Meat', ['meat']],
  ['Dry Bulk', ['dry_bulk', 'commodities_dry_bulk']],
  ['Beverages', ['beverages']],
  ['Paper Products', ['paper_products']],
  ['Farm Supplies', ['farm_supplies', 'agricultural_farm_supplies']],
  ['Construction', ['construction']],
  ['Other', ['other_cargo', 'other']]
];

function get(record: SocrataRecord, aliases: string[]): unknown {
  for (const alias of aliases) {
    const value = record[alias];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function str(record: SocrataRecord, aliases: string[]): string | null {
  const value = get(record, aliases);
  if (value === null) return null;
  const cleaned = String(value).trim();
  return cleaned.length ? cleaned : null;
}

function int(record: SocrataRecord, aliases: string[]): number | null {
  const value = get(record, aliases);
  if (value === null) return null;
  const parsed = Number.parseInt(String(value).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function date(record: SocrataRecord, aliases: string[]): string | null {
  const value = str(record, aliases);
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function yes(value: unknown): boolean {
  if (value === true) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['y', 'yes', 'true', 't', '1', 'x'].includes(normalized);
}

function detectCargo(record: SocrataRecord): string[] {
  const directCargo = str(record, ['cargo_carried', 'cargo', 'cargo_classifications']);
  const cargo = new Set<string>();

  if (directCargo) {
    directCargo.split(/[;,|]/).map((item) => item.trim()).filter(Boolean).forEach((item) => cargo.add(item));
  }

  for (const [label, aliases] of cargoAliases) {
    if (aliases.some((alias) => yes(record[alias]))) cargo.add(label);
  }

  return [...cargo];
}

function insurance(record: SocrataRecord): Record<string, unknown> {
  const keys = [
    'bipd_required', 'bipd_on_file', 'bipd_file', 'bipd_underlying_limit', 'bipd_max_limit',
    'cargo_required', 'cargo_on_file', 'cargo_file', 'bond_required', 'bond_on_file',
    'insurance_required', 'insurance_on_file', 'insurance_company_name', 'policy_number', 'policy_type',
    'op_auth_type', 'op_auth_status', 'common_stat', 'contract_stat', 'broker_stat'
  ];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') output[key] = value;
  }
  return output;
}

export function normalizeCarrier(record: SocrataRecord): NormalizedCarrier | null {
  const usdotNumber = str(record, ['dot_number', 'usdot_number', 'usdot', 'usdot_no', 'dot_no']);
  if (!usdotNumber) return null;

  return {
    usdotNumber,
    docketNumber: str(record, ['docket_number', 'mc_mx_ff_number', 'mc_number', 'mx_number', 'docket_no']),
    docketPrefix: str(record, ['docket_prefix', 'prefix', 'mx_type']),
    legalName: str(record, ['legal_name', 'carrier_name', 'name', 'business_name']),
    dbaName: str(record, ['dba_name', 'doing_business_as', 'dba']),
    entityType: str(record, ['entity_type', 'entity', 'entity_type_desc']),
    carrierOperation: str(record, ['carrier_operation', 'carrier_operation_desc', 'operation_classification']),
    authorityStatus: str(record, ['op_auth_status', 'authority_status', 'common_authority_status', 'contract_authority_status', 'common_stat', 'contract_stat', 'broker_stat', 'status', 'auth_status']),
    usdotStatus: str(record, ['usdot_status', 'status_code', 'dot_status']),
    allowedToOperate: str(record, ['allowed_to_operate', 'allowed_to_operate_desc']),
    physicalStreet: str(record, ['phy_street', 'physical_street', 'physical_address', 'street']),
    physicalCity: str(record, ['phy_city', 'physical_city', 'city']),
    physicalState: str(record, ['phy_state', 'physical_state', 'state']),
    physicalZip: str(record, ['phy_zip', 'physical_zip', 'zip']),
    mailingStreet: str(record, ['mailing_street', 'mail_street', 'mailing_address']),
    mailingCity: str(record, ['mailing_city', 'mail_city']),
    mailingState: str(record, ['mailing_state', 'mail_state']),
    mailingZip: str(record, ['mailing_zip', 'mail_zip']),
    phone: str(record, ['telephone', 'phone', 'phone_number']),
    email: str(record, ['email_address', 'email']),
    powerUnits: int(record, ['nbr_power_unit', 'power_units', 'number_of_power_units', 'pu']),
    drivers: int(record, ['driver_total', 'drivers', 'total_drivers']),
    mcs150Date: date(record, ['mcs150_date', 'mcs_150_date', 'form_date']),
    mcs150Mileage: int(record, ['mcs150_mileage', 'mcs_150_mileage', 'mileage']),
    mcs150MileageYear: int(record, ['mcs150_mileage_year', 'mcs_150_mileage_year', 'mileage_year']),
    cargo: detectCargo(record),
    insuranceOnFile: insurance(record),
    raw: record
  };
}
