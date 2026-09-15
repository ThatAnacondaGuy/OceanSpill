import { useEffect, useMemo, useState } from 'react';
import {
  Satellite, Target, ChevronUp, ChevronDown, Pin, PinOff, CheckCircle2, Plus, Layers, Database, ExternalLink, FileDown,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon } from './components/MapView';
import {
  Badge, Button, KeyValue, Toggle, Select, InfoBanner, Modal, Field, TextInput,
  TextArea, Slider, StatCard, DataTable, ProvenanceBadge, triggerDownload, type Column, Tabs,
} from './components/ui';
import { pointInPolygon, type LatLon } from './lib/geo';
import type { AreaOfInterest, SatellitePass } from './data/types';

const PLATFORM_COLORS: Record<string, string> = {
  'EOS-04': '#ea580c', NISAR: '#7c3aed', 'Sentinel-1A': '#059669', 'Sentinel-1B': '#0891b2', 'Sentinel-1C': '#2563eb',
};

const BHOONIDHI_COLLECTIONS = ['EOS-04_SAR-MRS_L2B', 'EOS-04_SAR-CRS_L2A', 'EOS-04_SAR-MRS_L2A'];

function boundsRing(b: AreaOfInterest['bounds']): LatLon[] {
  return [{ lat: b.north, lon: b.west }, { lat: b.north, lon: b.east }, { lat: b.south, lon: b.east }, { lat: b.south, lon: b.west }];
}

/** Public CDSE OData catalogue query, identical in form to the pipeline's Sentinel-1 adapter. */
function cdseQueryUrl(b: AreaOfInterest['bounds'], start: Date, end: Date): string {
  const ring = [...boundsRing(b), boundsRing(b)[0]].map((p) => `${p.lon} ${p.lat}`).join(',');
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const filter = `Collection/Name eq 'SENTINEL-1' and OData.CSC.Intersects(area=geography'SRID=4326;POLYGON((${ring}))')`
    + ` and ContentDate/Start gt ${iso(start)} and ContentDate/Start lt ${iso(end)}`
    + ` and Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' and att/OData.CSC.StringAttribute/Value eq 'IW_GRDH_1S')`;
  return `https://catalogue.dataspace.copernicus.eu/odata/v1/Products?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('ContentDate/Start desc')}&$top=50`;
}

