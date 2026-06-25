import type { ParsedRegistryOfficer, ParsedRegistryRecord, RegisteredAgentType } from './registryTypes.js';

function cleanText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function flattenRecord(value: unknown, output = new Map<string, string>(), prefix = ''): Map<string, string> {
  if (value === undefined || value === null) return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenRecord(item, output, `${prefix}${index}.`));
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const fullKey = prefix ? `${prefix}${key}` : key;
      flattenRecord(child, output, `${fullKey}.`);
      const direct = cleanText(child);
      if (direct && typeof child !== 'object') {
        output.set(normalizeKey(key), direct);
        output.set(normalizeKey(fullKey), direct);
      }
    }
    return output;
  }
  const direct = cleanText(value);
  if (direct && prefix) output.set(normalizeKey(prefix.replace(/\.$/, '')), direct);
  return output;
}

function getFirst(flat: Map<string, string>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = flat.get(normalizeKey(alias));
    if (value) return value;
  }
  return null;
}

function buildAddress(parts: Array<string | null>): string | null {
  const cleaned = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return cleaned.length ? cleaned.join(', ') : null;
}

function isLikelyServiceCompany(name: string | null): boolean {
  if (!name) return false;
  const text = name.toLowerCase();
  return [
    'registered agent', 'corp service', 'corporation service', 'ct corporation', 'incorp services',
    'northwest registered', 'national registered', 'legalinc', 'law firm', 'law office',
    'attorney', 'cpa', 'tax service', 'llc', 'inc', 'corp', 'corporation', 'company', 'co.'
  ].some((needle) => text.includes(needle));
}

function detectRegisteredAgentType(name: string | null): RegisteredAgentType {
  if (!name) return 'UNKNOWN';
  if (isLikelyServiceCompany(name)) return 'SERVICE';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 4) return 'PERSON';
  return 'UNKNOWN';
}

function rankTitle(title: string | null, source: string): { confidence: number; priorityRank: number } {
  const text = `${title ?? ''} ${source}`.toLowerCase();
  if (/(owner|president|chief executive|ceo|managing member|principal)/.test(text)) {
    return { confidence: 95, priorityRank: 1 };
  }
  if (/(member|manager|managing partner|partner)/.test(text)) {
    return { confidence: 84, priorityRank: 2 };
  }
  if (/(officer|director|governor|treasurer|secretary|vice president|vp)/.test(text)) {
    return { confidence: 74, priorityRank: 3 };
  }
  if (/registered agent/.test(text)) {
    return { confidence: 55, priorityRank: 5 };
  }
  return { confidence: 62, priorityRank: 4 };
}

function findCandidateObjects(value: unknown, keyHint = '', output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    const usefulArray = /(officer|director|govern|member|manager|partner|principal|person|contact)/i.test(keyHint);
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        if (usefulArray) output.push(item as Record<string, unknown>);
        findCandidateObjects(item, keyHint, output);
      }
    }
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child && typeof child === 'object') findCandidateObjects(child, key, output);
  }
  return output;
}

function parseOfficerObject(raw: Record<string, unknown>, source: string): ParsedRegistryOfficer | null {
  const flat = flattenRecord(raw);
  const name = getFirst(flat, [
    'name', 'person_name', 'personName', 'officer_name', 'officerName', 'governing_person_name',
    'governingPersonName', 'manager_name', 'member_name', 'principal_name', 'full_name', 'fullName'
  ]);
  if (!name || isLikelyServiceCompany(name)) return null;
  const title = getFirst(flat, [
    'title', 'office', 'role', 'position', 'capacity', 'officer_title', 'officerTitle',
    'governing_person_title', 'governingPersonTitle', 'relationship'
  ]);
  const ranked = rankTitle(title, source);
  return { name, title, source, confidence: ranked.confidence, priorityRank: ranked.priorityRank, raw };
}

