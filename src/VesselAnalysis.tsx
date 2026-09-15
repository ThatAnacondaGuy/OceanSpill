import { useEffect, useMemo, useState } from 'react';
import {
  Ship, Anchor, AlertTriangle, EyeOff, Layers, MapPin,
  TrendingDown, Gauge, Flag, Shield, Clock, ArrowRight, Radio,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPath, type MapPolygon } from './components/MapView';
import {
  DataTable, SearchInput, Select, Badge, Button, KeyValue, Toggle, Tabs, InfoBanner,
  EmptyState, TimeScrubber, usePlayback, LineChart, ExportButton, downloadCsv, StatCard, ProvenanceBadge, type Column,
} from './components/ui';
import { CORRIDORS, ECOLOGICAL_AREAS } from './data/geography';
import { analyseBehaviour, interpolateTrack } from './engine/attribution';
import type { Vessel } from './data/types';

export default function VesselAnalysis() {
  const { world, selectedMmsi, setSelectedMmsi, selectedCaseId, setSelectedCaseId, navigate, getAnalysis, revision } = useStore();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [provenanceFilter, setProvenanceFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [onlyDark, setOnlyDark] = useState(false);
  const [basemap, setBasemap] = useState<BasemapStyle>('dark');
  const [tab, setTab] = useState('particulars');
  const [layers, setLayers] = useState({ tracks: true, gaps: true, corridors: false, esa: false, vessels: true, anchors: true });
  const [layersOpen, setLayersOpen] = useState(false);

  // Tracks exist per case, so the page always works inside one case's AIS window.
  const selectedVesselAnyCase = selectedMmsi ? world.vesselsByMmsi.get(selectedMmsi) : undefined;
  const caseId = selectedVesselAnyCase?.caseId ?? selectedCaseId ?? world.cases[0]?.id ?? '';
  const activeCase = world.cases.find((c) => c.id === caseId) ?? null;
  const setCase = (id: string) => { setSelectedCaseId(id); setSelectedMmsi(null); };

  const windowBounds = useMemo(
    () => activeCase ? { min: activeCase.aisWindow.start, max: activeCase.aisWindow.end } : { min: 0, max: 1 },
    [activeCase]
  );
  const playback = usePlayback(windowBounds.min, windowBounds.max, windowBounds.max);
  useEffect(() => {
    if (activeCase) playback.setValue(Math.min(windowBounds.max, activeCase.detection.acquiredAt));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const caseVessels = useMemo(() => world.vessels.filter((v) => v.caseId === caseId), [world.vessels, caseId]);

  const darkMmsis = useMemo(() => {
    const s = new Set<string>();
    for (const v of caseVessels) if ((world.tracks.get(v.mmsi)?.gaps.length ?? 0) > 0) s.add(v.mmsi);
    return s;
  }, [caseVessels, world.tracks, revision]);

  const analysis = activeCase ? getAnalysis(activeCase.id) : null;
  const rankOf = useMemo(() => new Map((analysis?.ranked ?? []).map((r) => [r.mmsi, r])), [analysis]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return caseVessels.filter((v) => {
      if (q && !`${v.name} ${v.mmsiNumber ?? ''} ${v.imo ?? ''} ${v.flag ?? ''} ${v.type} ${v.operator ?? ''}`.toLowerCase().includes(q)) return false;
      if (typeFilter !== 'all' && v.type !== typeFilter) return false;
      if (provenanceFilter !== 'all' && v.provenance !== provenanceFilter) return false;
      if (roleFilter !== 'all' && v.role !== roleFilter) return false;
      if (onlyDark && !darkMmsis.has(v.mmsi)) return false;
      return true;
    });
  }, [caseVessels, query, typeFilter, provenanceFilter, roleFilter, onlyDark, darkMmsis]);

  const selected = caseVessels.find((v) => v.mmsi === selectedMmsi) ?? filtered.find((v) => v.provenance === 'real') ?? filtered[0] ?? null;
  const selectedTrack = selected ? world.tracks.get(selected.mmsi) : undefined;

  const behaviour = useMemo(
    () => (selectedTrack ? analyseBehaviour(selectedTrack, windowBounds.min, windowBounds.max) : null),
    [selectedTrack, windowBounds]
  );

  const mapData = useMemo(() => {
    const markers: MapMarker[] = [];
    const paths: MapPath[] = [];
    const polygons: MapPolygon[] = [];

    if (layers.esa) {
      for (const a of ECOLOGICAL_AREAS) {
        polygons.push({ id: a.id, rings: [a.ring], fill: 'rgba(16,185,129,0.15)', stroke: '#059669', strokeWidth: 1, z: 0 });
      }
    }
    if (layers.corridors) {
      for (const c of CORRIDORS) {
        paths.push({ id: c.id, points: c.waypoints, stroke: '#3b82f6', strokeWidth: 1.4, dash: '8 5', opacity: 0.45, z: 1 });
      }
    }
    if (activeCase) {
      polygons.push({ id: 'slick', rings: [activeCase.detection.polygon.ring], fill: 'rgba(15,23,42,0.6)', stroke: '#f8fafc', strokeWidth: 1.2, z: 3, effect: 'oil' });
      markers.push({
        id: `case-${activeCase.id}`, position: activeCase.facts.incident.position, kind: 'origin', color: '#f59e0b', size: 7,
        label: activeCase.title, sublabel: `Reported incident ± ${activeCase.facts.incident.positionPrecisionKm} km`, z: 8,
      });
    }

    for (const v of filtered) {
      const track = world.tracks.get(v.mmsi);
      if (!track) continue;
      const isSel = selected?.mmsi === v.mmsi;
      const hasGap = darkMmsis.has(v.mmsi);
      const color = isSel ? '#22d3ee' : v.provenance === 'real' ? '#f59e0b' : hasGap ? '#ef4444' : rankOf.get(v.mmsi)?.rank === 1 ? '#f97316' : '#94a3b8';

      if (layers.tracks) {
        const pts = track.pings.filter((p) => p.t <= playback.value);
        if (pts.length > 1) {
          paths.push({ id: `t-${v.mmsi}`, points: pts, stroke: color, strokeWidth: isSel ? 2.4 : 1, opacity: isSel ? 1 : 0.42, z: isSel ? 5 : 2 });
        }
      }
      if (layers.gaps && hasGap) {
        for (const g of track.gaps) {
          if (g.start > playback.value) continue;
          const a = track.pings.filter((p) => p.t <= g.start).pop();
          const b = track.pings.find((p) => p.t >= g.end);
          if (a && b) paths.push({ id: `g-${v.mmsi}-${g.start}`, points: [a, b], stroke: '#ef4444', strokeWidth: 1.8, dash: '3 5', opacity: 0.85, z: 4 });
        }
      }
      if (layers.vessels) {
        const at = interpolateTrack(track, playback.value);
        const darkNow = track.gaps.some((g) => playback.value >= g.start && playback.value <= g.end);
        const pos = at ?? (darkNow ? track.pings.filter((p) => p.t < playback.value).pop() : undefined);
        if (pos) {
          markers.push({
            id: v.mmsi, position: pos, kind: 'vessel', color: darkNow ? '#ef4444' : color,
            size: isSel ? 8 : v.provenance === 'real' ? 6.5 : 5, headingDeg: pos.cog, selected: isSel, pulse: darkNow,
            label: v.name, sublabel: `${v.type} · ${v.provenance === 'real' ? 'real vessel' : 'synthetic'}${darkNow ? ' · AIS DARK' : ''}`,
            z: isSel ? 9 : 6,
            meta: { ID: fmt.vesselId(v), Speed: `${pos.sog.toFixed(1)} kn`, Course: `${pos.cog.toFixed(0)}°`, Track: track.provenance },
          });
        }
      }
      if (layers.anchors && isSel) {
        v.anchors.forEach((an, i) => {
          markers.push({
            id: `anchor-${i}`, position: { lat: an.lat, lon: an.lon }, kind: 'sighting', color: '#10b981', size: 6,
            label: an.event, sublabel: `${fmt.utcShort(Date.parse(an.time))} · ${an.source}`, z: 10,
            meta: { 'Position ±': `${an.positionPrecisionKm} km`, Source: an.source },
          });
        });
      }
    }
    return { markers, paths, polygons };
  }, [filtered, world.tracks, selected, playback.value, layers, darkMmsis, rankOf, activeCase]);

  const columns: Column<Vessel>[] = [
    {
      key: 'name', header: 'Vessel', value: (v) => v.name,
      render: (v) => (
        <div className="min-w-0">
          <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1">
            <span className="font-bold text-gray-900 leading-snug">{v.name}</span>
            <ProvenanceBadge p={v.provenance} />
            {darkMmsis.has(v.mmsi) && <Badge tone="red">GAP</Badge>}
          </div>
          <div className="text-[11px] text-gray-500 font-mono">{fmt.vesselId(v)}</div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', width: '76px', value: (v) => v.role, render: (v) => <Badge tone={v.role === 'source' ? 'red' : v.role === 'responder' ? 'blue' : v.role === 'candidate' ? 'amber' : 'gray'}>{v.role}</Badge> },
    {
      key: 'rank', header: 'Rank', width: '48px', align: 'center', value: (v) => rankOf.get(v.mmsi)?.rank ?? 999,
      render: (v) => rankOf.get(v.mmsi) ? <span className="font-mono font-bold text-gray-800">{rankOf.get(v.mmsi)!.rank}</span> : <span className="text-gray-300">—</span>,
    },
  ];

  const speedSeries = useMemo(() => {
    if (!selectedTrack) return [];
    const pts = selectedTrack.pings.filter((p) => p.t >= windowBounds.min && p.t <= windowBounds.max);
    const step = Math.max(1, Math.ceil(pts.length / 120));
    return pts.filter((_, i) => i % step === 0).map((p) => p.sog);
  }, [selectedTrack, windowBounds]);

  const windowHours = (windowBounds.max - windowBounds.min) / 3600_000;

  return (
    <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
      <aside className="w-full lg:w-[300px] xl:w-[360px] bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col flex-shrink-0 max-h-[46vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Anchor className="w-4 h-4 text-blue-600" /> Vessel traffic</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {caseVessels.filter((v) => v.provenance === 'real').length} real · {caseVessels.filter((v) => v.provenance === 'synthetic').length} synthetic · {darkMmsis.size} with AIS gaps
          </p>
        </div>
        <div className="p-2 space-y-3 border-b border-gray-200">
          <Select value={caseId} onChange={setCase} options={world.cases.map((c) => ({ value: c.id, label: c.title }))} />
          <SearchInput value={query} onChange={setQuery} placeholder="Name, MMSI, IMO, operator…" />
          <div className="grid grid-cols-3 gap-2">
            <Select value={provenanceFilter} onChange={setProvenanceFilter}
              options={[{ value: 'all', label: 'All data' }, { value: 'real', label: 'Real' }, { value: 'synthetic', label: 'Synthetic' }]} />
            <Select value={roleFilter} onChange={setRoleFilter}
              options={[{ value: 'all', label: 'All roles' }, ...Array.from(new Set(caseVessels.map((v) => v.role))).map((r) => ({ value: r, label: r }))]} />
            <Select value={typeFilter} onChange={setTypeFilter}
              options={[{ value: 'all', label: 'All types' }, ...Array.from(new Set(caseVessels.map((v) => v.type))).sort().map((t) => ({ value: t, label: t }))]} />
          </div>
          <Toggle checked={onlyDark} onChange={setOnlyDark} label="Only vessels with transmission gaps" count={darkMmsis.size} />
        </div>
        <div className="flex-1 min-h-0">
          <DataTable columns={columns} rows={filtered} rowKey={(v) => v.mmsi} dense
            selectedId={selected?.mmsi} onRowClick={(v) => setSelectedMmsi(v.mmsi)}
            initialSort={{ key: 'rank', dir: 'asc' }} />
        </div>
        <div className="p-2 border-t border-gray-200 flex items-center justify-between gap-2">
          <span className="text-[11px] text-gray-500">AIS: {activeCase?.aisProvider}</span>
          <ExportButton onExport={() => downloadCsv(`oceanspill-vessels-${caseId}.csv`, columns.filter((c) => c.value), filtered)} />
        </div>
      </aside>

      <section className="flex-1 min-w-0 min-h-[72vh] lg:min-h-0 flex flex-col flex-shrink-0 lg:flex-shrink">
        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            markers={mapData.markers}
            paths={mapData.paths}
            polygons={mapData.polygons}
            initialCentre={{ lat: 13, lon: 80 }} initialZoom={3.9}
            fitTo={activeCase ? [
              { lat: activeCase.facts.incident.position.lat - 0.6, lon: activeCase.facts.incident.position.lon - 0.6 },
              { lat: activeCase.facts.incident.position.lat + 0.6, lon: activeCase.facts.incident.position.lon + 0.6 },
            ] : undefined}
            fitKey={caseId}
            onMarkerClick={(m) => { if (world.vesselsByMmsi.has(m.id)) setSelectedMmsi(m.id); }}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="relative">
                  <button onClick={() => setLayersOpen((o) => !o)}
                    className="bg-white rounded shadow-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Layers
                  </button>
                  {layersOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-3 w-56 z-30">
                      <Toggle checked={layers.vessels} onChange={(v) => setLayers({ ...layers, vessels: v })} label="Vessel positions" />
                      <Toggle checked={layers.tracks} onChange={(v) => setLayers({ ...layers, tracks: v })} label="AIS tracks" />
                      <Toggle checked={layers.gaps} onChange={(v) => setLayers({ ...layers, gaps: v })} label="Transmission gaps" count={darkMmsis.size} />
                      <Toggle checked={layers.anchors} onChange={(v) => setLayers({ ...layers, anchors: v })} label="Reported positions (selected)" />
                      <Toggle checked={layers.corridors} onChange={(v) => setLayers({ ...layers, corridors: v })} label="Indicative routes" count={CORRIDORS.length} />
                      <Toggle checked={layers.esa} onChange={(v) => setLayers({ ...layers, esa: v })} label="Sensitive areas" />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-3 text-[11px] shadow-lg max-w-[220px]">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Traffic</h4>
                <Dot color="#22d3ee" label="Selected vessel" />
                <Dot color="#f59e0b" label="Real vessel (synthetic track)" />
                <Dot color="#ef4444" label="AIS gap in window" />
                <Dot color="#94a3b8" label="Synthetic background traffic" />
                <Dot color="#10b981" label="Reported real position" />
                <p className="text-[10.5px] text-gray-500 mt-1.5 leading-normal">Tracks are synthetic, passing through reported real positions where available.</p>
              </div>
            }
          />
        </div>
        <TimeScrubber
          min={windowBounds.min} max={windowBounds.max} value={playback.value} onChange={playback.setValue}
          format={(v) => fmt.utc(v)} playing={playback.playing} onPlayToggle={playback.toggle}
          speed={playback.speed} onSpeedChange={playback.setSpeed}
          marks={activeCase ? [
            { t: activeCase.incidentTime, color: '#dc2626', label: 'Reported incident' },
            { t: activeCase.detection.acquiredAt, color: '#2563eb', label: 'Reference observation' },
            ...(selected?.anchors ?? []).map((a) => ({ t: Date.parse(a.time), color: '#10b981', label: a.event })),
          ].filter((m) => m.t >= windowBounds.min && m.t <= windowBounds.max) : []}
        />
      </section>

      <aside className="w-full lg:w-[300px] xl:w-[360px] bg-white border-t lg:border-t-0 lg:border-l border-gray-200 flex flex-col flex-shrink-0 h-[82vh] lg:h-auto">
        {!selected ? (
          <EmptyState icon={<Ship className="w-10 h-10" />} title="No vessel selected" body="Pick a vessel from the list or the map." />
        ) : (
          <>
            <div className="px-3 py-2.5 border-b border-gray-200">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-bold text-gray-900 text-sm truncate">{selected.name}</h3>
                  <p className="text-[11px] text-gray-500 font-mono">{fmt.vesselId(selected)}</p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <ProvenanceBadge p={selected.provenance} />
                  {selected.sanctioned && <Badge tone="slate">SANCTIONED</Badge>}
                  {darkMmsis.has(selected.mmsi) && <Badge tone="red">AIS GAPS</Badge>}
                </div>
              </div>
              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                <Badge tone="blue">{selected.type}</Badge>
                <Badge tone={selected.role === 'source' ? 'red' : 'gray'}>{selected.role}</Badge>
                {selected.flag && (
                  <Badge tone={selected.flagRisk === 'Black List' ? 'red' : selected.flagRisk === 'Grey List' ? 'amber' : 'gray'}>
                    <Flag className="w-2.5 h-2.5" /> {selected.flag}
                  </Badge>
                )}
              </div>
            </div>

            <Tabs fill active={tab} onChange={setTab} tabs={[
              { id: 'particulars', label: 'Record' },
              { id: 'behaviour', label: 'Behaviour' },
              { id: 'cases', label: 'Scoring' },
            ]} />

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {tab === 'particulars' && (
                <>
                  <KeyValue cols={2} items={[
                    ['MMSI', selected.mmsiNumber ?? 'Not public'], ['IMO', selected.imo ?? '—'],
                    ['Flag', selected.flag ?? '—'], ['Operator', selected.operator ?? 'Not published'],
                    ['Role in case', selected.role], ['Facility', selected.isFacility ? 'Yes' : 'No'],
                  ]} />
                  {selected.note && <p className="text-[11px] text-gray-600 leading-normal">{selected.note}</p>}

                  {selected.provenance === 'synthetic' && (
                    <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
                      <b>Synthetic vessel.</b> Name, MMSI (999…), registry history and track are generated to populate background traffic
                      for attribution. It does not represent a real ship.
                    </InfoBanner>
                  )}

                  {selected.anchors.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><MapPin className="w-3 h-3" /> Reported positions</p>
                      <div className="space-y-1.5">
                        {selected.anchors.map((a, i) => (
                          <button key={i} onClick={() => playback.setValue(Math.max(windowBounds.min, Math.min(windowBounds.max, Date.parse(a.time))))}
                            className="w-full text-left bg-emerald-50/60 border border-emerald-200 rounded px-2 py-1.5 hover:border-emerald-400">
                            <div className="flex justify-between gap-2">
                              <span className="text-[11.5px] font-bold text-gray-900">{a.event}</span>
                              <ProvenanceBadge p="real" />
                            </div>
                            <p className="text-[11px] font-mono text-gray-600">{fmt.utcShort(Date.parse(a.time))} · {a.lat.toFixed(3)}, {a.lon.toFixed(3)} ± {a.positionPrecisionKm} km</p>
                            <p className="text-[10.5px] text-gray-500">{a.source}{a.after ? ` · then ${a.after}` : ''}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedTrack && (
                    <div className="bg-gray-50 border border-gray-200 rounded p-3">
                      <p className="text-[11px] font-bold text-gray-700 uppercase mb-1 flex items-center gap-1.5">AIS track <ProvenanceBadge p={selectedTrack.provenance} /></p>
                      <ul className="space-y-0.5">
                        {selectedTrack.notes.map((n) => <li key={n} className="text-[11px] text-gray-600 leading-normal">• {n}</li>)}
                      </ul>
                    </div>
                  )}

                  {!selected.isFacility && (
                    <div className="rounded border p-3 bg-gray-50 border-gray-200">
                      <p className="text-[11px] font-bold text-gray-700 uppercase mb-1.5 flex items-center gap-1.5"><Shield className="w-3 h-3" /> Registry and sanctions</p>
                      <KeyValue cols={2} items={[
                        ['Registry', selected.provenance === 'synthetic' ? 'Synthetic' : selected.registryVerified ? 'Verified' : 'Not verified'],
                        ['Sanctions', selected.sanctionsChecked ? (selected.sanctioned ? 'Listed' : 'Not listed (UNSC, IMO match)') : selected.sanctioned ? 'Synthetic listing' : 'Not checked'],
                        ['Prior offences', selected.provenance === 'synthetic' || selected.registryVerified ? String(selected.priorOffences) : 'Unknown'],
                        ['PSC detentions', selected.pscDetentions != null ? String(selected.pscDetentions) : 'Needs Equasis'],
                      ]} />
                      {selected.registryDetails && (
                        <div className="mt-1.5 pt-1.5 border-t border-gray-200">
                          <KeyValue cols={2} items={Object.entries(selected.registryDetails).map(([k, val]) => [
                            k.replace(/([A-Z])/g, ' $1').replace(/^./, (x) => x.toUpperCase()), String(val),
                          ])} />
                        </div>
                      )}
                      {selected.registrySource && <p className="text-[11px] text-gray-500 mt-1">{selected.registrySource}</p>}
                    </div>
                  )}
                  {selected.sanctioned && (
                    <InfoBanner tone="red" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
                      Listed on {selected.sanctionsList}. Review before any dissemination.
                    </InfoBanner>
                  )}
                </>
              )}

              {tab === 'behaviour' && behaviour && selectedTrack && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <StatCard icon={<Gauge className="w-4 h-4" />} title="Mean speed" value={`${behaviour.meanSpeedKn.toFixed(1)}`} trend={`knots over ${windowHours.toFixed(0)} h`} />
                    <StatCard icon={<TrendingDown className="w-4 h-4" />} title="Min speed" value={`${behaviour.minSpeedKn.toFixed(1)}`} trend="knots" accent={behaviour.minSpeedKn < 8 ? 'amber' : 'blue'} />
                    <StatCard icon={<EyeOff className="w-4 h-4" />} title="AIS dark" value={`${behaviour.darkMinutes}`} trend="minutes" accent={behaviour.darkMinutes > 0 ? 'red' : 'green'} />
                    <StatCard icon={<Clock className="w-4 h-4" />} title="Loitering" value={`${behaviour.loiterMinutes}`} trend="minutes below 2 kn" accent={behaviour.loiterMinutes > 25 ? 'amber' : 'blue'} />
                  </div>

                  <InfoBanner tone="amber" icon={<Radio className="w-3.5 h-3.5" />}>
                    Behaviour is computed from the {selectedTrack.provenance} track. It demonstrates the method; it is not evidence about the real vessel.
                  </InfoBanner>

                  <div className={`rounded border p-3 ${behaviour.score > 0.5 ? 'bg-red-50 border-red-200' : behaviour.score > 0.2 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[11px] font-bold uppercase text-gray-700">Anomaly score</span>
                      <span className="text-base font-black text-gray-900">{(behaviour.score * 100).toFixed(0)}</span>
                    </div>
                    <ul className="space-y-1.5 mt-1.5">
                      {behaviour.flags.map((f, i) => (
                        <li key={i} className="text-[11px] text-gray-700 flex gap-1.5 leading-normal"><span className="text-gray-400">•</span><span>{f}</span></li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <p className="text-[11px] font-bold text-gray-600 uppercase mb-1">Speed over ground</p>
                    <LineChart height={110} series={[{ name: 'sog', color: '#2563eb', points: speedSeries }]} yFormat={(v) => `${v.toFixed(0)} kn`} showArea />
                  </div>

                  {selectedTrack.gaps.length > 0 && (
                    <div>
                      <p className="text-[11px] font-bold text-red-700 uppercase mb-1.5 flex items-center gap-1.5"><EyeOff className="w-3 h-3" /> Transmission gaps</p>
                      <div className="space-y-2">
                        {selectedTrack.gaps.map((g, i) => (
                          <button key={i} onClick={() => playback.setValue(g.start)} className="w-full text-left bg-red-50 border border-red-200 rounded p-2 hover:border-red-400">
                            <div className="flex justify-between text-[11px]">
                              <span className="font-bold text-red-900">{g.minutes} min silent</span>
                              <span className="font-mono text-red-700">{g.distanceKm} km</span>
                            </div>
                            <p className="text-[11px] text-red-700 mt-0.5 font-mono">{fmt.utcShort(g.start)} → {fmt.utcShort(g.end)}</p>
                            <p className="text-[11px] text-red-600 mt-0.5">
                              Implied speed {g.impliedSpeedKn} kn{g.impliedSpeedKn > 22 && ' — implausible, suggests a position jump'}
                            </p>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <KeyValue cols={2} items={[
                    ['AIS reports', fmt.num(selectedTrack.pings.length)],
                    ['Max turn rate', `${behaviour.maxTurnRate.toFixed(1)}°/min`],
                    ['First report', fmt.utcShort(selectedTrack.pings[0]?.t ?? 0)],
                    ['Last report', fmt.utcShort(selectedTrack.pings[selectedTrack.pings.length - 1]?.t ?? 0)],
                  ]} />
                </>
              )}

              {tab === 'cases' && activeCase && (() => {
                const score = rankOf.get(selected.mmsi);
                const excluded = analysis?.excluded.find((e) => e.mmsi === selected.mmsi);
                return (
                  <>
                    <button onClick={() => navigate({ tab: 'Investigation', caseId: activeCase.id })}
                      className="w-full text-left border border-gray-200 rounded p-3 hover:border-blue-400 hover:bg-blue-50/40">
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0">
                          <p className="font-bold text-[12px] text-gray-900">{activeCase.title}</p>
                          <p className="text-[11px] text-gray-600 truncate">{activeCase.subRegion}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">{fmt.precise(activeCase.incidentTime, activeCase.facts.incident.timePrecision)}</p>
                        </div>
                        {score && (
                          <div className="text-right flex-shrink-0">
                            <div className={`text-base font-black leading-none ${score.rank === 1 ? 'text-rose-600' : 'text-gray-600'}`}>{(score.total * 100).toFixed(0)}</div>
                            <div className="text-[10.5px] text-gray-400">rank {score.rank}</div>
                          </div>
                        )}
                      </div>
                      {score && (
                        <div className="mt-1.5 pt-1.5 border-t border-gray-100 flex gap-3 text-[11px] text-gray-600">
                          <span>CPA {score.cpaKm.toFixed(1)} km</span>
                          <span>Δt {score.deltaTimeMin.toFixed(0)} min</span>
                          {score.darkDuringWindow && <Badge tone="red">DARK</Badge>}
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center gap-1 text-[11px] text-blue-600 font-semibold">Open investigation <ArrowRight className="w-3 h-3" /></div>
                    </button>
                    {score && (
                      <ul className="space-y-1.5">
                        {score.reasons.map((r, i) => <li key={i} className="text-[11px] text-gray-700 leading-normal flex gap-1.5"><span className="text-gray-400">•</span>{r}</li>)}
                      </ul>
                    )}
                    {excluded && <p className="text-[11.5px] text-gray-600">Excluded from scoring: {excluded.reason}</p>}
                    {!score && !excluded && <p className="text-[11.5px] text-gray-500">Not evaluated for this case.</p>}
                    {selected.provenance === 'real' && (
                      <Button size="sm" className="w-full justify-center" onClick={() => navigate({ tab: 'Offender Registry', mmsi: selected.mmsi })} icon={<Shield className="w-3 h-3" />}>
                        Liability register
                      </Button>
                    )}
                  </>
                );
              })()}
            </div>
          </>
        )}
      </aside>
    </main>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <div className="w-2.5 h-2.5 rounded-full border border-white shadow" style={{ background: color }} />
      <span className="text-gray-700">{label}</span>
    </div>
  );
}
