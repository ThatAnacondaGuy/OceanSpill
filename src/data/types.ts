import type { LatLon } from '../lib/geo';

/** Where a piece of data came from. Shown next to every value an analyst might act on. */
export type Provenance = 'real' | 'synthetic' | 'modelled' | 'pending' | 'session';

export type RiskTier = 'HIGH' | 'MEDIUM' | 'LOW';

export type CaseStatus =
  | 'New'
  | 'Under Analysis'
  | 'Attributed'
  | 'Verification Dispatched'
  | 'Verified'
  | 'Enforcement'
  | 'Closed'
  | 'Dismissed — Look-alike';

export type WorkflowStage =
  | 'Awaiting Dispatch'
  | 'Patrol En Route'
  | 'Sample Collected'
  | 'Forensic Match Pending'
  | 'Port Inspection Requested'
  | 'Closed';

export type SourceType = 'vessel' | 'facility' | 'pipeline' | 'unknown';
export type TimePrecision = 'minute' | 'hour' | 'day' | 'month' | 'year';

// ---------------------------------------------------------------------------------------------
// Pipeline artifacts (public/data). These mirror the JSON written by pipeline/src/oceanspill/build.py.
// ---------------------------------------------------------------------------------------------

export interface AnchorFact {
  time: string;
  event: string;
  lat: number;
  lon: number;
  positionPrecisionKm: number;
  sog?: number;
  cog?: number;
  navStatus?: number;
  source: string;
  after?: 'sunk' | 'stationary';
}

export interface ObservationFact {
  time: string;
  type: string;
  description: string;
  lat?: number;
  lon?: number;
  extentKm2: number | null;
  lengthKm?: number;
  source: string;
}

export interface CaseFacts {
  id: string;
  title: string;
  region: string;
  subRegion: string;
  sourceType: SourceType;
  officiallyConfirmed: boolean;
  incident: {
    time: string;
    timePrecision: TimePrecision;
    timeNote?: string;
    position: LatLon;
    positionPrecisionKm: number;
    positionSource: string;
  };
  oil: {
    modelType: string;
    onboard: { product: string; tonnes?: number; cubicMetres?: number; note?: string }[];
    spilledTonnes: number | null;
    spilledNote?: string;
  };
  observations: ObservationFact[];
  timeline: { time: string; event: string; timePrecision?: TimePrecision }[];
  response: string[];
  impact: Record<string, number>;
  officialFindings: string;
  legal?: LegalFact[];
  sources: { title: string; url: string }[];
}

export interface SceneArtifact {
  id: string;
  name: string;
  platform: string;
  mode: string;
  productType: string;
  collection: string;
  start: number;
  end: number;
  orbitDirection: string | null;
  online: boolean;
  provider: 'cdse' | 'bhoonidhi';
  sizeBytes: number | null;
  footprint: LatLon[];
  coversIncident: boolean;
}

export interface VesselArtifact {
  key: string;
  name: string;
  type: string;
  role: VesselRole;
  provenance: 'real' | 'synthetic';
  mmsi: string | null;
  imo: string | null;
  flag: string | null;
  operator: string | null;
  isFacility: boolean;
  registry: {
    verified: boolean;
    synthetic?: boolean;
    flagRisk?: FlagRisk;
    priorOffences?: number;
    sanctioned?: boolean;
    pscDetentions?: number;
    note?: string;
    source?: string;
    details?: Record<string, string | number>;
    gfw?: Record<string, string | number | boolean | null>;
  };
  anchors: AnchorFact[];
  note: string | null;
}

export interface TrackArtifact {
  key: string;
  provenance: 'synthetic-anchored' | 'synthetic' | 'facility-position' | 'real';
  notes: string[];
  gaps: TrackGap[];
  /** [secondsFromWindowStart, lat, lon, sogKn, cogDeg, headingDeg, navStatus] */
  pings: [number, number, number, number, number, number, number][];
}