function uniqueOfficers(officers: ParsedRegistryOfficer[]): ParsedRegistryOfficer[] {
  const seen = new Set<string>();
  const output: ParsedRegistryOfficer[] = [];
  for (const officer of officers) {
    const key = `${officer.name.toLowerCase()}|${officer.title ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(officer);
  }
  return output.sort((a, b) => a.priorityRank - b.priorityRank || b.confidence - a.confidence);
}

export function parseRegistryRecord(raw: Record<string, unknown>): ParsedRegistryRecord {
  const flat = flattenRecord(raw);
  const officeStreet = getFirst(flat, [
    'registered_office_street', 'registeredOfficeStreet', 'registered_address_street', 'registeredAddressStreet',
    'principal_office_street', 'principalOfficeStreet', 'office_address_street', 'officeAddressStreet',
    'registered_office_address1', 'registeredOfficeAddress1', 'address1', 'street', 'street_address'
  ]);
  const officeCity = getFirst(flat, [
    'registered_office_city', 'registeredOfficeCity', 'registered_address_city', 'registeredAddressCity',
    'principal_office_city', 'principalOfficeCity', 'office_city', 'city'
  ]);
  const officeState = getFirst(flat, [
    'registered_office_state', 'registeredOfficeState', 'registered_address_state', 'registeredAddressState',
    'principal_office_state', 'principalOfficeState', 'office_state', 'state'
  ]);
  const officeZip = getFirst(flat, [
    'registered_office_zip', 'registeredOfficeZip', 'registered_address_zip', 'registeredAddressZip',
    'principal_office_zip', 'principalOfficeZip', 'office_zip', 'zip', 'postal_code', 'postalCode'
  ]);
  const agentName = getFirst(flat, [
    'registered_agent_name', 'registeredAgentName', 'agent_name', 'agentName', 'registered_agent',
    'registeredAgent', 'ra_name', 'raName'
  ]);
  const registeredAgentAddress = buildAddress([
    getFirst(flat, ['registered_agent_street', 'registeredAgentStreet', 'agent_street', 'agentStreet', 'ra_street', 'raStreet']),
    getFirst(flat, ['registered_agent_city', 'registeredAgentCity', 'agent_city', 'agentCity', 'ra_city', 'raCity']),
    getFirst(flat, ['registered_agent_state', 'registeredAgentState', 'agent_state', 'agentState', 'ra_state', 'raState']),
    getFirst(flat, ['registered_agent_zip', 'registeredAgentZip', 'agent_zip', 'agentZip', 'ra_zip', 'raZip'])
  ]);

  const directOfficer = parseOfficerObject(raw, 'registry_officer');
  const nestedOfficers = findCandidateObjects(raw)
    .map((item) => parseOfficerObject(item, 'registry_officer'))
    .filter((item): item is ParsedRegistryOfficer => item !== null);
  const officers = uniqueOfficers([...(directOfficer ? [directOfficer] : []), ...nestedOfficers]);

  const agentType = detectRegisteredAgentType(agentName);
  if (agentName && agentType === 'PERSON') {
    const ranked = rankTitle('Registered Agent', 'registered_agent');
    officers.push({
      name: agentName,
      title: 'Registered Agent',
      source: 'registered_agent',
      confidence: ranked.confidence,
      priorityRank: ranked.priorityRank,
      raw: { name: agentName, address: registeredAgentAddress }
    });
  }

  return {
    matchedName: getFirst(flat, ['legal_name', 'legalName', 'taxpayer_name', 'taxpayerName', 'entity_name', 'entityName', 'name', 'business_name', 'businessName']),
    entityId: getFirst(flat, ['entity_id', 'entityId', 'taxpayer_number', 'taxpayerNumber', 'file_number', 'fileNumber', 'sos_number', 'sosNumber']),
    entityStatus: getFirst(flat, ['status', 'entity_status', 'entityStatus', 'sos_status', 'sosStatus', 'taxpayer_status', 'taxpayerStatus']),
    rightToTransact: getFirst(flat, ['right_to_transact', 'rightToTransact', 'franchise_tax_eligibility', 'franchiseTaxEligibility', 'active_right_to_transact']),
    registeredOfficeStreet: officeStreet,
    registeredOfficeCity: officeCity,
    registeredOfficeState: officeState,
    registeredOfficeZip: officeZip,
    registeredAgentName: agentName,
    registeredAgentType: agentType,
    registeredAgentAddress,
    officers: uniqueOfficers(officers),
    raw
  };
}