export default function SatelliteTasking() {
  const { world, now, navigate, toggleAoiPin, reorderAoi, consumeSection, revision } = useStore();
  const [basemap, setBasemap] = useState<BasemapStyle>('map');
  const [selectedPass, setSelectedPass] = useState<string | null>(null);
  const [selectedAoi, setSelectedAoi] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [caseFilter, setCaseFilter] = useState('all');
  const [coverFilter, setCoverFilter] = useState('all');
  const [tab, setTab] = useState('queue');
  const [requestOpen, setRequestOpen] = useState(false);
  const [layers, setLayers] = useState({ footprints: true, aois: true, cases: true, incidents: false });
  const [layersOpen, setLayersOpen] = useState(false);
  const [searchDays, setSearchDays] = useState(30);

  useEffect(() => {
    const s = consumeSection();
    if (s) { setSelectedAoi(s); setTab('queue'); }
  }, [consumeSection]);

  const passes = useMemo(() => world.passes
    .filter((p) => platformFilter === 'all' || p.sensor === platformFilter)
    .filter((p) => caseFilter === 'all' || p.caseIds.includes(caseFilter))
    .filter((p) => coverFilter === 'all' || (coverFilter === 'covers' ? p.coversIncident : !p.coversIncident))
    .sort((a, b) => b.start - a.start), [world.passes, platformFilter, caseFilter, coverFilter, revision]);

  const platforms = useMemo(() => Array.from(new Set(world.passes.map((p) => p.sensor))).sort(), [world.passes]);

  /** Planning areas ranked by manual priority, with the real incident count and latest scene shown alongside. */
  const aois = useMemo(() => [...world.aois]
    .map((a) => {
      const ring = boundsRing(a.bounds);
      const incidents = world.historical.filter((h) => h.lat != null && h.lon != null && pointInPolygon({ lat: h.lat, lon: h.lon }, ring));
      const scenes = world.passes.filter((p) => p.footprint.some((pt) => pointInPolygon(pt, ring)) || ring.some((pt) => pointInPolygon(pt, p.footprint)));
      const latestScene = scenes.reduce((m, p) => Math.max(m, p.start), 0);
      return { aoi: a, incidents, scenes, latestScene };
    })
    .sort((x, y) => {
      if (x.aoi.pinned !== y.aoi.pinned) return x.aoi.pinned ? -1 : 1;
      return x.aoi.priority - y.aoi.priority;
    }), [world.aois, world.historical, world.passes, revision]);

  const active = world.passes.find((p) => p.id === selectedPass) ?? null;
  const activeAoi = aois.find((a) => a.aoi.id === selectedAoi) ?? null;

  const mapData = useMemo(() => {
    const polygons: MapPolygon[] = [];
    const markers: MapMarker[] = [];

    if (layers.aois) {
      for (const { aoi: a } of aois) {
        const sel = a.id === selectedAoi;
        polygons.push({
          id: a.id, rings: [boundsRing(a.bounds)],
          fill: sel ? 'rgba(37,99,235,0.2)' : a.pinned ? 'rgba(37,99,235,0.1)' : 'rgba(100,116,139,0.07)',
          stroke: sel ? '#1d4ed8' : a.pinned ? '#2563eb' : '#64748b',
          strokeWidth: sel ? 2.2 : 1.2, dash: a.pinned ? undefined : '5 4', z: 1, selected: sel,
        });
      }
    }
    if (layers.footprints) {
      for (const p of passes) {
        const sel = p.id === selectedPass;
        const colour = PLATFORM_COLORS[p.sensor] ?? '#2563eb';
        polygons.push({
          id: `fp-${p.id}`, rings: [p.footprint],
          fill: sel ? `${colour}40` : `${colour}14`, stroke: colour,
          strokeWidth: sel ? 2 : 0.8, opacity: sel ? 1 : 0.6, z: sel ? 4 : 2,
        });
      }
    }
    if (layers.cases) {
      for (const c of world.cases) {
        markers.push({
          id: c.id, position: c.facts.incident.position, kind: 'case', color: '#111827', size: 5.5,
          label: c.title, sublabel: `${c.detection.scenes.length} scene(s) · ${fmt.precise(c.incidentTime, c.facts.incident.timePrecision)}`, z: 7,
        });
      }
    }
    if (layers.incidents) {
      for (const h of world.historical) {
        if (h.lat == null || h.lon == null || h.activeCaseId) continue;
        markers.push({ id: `h-${h.id}`, position: { lat: h.lat, lon: h.lon }, kind: 'case', color: '#b45309', size: 3.5, label: h.name, sublabel: h.date, z: 5 });
      }
    }
    return { polygons, markers };
  }, [passes, aois, world.cases, world.historical, layers, selectedPass, selectedAoi]);

  const stats = useMemo(() => ({
    scenes: world.passes.length,
    covering: world.passes.filter((p) => p.coversIncident).length,
    sovereign: world.passes.filter((p) => p.sovereign).length,
    casesWithout: world.cases.filter((c) => !c.detection.scenes.some((s) => s.coversIncident)).length,
    totalGb: world.cases.reduce((s, c) => s + c.detection.scenes.reduce((x, sc) => x + (sc.sizeBytes ?? 0), 0), 0) / 1e9,
  }), [world.passes, world.cases]);

  const processed = useMemo(() => new Set(world.cases.flatMap((c) => c.detection.sarMeasurements.map((m) => m.scene))), [world.cases]);

  const passColumns: Column<SatellitePass>[] = [
    {
      key: 'start', header: 'Acquired (UTC)', width: '124px', value: (p) => p.start,
      render: (p) => <div><div className="font-mono text-gray-800">{fmt.utcShort(p.start)}</div><div className="text-[9px] text-gray-400">{fmt.ago(p.start, now)}</div></div>,
    },
    {
      key: 'sensor', header: 'Platform', width: '118px', value: (p) => p.sensor,
      render: (p) => (
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: PLATFORM_COLORS[p.sensor] ?? '#2563eb' }} />
          <span className="font-semibold text-gray-800">{p.sensor}</span>
          <Badge tone={p.sovereign ? 'green' : 'gray'}>{p.sovereign ? 'IN' : 'EXT'}</Badge>
        </div>
      ),
    },
    { key: 'product', header: 'Product', width: '96px', value: (p) => p.productType, render: (p) => <span className="font-mono text-gray-600 text-[10px]">{p.productType}</span> },
    { key: 'orbit', header: 'Pass', width: '96px', value: (p) => p.orbitDirection ?? '', render: (p) => <span className="text-gray-600">{p.orbitDirection ?? '—'}</span> },
    {
      key: 'cases', header: 'Case', value: (p) => p.caseIds.join(', '),
      render: (p) => (
        <div className="flex flex-col">
          {p.caseIds.map((id) => (
            <button key={id} onClick={(e) => { e.stopPropagation(); navigate({ tab: 'Investigation', caseId: id }); }} className="text-left text-blue-600 hover:underline truncate">
              {world.cases.find((c) => c.id === id)?.title ?? id}
            </button>
          ))}
        </div>
      ),
    },
    {
      key: 'covers', header: 'Covers incident', width: '104px', align: 'center', value: (p) => (p.coversIncident ? 1 : 0),
      render: (p) => p.coversIncident ? <Badge tone="green"><CheckCircle2 className="w-2.5 h-2.5" /> Yes</Badge> : <Badge tone="gray">Nearby</Badge>,
    },
    {
      key: 'status', header: 'Archive', width: '90px', value: (p) => (p.online ? 1 : 0),
      render: (p) => <Badge tone={p.online ? 'blue' : 'amber'}>{p.online ? 'Online' : 'Offline'}</Badge>,
    },
    {
      key: 'processing', header: 'Processed', width: '100px', value: (p) => (processed.has(p.name.replace(/\.SAFE$/, '')) ? 1 : 0),
      render: (p) => processed.has(p.name.replace(/\.SAFE$/, ''))
        ? <Badge tone="green">Dark spots</Badge>
        : <ProvenanceBadge p="pending" />,
    },
  ];

  const sarSources = world.dataSources.filter((d) => d.kind === 'SAR');

  return (
    <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
      <aside className="w-full lg:w-[290px] xl:w-[350px] bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col flex-shrink-0 max-h-[46vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Satellite className="w-4 h-4 text-blue-600" /> SAR coverage &amp; tasking</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">{stats.scenes} real catalogue scenes for {world.cases.length} cases</p>
        </div>

        <Tabs active={tab} onChange={setTab} tabs={[
          { id: 'queue', label: 'Planning areas', count: world.aois.length },
          { id: 'feeds', label: 'SAR providers', count: sarSources.length },
        ]} />

        {tab === 'queue' && (
          <div className="flex-1 overflow-y-auto">
            <div className="p-2.5 border-b border-gray-200 space-y-1.5">
              <Button size="sm" variant="primary" className="w-full justify-center" onClick={() => setRequestOpen(true)} icon={<Plus className="w-3 h-3" />}>
                Add planning area
              </Button>
              <p className="text-[9.5px] text-gray-500 leading-snug">
                Areas are ordered by analyst priority. Each shows how many register incidents fall inside it and the most recent
                catalogued scene. Tasking a satellite needs NRSC access, so this page builds catalogue searches instead.
              </p>
            </div>
            {aois.map(({ aoi, incidents, scenes, latestScene }, i) => (
              <div key={aoi.id}
                onClick={() => setSelectedAoi(aoi.id === selectedAoi ? null : aoi.id)}
                className={`px-2.5 py-2 border-b border-gray-100 cursor-pointer ${
                  aoi.id === selectedAoi ? 'bg-blue-50 border-l-[3px] border-l-blue-600' : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'
                }`}>
                <div className="flex items-start gap-2">
                  <div className="flex flex-col items-center gap-0.5 flex-shrink-0 pt-0.5">
                    <button onClick={(e) => { e.stopPropagation(); reorderAoi(aoi.id, -1); }} disabled={i === 0} className="text-gray-400 hover:text-blue-600 disabled:opacity-25" title="Raise priority">
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <span className="text-[10px] font-black text-gray-700">{aoi.priority}</span>
                    <button onClick={(e) => { e.stopPropagation(); reorderAoi(aoi.id, 1); }} disabled={i === aois.length - 1} className="text-gray-400 hover:text-blue-600 disabled:opacity-25" title="Lower priority">
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1.5">
                      <p className="text-[11px] font-bold text-gray-900 leading-tight">{aoi.name}</p>
                      <button onClick={(e) => { e.stopPropagation(); toggleAoiPin(aoi.id); }}
                        className={`flex-shrink-0 ${aoi.pinned ? 'text-blue-600' : 'text-gray-300 hover:text-gray-500'}`}
                        title={aoi.pinned ? 'Unpin' : 'Pin to the top of the queue'}>
                        {aoi.pinned ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <div className="flex gap-2 mt-1 text-[9.5px] text-gray-500 flex-wrap">
                      <span><b className="text-gray-800">{incidents.length}</b> register incidents</span>
                      <span><b className="text-gray-800">{scenes.length}</b> scenes</span>
                      <span>latest {latestScene ? fmt.date(latestScene) : 'none'}</span>
                    </div>
                    {aoi.id === selectedAoi && (
                      <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                        <p className="text-[10px] text-gray-600 leading-snug">{aoi.rationale}</p>
                        {incidents.length > 0 && (
                          <p className="text-[9.5px] text-gray-500 leading-snug">{incidents.map((h) => `${h.name.split(' (')[0]} (${h.date.slice(0, 4)})`).join(' · ')}</p>
                        )}
                        <KeyValue cols={2} items={[
                          ['Requested by', aoi.requestedBy],
                          ['Bounds', `${aoi.bounds.south}–${aoi.bounds.north}°N, ${aoi.bounds.west}–${aoi.bounds.east}°E`],
                        ]} />
                        <Slider label="Search window" value={searchDays} onChange={setSearchDays} min={3} max={90} step={1} format={(v) => `last ${v} days`} />
                        <a href={cdseQueryUrl(aoi.bounds, new Date(now - searchDays * 86400_000), new Date(now))} target="_blank" rel="noreferrer"
                          className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700">
                          <ExternalLink className="w-3 h-3" /> Sentinel-1 catalogue (public)
                        </a>
                        <Button size="sm" className="w-full justify-center" icon={<FileDown className="w-3 h-3" />} onClick={() => {
                          const body = {
                            collections: BHOONIDHI_COLLECTIONS,
                            bbox: [aoi.bounds.west, aoi.bounds.south, aoi.bounds.east, aoi.bounds.north],
                            datetime: `${new Date(now - searchDays * 86400_000).toISOString()}/${new Date(now).toISOString()}`,
                            limit: 500,
                          };
                          triggerDownload(`${aoi.id}-bhoonidhi-search.json`, JSON.stringify({ endpoint: 'POST https://bhoonidhi-api.nrsc.gov.in/data/search', note: 'Requires a Bhoonidhi token (POST /auth/token).', body }, null, 2), 'application/json');
                        }}>
                          EOS-04 search request (Bhoonidhi)
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'feeds' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {sarSources.map((d) => (
              <div key={d.id} className="border border-gray-200 rounded p-2.5">
                <div className="flex justify-between items-start gap-2 mb-1">
                  <div className="min-w-0">
                    <span className="text-[11px] font-bold text-gray-900">{d.name}</span>
                    <p className="text-[10px] text-gray-500">{d.agency}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Interim fallback' ? 'teal' : d.status === 'Not configured' ? 'amber' : 'gray'}>{d.status}</Badge>
                    <Badge tone={d.sovereign ? 'green' : 'gray'}>{d.sovereign ? 'Indian' : 'Foreign'} · {d.role}</Badge>
                  </div>
                </div>
                <p className="text-[10px] text-gray-600 leading-snug">{d.message}</p>
              </div>
            ))}
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mt-2 mb-1">Search results per case</p>
              {world.cases.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[10px] py-1 border-b border-gray-100">
                  <span className="flex-1 truncate font-semibold text-gray-800" title={c.title}>{c.title}</span>
                  {c.detection.sarProviders.map((p) => (
                    <Badge key={p.name} tone={p.ok ? (p.count ? 'green' : 'gray') : 'amber'}>{p.name}: {p.ok ? p.count : 'n/a'}</Badge>
                  ))}
                </div>
              ))}
            </div>
            <InfoBanner tone="amber">
              EOS-04 is the primary source but needs Bhoonidhi credentials. Until then, Sentinel-1 is the interim fallback,
              which is why every scene listed is foreign.
            </InfoBanner>
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 min-h-[72vh] lg:min-h-0 flex flex-col flex-shrink-0 lg:flex-shrink">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<Database className="w-4 h-4" />} title="Catalogue scenes" value={stats.scenes} trend={`${stats.totalGb.toFixed(1)} GB if downloaded`} />
          <StatCard icon={<CheckCircle2 className="w-4 h-4" />} title="Cover the incident" value={stats.covering} trend="footprint contains the position" accent="green" />
          <StatCard icon={<Satellite className="w-4 h-4" />} title="Indian scenes" value={stats.sovereign} trend="EOS-04 access pending" accent="amber" />
          <StatCard icon={<Target className="w-4 h-4" />} title="Cases without cover" value={stats.casesWithout} trend="no footprint over the incident" accent={stats.casesWithout ? 'red' : 'green'} />
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            polygons={mapData.polygons} markers={mapData.markers}
            initialCentre={{ lat: 14, lon: 80 }} initialZoom={3.6}
            onMarkerClick={(m) => { if (!m.id.startsWith('h-')) navigate({ tab: 'Investigation', caseId: m.id }); }}
            fitTo={activeAoi ? boundsRing(activeAoi.aoi.bounds) : active ? active.footprint : undefined}
            fitKey={selectedAoi ?? selectedPass ?? 'none'}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="relative">
                  <button onClick={() => setLayersOpen((o) => !o)}
                    className="bg-white rounded shadow-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Layers
                  </button>
                  {layersOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-2.5 w-56 z-30">
                      <Toggle checked={layers.footprints} onChange={(v) => setLayers({ ...layers, footprints: v })} label="Scene footprints" count={passes.length} />
                      <Toggle checked={layers.aois} onChange={(v) => setLayers({ ...layers, aois: v })} label="Planning areas" count={world.aois.length} />
                      <Toggle checked={layers.cases} onChange={(v) => setLayers({ ...layers, cases: v })} label="Analysed cases" count={world.cases.length} />
                      <Toggle checked={layers.incidents} onChange={(v) => setLayers({ ...layers, incidents: v })} label="Register incidents" />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-4 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Platforms</h4>
                {platforms.map((s) => (
                  <div key={s} className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-2 rounded-sm" style={{ background: PLATFORM_COLORS[s] ?? '#2563eb' }} /><span className="text-gray-700">{s}</span>
                  </div>
                ))}
                <p className="text-[9px] text-gray-400 mt-1">Footprints from the CDSE catalogue.</p>
              </div>
            }
          />
        </div>

        <div className="h-[240px] border-t border-gray-200 bg-white flex-shrink-0 flex flex-col">
          <div className="px-3 py-1.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
            <span className="text-[11px] font-bold text-gray-700 flex items-center gap-2">Scene catalogue — {passes.length} <ProvenanceBadge p="real" /></span>
            <div className="flex items-center gap-2">
              {active && (
                <span className="text-[10px] text-gray-500 font-mono truncate max-w-[280px]" title={active.name}>{active.name}</span>
              )}
              <Select value={caseFilter} onChange={setCaseFilter} options={[{ value: 'all', label: 'All cases' }, ...world.cases.map((c) => ({ value: c.id, label: c.title }))]} />
              <Select value={platformFilter} onChange={setPlatformFilter} options={[{ value: 'all', label: 'All platforms' }, ...platforms.map((s) => ({ value: s, label: s }))]} />
              <Select value={coverFilter} onChange={setCoverFilter} options={[{ value: 'all', label: 'Any coverage' }, { value: 'covers', label: 'Covers incident' }, { value: 'nearby', label: 'Nearby only' }]} />
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <DataTable columns={passColumns} rows={passes} rowKey={(p) => p.id} dense
              selectedId={selectedPass} onRowClick={(p) => { setSelectedPass(p.id === selectedPass ? null : p.id); setSelectedAoi(null); }}
              initialSort={{ key: 'start', dir: 'desc' }}
              empty="No scenes match the filters." />
          </div>
        </div>
      </section>

      <RequestModal open={requestOpen} onClose={() => setRequestOpen(false)} />
    </main>
  );
}

function RequestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { world, notify, log, currentUser } = useStore();
  const [name, setName] = useState('');
  const [north, setNorth] = useState('15');
  const [south, setSouth] = useState('12');
  const [east, setEast] = useState('76');
  const [west, setWest] = useState('72');
  const [rationale, setRationale] = useState('');
  const [priority, setPriority] = useState(3);

  const nums = [north, south, east, west].map(Number);
  const valid = name.trim() && nums.every(Number.isFinite) && nums[0] > nums[1] && nums[2] > nums[3];

  const submit = () => {
    const id = `AOI-SES-${String(world.aois.length + 1).padStart(2, '0')}`;
    world.aois.push({
      id, name: name.trim(), priority,
      bounds: { north: nums[0], south: nums[1], east: nums[2], west: nums[3] },
      rationale: rationale.trim() || 'Analyst-requested planning area.',
      pinned: false, requestedBy: currentUser.role, provenance: 'session',
    });
    log({ actor: currentUser.name, role: currentUser.role, action: 'Planning area created', target: id, detail: name, category: 'System' });
    notify({ kind: 'success', title: 'Planning area added', body: `${name} added at priority ${priority}.` });
    setName(''); setRationale('');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add planning area"
      subtitle="Adds an area to the queue and lets you build catalogue searches for it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={submit}>Add area</Button></>}>
      <div className="space-y-3">
        <Field label="Area name"><TextInput value={name} onChange={setName} placeholder="e.g. Kakinada Anchorage Watch" /></Field>
        <div>
          <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Bounding box (decimal degrees)</p>
          <div className="grid grid-cols-4 gap-2">
            <Field label="North"><TextInput value={north} onChange={setNorth} mono /></Field>
            <Field label="South"><TextInput value={south} onChange={setSouth} mono /></Field>
            <Field label="East"><TextInput value={east} onChange={setEast} mono /></Field>
            <Field label="West"><TextInput value={west} onChange={setWest} mono /></Field>
          </div>
          {!valid && name.trim() && <p className="text-[10px] text-amber-700 mt-1">North must exceed South and East must exceed West.</p>}
        </div>
        <Slider label="Priority" value={priority} onChange={setPriority} min={1} max={9} step={1} format={(v) => `P${v}`} />
        <Field label="Rationale" hint="Shown to whoever reviews the queue.">
          <TextArea value={rationale} onChange={setRationale} rows={3} placeholder="Traffic pattern, ecological exposure, incident history…" />
        </Field>
      </div>
    </Modal>
  );
}