export interface ProviderEntry {
  name: string;
  agency: string;
  sovereign: boolean;
  ok: boolean;
  message: string;
  count: number;
}

export interface SarSpot {
  areaKm2: number;
  meanDb: number;
  backgroundDb: number;
  contrastDb: number;
  centroid: LatLon;
  distanceKm: number;
  elongation: number;
  orientationDeg: number;
  outline: LatLon[];
}

/** Output of `oceanspill process`: calibrated scene analysed with the classical dark-spot detector. */
export interface SarMeasurement {
  schemaVersion: 1;
  caseId: string;
  scene: string;
  product?: string;
  radiometry?: string;
  processedAt: string;
  polarisation: string;
  method: string;
  parameters: Record<string, number>;
  crop: { corners: LatLon[]; shape: [number, number] };
  incidenceDeg: number;
  sea: { meanDb: number | null; stdDb: number | null; pixels: number };
  quicklook: string;
  spots: SarSpot[];
  limitations: string[];
}

export interface CaseArtifact {
  schemaVersion: 1;
  generatedAt: string;
  case: CaseFacts;
  reference: { time: number; basis: string; hindcastHours: number; forecastHours: number };
  reportedGeometry: {
    ring: LatLon[];
    basis: string;
    assumptions: string[];
    observationTime: string;
    observationSource: string;
    extentReported: boolean;
  };
  sar: {
    window: { start: number; end: number };
    bbox: { west: number; south: number; east: number; north: number };
    providers: ProviderEntry[];
    scenes: SceneArtifact[];
  };
  forcing: {
    file: string;
    provider: string;
    sources: Record<string, string>;
    coverage: { wind: number; current: number; waves: number };
    window: { start: number; end: number };
  } | null;
  ais: { provider: string; agency: string; window: { start: number; end: number }; pingFormat: string[] };
  vessels: VesselArtifact[];
  tracks: TrackArtifact[];
  sanctions: { key: string; name: string; imo: string | null; listed: boolean; list: string; reference: string | null; checkedAt: string }[];
  sarMeasurements?: SarMeasurement[];
  windCatalog?: {
    provider: string;
    collection: string;
    description: string;
    products: { id: string; collection: string; date: string | null; online: boolean }[];
    online: number;
  } | null;
  warnings: string[];
}

export interface ForcingArtifact {
  lats: number[];
  lons: number[];
  times: number[];
  hourStep: number;
  shape: [number, number, number];
  wind: { u: (number | null)[]; v: (number | null)[] };
  current: { u: (number | null)[]; v: (number | null)[] };
  waveHs: (number | null)[];
  sources: Record<string, string>;
  coverage: { wind: number; current: number; waves: number };
}

export interface HistoricalIncident {
  id: string;
  date: string;
  name: string;
  location: string;
  lat: number | null;
  lon: number | null;
  positionPrecisionKm: number | null;
  oil: string | null;
  tonnes: number | null;
  tonnesNote?: string;
  cause: string | null;
  activeCaseId?: string;
  source: string;
  legal?: LegalFact[];
}

export interface LegalFact {
  authority: string;
  action: string;
  amountInr?: number;
  party: string;
  note?: string;
  source?: string;
}

export interface IndexArtifact {
  schemaVersion: 1;
  generatedAt: string;
  providers: { kind: string; name: string; agency: string; sovereign: boolean; available: boolean; message: string }[];
  cases: { id: string; title: string; region: string; file: string; incidentTime: string; position: LatLon; sourceType: SourceType; sarScenes: number; forcing: boolean; warnings: number }[];
  historical: { note: string; compiled: string; incidents: HistoricalIncident[] };
  failures: { id: string; error: string }[];
}

// ---------------------------------------------------------------------------------------------
// Application model
// ---------------------------------------------------------------------------------------------

export type VesselRole = 'source' | 'involved' | 'responder' | 'background' | 'candidate';
export type FlagRisk = 'Standard' | 'Grey List' | 'Black List';

