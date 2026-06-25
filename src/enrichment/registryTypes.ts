export type RegistrySourceStatus = 'ACTIVE' | 'NEEDS_CONFIGURATION' | 'DISABLED';

export type RegisteredAgentType = 'PERSON' | 'SERVICE' | 'UNKNOWN';

export type PersonalizationMode = 'DECISION_MAKER' | 'REGISTERED_AGENT_CLUE' | 'COMPANY_ONLY' | 'UNQUALIFIED';

export interface StateRegistryRecordInput {
  stateCode: string;
  sourceName: string;
  searchName?: string | null;
  carrierId?: number | null;
  usdotNumber?: string | null;
  legalName?: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedRegistryRecord {
  matchedName: string | null;
  entityId: string | null;
  entityStatus: string | null;
  rightToTransact: string | null;
  registeredOfficeStreet: string | null;
  registeredOfficeCity: string | null;
  registeredOfficeState: string | null;
  registeredOfficeZip: string | null;
  registeredAgentName: string | null;
  registeredAgentType: RegisteredAgentType;
  registeredAgentAddress: string | null;
  officers: ParsedRegistryOfficer[];
  raw: Record<string, unknown>;
}

export interface ParsedRegistryOfficer {
  name: string;
  title: string | null;
  source: string;
  confidence: number;
  priorityRank: number;
  raw: Record<string, unknown>;
}

export interface EnrichmentResult {
  carrierId: number;
  usdotNumber: string | null;
  companyName: string | null;
  registryMatchId: number;
  stateCode: string;
  sourceName: string;
  decisionMakerName: string | null;
  decisionMakerTitle: string | null;
  decisionMakerConfidence: number | null;
  personalizationMode: PersonalizationMode;
  salesReady: boolean;
  salesReadyReason: string;
}

export interface EnrichmentRunResult {
  ok: true;
  sourceName: string;
  stateCode: string;
  attempted: number;
  enriched: number;
  skipped: number;
  results: EnrichmentResult[];
  warnings: string[];
}
