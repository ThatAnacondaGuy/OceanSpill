import { useEffect, useMemo, useState } from 'react';
import { Wind, Waves, Thermometer, Droplets, Navigation, Activity, Satellite, Info } from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon, type MapVector } from './components/MapView';
import { Select, Slider, KeyValue, Badge, InfoBanner, LineChart, Tabs, Toggle, StatCard, ProvenanceBadge } from './components/ui';
import { monsoonLabel, monsoonPhase, sampleField, seaStateAt, vector } from './engine/ocean';
import { MODEL_SAMPLER, type FieldSampler } from './engine/forcing';
import { formatBearing, type LatLon } from './lib/geo';
import { PORTS } from './data/geography';
import type { ForcingArtifact } from './data/types';

const HOUR = 3600_000;

/**
 * Ocean and meteorological conditions. In case mode every value comes from the forcing grid the
 * pipeline fetched for that incident (ERA5 wind, SMOC currents), which is exactly what the drift
 * engine integrates. Model mode shows the climatological fallback and is labelled as modelled.
 */
export default function EnvironmentalData() {
  const { now, world, navigate, selectedCaseId, samplerFor } = useStore();
  const casesWithForcing = useMemo(() => world.cases.filter((c) => world.forcing.has(c.id)), [world]);

  const [mode, setMode] = useState<'case' | 'model'>(casesWithForcing.length ? 'case' : 'model');
  const [caseId, setCaseId] = useState<string>(
    casesWithForcing.find((c) => c.id === selectedCaseId)?.id ?? casesWithForcing[0]?.id ?? ''
  );
  const activeCase = world.cases.find((c) => c.id === caseId) ?? null;
  const forcing: ForcingArtifact | null = mode === 'case' ? world.forcing.get(caseId) ?? null : null;

  const [basemap, setBasemap] = useState<BasemapStyle>('bathymetry');
  const [field, setField] = useState<'current' | 'wind'>('current');
  const [probe, setProbe] = useState<LatLon>({ lat: 12.5, lon: 74.2 });
  const [timeIndex, setTimeIndex] = useState(0);
  const [hourOffset, setHourOffset] = useState(0);
  const [density, setDensity] = useState(16);
  const [tab, setTab] = useState('conditions');
  const [showCases, setShowCases] = useState(true);

  // Jump to the reference observation and incident position whenever the case changes.
  useEffect(() => {
    if (mode !== 'case' || !activeCase || !forcing) return;
    const ref = activeCase.detection.acquiredAt;
    let best = 0;
    forcing.times.forEach((t, i) => { if (Math.abs(t - ref) < Math.abs(forcing.times[best] - ref)) best = i; });
    setTimeIndex(best);
    setProbe(activeCase.facts.incident.position);
    setField(forcing.coverage.current > 0 ? 'current' : 'wind');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, mode]);

  const sampler: FieldSampler = mode === 'case' && forcing ? samplerFor(caseId) : MODEL_SAMPLER;
  const sampleTime = forcing ? forcing.times[Math.min(timeIndex, forcing.times.length - 1)] : now + hourOffset * HOUR;
  const when = new Date(sampleTime);

  const vectors = useMemo<MapVector[]>(() => {
    if (forcing) {
      const [, ny, nx] = forcing.shape;
      const ti = Math.min(timeIndex, forcing.times.length - 1);
      const src = field === 'current' ? forcing.current : forcing.wind;
      const out: MapVector[] = [];
      for (let yi = 0; yi < ny; yi++) {
        for (let xi = 0; xi < nx; xi++) {
          const k = ti * ny * nx + yi * nx + xi;
          const u = src.u[k];
          const v = src.v[k];
          if (u == null || v == null) continue;
          const s = vector(u, v);
          out.push({ position: { lat: forcing.lats[yi], lon: forcing.lons[xi] }, dirDeg: s.dirTo, magnitude: field === 'current' ? s.speed : s.speed / 4 });
        }
      }
      return out;
    }
    return sampleField({ north: 25, south: 3, east: 97, west: 64 }, when, density, Math.round(density * 0.78), field)
      .map((s) => ({ position: s.position, dirDeg: s.sample.dirTo, magnitude: field === 'current' ? s.sample.speed : s.sample.speed / 4 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forcing, timeIndex, sampleTime, density, field]);

  const wind = sampler.wind(probe, sampleTime);
  const current = sampler.current(probe, sampleTime);
  const observedHs = sampler.waveHeight(probe, sampleTime);
  const sea = seaStateAt(probe, when, {
    windSpeedMs: wind.origin === 'observed' ? wind.speed : null,
    waveHeightM: observedHs,
  });
  const stokes = { u: 0.012 * wind.u, v: 0.012 * wind.v, speed: 0.012 * wind.speed, dirTo: wind.dirTo };
  const phase = monsoonPhase(when);

  // Total surface drift a slick would experience here: current + Stokes + 3% windage.
  const driftU = current.u + stokes.u + 0.03 * wind.u;
  const driftV = current.v + stokes.v + 0.03 * wind.v;
  const driftSpeed = Math.hypot(driftU, driftV);
  const driftDir = (Math.atan2(driftU, driftV) * 180) / Math.PI;

  const series = useMemo(() => {
    const times: number[] = [];
    if (forcing) {
      const step = Math.max(1, Math.ceil(forcing.times.length / 36));
      for (let i = 0; i < forcing.times.length; i += step) times.push(forcing.times[i]);
    } else {
      for (let h = -24; h <= 48; h += 3) times.push(now + h * HOUR);
    }
    const windSpeed: number[] = [];
    const currentSpeed: number[] = [];
    const waveHeight: number[] = [];
    let observedCurrent = 0;
    let observedWaves = 0;
    for (const t of times) {
      const w = sampler.wind(probe, t);
      const c = sampler.current(probe, t);
      const hs = sampler.waveHeight(probe, t);
      if (c.origin === 'observed') observedCurrent++;
      if (hs != null) observedWaves++;
      windSpeed.push(w.speed);
      currentSpeed.push(c.speed * 100);
      waveHeight.push(seaStateAt(probe, new Date(t), { windSpeedMs: w.speed, waveHeightM: hs }).significantWaveHeightM);
    }
    return { times, windSpeed, currentSpeed, waveHeight, observedCurrent, observedWaves };
  }, [probe, now, forcing, sampler]);

  const seriesLabels = useMemo(() => {
    const n = series.times.length;
    if (!n) return [];
    const idx = [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
    return idx.map((i) => fmt.utcShort(series.times[i]).slice(0, 9));
  }, [series.times]);

  const markerIndex = useMemo(() => {
    let best = 0;
    series.times.forEach((t, i) => { if (Math.abs(t - sampleTime) < Math.abs(series.times[best] - sampleTime)) best = i; });
    return best;
  }, [series.times, sampleTime]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [{
      id: 'probe', position: probe, kind: 'origin', color: '#dc2626', size: 8,
      label: 'Probe', sublabel: 'Click the map to move the sampling point', z: 5,
    }];
    if (showCases) {
      for (const c of world.cases) {
        out.push({
          id: c.id, position: c.facts.incident.position,
          kind: 'case', color: c.id === caseId && mode === 'case' ? '#dc2626' : '#111827', size: 5, label: c.title, sublabel: c.subRegion, z: 3,
        });
      }
    }
    for (const p of PORTS.filter((x) => x.tier === 1)) {
      out.push({ id: `p-${p.name}`, position: p, kind: 'port', color: '#64748b', size: 3, label: p.name, z: 1 });
    }
    return out;
  }, [probe, showCases, world.cases, caseId, mode]);

  const polygons = useMemo<MapPolygon[]>(() => {
    if (!forcing) return [];
    const s = forcing.lats[0], n = forcing.lats[forcing.lats.length - 1];
    const w = forcing.lons[0], e = forcing.lons[forcing.lons.length - 1];
    return [{
      id: 'grid', rings: [[{ lat: n, lon: w }, { lat: n, lon: e }, { lat: s, lon: e }, { lat: s, lon: w }]],
      fill: 'rgba(37,99,235,0.04)', stroke: '#2563eb', strokeWidth: 1, dash: '4 4', label: 'Forcing grid',
    }];
  }, [forcing]);

  const detectability = sea.sarDetectability;
  const detTone = detectability === 'Optimal' ? 'green' : detectability.startsWith('Marginal') ? 'amber' : 'red';
  const metSources = world.dataSources.filter((d) => d.kind === 'Metocean');
  const gridHasCurrent = !forcing || forcing.coverage.current > 0;

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[340px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0 overflow-y-auto">
        <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Activity className="w-4 h-4 text-blue-600" /> Environmental data</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {mode === 'case' ? 'Reanalysis forcing fetched for each real case' : 'Climatological model (fallback)'}
          </p>
          <div className="flex rounded border border-gray-300 overflow-hidden mt-2">
            <button onClick={() => setMode('case')} disabled={!casesWithForcing.length}
              className={`flex-1 px-2 py-1 text-[11px] font-semibold ${mode === 'case' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'} disabled:opacity-40`}>Case forcing</button>
            <button onClick={() => setMode('model')}
              className={`flex-1 px-2 py-1 text-[11px] font-semibold border-l border-gray-300 ${mode === 'model' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>Climatology</button>
          </div>
          {mode === 'case' && (
            <div className="mt-2">
              <Select value={caseId} onChange={setCaseId} options={casesWithForcing.map((c) => ({ value: c.id, label: c.title }))} />
            </div>
          )}
        </div>

        <Tabs
          tabs={[{ id: 'conditions', label: 'Conditions' }, { id: 'forecast', label: 'Time series' }, { id: 'sources', label: 'Provenance' }]}
          active={tab} onChange={setTab}
        />

        {tab === 'conditions' && (
          <div className="p-3 space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded p-2.5">
              <p className="text-[10px] font-bold text-blue-900 uppercase mb-1">Sampling point</p>
              <p className="font-mono text-xs font-bold text-blue-900">
                {Math.abs(probe.lat).toFixed(3)}° {probe.lat >= 0 ? 'N' : 'S'} &nbsp; {Math.abs(probe.lon).toFixed(3)}° {probe.lon >= 0 ? 'E' : 'W'}
              </p>
              <p className="text-[10px] text-blue-700 mt-1">{fmt.utc(sampleTime)}</p>
              <p className="text-[9.5px] text-blue-600 mt-1">Click anywhere on the map to move the probe.</p>
            </div>

            {forcing ? (
              <Slider
                label="Forcing time" value={timeIndex} onChange={setTimeIndex} min={0} max={forcing.times.length - 1} step={1}
                format={(i) => {
                  const t = forcing.times[Math.min(i, forcing.times.length - 1)];
                  const rel = activeCase ? (t - activeCase.detection.acquiredAt) / HOUR : 0;
                  return `${fmt.utcShort(t)} (${rel >= 0 ? '+' : ''}${rel.toFixed(0)} h from obs.)`;
                }}
              />
            ) : (
              <Slider
                label="Time offset" value={hourOffset} onChange={setHourOffset} min={-48} max={72} step={1}
                format={(v) => (v === 0 ? 'now' : `${v > 0 ? '+' : ''}${v} h`)}
              />
            )}

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><Wind className="w-3 h-3" /> 10 m wind <ProvenanceBadge p={wind.origin} /></p>
              <KeyValue cols={2} items={[
                ['Speed', `${wind.speed.toFixed(1)} m/s`],
                ['Knots', `${(wind.speed * 1.944).toFixed(1)} kn`],
                ['From', `${wind.dirFrom.toFixed(0)}° ${formatBearing(wind.dirFrom)}`],
                ['Beaufort', `${sea.beaufort} — ${sea.beaufortLabel}`],
              ]} />
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><Navigation className="w-3 h-3" /> Surface current <ProvenanceBadge p={current.origin} /></p>
              <KeyValue cols={2} items={[
                ['Speed', `${current.speed.toFixed(3)} m/s`],
                ['Knots', `${(current.speed * 1.944).toFixed(2)} kn`],
                ['Toward', `${current.dirTo.toFixed(0)}° ${formatBearing(current.dirTo)}`],
                ['U / V', `${current.u.toFixed(2)} / ${current.v.toFixed(2)}`],
              ]} />
              {!gridHasCurrent && (
                <p className="text-[9.5px] text-amber-700 mt-1 leading-snug">No reanalysis currents for this date (SMOC starts 2022). Using the climatological model.</p>
              )}
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><Waves className="w-3 h-3" /> Sea state</p>
              <KeyValue cols={2} items={[
                [<span className="flex items-center gap-1">Wave height <ProvenanceBadge p={observedHs != null ? 'observed' : 'modelled'} /></span>, `${sea.significantWaveHeightM} m`],
                ['Peak period', `${sea.peakPeriodS} s`],
                [<span className="flex items-center gap-1">SST <ProvenanceBadge p="modelled" /></span>, `${sea.seaSurfaceTempC} °C`],
                [<span className="flex items-center gap-1">Salinity <ProvenanceBadge p="modelled" /></span>, `${sea.salinityPsu} PSU`],
                ['Stokes drift', `${stokes.speed.toFixed(3)} m/s`],
                ['Stokes dir', `${stokes.dirTo.toFixed(0)}°`],
              ]} />
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded p-2.5">
              <p className="text-[10px] font-bold text-slate-700 uppercase mb-1.5">Resultant slick drift</p>
              <p className="text-[9.5px] text-slate-600 mb-2 leading-snug">
                Current + Stokes drift (1.2% of wind) + 3% windage: the velocity the particle model integrates.
              </p>
              <div className="flex items-center gap-3">
                <div className="relative w-14 h-14 flex-shrink-0">
                  <svg viewBox="0 0 56 56" className="w-full h-full">
                    <circle cx="28" cy="28" r="25" fill="white" stroke="#cbd5e1" strokeWidth="1.5" />
                    {['N', 'E', 'S', 'W'].map((d, i) => (
                      <text key={d} x={28 + Math.sin((i * 90 * Math.PI) / 180) * 19} y={28 - Math.cos((i * 90 * Math.PI) / 180) * 19 + 3}
                        textAnchor="middle" fontSize="7" fill="#94a3b8" fontWeight="700">{d}</text>
                    ))}
                    <g transform={`rotate(${driftDir} 28 28)`}>
                      <line x1="28" y1="28" x2="28" y2="9" stroke="#dc2626" strokeWidth="2.5" />
                      <path d="M28,6 L31.5,13 L24.5,13 Z" fill="#dc2626" />
                    </g>
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="text-lg font-black text-slate-900 leading-none">{(driftSpeed * 1.944).toFixed(2)} <span className="text-xs font-bold text-slate-500">kn</span></div>
                  <div className="text-[10px] text-slate-600 mt-1">{((driftDir + 360) % 360).toFixed(0)}° toward {formatBearing((driftDir + 360) % 360)}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{(driftSpeed * 3.6 * 24).toFixed(1)} km per day</div>
                </div>
              </div>
            </div>

            <div className={`border rounded p-2.5 ${detTone === 'green' ? 'bg-emerald-50 border-emerald-200' : detTone === 'amber' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] font-bold uppercase text-gray-700 flex items-center gap-1.5"><Satellite className="w-3 h-3" /> SAR detectability</p>
                <Badge tone={detTone}>{detectability}</Badge>
              </div>
              <p className="text-[9.5px] text-gray-700 leading-snug">
                Oil damps capillary waves only between roughly 3 and 12 m/s of wind. Below that the whole
                sea surface appears dark; above it, wave breaking re-roughens the slick. Wind here is {wind.speed.toFixed(1)} m/s.
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded p-2.5">
              <p className="text-[10px] font-bold text-gray-700 uppercase mb-1">Monsoon regime</p>
              <p className="text-xs font-bold text-gray-900">{monsoonLabel(when)}</p>
              <div className="mt-1.5 h-1.5 bg-gradient-to-r from-blue-400 via-gray-200 to-orange-400 rounded relative">
                <div className="absolute top-1/2 -translate-y-1/2 w-2 h-3 bg-gray-900 rounded-sm" style={{ left: `calc(${((phase + 1) / 2) * 100}% - 4px)` }} />
              </div>
              <div className="flex justify-between text-[9px] text-gray-500 mt-0.5"><span>NE monsoon</span><span>SW monsoon</span></div>
            </div>
          </div>
        )}

        {tab === 'forecast' && (
          <div className="p-3 space-y-4">
            <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
              {forcing
                ? <>Full forcing window at the probe ({series.times.length} samples). The red marker is the selected time.</>
                : <>72-hour window of the climatological model at the probe, every 3 hours. Values are modelled, not observed.</>}
            </InfoBanner>
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1 flex items-center gap-1.5">Wind speed (m/s) <ProvenanceBadge p={forcing ? 'observed' : 'modelled'} /></p>
              <LineChart
                series={[{ name: 'wind', color: '#2563eb', points: series.windSpeed }]}
                xLabels={seriesLabels} showArea
                markers={[{ x: markerIndex, label: 'selected', color: '#dc2626' }]}
                yFormat={(v) => v.toFixed(0)}
              />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1 flex items-center gap-1.5">
                Current speed (cm/s) <ProvenanceBadge p={forcing && series.observedCurrent > 0 ? 'observed' : 'modelled'} />
              </p>
              <LineChart
                series={[{ name: 'current', color: '#0891b2', points: series.currentSpeed }]}
                xLabels={seriesLabels} showArea
                markers={[{ x: markerIndex, label: 'selected', color: '#dc2626' }]}
                yFormat={(v) => v.toFixed(0)}
              />
              {forcing && series.observedCurrent < series.times.length && (
                <p className="text-[9.5px] text-gray-500 mt-0.5">{series.observedCurrent} of {series.times.length} samples observed; the rest fall back to the model.</p>
              )}
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1 flex items-center gap-1.5">
                Significant wave height (m) <ProvenanceBadge p={forcing && series.observedWaves > 0 ? 'observed' : 'modelled'} />
              </p>
              <LineChart
                series={[{ name: 'hs', color: '#7c3aed', points: series.waveHeight }]}
                xLabels={seriesLabels} showArea
                markers={[{ x: markerIndex, label: 'selected', color: '#dc2626' }]}
                yFormat={(v) => v.toFixed(1)}
              />
            </div>
          </div>
        )}

        {tab === 'sources' && (
          <div className="p-3 space-y-2">
            {forcing && activeCase && (
              <div className="border border-blue-200 bg-blue-50/50 rounded p-2.5">
                <p className="text-xs font-bold text-gray-900 mb-1">Forcing for this case</p>
                <KeyValue cols={1} items={[
                  ['Wind', forcing.sources.wind],
                  ['Current', forcing.sources.current],
                  ['Waves', forcing.sources.waves ?? '—'],
                  ['Window', `${fmt.utcShort(forcing.times[0])} → ${fmt.utcShort(forcing.times[forcing.times.length - 1])}`],
                  ['Grid', `${forcing.shape[1]} × ${forcing.shape[2]} cells · ${forcing.hourStep} h step`],
                  ['Coverage', `wind ${fmt.pct(forcing.coverage.wind, 0)} · current ${fmt.pct(forcing.coverage.current, 0)} · waves ${fmt.pct(forcing.coverage.waves, 0)}`],
                ]} />
              </div>
            )}
            {metSources.map((d) => (
              <div key={d.id} className="border border-gray-200 rounded p-2.5">
                <div className="flex justify-between items-start gap-2 mb-1">
                  <div className="min-w-0">
                    <span className="text-xs font-bold text-gray-900">{d.name}</span>
                    <p className="text-[10px] text-gray-500">{d.agency}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Interim fallback' ? 'blue' : d.status === 'Not configured' ? 'amber' : 'gray'}>{d.status}</Badge>
                    <Badge tone={d.sovereign ? 'green' : 'gray'}>{d.sovereign ? 'IN' : 'EXT'} · {d.role}</Badge>
                  </div>
                </div>
                <p className="text-[10px] text-gray-600 leading-snug">{d.message}</p>
                {d.lastSync != null && <p className="text-[9.5px] text-gray-400 mt-0.5">Last pipeline build {fmt.ago(d.lastSync, now)}</p>}
              </div>
            ))}
            <InfoBanner tone="amber">
              Climatology mode uses a parameterised model of the North Indian Ocean (monsoon current reversal, coastal
              currents, Lakshadweep eddies). It is only a fallback where no reanalysis value exists.
            </InfoBanner>
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<Wind className="w-5 h-5" />} title="Wind" value={`${wind.speed.toFixed(1)} m/s`} trend={`${formatBearing(wind.dirFrom)} · ${wind.origin}`} />
          <StatCard icon={<Navigation className="w-5 h-5" />} title="Current" value={`${(current.speed * 1.944).toFixed(2)} kn`} trend={`toward ${formatBearing(current.dirTo)} · ${current.origin}`} />
          <StatCard icon={<Waves className="w-5 h-5" />} title="Wave height" value={`${sea.significantWaveHeightM} m`} trend={observedHs != null ? 'observed' : 'modelled'} />
          <StatCard icon={<Thermometer className="w-5 h-5" />} title="SST" value={`${sea.seaSurfaceTempC} °C`} trend="modelled" />
          <StatCard icon={<Droplets className="w-5 h-5" />} title="Slick drift" value={`${(driftSpeed * 3.6 * 24).toFixed(0)} km/d`} accent={driftSpeed > 0.4 ? 'amber' : 'blue'} trend={`toward ${formatBearing((driftDir + 360) % 360)}`} />
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            initialCentre={{ lat: 13, lon: 79 }}
            initialZoom={3.9}
            markers={markers}
            polygons={polygons}
            vectors={vectors}
            vectorLabel={`${field === 'current' ? 'Surface current' : '10 m wind'} · ${forcing ? 'observed grid' : 'modelled'} · ${fmt.utc(sampleTime)}`}
            fitTo={forcing ? [{ lat: forcing.lats[0], lon: forcing.lons[0] }, { lat: forcing.lats[forcing.lats.length - 1], lon: forcing.lons[forcing.lons.length - 1] }] : undefined}
            fitKey={`${mode}-${caseId}`}
            onMapClick={(p) => setProbe(p)}
            onMarkerClick={(m) => { if (m.kind === 'case') navigate({ tab: 'Investigation', caseId: m.id }); }}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex flex-col gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="bg-white rounded shadow-md border border-gray-300 p-2 w-52">
                  <Select
                    label="Vector field" value={field} onChange={(v) => setField(v as 'current' | 'wind')}
                    options={[
                      { value: 'current', label: gridHasCurrent ? 'Surface currents' : 'Surface currents (none in grid)' },
                      { value: 'wind', label: '10 m wind' },
                    ]}
                  />
                  {!forcing && (
                    <div className="mt-2">
                      <Slider label="Grid density" value={density} onChange={setDensity} min={8} max={30} step={1} format={(v) => `${v} × ${Math.round(v * 0.78)}`} />
                    </div>
                  )}
                  <div className="mt-1 pt-1.5 border-t border-gray-200">
                    <Toggle checked={showCases} onChange={setShowCases} label="Show cases" count={world.cases.length} />
                  </div>
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2 text-[10px] shadow-lg max-w-[220px]">
                <p className="font-bold text-gray-700 mb-1">Arrow length ∝ {field === 'current' ? 'current speed' : 'wind speed'}</p>
                <p className="text-gray-500">Arrows point in the direction of flow.</p>
                {forcing
                  ? <p className="text-gray-500 mt-1">Arrows are raw grid values; cells with no data are omitted.</p>
                  : <p className="text-amber-700 mt-1">Modelled climatology, not observations.</p>}
              </div>
            }
          />
        </div>
      </section>
    </main>
  );
}
