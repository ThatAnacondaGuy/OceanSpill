import { analysePolygon } from '../lib/geo';
import { ECOLOGICAL_AREAS } from './geography';
import { observedSampler } from '../engine/forcing';
import BUILT_IN_AOIS from '../../shared/aois.json';
import { api, serverMode } from './api';
import type {
  AreaOfInterest, AuditEntry, CaseArtifact, CoastArtifact, CommunityAlert, DataSource, EnforcementAction, ForcingArtifact,
  HistoricalIncident, IndexArtifact, OilQuantityBasis, OpticalCoverage, RiskTier, SarMeasurement, SarSpot, SatellitePass, ShoreTypeArtifact, SightingReport, SpillCase,
  SystemUser, Vessel, VesselTrack,
} from './types';

const DATA_BASE = (import.meta.env.VITE_DATA_URL as string | undefined) ?? '/data';

export interface World {
  generatedAt: string;
  index: IndexArtifact;
  artifacts: Map<string, CaseArtifact>;
  forcing: Map<string, ForcingArtifact>;
  coast: Map<string, CoastArtifact>;
  shoreTypes: Map<string, ShoreTypeArtifact>;
  /** Optical coverage per case: what Sentinel-2 flew over the incident, and how cloudy it was. */
  optical: Map<string, OpticalCoverage>;
  /** How many protected areas carry a real mapped boundary rather than a hand-drawn one. */
  protectedBoundaries: number;
  cases: SpillCase[];
  vessels: Vessel[];
  vesselsByMmsi: Map<string, Vessel>;
  tracks: Map<string, VesselTrack>;
  passes: SatellitePass[];
  aois: AreaOfInterest[];
  alerts: CommunityAlert[];
  sightings: SightingReport[];
  users: SystemUser[];
  dataSources: DataSource[];
  audit: AuditEntry[];
  enforcement: EnforcementAction[];
  historical: HistoricalIncident[];
}

