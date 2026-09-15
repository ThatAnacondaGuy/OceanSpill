import { analysePolygon } from '../lib/geo';
import { observedSampler } from '../engine/forcing';
import type {
  AreaOfInterest, AuditEntry, CaseArtifact, CommunityAlert, DataSource, EnforcementAction, ForcingArtifact,
  HistoricalIncident, IndexArtifact, RiskTier, SarMeasurement, SarSpot, SatellitePass, SightingReport, SpillCase,
  SystemUser, Vessel, VesselTrack,
} from './types';

const DATA_BASE = (import.meta.env.VITE_DATA_URL as string | undefined) ?? '/data';

export interface World {
  generatedAt: string;
  index: IndexArtifact;
  artifacts: Map<string, CaseArtifact>;
  forcing: Map<string, ForcingArtifact>;
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
  return buildWorld(index, artifacts, new Map(forcingEntries));
}

const ms = (iso: string) => new Date(iso).getTime();

/** Best-known oil quantity in tonnes: released if reported, otherwise what was on board or recovered. */
function oilQuantityTonnes(a: CaseArtifact): number | null {
  const oil = a.case.oil;
  if (oil.spilledTonnes != null) return oil.spilledTonnes;
  const onboard = oil.onboard.reduce((s, o) => s + (o.tonnes ?? (o.cubicMetres != null ? o.cubicMetres * 0.95 : 0)), 0);
  if (onboard > 0) return onboard;
  const impact = a.case.impact;
  if (impact.oilySludgeRecoveredT) return impact.oilySludgeRecoveredT;
  if (impact.unaccountedOilLitres) return (impact.unaccountedOilLitres / 1000) * 0.9;
  return null;
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

export function buildWorld(index: IndexArtifact, artifacts: CaseArtifact[], forcing: Map<string, ForcingArtifact>): World {
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
    const quantity = oilQuantityTonnes(a);
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
        role: 'Source document',
        action: ev.event,
        target: facts.id,
        detail: facts.sources.map((s) => s.title).slice(0, 2).join('; '),
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
    actor: 'oceanspill pipeline',
    role: 'Automated',
    action: 'Artifacts generated',
    target: 'public/data',
    detail: `${artifacts.length} cases, ${passMap.size} catalogue scenes; providers: ${index.providers.filter((p) => p.available).map((p) => p.name).join(', ')}`,
    category: 'System',
    provenance: 'real',
  });
  audit.sort((x, y) => y.t - x.t);

  return {
    generatedAt: index.generatedAt,
    index,
    artifacts: new Map(artifacts.map((a) => [a.case.id, a])),
    forcing,
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
  const aoi = (id: string, name: string, priority: number, bounds: AreaOfInterest['bounds'], rationale: string, pinned: boolean, requestedBy: string): AreaOfInterest =>
    ({ id, name, priority, bounds, rationale, pinned, requestedBy, provenance: 'modelled' });
  return [
    aoi('AOI-KERALA', 'Kerala Coast Shipping Lane', 1, { north: 12.5, south: 8.0, east: 77.2, west: 73.8 }, 'Two major 2025 casualties (MSC ELSA 3, WAN HAI 503) on the Colombo–west coast container route.', true, 'Analyst'),
    aoi('AOI-MUMBAI', 'Mumbai Port Approaches and Bombay High', 2, { north: 20.2, south: 18.4, east: 73.1, west: 70.8 }, 'MSC Chitra (2010), MV Rak (2011), Uran pipeline (2013) and Mumbai High (2005) all fall inside this area.', true, 'NTRO Reviewer'),
    aoi('AOI-CHENNAI', 'Chennai–Ennore Coast', 3, { north: 13.6, south: 12.9, east: 80.7, west: 80.1 }, 'Ennore 2017 collision and 2023 refinery spill; dense port and refinery activity.', true, 'Indian Coast Guard'),
    aoi('AOI-GOA', 'Goa–Karnataka Tar Ball Coast', 4, { north: 16.0, south: 14.0, east: 74.5, west: 72.8 }, 'Recurring April–September tar ball deposition; Ocean Seraya 2006 off Karwar.', false, 'MoEFCC'),
    aoi('AOI-SUNDARBANS', 'Hooghly Approach / Sundarbans', 5, { north: 22.3, south: 20.8, east: 89.2, west: 87.6 }, 'SSL Kolkata 2018 wreck; world heritage mangroves adjacent to the shipping channel.', false, 'MoEFCC'),
    aoi('AOI-CAUVERY', 'Cauvery Delta / Karaikal', 6, { north: 11.2, south: 10.4, east: 80.2, west: 79.7 }, 'Nagapattinam 2023 undersea pipeline leak; crude transfers to ships.', false, 'Analyst'),
    aoi('AOI-KUTCH', 'Gulf of Kachchh Oil Terminals', 7, { north: 23.2, south: 21.4, east: 70.6, west: 67.8 }, 'Largest crude import terminals (Sikka, Vadinar, Mundra); historic tanker spills off Kutch.', false, 'NTRO Reviewer'),
  ];
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
  const pipeline = new Map(index.providers.map((p) => [p.name, p]));
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
    fromPipeline('eos04', 'SAR', 'primary'),
    pending('nisar', 'SAR', 'NISAR S-SAR', 'ISRO / NRSC Bhoonidhi', 'Open data on Bhoonidhi; only covers acquisitions after June 2026'),
    fromPipeline('sentinel1', 'SAR', 'fallback'),
    pending('incois', 'Metocean', 'INCOIS HOOFS currents', 'INCOIS', 'Needs INCOIS data portal registration and API details'),
    pending('mosdac', 'Metocean', 'Oceansat-3 scatterometer winds', 'ISRO SAC / MOSDAC', 'Needs MOSDAC account'),
    fromPipeline('openmeteo', 'Metocean', 'fallback'),
    pending('dgll', 'AIS', 'National AIS Network', 'DGLL / Indian Coast Guard / IFC-IOR', 'Needs government data access'),
    pipeline.has('gfw')
      ? fromPipeline('gfw', 'AIS', 'fallback')
      : { id: 'gfw', kind: 'AIS', role: 'fallback', name: 'Global Fishing Watch AIS', agency: 'Global Fishing Watch', sovereign: false, status: 'Not configured', message: 'Adapter ready: set AIS_PROVIDER=gfw and GFW_API_TOKEN (free, non-commercial)', lastSync: null },
    pipeline.has('synthetic')
      ? fromPipeline('synthetic', 'AIS', 'fallback')
      : { id: 'synthetic', kind: 'AIS', role: 'fallback', name: 'Synthetic AIS generator', agency: 'OceanSpill', sovereign: true, status: 'Not configured', message: 'Used for interpolation between real event positions', lastSync: null },
    pending('dgs-registry', 'Registry', 'Vessel registry and PSC history', 'DG Shipping', 'Needs government access; Equasis account as interim'),
    pending('mea', 'Sanctions', 'Watchlists', 'MEA / DG Shipping', 'Needs government access'),
    fromPipeline('unsc', 'Sanctions', 'fallback'),
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
