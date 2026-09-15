import type { LatLon } from '../lib/geo';

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

export type SensorName = 'EOS-04' | 'NISAR' | 'Sentinel-1A' | 'Sentinel-1C' | 'RISAT-2BR2' | 'Oceansat-3';

export type VesselType =
  | 'Crude Oil Tanker'
  | 'Product Tanker'
  | 'Chemical Tanker'
  | 'LPG Carrier'
  | 'Bulk Carrier'
  | 'Container Ship'
  | 'General Cargo'
  | 'Fishing Vessel'
  | 'Offshore Supply'
  | 'Tug'
  | 'Passenger'
  | 'Naval / Government';

export interface AisPing {
  /** Epoch milliseconds. */
  t: number;
  lat: number;
  lon: number;
  /** Speed over ground, knots. */
  sog: number;
  /** Course over ground, degrees. */
  cog: number;
  /** True heading, degrees. */
  heading: number;
  /** Navigational status code per ITU-R M.1371. */
  navStatus: number;
  /** Rate of turn, degrees per minute. */
  rot: number;
  /** Set when this ping is the first one after a transmission gap. */
  afterGapMinutes?: number;
}

export interface Vessel {
  mmsi: string;
  imo: string;
  name: string;
  callSign: string;
  flag: string;
  flagRisk: 'Standard' | 'Grey List' | 'Black List';
  type: VesselType;
  lengthM: number;
  beamM: number;
  grossTonnage: number;
  deadweightT: number;
  builtYear: number;
  owner: string;
  operator: string;
  classSociety: string;
  piClub: string;
  /** Last known port call. */
  lastPort: string;
  nextPort: string;
  destination: string;
  eta: string;
  draughtM: number;
  /** Sanctions / watchlist flags. */
  sanctioned: boolean;
  sanctionsList?: string;
  /** Count of prior confirmed attributions, feeds the recidivism boost. */
  priorOffences: number;
  psc: { detentions: number; deficiencies: number; lastInspection: string; lastPort: string };
}

export interface VesselTrack {
  mmsi: string;
  pings: AisPing[];
  /** Detected transmission gaps longer than the reporting interval allows. */
  gaps: { start: number; end: number; minutes: number; distanceKm: number; impliedSpeedKn: number }[];
}

export interface SlickPolygon {
  /** Outer ring in lat/lon. */
  ring: LatLon[];
  /** Additional disconnected fragments. */
  fragments?: LatLon[][];
}

export interface Detection {
  id: string;
  /** Epoch ms of the satellite acquisition. */
  acquiredAt: number;
  sensor: SensorName;
  /** SAR mode or optical band. */
  mode: string;
  polarisation: string;
  resolutionM: number;
  incidenceAngleDeg: number;
  sceneId: string;
  /** Model output. */
  classProbabilities: { oil: number; lookalike: number; sea: number };
  meanBackscatterDb: number;
  backgroundBackscatterDb: number;
  /** Wind speed at acquisition, used for the look-alike cross-check. */
  windSpeedMs: number;
  polygon: SlickPolygon;
  modelVersion: string;
}

export interface AttributionScore {
  mmsi: string;
  /** 0–1 sub-scores. */
  proximity: number;
  temporality: number;
  trajectory: number;
  behaviour: number;
  vesselPrior: number;
  /** Weighted total, 0–1. */
  total: number;
  rank: number;
  /** Closest point of approach to the hindcast origin. */
  cpaKm: number;
  cpaTime: number;
  /** Minutes between the vessel's CPA and the estimated discharge time. */
  deltaTimeMin: number;
  /** Angle between vessel course and slick major axis, degrees. */
  courseAlignmentDeg: number;
  /** Human-readable reasons, shown in the UI so the ranking is inspectable. */
  reasons: string[];
  flags: string[];
  /** True when the vessel stopped transmitting across the discharge window. */
  darkDuringWindow: boolean;
  darkMinutes: number;
}

export interface SpillCase {
  id: string;
  detection: Detection;
  region: string;
  subRegion: string;
  status: CaseStatus;
  tier: RiskTier;
  /** 0–1, produced by the detection model and adjusted by the look-alike cross-checks. */
  confidence: number;
  oilType: keyof typeof import('../engine/drift').OIL_TYPES;
  estimatedVolumeM3: number;
  /** Hours before acquisition that the hindcast is run for. */
  hindcastHours: number;
  forecastHours: number;
  createdAt: number;
  updatedAt: number;
  assignedTo: string;
  workflowStage: WorkflowStage;
  /** MMSIs considered in the attribution window. */
  candidateMmsis: string[];
  notes: string;
  /** Set when an analyst has dismissed the detection as a natural look-alike. */
  lookalikeReason?: string;
  imacPushed: boolean;
  imacPushedAt?: number;
  alertDispatched: boolean;
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
}

export interface SatellitePass {
  id: string;
  sensor: SensorName;
  /** Epoch ms. */
  start: number;
  end: number;
  /** Ground-track swath centre points. */
  track: LatLon[];
  swathKm: number;
  /** Area of interest this pass was tasked against, if any. */
  taskedAoi?: string;
  status: 'Scheduled' | 'Acquiring' | 'Downlinked' | 'Processed' | 'Failed';
  orbitNumber: number;
  /** Detections produced from this pass. */
  detectionIds: string[];
  cloudCoverPct?: number;
}

export interface AreaOfInterest {
  id: string;
  name: string;
  priority: number;
  bounds: { north: number; south: number; east: number; west: number };
  /** Historical detections per 100 passes — drives the tasking recommendation. */
  hitRate: number;
  lastCovered: number;
  rationale: string;
  pinned: boolean;
  requestedBy: string;
}

export interface CommunityAlert {
  id: string;
  caseId: string;
  issuedAt: number;
  channel: ('SMS' | 'WhatsApp' | 'Community Radio' | 'Coastal Siren' | 'App Push')[];
  languages: string[];
  districts: string[];
  headline: string;
  body: string;
  noGoRadiusKm: number;
  centre: LatLon;
  validUntil: number;
  status: 'Draft' | 'Queued' | 'Dispatched' | 'Expired';
  reach: { channel: string; sent: number; delivered: number; failed: number }[];
}

export interface SightingReport {
  id: string;
  receivedAt: number;
  reporter: string;
  boatRegistration: string;
  district: string;
  position: LatLon;
  description: string;
  severity: 'Sheen' | 'Patchy Oil' | 'Heavy Oil' | 'Tar Balls' | 'Dead Fish';
  photos: number;
  linkedCaseId?: string;
  verified: boolean;
  language: string;
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
  name: string;
  kind: 'Satellite' | 'Ocean Model' | 'AIS' | 'Meteorology' | 'Registry' | 'Alerting';
  endpoint: string;
  status: 'Online' | 'Degraded' | 'Offline';
  latencyMs: number;
  lastSync: number;
  recordsPerMin: number;
  provider: string;
  authMode: string;
  quotaUsedPct: number;
}

export interface EnforcementAction {
  id: string;
  caseId: string;
  mmsi: string;
  type: 'Inspection Ordered' | 'Detention' | 'Fine Issued' | 'Insurance Flagged' | 'Blacklist Recommended' | 'Prosecution Referred';
  issuedAt: number;
  authority: string;
  reference: string;
  amountInr?: number;
  status: 'Pending' | 'Served' | 'Contested' | 'Concluded';
  outcome?: string;
}