export interface AisPing {
  t: number;
  lat: number;
  lon: number;
  sog: number;
  cog: number;
  heading: number;
  navStatus: number;
  afterGapMinutes?: number;
}

export interface TrackGap {
  start: number;
  end: number;
  minutes: number;
  distanceKm: number;
  impliedSpeedKn: number;
}

export interface Vessel {
  /** Stable key used everywhere in the app (MMSI-…, IMO-…, REF-…, FAC-…). */
  mmsi: string;
  mmsiNumber: string | null;
  imo: string | null;
  name: string;
  flag: string | null;
  flagRisk: FlagRisk | null;
  type: string;
  operator: string | null;
  role: VesselRole;
  provenance: 'real' | 'synthetic';
  isFacility: boolean;
  /** True only when registry history comes from a verified registry source. */
  registryVerified: boolean;
  priorOffences: number;
  sanctioned: boolean;
  sanctionsChecked: boolean;
  sanctionsList?: string;
  pscDetentions: number | null;
  /** Where verified registry details came from (e.g. a dated manual Equasis lookup). */
  registrySource: string | null;
  registryDetails: Record<string, string | number> | null;
  note: string | null;
  caseId: string;
  anchors: AnchorFact[];
}

export interface VesselTrack {
  mmsi: string;
  provenance: TrackArtifact['provenance'];
  notes: string[];
  pings: AisPing[];
  gaps: TrackGap[];
}

export interface SlickPolygon {
  ring: LatLon[];
  fragments?: LatLon[][];
}

export interface Detection {
  id: string;
  /** Reference time the analysis is anchored to (first reported observation or incident). */
  acquiredAt: number;
  referenceBasis: string;
  /** 'reported' until a SAR scene has been downloaded and segmented. */
  status: 'reported' | 'sar-processed';
  observationSource: string;
  polygon: SlickPolygon;
  geometryBasis: string;
  geometryAssumptions: string[];
  extentReported: boolean;
  /** Wind at the reference time and place from the forcing provider (null if unavailable). */
  windSpeedMs: number | null;
  scenes: SceneArtifact[];
  sarProviders: ProviderEntry[];
  /** Processed scenes (classical dark-spot detector). Empty until scenes are downloaded and processed. */
  sarMeasurements: SarMeasurement[];
  /** The processed dark spot used for the contrast check, if one lies near the incident. */
  sarSpot: (SarSpot & { scene: string }) | null;
  // SAR-derived measurements. Null until segmentation has run on a downloaded scene.
  classProbabilities: { oil: number; lookalike: number; sea: number } | null;
  meanBackscatterDb: number | null;
  backgroundBackscatterDb: number | null;
  modelVersion: string | null;
}

export interface AttributionScore {
  mmsi: string;
  proximity: number;
  temporality: number;
  trajectory: number;
  behaviour: number;
  vesselPrior: number;
  total: number;
  rank: number;
  cpaKm: number;
  cpaTime: number;
  deltaTimeMin: number;
  courseAlignmentDeg: number;
  reasons: string[];
  flags: string[];
  darkDuringWindow: boolean;
  darkMinutes: number;
}

export interface SpillCase {
  id: string;
  title: string;
  facts: CaseFacts;
  detection: Detection;
  region: string;
  subRegion: string;
  sourceType: SourceType;
  status: CaseStatus;
  tier: RiskTier;
  /**
   * Detection confidence. 1.0 for spills officially confirmed by an authority; model probability
   * once SAR segmentation exists. `confidenceBasis` says which.
   */
  confidence: number;
  confidenceBasis: 'official-report' | 'sar-model';
  oilType: string;
  /** Tonnes on board or released, whichever is known, for impact scaling. */
  oilQuantityTonnes: number | null;
  hindcastHours: number;
  forecastHours: number;
  incidentTime: number;
  createdAt: number;
  updatedAt: number;
  assignedTo: string;
  workflowStage: WorkflowStage;
  candidateMmsis: string[];
  notes: string;
  lookalikeReason?: string;
  imacPushed: boolean;
  imacPushedAt?: number;
  alertDispatched: boolean;
  forcingFile: string | null;
  forcingSources: Record<string, string> | null;
  forcingCoverage: { wind: number; current: number; waves: number } | null;
  aisProvider: string;
  aisWindow: { start: number; end: number };
  warnings: string[];
  generatedAt: string;
}