async function getJson<T>(path: string): Promise<T> {
  // With a server configured the same files come from it, so clearance rules apply to the data
  // itself rather than only to what the pages choose to show.
  if (serverMode) return api.data<T>(path);
  const res = await fetch(`${DATA_BASE}/${path}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function loadWorld(): Promise<World> {
  const index = await getJson<IndexArtifact>('index.json');
  const artifacts = await Promise.all(index.cases.map((c) => getJson<CaseArtifact>(c.file)));
  const forcingEntries = await Promise.all(
    artifacts.filter((a) => a.forcing).map(async (a) => [a.case.id, await getJson<ForcingArtifact>(a.forcing!.file)] as const)
  );
  // A coastline that fails to load only costs land awareness in the drift model, so it is not fatal.
  const coastEntries = await Promise.all(
    artifacts.filter((a) => a.coast).map(async (a) => {
      try {
        return [[a.case.id, await getJson<CoastArtifact>(a.coast!.file)] as const];
      } catch {
        return [];
      }
    })
  );
  // Shore type is an extra pass over the coastline and may not have been run; without it the
  // pages simply do not mention what the shore is made of.
  // What optical coverage exists over each incident; absent until `oceanspill eo-search` has run.
  let optical: Record<string, OpticalCoverage> = {};
  try {
    optical = await getJson<Record<string, OpticalCoverage>>('eo-coverage.json');
  } catch {
    // No search yet; the pages simply do not mention optical.
  }

  // Real boundaries for the protected areas, where OpenStreetMap has them.
  let boundaries: Record<string, { ring: [number, number][] }> = {};
  try {
    boundaries = ((await getJson<{ areas: Record<string, { ring: [number, number][] }> }>('protected-areas.json')).areas) ?? {};
  } catch {
    // Not fetched yet; the hand-drawn outlines stand.
  }

  const shoreEntries = await Promise.all(
    artifacts.filter((a) => a.coast).map(async (a) => {
      try {
        const file = a.coast!.file.replace(/\.json$/, '-shoretype.json');
        return [[a.case.id, await getJson<ShoreTypeArtifact>(file)] as const];
      } catch {
        return [];
      }
    })
  );
  return buildWorld(index, artifacts, new Map(forcingEntries), new Map(coastEntries.flat()), new Map(shoreEntries.flat()), boundaries, new Map(Object.entries(optical)));
}

const ms = (iso: string) => new Date(iso).getTime();

const PROVIDER_NAMES: Record<string, string> = {
  eos04: 'EOS-04 (Bhoonidhi)', sentinel1: 'Sentinel-1 (Copernicus)', 'openmeteo+cmems': 'Open-Meteo and Copernicus Marine',
  openmeteo: 'Open-Meteo', cmems: 'Copernicus Marine', gfw: 'Global Fishing Watch', unsc: 'UN sanctions list',
};

/** Best-known oil quantity in tonnes and what it measures: released if reported, otherwise on board or recovered. */
function oilQuantity(a: CaseArtifact): { tonnes: number | null; basis: OilQuantityBasis | null } {
  const oil = a.case.oil;
  if (oil.spilledTonnes != null) return { tonnes: oil.spilledTonnes, basis: 'released' };
  const onboard = oil.onboard.reduce((s, o) => s + (o.tonnes ?? (o.cubicMetres != null ? o.cubicMetres * 0.95 : 0)), 0);
  if (onboard > 0) return { tonnes: onboard, basis: 'on board' };
  const impact = a.case.impact;
  if (impact.oilySludgeRecoveredT) return { tonnes: impact.oilySludgeRecoveredT, basis: 'recovered' };
  if (impact.unaccountedOilLitres) return { tonnes: (impact.unaccountedOilLitres / 1000) * 0.9, basis: 'unaccounted' };
  return { tonnes: null, basis: null };
}

function tierFor(quantity: number | null): RiskTier {
  if (quantity == null) return 'MEDIUM';
  if (quantity >= 250) return 'HIGH';
  if (quantity >= 20) return 'MEDIUM';
  return 'LOW';
}

const ANALYSTS = ['A. Sharma', 'S. Iyer', 'R. Das', 'K. Verma'];

function categorise(event: string): AuditEntry['category'] {
  const e = event.toLowerCase();
  if (/(fine|ngt|charges|police|prosecut|penalt)/.test(e)) return 'Enforcement';
  if (/(advisory|alert|restriction|warn)/.test(e)) return 'Alert';
  if (/(slick|sheen|visible|observed|ashore|tar ball|explosion|fire|sank|collision|leak|list)/.test(e)) return 'Detection';
  if (/(meeting|deploy|dispatch|rescue|salvage|activates|recovery|clean|offloaded|relief|expected on scene)/.test(e)) return 'Dispatch';
  return 'Analysis';
}

const SEVERITY: Record<string, SightingReport['severity']> = {
  sheen: 'Sheen', slick: 'Patchy Oil', tarballs: 'Tar Balls', shoreline: 'Heavy Oil',
  'containers-ashore': 'Debris / Containers', fire: 'Fire',
};

export function buildWorld(
  index: IndexArtifact, artifacts: CaseArtifact[], forcing: Map<string, ForcingArtifact>,
  coast: Map<string, CoastArtifact> = new Map(), shoreTypes: Map<string, ShoreTypeArtifact> = new Map(),
  protectedBoundaries: Record<string, { ring: [number, number][] }> = {},
  optical: Map<string, OpticalCoverage> = new Map()
): World {
  const vessels: Vessel[] = [];
  const tracks = new Map<string, VesselTrack>();
  const cases: SpillCase[] = [];
  const passMap = new Map<string, SatellitePass>();
  const sightings: SightingReport[] = [];
  const audit: AuditEntry[] = [];
  const alerts: CommunityAlert[] = [];
  const enforcement: EnforcementAction[] = [];

  artifacts.forEach((a, i) => {
    const facts = a.case;
    const sanctionsByKey = new Map(a.sanctions.map((s) => [s.key, s]));

    for (const v of a.vessels) {
      const sanction = sanctionsByKey.get(v.key);
      vessels.push({
        mmsi: v.key,
        mmsiNumber: v.mmsi,
        imo: v.imo,
        name: v.name,
        flag: v.flag,
        flagRisk: v.registry.flagRisk ?? null,
        type: v.type,
        operator: v.operator,
        role: v.role,
        provenance: v.provenance,
        isFacility: v.isFacility,
        registryVerified: v.registry.verified,
        priorOffences: v.registry.priorOffences ?? 0,
        sanctioned: sanction?.listed ?? v.registry.sanctioned ?? false,
        sanctionsChecked: Boolean(sanction),
        sanctionsList: sanction?.listed ? `${sanction.list} (${sanction.reference})` : v.registry.sanctioned ? 'Synthetic watchlist' : undefined,
        pscDetentions: v.registry.pscDetentions ?? null,
        registrySource: v.registry.source ?? null,
        registryDetails: v.registry.details ?? null,
        note: v.note,
        caseId: facts.id,
        anchors: v.anchors,
      });
    }

    for (const t of a.tracks) {
      tracks.set(t.key, {
        mmsi: t.key,
        provenance: t.provenance,
        notes: t.notes,
        gaps: t.gaps,
        pings: t.pings.map(([sec, lat, lon, sog, cog, heading, navStatus]) => ({
          t: a.ais.window.start + sec * 1000, lat, lon, sog, cog, heading, navStatus,
        })),
      });
    }

    const polygon = { ring: a.reportedGeometry.ring };
    const centre = analysePolygon(polygon.ring).centroid;
    const f = forcing.get(facts.id);
    const wind = f ? observedSampler(f).wind(centre, a.reference.time) : null;
    const { tonnes: quantity, basis: quantityBasis } = oilQuantity(a);
    const measurements = a.sarMeasurements ?? [];
    const sarSpot = nearestSpot(measurements, facts.incident.positionPrecisionKm);

    cases.push({
      id: facts.id,
      title: facts.title,
      facts,
      region: facts.region,
      subRegion: facts.subRegion,
      sourceType: facts.sourceType,
      detection: {
        id: `OBS-${facts.id}`,
        acquiredAt: a.reference.time,
        referenceBasis: a.reference.basis,
        status: 'reported',
        observationSource: a.reportedGeometry.observationSource,
        polygon,
        geometryBasis: a.reportedGeometry.basis,
        geometryAssumptions: a.reportedGeometry.assumptions,
        extentReported: a.reportedGeometry.extentReported,
        windSpeedMs: wind && wind.origin === 'observed' ? wind.speed : null,
        scenes: a.sar.scenes,
        sarProviders: a.sar.providers,
        sarMeasurements: measurements,
        sarSpot,
        classProbabilities: null,
        meanBackscatterDb: sarSpot?.meanDb ?? null,
        backgroundBackscatterDb: sarSpot?.backgroundDb ?? null,
        modelVersion: null,
      },
      // Replay mode: every real case starts at the beginning of this system's workflow. The
      // real-world outcome is shown alongside from the case facts.
      status: 'Under Analysis',
      workflowStage: 'Awaiting Dispatch',
      tier: tierFor(quantity),
      confidence: facts.officiallyConfirmed ? 1 : 0.5,
      confidenceBasis: 'official-report',
      oilType: facts.oil.modelType,
      oilQuantityTonnes: quantity,
      oilQuantityBasis: quantityBasis,
      hindcastHours: a.reference.hindcastHours,
      forecastHours: a.reference.forecastHours,
      incidentTime: ms(facts.incident.time),
      createdAt: a.reference.time,
      updatedAt: ms(a.generatedAt),
      assignedTo: ANALYSTS[i % ANALYSTS.length],
      candidateMmsis: a.vessels.map((v) => v.key),
      notes: facts.officialFindings,
      imacPushed: false,
      alertDispatched: false,
      forcingFile: a.forcing?.file ?? null,
      forcingSources: a.forcing?.sources ?? null,
      forcingCoverage: a.forcing?.coverage ?? null,
      aisProvider: a.ais.provider,
      aisWindow: a.ais.window,
      warnings: a.warnings,
      generatedAt: a.generatedAt,
    });

    for (const s of a.sar.scenes) {
      const existing = passMap.get(s.id);
      if (existing) {
        existing.caseIds.push(facts.id);
        existing.coversIncident ||= s.coversIncident;
        continue;
      }
      passMap.set(s.id, {
        id: s.id, name: s.name, sensor: s.platform, productType: s.productType, start: s.start, end: s.end,
        footprint: s.footprint, orbitDirection: s.orbitDirection, online: s.online, provider: s.provider,
        sovereign: s.provider === 'bhoonidhi',
        caseIds: [facts.id], coversIncident: s.coversIncident,
      });
    }

    facts.observations.forEach((o, k) => {
      sightings.push({
        id: `OBS-${facts.id.slice(4)}-${k + 1}`,
        receivedAt: ms(o.time),
        reporter: o.source,
        district: facts.region,
        position: { lat: o.lat ?? facts.incident.position.lat, lon: o.lon ?? facts.incident.position.lon },
        description: o.description,
        severity: SEVERITY[o.type] ?? 'Patchy Oil',
        linkedCaseId: facts.id,
        verified: true,
        provenance: 'real',
        source: o.source,
      });
    });

    facts.timeline.forEach((ev, k) => {
      audit.push({
        id: `REC-${facts.id.slice(4)}-${k + 1}`,
        t: ms(ev.time),
        actor: 'Public record',
        role: 'Case timeline',
        action: ev.event,
        target: facts.id,
        // The timeline has no per-event citation; the case's sources are listed once with the case.
        detail: '',
        category: categorise(ev.event),
        provenance: 'real',
      });
    });

    if (facts.impact.fishingRestrictionNm) {
      alerts.push({
        id: `OFFICIAL-${facts.id.slice(4)}`,
        caseId: facts.id,
        issuedAt: ms(facts.incident.time),
        channel: ['Official order'],
        languages: [],
        districts: [facts.region],
        headline: `Fishing restricted within ${facts.impact.fishingRestrictionNm} nm of the wreck`,
        body: `Authorities restricted fishing within a ${facts.impact.fishingRestrictionNm} nautical mile radius of the ${facts.title} site.`,
        noGoRadiusKm: facts.impact.fishingRestrictionNm * 1.852,
        centre: facts.incident.position,
        validUntil: null,
        status: 'Issued (official)',
        reach: null,
        issuer: 'State and central authorities',
        provenance: 'real',
        source: facts.sources.find((s) => s.url.includes('wikipedia'))?.url ?? facts.sources[0]?.url,
      });
    }

    (facts.legal ?? []).forEach((l, k) => {
      const party = a.vessels.find((v) => l.party.toUpperCase().includes(v.name)) ?? a.vessels.find((v) => v.isFacility && l.party.includes('Corporation'));
      enforcement.push({
        id: `LEGAL-${facts.id.slice(4)}-${k + 1}`,
        caseId: facts.id,
        mmsi: party?.key ?? '',
        party: l.party,
        type: l.action as EnforcementAction['type'],
        issuedAt: null,
        authority: l.authority,
        reference: null,
        amountInr: l.amountInr,
        status: 'Reported',
        outcome: l.note,
        provenance: 'real',
        source: l.source,
      });
    });
  });

  for (const h of index.historical.incidents) {
    if (h.activeCaseId) continue;
    (h.legal ?? []).forEach((l, k) => {
      enforcement.push({
        id: `LEGAL-${h.id.slice(5)}-${k + 1}`, caseId: h.id, mmsi: '', party: l.party,
        type: l.action as EnforcementAction['type'], issuedAt: null, authority: l.authority, reference: null,
        amountInr: l.amountInr, status: 'Reported', outcome: `${h.name} (${h.date})`, provenance: 'real', source: l.source,
      });
    });
  }

  audit.push({
    id: 'PIPELINE-BUILD',
    t: ms(index.generatedAt),
    actor: 'Data pipeline',
    role: 'Automated',
    action: 'Case data updated',
    target: 'All cases',
    detail: `${artifacts.length} cases and ${passMap.size} catalogue scenes from ${index.providers.filter((p) => p.available).map((p) => PROVIDER_NAMES[p.name] ?? p.name).join(', ')}`,
    category: 'System',
    provenance: 'real',
  });
  audit.sort((x, y) => y.t - x.t);

  return {
    generatedAt: index.generatedAt,
    index,
    artifacts: new Map(artifacts.map((a) => [a.case.id, a])),
    forcing,
    coast,
    shoreTypes,
    optical,
    protectedBoundaries: applyProtectedBoundaries(protectedBoundaries),
    cases: cases.sort((x, y) => y.incidentTime - x.incidentTime),
    vessels,
    vesselsByMmsi: new Map(vessels.map((v) => [v.mmsi, v])),
    tracks,
    passes: [...passMap.values()].sort((x, y) => y.start - x.start),
    aois: buildAois(),
    alerts,
    sightings: sightings.sort((x, y) => y.receivedAt - x.receivedAt),
    users: buildUsers(),
    dataSources: buildDataSources(index),
    audit,
    enforcement,
    historical: index.historical.incidents,
  };
}

function buildAois(): AreaOfInterest[] {
  return BUILT_IN_AOIS.areas.map((a) => ({ ...a, provenance: 'modelled' as const }));
}

function buildUsers(): SystemUser[] {
  const now = Date.now();
  const h = 3600_000;
  return [
    { id: 'U-001', name: 'Dr. R. Menon', email: 'rmenon@ntro.gov.in', role: 'NTRO Admin', agency: 'NTRO', status: 'Active', lastLogin: now - 0.4 * h, mfa: true, clearance: 'Secret' },
    { id: 'U-002', name: 'S. Iyer', email: 'siyer@ntro.gov.in', role: 'NTRO Reviewer', agency: 'NTRO', status: 'Active', lastLogin: now - 2.2 * h, mfa: true, clearance: 'Secret' },
    { id: 'U-003', name: 'A. Sharma', email: 'asharma@indiancoastguard.gov.in', role: 'Analyst', agency: 'Indian Coast Guard', status: 'Active', lastLogin: now - 2.6 * h, mfa: true, clearance: 'Confidential' },
    { id: 'U-004', name: 'P. Nair', email: 'pnair@dgshipping.gov.in', role: 'Regulator', agency: 'DG Shipping', status: 'Active', lastLogin: now - 18 * h, mfa: true, clearance: 'Confidential' },
    { id: 'U-005', name: 'K. Verma', email: 'kverma@moefcc.gov.in', role: 'Viewer', agency: 'MoEFCC', status: 'Active', lastLogin: now - 21 * h, mfa: false, clearance: 'Restricted' },
    { id: 'U-006', name: 'R. Das', email: 'rdas@incois.gov.in', role: 'Data Operator', agency: 'INCOIS', status: 'Active', lastLogin: now - 44 * h, mfa: true, clearance: 'Restricted' },
    { id: 'U-007', name: 'Cdr. V. Pillai', email: 'vpillai@indiannavy.gov.in', role: 'Liaison', agency: 'Indian Navy (IMAC)', status: 'Active', lastLogin: now - 6.8 * h, mfa: true, clearance: 'Secret' },
  ];
}

/** Integrations in priority order: Indian primary first, foreign fallbacks after. */
function buildDataSources(index: IndexArtifact): DataSource[] {
  // A merged metocean provider is reported as "openmeteo+cmems"; list each member on its own.
  const pipeline = new Map(index.providers.flatMap((p) => p.name.split('+').map((name) => [name, p] as const)));
  const built = ms(index.generatedAt);
  const fromPipeline = (id: string, kind: DataSource['kind'], role: DataSource['role']): DataSource => {
    const p = pipeline.get(id);
    return {
      id, kind, role, name: p?.agency ?? id, agency: p?.agency ?? id, sovereign: p?.sovereign ?? false,
      status: !p ? 'Pending access' : !p.available ? 'Not configured' : role === 'fallback' ? 'Interim fallback' : 'Online',
      message: p?.message ?? 'Not configured in pipeline', lastSync: p?.available ? built : null,
    };
  };
  const pending = (id: string, kind: DataSource['kind'], name: string, agency: string, message: string): DataSource =>
    ({ id, kind, role: 'primary', name, agency, sovereign: true, status: 'Pending access', message, lastSync: null });

  return [
    { ...fromPipeline('eos04', 'SAR', 'primary'), name: 'EOS-04 SAR', agency: 'ISRO / NRSC Bhoonidhi' },
    pending('nisar', 'SAR', 'NISAR S-SAR', 'ISRO / NRSC Bhoonidhi', 'Open data on Bhoonidhi; only covers acquisitions after June 2026'),
    { ...fromPipeline('sentinel1', 'SAR', 'fallback'), name: 'Sentinel-1 SAR', agency: 'ESA Copernicus Data Space Ecosystem' },
    pending('incois', 'Metocean', 'INCOIS HOOFS currents', 'INCOIS', 'Needs INCOIS data portal registration and API details'),
    pending('eos06-scat', 'Metocean', 'Oceansat-3 (EOS-06) scatterometer winds', 'ISRO / NRSC Bhoonidhi',
      'Listed per case from the Bhoonidhi catalogue (EOS-06_SCAT_3WW); products are offline and must be requested via the portal'),
    { ...fromPipeline('openmeteo', 'Metocean', 'fallback'), name: 'ERA5 wind, waves and SMOC currents', agency: 'Open-Meteo', message: 'ERA5 reanalysis wind and waves; Météo-France SMOC currents from 2022' },
    pipeline.has('cmems')
      ? { ...fromPipeline('cmems', 'Metocean', 'fallback'), name: 'Copernicus Marine GLORYS12 currents', agency: 'Copernicus Marine Service', message: 'Reanalysis currents fill cells Open-Meteo lacks (all dates before 2022)' }
      : { id: 'cmems', kind: 'Metocean', role: 'fallback', name: 'Copernicus Marine GLORYS12 currents', agency: 'Copernicus Marine Service', sovereign: false, status: 'Not configured', message: 'Adapter ready: METOCEAN_PROVIDER=openmeteo,cmems and CMEMS login', lastSync: null },
    pending('dgll', 'AIS', 'National AIS Network', 'DGLL / Indian Coast Guard / IFC-IOR', 'Needs government data access'),
    pipeline.has('gfw')
      ? { ...fromPipeline('gfw', 'AIS', 'fallback'), name: 'Global Fishing Watch AIS', agency: 'Global Fishing Watch', message: 'Hourly vessel positions and vessel identity for every case window' }
      : { id: 'gfw', kind: 'AIS', role: 'fallback', name: 'Global Fishing Watch AIS', agency: 'Global Fishing Watch', sovereign: false, status: 'Not configured', message: 'Adapter ready: set AIS_PROVIDER=gfw and GFW_API_TOKEN (free, non-commercial)', lastSync: null },
    pipeline.has('synthetic')
      ? fromPipeline('synthetic', 'AIS', 'fallback')
      : { id: 'synthetic', kind: 'AIS', role: 'fallback', name: 'Estimated tracks from reported positions', agency: 'OceanSpill (built in)', sovereign: true, status: 'Interim fallback', message: 'Used only where a vessel has no AIS in the window, between its officially reported positions', lastSync: built },
    pending('dgs-registry', 'Registry', 'Vessel registry and PSC history', 'DG Shipping', 'Needs government access; Equasis account as interim'),
    pending('mea', 'Sanctions', 'Watchlists', 'MEA / DG Shipping', 'Needs government access'),
    { ...fromPipeline('unsc', 'Sanctions', 'fallback'), name: 'UN Security Council Consolidated List', agency: 'United Nations', message: 'Public sanctions list, checked by vessel name and IMO number' },
    pending('sachet', 'Alerting', 'SACHET CAP gateway', 'NDMA', 'Publishing needs NDMA authorisation; alerts are drafted locally'),
    pending('imac', 'Operating picture', 'IMAC common operating picture', 'Indian Navy', 'Needs Navy integration; payloads generated locally'),
  ];
}

/** The processed dark spot closest to the incident, within 10 km plus the position uncertainty. */
function nearestSpot(measurements: SarMeasurement[], precisionKm: number): (SarSpot & { scene: string }) | null {
  let best: (SarSpot & { scene: string }) | null = null;
  for (const m of measurements) {
    for (const spot of m.spots) {
      if (spot.distanceKm > 10 + precisionKm) continue;
      if (!best || spot.distanceKm < best.distanceKm) best = { ...spot, scene: m.scene };
    }
  }
  return best;
}

export function dataUrl(path: string): string {
  return `${DATA_BASE}/${path}`;
}

/**
 * A supporting file as something an <img> can show. Against a server the file needs the session
 * token, which an image tag cannot send, so it is fetched and handed over as an object URL.
 */
export async function fileUrl(path: string): Promise<string> {
  return serverMode ? api.objectUrl(path) : dataUrl(path);
}

/**
 * Legal actions on record from public sources, counted the same way on every page:
 * individual actions, and the distinct incidents they relate to.
 */
export function legalSummary(world: Pick<World, 'enforcement'>) {
  const published = world.enforcement.filter((e) => e.provenance === 'real');
  const incidentIds = new Set(published.map((e) => e.caseId));
  return {
    actions: published.length,
    incidents: incidentIds.size,
    incidentIds,
    penaltiesInr: published.reduce((s, e) => s + (e.amountInr ?? 0), 0),
  };
}

/** The party authorities named as the source of a case, if any (a vessel, facility or pipeline). */
export function reportedSource(world: Pick<World, 'vessels'>, caseId: string) {
  return world.vessels.find((v) => v.caseId === caseId && v.role === 'source') ?? null;
}

/**
 * Replaces the hand-drawn outline of a protected area with its real mapped boundary where the
 * pipeline found one. The areas are a single shared list, so this is applied once as the data
 * loads; areas with no match keep the outline they had.
 */
function applyProtectedBoundaries(boundaries: Record<string, { ring: [number, number][] }>): number {
  let applied = 0;
  for (const area of ECOLOGICAL_AREAS) {
    const match = boundaries[area.id];
    if (!match?.ring?.length) continue;
    area.ring = match.ring.map(([lon, lat]) => ({ lat, lon }));
    applied++;
  }
  return applied;
}
