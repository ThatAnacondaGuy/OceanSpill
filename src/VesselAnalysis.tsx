import { useEffect, useMemo, useState } from 'react';
import {
  Ship, Anchor, AlertTriangle, EyeOff, Layers,
  TrendingDown, Gauge, Flag, Shield, Clock, ArrowRight, Radio,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPath, type MapPolygon } from './components/MapView';
import {
  DataTable, SearchInput, Select, Badge, Button, KeyValue, Toggle, Tabs, InfoBanner,
  EmptyState, TimeScrubber, usePlayback, LineChart, ExportButton, downloadCsv, StatCard, type Column,
} from './components/ui';
import { CORRIDORS, ECOLOGICAL_AREAS } from './data/geography';
import { analyseBehaviour, interpolateTrack } from './engine/attribution';
import type { Vessel } from './data/types';

export default function VesselAnalysis() {
  const { world, now, selectedMmsi, setSelectedMmsi, navigate, getAnalysis, revision } = useStore();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [flagRisk, setFlagRisk] = useState('all');
  const [onlyTracked, setOnlyTracked] = useState(true);
  const [onlyDark, setOnlyDark] = useState(false);
  const [onlyOffenders, setOnlyOffenders] = useState(false);
  const [basemap, setBasemap] = useState<BasemapStyle>('dark');
  const [tab, setTab] = useState('particulars');
  const [layers, setLayers] = useState({ tracks: true, gaps: true, corridors: true, esa: false, vessels: true });
  const [layersOpen, setLayersOpen] = useState(false);

  const windowBounds = useMemo(() => ({ min: now - 30 * 3600_000, max: now + 2 * 3600_000 }), [now]);
  const playback = usePlayback(windowBounds.min, windowBounds.max, windowBounds.max);

  const tracked = useMemo(() => world.vessels.filter((v) => world.tracks.has(v.mmsi)), [world, revision]);

  const darkMmsis = useMemo(() => {
    const s = new Set<string>();
    for (const [mmsi, t] of world.tracks) if (t.gaps.length > 0) s.add(mmsi);
    return s;
  }, [world.tracks, revision]);

  const candidateMmsis = useMemo(() => {
    const s = new Set<string>();
    for (const c of world.cases) for (const m of c.candidateMmsis) s.add(m);
    return s;
  }, [world.cases, revision]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = onlyTracked ? tracked : world.vessels;
    return base.filter((v) => {
      if (q && !`${v.name} ${v.mmsi} ${v.imo} ${v.flag} ${v.type} ${v.owner}`.toLowerCase().includes(q)) return false;
      if (typeFilter !== 'all' && v.type !== typeFilter) return false;
      if (flagRisk !== 'all' && v.flagRisk !== flagRisk) return false;
      if (onlyDark && !darkMmsis.has(v.mmsi)) return false;
      if (onlyOffenders && v.priorOffences === 0 && !v.sanctioned) return false;
      return true;
    });
  }, [world.vessels, tracked, query, typeFilter, flagRisk, onlyTracked, onlyDark, onlyOffenders, darkMmsis]);

  const selected = world.vessels.find((v) => v.mmsi === selectedMmsi) ?? filtered[0] ?? null;
  const selectedTrack = selected ? world.tracks.get(selected.mmsi) : undefined;

  useEffect(() => {
    if (!selectedMmsi && filtered.length) setSelectedMmsi(filtered[0].mmsi);
  }, [selectedMmsi, filtered, setSelectedMmsi]);

  const behaviour = useMemo(
    () => (selectedTrack ? analyseBehaviour(selectedTrack, windowBounds.min, windowBounds.max) : null),
    [selectedTrack, windowBounds]
  );

  const linkedCases = useMemo(
    () => (selected ? world.cases.filter((c) => c.candidateMmsis.includes(selected.mmsi)) : []),
    [selected, world.cases, revision]
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
        paths.push({
          id: c.id, points: c.waypoints, stroke: c.highRisk ? '#f97316' : '#3b82f6',
          strokeWidth: c.highRisk ? 2 : 1.4, dash: '8 5', opacity: 0.5, z: 1,
        });
      }
    }

    for (const v of filtered) {
      const track = world.tracks.get(v.mmsi);
      if (!track) continue;
      const isSel = selected?.mmsi === v.mmsi;
      const hasGap = darkMmsis.has(v.mmsi);
      const color = isSel ? '#22d3ee' : hasGap ? '#ef4444' : candidateMmsis.has(v.mmsi) ? '#f97316' : '#94a3b8';

      if (layers.tracks) {
        const pts = track.pings.filter((p) => p.t <= playback.value);
        if (pts.length > 1) {
          paths.push({
            id: `t-${v.mmsi}`, points: pts, stroke: color,
            strokeWidth: isSel ? 2.4 : 1, opacity: isSel ? 1 : 0.42, z: isSel ? 5 : 2,
          });
        }
      }
      if (layers.gaps && hasGap) {
        for (const g of track.gaps) {
          if (g.start > playback.value) continue;
          const a = track.pings.filter((p) => p.t <= g.start).pop();
          const b = track.pings.find((p) => p.t >= g.end);
          if (a && b) {
            paths.push({ id: `g-${v.mmsi}-${g.start}`, points: [a, b], stroke: '#ef4444', strokeWidth: 1.8, dash: '3 5', opacity: 0.85, z: 4 });
          }
        }
      }
      if (layers.vessels) {
        const at = interpolateTrack(track, playback.value);
        const darkNow = track.gaps.some((g) => playback.value >= g.start && playback.value <= g.end);
        const pos = at ?? (darkNow ? track.pings.filter((p) => p.t < playback.value).pop() : undefined);
        if (pos) {
          markers.push({
            id: v.mmsi, position: pos, kind: 'vessel', color: darkNow ? '#ef4444' : color,
            size: isSel ? 8 : 5, headingDeg: pos.cog, selected: isSel, pulse: darkNow,
            label: v.name, sublabel: `${v.type} · ${v.flag}${darkNow ? ' · AIS DARK' : ''}`,
            z: isSel ? 9 : 6,
            meta: { MMSI: v.mmsi, Speed: `${pos.sog.toFixed(1)} kn`, Course: `${pos.cog.toFixed(0)}°`, Destination: v.destination },
          });
        }
      }
    }
    return { markers, paths, polygons };
  }, [filtered, world.tracks, selected, playback.value, layers, darkMmsis, candidateMmsis]);

  const columns: Column<Vessel>[] = [
    {
      key: 'name', header: 'Vessel', value: (v) => v.name,
      render: (v) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-gray-900 truncate">{v.name}</span>
            {darkMmsis.has(v.mmsi) && <Badge tone="red">DARK</Badge>}
            {v.sanctioned && <Badge tone="slate">SANC</Badge>}
          </div>
          <div className="text-[9.5px] text-gray-500 font-mono">MMSI {v.mmsi}</div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', width: '112px', value: (v) => v.type, render: (v) => <span className="text-gray-600">{v.type}</span> },
    {
      key: 'flag', header: 'Flag', width: '104px', value: (v) => v.flag,
      render: (v) => (
        <div className="flex items-center gap-1">
          <span className="text-gray-700">{v.flag}</span>
          {v.flagRisk === 'Black List' && <span title="Paris MoU black list" className="w-1.5 h-1.5 rounded-full bg-red-500" />}
          {v.flagRisk === 'Grey List' && <span title="Paris MoU grey list" className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
        </div>
      ),
    },
    { key: 'dwt', header: 'DWT', width: '78px', align: 'right', value: (v) => v.deadweightT, render: (v) => <span className="font-mono text-gray-700">{fmt.num(v.deadweightT)}</span> },
    {
      key: 'priors', header: 'Priors', width: '60px', align: 'center', value: (v) => v.priorOffences,
      render: (v) => v.priorOffences > 0 ? <Badge tone="red">{v.priorOffences}</Badge> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'psc', header: 'PSC', width: '62px', align: 'center', value: (v) => v.psc.detentions,
      render: (v) => v.psc.detentions > 0 ? <Badge tone="amber">{v.psc.detentions}D</Badge> : <span className="text-gray-300">—</span>,
    },
    {
      key: 'cases', header: 'Cases', width: '58px', align: 'center',
      value: (v) => world.cases.filter((c) => c.candidateMmsis.includes(v.mmsi)).length,
      render: (v) => {
        const n = world.cases.filter((c) => c.candidateMmsis.includes(v.mmsi)).length;
        return n > 0 ? <Badge tone="blue">{n}</Badge> : <span className="text-gray-300">—</span>;
      },
    },
  ];

  const speedSeries = useMemo(() => {
    if (!selectedTrack) return [];
    return selectedTrack.pings.filter((p) => p.t >= windowBounds.min).map((p) => p.sog);
  }, [selectedTrack, windowBounds.min]);

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[330px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Anchor className="w-4 h-4 text-blue-600" /> Vessel traffic</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">{filtered.length} vessels · {darkMmsis.size} with AIS gaps</p>
        </div>
        <div className="p-2 space-y-2 border-b border-gray-200">
          <SearchInput value={query} onChange={setQuery} placeholder="Name, MMSI, IMO, owner…" />
          <div className="grid grid-cols-2 gap-2">
            <Select value={typeFilter} onChange={setTypeFilter}
              options={[{ value: 'all', label: 'All types' }, ...Array.from(new Set(world.vessels.map((v) => v.type))).sort().map((t) => ({ value: t, label: t }))]} />
            <Select value={flagRisk} onChange={setFlagRisk}
              options={[{ value: 'all', label: 'All flags' }, { value: 'Standard', label: 'Standard' }, { value: 'Grey List', label: 'Grey list' }, { value: 'Black List', label: 'Black list' }]} />
          </div>
          <div className="grid grid-cols-1 gap-0">
            <Toggle checked={onlyTracked} onChange={setOnlyTracked} label="Only vessels with AIS tracks" count={tracked.length} />
            <Toggle checked={onlyDark} onChange={setOnlyDark} label="Only vessels with transmission gaps" count={darkMmsis.size} />
            <Toggle checked={onlyOffenders} onChange={setOnlyOffenders} label="Only prior offenders or sanctioned" />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <DataTable columns={columns} rows={filtered} rowKey={(v) => v.mmsi} dense
            selectedId={selected?.mmsi} onRowClick={(v) => setSelectedMmsi(v.mmsi)}
            initialSort={{ key: 'priors', dir: 'desc' }} />
        </div>
        <div className="p-2 border-t border-gray-200">
          <ExportButton onExport={() => downloadCsv('oceanwatch-vessels.csv', columns.filter((c) => c.value), filtered)} />
        </div>
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            markers={mapData.markers}
            paths={mapData.paths}
            polygons={mapData.polygons}
            initialCentre={{ lat: 13, lon: 80 }} initialZoom={3.9}
            onMarkerClick={(m) => setSelectedMmsi(m.id)}
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
                      <Toggle checked={layers.vessels} onChange={(v) => setLayers({ ...layers, vessels: v })} label="Vessel positions" />
                      <Toggle checked={layers.tracks} onChange={(v) => setLayers({ ...layers, tracks: v })} label="AIS tracks" />
                      <Toggle checked={layers.gaps} onChange={(v) => setLayers({ ...layers, gaps: v })} label="Transmission gaps" count={darkMmsis.size} />
                      <Toggle checked={layers.corridors} onChange={(v) => setLayers({ ...layers, corridors: v })} label="Shipping corridors" count={CORRIDORS.length} />
                      <Toggle checked={layers.esa} onChange={(v) => setLayers({ ...layers, esa: v })} label="Sensitive areas" />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Traffic</h4>
                <Dot color="#22d3ee" label="Selected vessel" />
                <Dot color="#ef4444" label="AIS gap in window" />
                <Dot color="#f97316" label="Case candidate" />
                <Dot color="#94a3b8" label="Background traffic" />
                <div className="border-t border-gray-200 mt-1.5 pt-1.5">
                  <div className="flex items-center gap-2"><div className="w-4 border-t-2 border-dashed border-orange-500" /><span className="text-gray-600">High-risk corridor</span></div>
                </div>
              </div>
            }
          />
        </div>
        <TimeScrubber
          min={windowBounds.min} max={windowBounds.max} value={playback.value} onChange={playback.setValue}
          format={(v) => fmt.utc(v)} playing={playback.playing} onPlayToggle={playback.toggle}
          speed={playback.speed} onSpeedChange={playback.setSpeed}
          marks={world.cases.map((c) => ({ t: c.detection.acquiredAt, color: '#2563eb', label: c.id }))}
        />
      </section>

      <aside className="w-[360px] bg-white border-l border-gray-200 flex flex-col flex-shrink-0">
        {!selected ? (
          <EmptyState icon={<Ship className="w-10 h-10" />} title="No vessel selected" body="Pick a vessel from the list or the map." />
        ) : (
          <>
            <div className="px-3 py-2.5 border-b border-gray-200">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-bold text-gray-900 text-sm truncate">{selected.name}</h3>
                  <p className="text-[10px] text-gray-500 font-mono">MMSI {selected.mmsi} · IMO {selected.imo}</p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {selected.sanctioned && <Badge tone="slate">SANCTIONED</Badge>}
                  {darkMmsis.has(selected.mmsi) && <Badge tone="red">AIS GAPS</Badge>}
                </div>
              </div>
              <div className="flex gap-1.5 mt-1.5 flex-wrap">
                <Badge tone="blue">{selected.type}</Badge>
                <Badge tone={selected.flagRisk === 'Black List' ? 'red' : selected.flagRisk === 'Grey List' ? 'amber' : 'gray'}>
                  <Flag className="w-2.5 h-2.5" /> {selected.flag}
                </Badge>
                {selected.priorOffences > 0 && <Badge tone="red">{selected.priorOffences} prior</Badge>}
              </div>
            </div>

            <Tabs active={tab} onChange={setTab} tabs={[
              { id: 'particulars', label: 'Particulars' },
              { id: 'behaviour', label: 'Behaviour' },
              { id: 'cases', label: 'Cases', count: linkedCases.length },
            ]} />

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {tab === 'particulars' && (
                <>
                  <KeyValue cols={2} items={[
                    ['Call sign', selected.callSign], ['Built', String(selected.builtYear)],
                    ['Length', `${selected.lengthM} m`], ['Beam', `${selected.beamM} m`],
                    ['Gross tonnage', fmt.num(selected.grossTonnage)], ['Deadweight', `${fmt.num(selected.deadweightT)} t`],
                    ['Draught', `${selected.draughtM} m`], ['Age', `${2025 - selected.builtYear} years`],
                  ]} />
                  <div>
                    <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Commercial</p>
                    <KeyValue cols={1} items={[
                      ['Registered owner', selected.owner], ['Operator', selected.operator],
                      ['Classification', selected.classSociety], ['P&I club', selected.piClub],
                    ]} />
                  </div>
                  <div>
                    <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5">Voyage</p>
                    <KeyValue cols={2} items={[
                      ['Last port', selected.lastPort], ['Next port', selected.nextPort],
                      ['Destination', selected.destination], ['ETA', selected.eta],
                    ]} />
                  </div>
                  <div className={`rounded border p-2.5 ${selected.psc.detentions > 0 ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                    <p className="text-[10px] font-bold text-gray-700 uppercase mb-1.5 flex items-center gap-1.5"><Shield className="w-3 h-3" /> Port state control</p>
                    <KeyValue cols={2} items={[
                      ['Detentions', String(selected.psc.detentions)], ['Deficiencies', String(selected.psc.deficiencies)],
                      ['Last inspection', selected.psc.lastInspection], ['At', selected.psc.lastPort],
                    ]} />
                  </div>
                  {selected.sanctioned && (
                    <InfoBanner tone="red" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
                      <b>Sanctions match.</b> Listed on {selected.sanctionsList}. Any attribution involving this
                      vessel carries additional diplomatic weight and should be reviewed before dissemination.
                    </InfoBanner>
                  )}
                </>
              )}

              {tab === 'behaviour' && behaviour && selectedTrack && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <StatCard icon={<Gauge className="w-4 h-4" />} title="Mean speed" value={`${behaviour.meanSpeedKn.toFixed(1)}`} trend="knots over 30 h" />
                    <StatCard icon={<TrendingDown className="w-4 h-4" />} title="Min speed" value={`${behaviour.minSpeedKn.toFixed(1)}`} trend="knots" accent={behaviour.minSpeedKn < 8 ? 'amber' : 'blue'} />
                    <StatCard icon={<EyeOff className="w-4 h-4" />} title="AIS dark" value={`${behaviour.darkMinutes}`} trend="minutes" accent={behaviour.darkMinutes > 0 ? 'red' : 'green'} />
                    <StatCard icon={<Clock className="w-4 h-4" />} title="Loitering" value={`${behaviour.loiterMinutes}`} trend="minutes below 2 kn" accent={behaviour.loiterMinutes > 25 ? 'amber' : 'blue'} />
                  </div>

                  <div className={`rounded border p-2.5 ${behaviour.score > 0.5 ? 'bg-red-50 border-red-200' : behaviour.score > 0.2 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold uppercase text-gray-700">Anomaly score</span>
                      <span className="text-base font-black text-gray-900">{(behaviour.score * 100).toFixed(0)}</span>
                    </div>
                    <ul className="space-y-1 mt-1.5">
                      {behaviour.flags.map((f, i) => (
                        <li key={i} className="text-[10px] text-gray-700 flex gap-1.5 leading-snug">
                          <span className="text-gray-400">•</span><span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Speed over ground (30 h)</p>
                    <LineChart height={110} series={[{ name: 'sog', color: '#2563eb', points: speedSeries }]}
                      yFormat={(v) => `${v.toFixed(0)} kn`} showArea />
                    <p className="text-[9.5px] text-gray-500 mt-1 leading-snug">
                      A laden tanker easing to 4–8 knots is the classic discharge signature: slow enough for the
                      slick to form astern, fast enough to keep making passage.
                    </p>
                  </div>

                  {selectedTrack.gaps.length > 0 && (
                    <div>
                      <p className="text-[10px] font-bold text-red-700 uppercase mb-1.5 flex items-center gap-1.5">
                        <EyeOff className="w-3 h-3" /> Transmission gaps
                      </p>
                      <div className="space-y-1.5">
                        {selectedTrack.gaps.map((g, i) => (
                          <div key={i} className="bg-red-50 border border-red-200 rounded p-2">
                            <div className="flex justify-between text-[10px]">
                              <span className="font-bold text-red-900">{g.minutes} min silent</span>
                              <span className="font-mono text-red-700">{g.distanceKm} km</span>
                            </div>
                            <p className="text-[9.5px] text-red-700 mt-0.5 font-mono">{fmt.utcShort(g.start)} → {fmt.utcShort(g.end)}</p>
                            <p className="text-[9.5px] text-red-600 mt-0.5">
                              Implied speed across the gap {g.impliedSpeedKn} kn
                              {g.impliedSpeedKn > 22 && ' — physically implausible, suggesting a position jump rather than a simple outage'}
                            </p>
                          </div>
                        ))}
                      </div>
                      <InfoBanner tone="amber" icon={<Radio className="w-3.5 h-3.5" />}>
                        A gap is not proof of intent — coverage holes and equipment faults happen. It becomes
                        significant when it coincides with a discharge window and the vessel resumes transmission
                        afterwards.
                      </InfoBanner>
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

              {tab === 'cases' && (
                <>
                  {linkedCases.length === 0 ? (
                    <EmptyState title="Not linked to any case" body="This vessel has not appeared in the candidate set for any detection." />
                  ) : (
                    linkedCases.map((c) => {
                      const a = getAnalysis(c.id);
                      const score = a?.ranked.find((r) => r.mmsi === selected.mmsi);
                      return (
                        <button key={c.id} onClick={() => navigate({ tab: 'Investigation', caseId: c.id })}
                          className="w-full text-left border border-gray-200 rounded p-2.5 hover:border-blue-400 hover:bg-blue-50/40">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0">
                              <p className="font-bold text-[11px] font-mono text-gray-900">{c.id}</p>
                              <p className="text-[10px] text-gray-600 truncate">{c.subRegion}</p>
                              <p className="text-[9.5px] text-gray-400 mt-0.5">{fmt.utc(c.detection.acquiredAt)}</p>
                            </div>
                            {score && (
                              <div className="text-right flex-shrink-0">
                                <div className={`text-base font-black leading-none ${score.rank === 1 ? 'text-rose-600' : 'text-gray-600'}`}>
                                  {(score.total * 100).toFixed(0)}
                                </div>
                                <div className="text-[9px] text-gray-400">rank {score.rank}</div>
                              </div>
                            )}
                          </div>
                          {score && (
                            <div className="mt-1.5 pt-1.5 border-t border-gray-100 flex gap-3 text-[9.5px] text-gray-600">
                              <span>CPA {score.cpaKm.toFixed(1)} km</span>
                              <span>Δt {score.deltaTimeMin.toFixed(0)} min</span>
                              {score.darkDuringWindow && <Badge tone="red">DARK</Badge>}
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-blue-600 font-semibold">
                            Open investigation <ArrowRight className="w-3 h-3" />
                          </div>
                        </button>
                      );
                    })
                  )}
                  {selected.priorOffences > 0 && (
                    <Button size="sm" className="w-full justify-center" onClick={() => navigate({ tab: 'Offender Registry', mmsi: selected.mmsi })}
                      icon={<Shield className="w-3 h-3" />}>
                      View registry record
                    </Button>
                  )}
                </>
              )}
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