export interface AuditEntry {
  id: string;
  t: number;
  actor: string;
  role: string;
  action: string;
  target: string;
  detail: string;
  category: 'Detection' | 'Analysis' | 'Attribution' | 'Dispatch' | 'Enforcement' | 'System' | 'Access' | 'Alert';
  provenance: Provenance;
}

/** A real satellite acquisition from a catalogue search. */
export interface SatellitePass {
  id: string;
  name: string;
  sensor: string;
  productType: string;
  start: number;
  end: number;
  footprint: LatLon[];
  orbitDirection: string | null;
  online: boolean;
  provider: 'cdse' | 'bhoonidhi';
  sovereign: boolean;
  caseIds: string[];
  coversIncident: boolean;
  taskedAoi?: string;
}

export interface AreaOfInterest {
  id: string;
  name: string;
  priority: number;
  bounds: { north: number; south: number; east: number; west: number };
  rationale: string;
  pinned: boolean;
  requestedBy: string;
  provenance: Provenance;
}

export interface CommunityAlert {
  id: string;
  caseId: string;
  issuedAt: number;
  channel: string[];
  languages: string[];
  districts: string[];
  headline: string;
  body: string;
  noGoRadiusKm: number;
  centre: LatLon;
  validUntil: number | null;
  status: 'Draft' | 'Queued' | 'Dispatched' | 'Expired' | 'Issued (official)';
  reach: { channel: string; sent: number; delivered: number; failed: number }[] | null;
  issuer: string;
  provenance: Provenance;
  source?: string;
}

export interface SightingReport {
  id: string;
  receivedAt: number;
  reporter: string;
  district: string;
  position: LatLon;
  description: string;
  severity: 'Sheen' | 'Patchy Oil' | 'Heavy Oil' | 'Tar Balls' | 'Debris / Containers' | 'Fire';
  linkedCaseId?: string;
  verified: boolean;
  provenance: Provenance;
  source: string;
}

export interface SystemUser {
  id: string;
  name: string;
  email: string;
  role: 'NTRO Admin' | 'NTRO Reviewer' | 'Analyst' | 'Regulator' | 'Viewer' | 'Data Operator' | 'Liaison';
  agency: string;
  status: 'Active' | 'Suspended' | 'Pending';
  lastLogin: number;
  mfa: boolean;
  clearance: 'Restricted' | 'Confidential' | 'Secret';
}

export interface DataSource {
  id: string;
  kind: 'SAR' | 'Metocean' | 'AIS' | 'Sanctions' | 'Registry' | 'Alerting' | 'Operating picture';
  name: string;
  agency: string;
  sovereign: boolean;
  /** Online = integrated and working; Not configured = integrated but credentials missing; Pending access = not integrated yet. */
  status: 'Online' | 'Not configured' | 'Pending access' | 'Interim fallback';
  message: string;
  role: 'primary' | 'fallback';
  lastSync: number | null;
}

export interface EnforcementAction {
  id: string;
  caseId: string;
  mmsi: string;
  party: string;
  type: 'Inspection Ordered' | 'Detention' | 'Fine Issued' | 'Insurance Flagged' | 'Blacklist Recommended' | 'Prosecution Referred';
  issuedAt: number | null;
  authority: string;
  reference: string | null;
  amountInr?: number;
  status: 'Pending' | 'Served' | 'Contested' | 'Concluded' | 'Reported';
  outcome?: string;
  provenance: Provenance;
  source?: string;
}
