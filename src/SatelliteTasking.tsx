import { useEffect, useMemo, useState } from 'react';
import {
  Satellite, Target, ChevronUp, ChevronDown, Pin, PinOff, CheckCircle2, Plus, Layers, Calendar,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon, type MapPath } from './components/MapView';
import {
  Badge, Button, KeyValue, Toggle, Select, InfoBanner, Modal, Field, TextInput,
  TextArea, Slider, StatCard, DataTable, type Column, Tabs,
} from './components/ui';
import { analysePolygon } from './lib/geo';
import type { SatellitePass } from './data/types';

const SENSOR_COLORS: Record<string, string> = {
  'EOS-04': '#2563eb', 'NISAR': '#7c3aed', 'Sentinel-1A': '#059669',
  'Sentinel-1C': '#0891b2', 'RISAT-2BR2': '#ea580c', 'Oceansat-3': '#db2777',
};

export default function SatelliteTasking() {
  const { world, now, navigate, toggleAoiPin, reorderAoi, consumeSection, notify, log, currentUser, revision } = useStore();
  const [basemap, setBasemap] = useState<BasemapStyle>('map');
  const [selectedPass, setSelectedPass] = useState<string | null>(null);
  const [selectedAoi, setSelectedAoi] = useState<string | null>(null);
  const [sensorFilter, setSensorFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tab, setTab] = useState('queue');
  const [requestOpen, setRequestOpen] = useState(false);
  const [layers, setLayers] = useState({ swaths: true, aois: true, cases: true });
  const [layersOpen, setLayersOpen] = useState(false);
  const [windowHours, setWindowHours] = useState(48);

  useEffect(() => {
    const s = consumeSection();
    if (s) { setSelectedAoi(s); setTab('queue'); }
  }, [consumeSection]);

  const passes = useMemo(() => {
    return world.passes
      .filter((p) => p.start > now - windowHours * 3600_000 && p.start < now + windowHours * 3600_000)
      .filter((p) => sensorFilter === 'all' || p.sensor === sensorFilter)
      .filter((p) => statusFilter === 'all' || p.status === statusFilter)
      .sort((a, b) => a.start - b.start);
  }, [world.passes, now, windowHours, sensorFilter, statusFilter]);

  const sensors = useMemo(() => Array.from(new Set(world.passes.map((p) => p.sensor))), [world.passes]);

  const aois = useMemo(() => {
    // Ranking blends historical hit rate with how long the area has gone uncovered.
    return [...world.aois]
      .map((a) => {
        const hoursSince = (now - a.lastCovered) / 3600_000;
        const staleness = Math.min(2.2, hoursSince / 14);
        return { aoi: a, hoursSince, score: a.hitRate * (0.55 + staleness) };
      })
      .sort((x, y) => {
        if (x.aoi.pinned !== y.aoi.pinned) return x.aoi.pinned ? -1 : 1;
        return x.aoi.priority - y.aoi.priority;
      });
  }, [world.aois, now, revision]);

  const active = passes.find((p) => p.id === selectedPass) ?? null;
  const activeAoi = world.aois.find((a) => a.id === selectedAoi) ?? null;

  const mapData = useMemo(() => {
    const polygons: MapPolygon[] = [];
    const paths: MapPath[] = [];
    const markers: MapMarker[] = [];

    if (layers.aois) {
      for (const a of world.aois) {
        const { north, south, east, west } = a.bounds;
        const sel = a.id === selectedAoi;
        polygons.push({
          id: a.id,
          rings: [[{ lat: north, lon: west }, { lat: north, lon: east }, { lat: south, lon: east }, { lat: south, lon: west }]],
          fill: sel ? 'rgba(37,99,235,0.2)' : a.pinned ? 'rgba(37,99,235,0.1)' : 'rgba(100,116,139,0.07)',
          stroke: sel ? '#1d4ed8' : a.pinned ? '#2563eb' : '#64748b',
          strokeWidth: sel ? 2.2 : 1.2, dash: a.pinned ? undefined : '5 4', z: 1, selected: sel,
        });
      }
    }

    if (layers.swaths) {
      for (const p of passes) {
        const sel = p.id === selectedPass;
        const colour = SENSOR_COLORS[p.sensor] ?? '#2563eb';
        // Draw the swath as a band either side of the ground track.
        const halfDeg = p.swathKm / 2 / 111;
        const left = p.track.map((t) => ({ lat: t.lat, lon: t.lon - halfDeg }));
        const right = [...p.track].reverse().map((t) => ({ lat: t.lat, lon: t.lon + halfDeg }));
        polygons.push({
          id: `sw-${p.id}`, rings: [[...left, ...right]],
          fill: sel ? `${colour}33` : `${colour}12`, stroke: colour,
          strokeWidth: sel ? 1.8 : 0.7, opacity: sel ? 1 : p.start > now ? 0.55 : 0.32, z: sel ? 4 : 2,
        });
        paths.push({
          id: `gt-${p.id}`, points: p.track, stroke: colour,
          strokeWidth: sel ? 2.2 : 0.9, dash: p.start > now ? '6 4' : undefined,
          opacity: sel ? 1 : 0.5, z: sel ? 5 : 3,
        });
      }
    }

    if (layers.cases) {
      for (const c of world.cases) {
        const shape = analysePolygon(c.detection.polygon.ring);
        markers.push({
          id: c.id, position: shape.centroid, kind: 'case', color: '#111827', size: 5,
          label: c.id, sublabel: `${c.detection.sensor} · ${fmt.utcShort(c.detection.acquiredAt)}`, z: 7,
        });
      }
    }

    return { polygons, paths, markers };
  }, [passes, world.aois, world.cases, layers, selectedPass, selectedAoi, now]);

  const stats = useMemo(() => {
    const upcoming = world.passes.filter((p) => p.start > now).length;
    const last24 = world.passes.filter((p) => p.start > now - 86400_000 && p.start <= now);
    const failed = last24.filter((p) => p.status === 'Failed').length;
    const withDetections = world.passes.filter((p) => p.detectionIds.length > 0).length;
    return { upcoming, last24: last24.length, failed, withDetections };
  }, [world.passes, now, revision]);

  const passColumns: Column<SatellitePass>[] = [
    {
      key: 'start', header: 'Start (UTC)', width: '116px', value: (p) => p.start,
      render: (p) => (
        <div>
          <div className="font-mono text-gray-800">{fmt.utcShort(p.start)}</div>
          <div className={`text-[9px] ${p.start > now ? 'text-blue-600 font-semibold' : 'text-gray-400'}`}>{fmt.ago(p.start, now)}</div>
        </div>
      ),
    },
    {
      key: 'sensor', header: 'Sensor', width: '106px', value: (p) => p.sensor,
      render: (p) => (
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: SENSOR_COLORS[p.sensor] }} />
          <span className="font-semibold text-gray-800">{p.sensor}</span>
        </div>
      ),
    },
    { key: 'orbit', header: 'Orbit', width: '64px', align: 'right', value: (p) => p.orbitNumber, render: (p) => <span className="font-mono text-gray-600">{p.orbitNumber}</span> },
    { key: 'swath', header: 'Swath', width: '62px', align: 'right', value: (p) => p.swathKm, render: (p) => <span className="font-mono text-gray-600">{p.swathKm} km</span> },
    {
      key: 'aoi', header: 'Tasked AOI', width: '116px', value: (p) => p.taskedAoi ?? '',
      render: (p) => p.taskedAoi
        ? <span className="text-gray-700 truncate">{world.aois.find((a) => a.id === p.taskedAoi)?.name ?? p.taskedAoi}</span>
        : <span className="text-gray-300">Routine</span>,
    },
    {
      key: 'status', header: 'Status', width: '92px', value: (p) => p.status,
      render: (p) => (
        <Badge tone={p.status === 'Processed' ? 'green' : p.status === 'Scheduled' ? 'blue' : p.status === 'Failed' ? 'red' : 'amber'}>
          {p.status}
        </Badge>
      ),
    },
    {
      key: 'det', header: 'Detections', width: '76px', align: 'center', value: (p) => p.detectionIds.length,
      render: (p) => p.detectionIds.length > 0
        ? <Badge tone="red">{p.detectionIds.length}</Badge>
        : <span className="text-gray-300">—</span>,
    },
  ];

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[350px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Satellite className="w-4 h-4 text-blue-600" /> Satellite tasking</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">{stats.upcoming} passes scheduled · {stats.last24} in the last 24 h</p>
        </div>

        <Tabs active={tab} onChange={setTab} tabs={[
          { id: 'queue', label: 'Priority queue', count: world.aois.length },
          { id: 'feeds', label: 'Feed health' },
        ]} />

        {tab === 'queue' && (
          <div className="flex-1 overflow-y-auto">
            <div className="p-2.5 border-b border-gray-200">
              <Button size="sm" variant="primary" className="w-full justify-center" onClick={() => setRequestOpen(true)} icon={<Plus className="w-3 h-3" />}>
                Request new tasking
              </Button>
              <p className="text-[9.5px] text-gray-500 mt-1.5 leading-snug">
                Areas are ranked by historical hit rate weighted by how long they have gone uncovered.
                Pinned areas hold the top of the queue regardless of score.
              </p>
            </div>
            {aois.map(({ aoi, hoursSince, score }, i) => (
              <div key={aoi.id}
                onClick={() => setSelectedAoi(aoi.id === selectedAoi ? null : aoi.id)}
                className={`px-2.5 py-2 border-b border-gray-100 cursor-pointer ${
                  aoi.id === selectedAoi ? 'bg-blue-50 border-l-[3px] border-l-blue-600' : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'
                }`}>
                <div className="flex items-start gap-2">
                  <div className="flex flex-col items-center gap-0.5 flex-shrink-0 pt-0.5">
                    <button onClick={(e) => { e.stopPropagation(); reorderAoi(aoi.id, -1); }}
                      disabled={i === 0} className="text-gray-400 hover:text-blue-600 disabled:opacity-25" title="Raise priority">
                      <ChevronUp className="w-3 h-3" />
                    </button>
                    <span className="text-[10px] font-black text-gray-700">{aoi.priority}</span>
                    <button onClick={(e) => { e.stopPropagation(); reorderAoi(aoi.id, 1); }}
                      disabled={i === aois.length - 1} className="text-gray-400 hover:text-blue-600 disabled:opacity-25" title="Lower priority">
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
                    <div className="flex gap-2 mt-1 text-[9.5px] text-gray-500">
                      <span>Hit rate <b className="text-gray-800">{aoi.hitRate.toFixed(1)}</b>/100</span>
                      <span>Covered <b className="text-gray-800">{hoursSince.toFixed(0)} h</b> ago</span>
                    </div>
                    <div className="mt-1 h-1 bg-gray-200 rounded overflow-hidden">
                      <div className="h-full bg-blue-500 rounded" style={{ width: `${Math.min(100, (score / 40) * 100)}%` }} />
                    </div>
                    {aoi.id === selectedAoi && (
                      <div className="mt-2 space-y-1.5">
                        <p className="text-[10px] text-gray-600 leading-snug">{aoi.rationale}</p>
                        <KeyValue cols={2} items={[
                          ['Requested by', aoi.requestedBy],
                          ['Tasking score', score.toFixed(1)],
                          ['Bounds N/S', `${aoi.bounds.north}° / ${aoi.bounds.south}°`],
                          ['Bounds E/W', `${aoi.bounds.east}° / ${aoi.bounds.west}°`],
                        ]} />
                        <Button size="sm" className="w-full justify-center" onClick={(e: any) => { e?.stopPropagation?.();
                          const next = world.passes.find((p) => p.start > now);
                          if (next) {
                            next.taskedAoi = aoi.id;
                            log({ actor: currentUser.name, role: currentUser.role, action: 'Pass tasked', target: next.id, detail: `${next.sensor} orbit ${next.orbitNumber} assigned to ${aoi.name}`, category: 'System' });
                            notify({ kind: 'success', title: 'Next pass tasked', body: `${next.sensor} at ${fmt.utc(next.start)} assigned to ${aoi.name}.` });
                            setSelectedPass(next.id);
                          }
                        }} icon={<Target className="w-3 h-3" />}>
                          Assign next available pass
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
            {world.dataSources.filter((d) => d.kind === 'Satellite' || d.kind === 'AIS' || d.kind === 'Ocean Model').map((d) => (
              <div key={d.id} className="border border-gray-200 rounded p-2.5">
                <div className="flex justify-between items-start gap-2 mb-1">
                  <span className="text-[11px] font-bold text-gray-900">{d.name}</span>
                  <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Degraded' ? 'amber' : 'red'}>{d.status}</Badge>
                </div>
                <KeyValue cols={2} items={[
                  ['Provider', d.provider], ['Latency', `${d.latencyMs} ms`],
                  ['Last sync', fmt.ago(d.lastSync, now)], ['Quota', `${d.quotaUsedPct}%`],
                ]} />
                <div className="mt-1.5 h-1 bg-gray-200 rounded overflow-hidden">
                  <div className={`h-full rounded ${d.quotaUsedPct > 80 ? 'bg-red-500' : d.quotaUsedPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${d.quotaUsedPct}%` }} />
                </div>
              </div>
            ))}
            <InfoBanner tone="amber">
              A system this sensor-dependent needs its plumbing visible. Quota exhaustion on the S-AIS feed is
              the most common cause of an attribution gap, and it is silent unless surfaced here.
            </InfoBanner>
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<Calendar className="w-4 h-4" />} title="Scheduled" value={stats.upcoming} trend="upcoming passes" />
          <StatCard icon={<CheckCircle2 className="w-4 h-4" />} title="Last 24 h" value={stats.last24} trend={`${stats.failed} failed`} accent={stats.failed > 0 ? 'amber' : 'green'} />
          <StatCard icon={<Target className="w-4 h-4" />} title="Productive passes" value={stats.withDetections} trend="produced a detection" accent="red" />
          <div className="ml-auto flex items-center gap-2">
            <Select value={sensorFilter} onChange={setSensorFilter}
              options={[{ value: 'all', label: 'All sensors' }, ...sensors.map((s) => ({ value: s, label: s }))]} />
            <Select value={statusFilter} onChange={setStatusFilter}
              options={[{ value: 'all', label: 'All statuses' }, ...['Scheduled', 'Acquiring', 'Downlinked', 'Processed', 'Failed'].map((s) => ({ value: s, label: s }))]} />
            <div className="w-40"><Slider label="Window" value={windowHours} onChange={setWindowHours} min={12} max={120} step={6} format={(v) => `± ${v} h`} /></div>
          </div>
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            polygons={mapData.polygons} paths={mapData.paths} markers={mapData.markers}
            initialCentre={{ lat: 14, lon: 80 }} initialZoom={3.6}
            onMarkerClick={(m) => navigate({ tab: 'Investigation', caseId: m.id })}
            fitTo={activeAoi ? [
              { lat: activeAoi.bounds.north, lon: activeAoi.bounds.west },
              { lat: activeAoi.bounds.south, lon: activeAoi.bounds.east },
            ] : undefined}
            fitKey={selectedAoi ?? 'none'}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="relative">
                  <button onClick={() => setLayersOpen((o) => !o)}
                    className="bg-white rounded shadow-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Layers
                  </button>
                  {layersOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-2.5 w-52 z-30">
                      <Toggle checked={layers.swaths} onChange={(v) => setLayers({ ...layers, swaths: v })} label="Pass swaths" count={passes.length} />
                      <Toggle checked={layers.aois} onChange={(v) => setLayers({ ...layers, aois: v })} label="Areas of interest" count={world.aois.length} />
                      <Toggle checked={layers.cases} onChange={(v) => setLayers({ ...layers, cases: v })} label="Detections" count={world.cases.length} />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Sensors</h4>
                {sensors.map((s) => (
                  <div key={s} className="flex items-center gap-2 mb-1">
                    <div className="w-3 h-2 rounded-sm" style={{ background: SENSOR_COLORS[s] }} /><span className="text-gray-700">{s}</span>
                  </div>
                ))}
                <div className="border-t border-gray-200 mt-1.5 pt-1.5 text-gray-600">
                  <div className="flex items-center gap-2"><div className="w-4 border-t-2 border-dashed border-gray-500" /><span>Scheduled (future)</span></div>
                  <div className="flex items-center gap-2 mt-0.5"><div className="w-4 border-t-2 border-gray-500" /><span>Completed</span></div>
                </div>
              </div>
            }
          />
        </div>

        <div className="h-[230px] border-t border-gray-200 bg-white flex-shrink-0 flex flex-col">
          <div className="px-3 py-1.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
            <span className="text-[11px] font-bold text-gray-700">Pass schedule — {passes.length} within ± {windowHours} h</span>
            {active && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-gray-500">Selected:</span>
                <span className="font-bold text-gray-900">{active.sensor} orbit {active.orbitNumber}</span>
                <Badge tone={active.status === 'Processed' ? 'green' : active.status === 'Scheduled' ? 'blue' : active.status === 'Failed' ? 'red' : 'amber'}>{active.status}</Badge>
                {active.detectionIds.length > 0 && (
                  <Button size="sm" onClick={() => {
                    const c = world.cases.find((x) => active.detectionIds.includes(x.detection.id));
                    if (c) navigate({ tab: 'Investigation', caseId: c.id });
                  }}>Open detection</Button>
                )}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <DataTable columns={passColumns} rows={passes} rowKey={(p) => p.id} dense
              selectedId={selectedPass} onRowClick={(p) => setSelectedPass(p.id === selectedPass ? null : p.id)}
              empty="No passes in this window match the filters." />
          </div>
        </div>
      </section>

      <RequestModal open={requestOpen} onClose={() => setRequestOpen(false)} />
    </main>
  );
}

function RequestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { world, notify, log, currentUser, now } = useStore();
  const [name, setName] = useState('');
  const [north, setNorth] = useState('15');
  const [south, setSouth] = useState('12');
  const [east, setEast] = useState('76');
  const [west, setWest] = useState('72');
  const [rationale, setRationale] = useState('');
  const [priority, setPriority] = useState(3);

  const submit = () => {
    const id = `AOI-${name.slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'NEW'}`;
    world.aois.push({
      id, name: name.trim(), priority,
      bounds: { north: Number(north), south: Number(south), east: Number(east), west: Number(west) },
      hitRate: 0, lastCovered: now - 72 * 3600_000, rationale: rationale.trim() || 'Analyst-requested area of interest.',
      pinned: false, requestedBy: currentUser.role,
    });
    log({ actor: currentUser.name, role: currentUser.role, action: 'Tasking area created', target: id, detail: name, category: 'System' });
    notify({ kind: 'success', title: 'Tasking area added', body: `${name} entered the priority queue at position ${priority}.` });
    setName(''); setRationale('');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Request satellite tasking"
      subtitle="Adds an area of interest to the priority queue for the next available pass."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={submit}>Submit request</Button></>}>
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
        </div>
        <Slider label="Initial priority" value={priority} onChange={setPriority} min={1} max={9} step={1} format={(v) => `P${v}`} />
        <Field label="Rationale" hint="Recorded against the request and shown to whoever reviews the queue.">
          <TextArea value={rationale} onChange={setRationale} rows={3}
            placeholder="Why this area needs coverage — traffic pattern, ecological exposure, incident history…" />
        </Field>
        <InfoBanner tone="blue">
          A new area starts with no hit-rate history, so it ranks on staleness alone until it produces its first
          detection. That is deliberate: an unproven area should not outrank a corridor with a measured record.
        </InfoBanner>
      </div>
    </Modal>
  );
}
