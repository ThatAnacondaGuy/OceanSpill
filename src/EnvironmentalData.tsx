import { useMemo, useState } from 'react';
import { Wind, Waves, Thermometer, Droplets, Navigation, Activity, Satellite, Info } from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker } from './components/MapView';
import { Select, Slider, KeyValue, Badge, InfoBanner, LineChart, Tabs, Toggle, StatCard } from './components/ui';
import { currentAt, monsoonLabel, monsoonPhase, sampleField, seaStateAt, stokesDrift, windAt } from './engine/ocean';
import { formatBearing, type LatLon } from './lib/geo';
import { PORTS } from './data/geography';

/**
 * Ocean and meteorological conditions. Every value on this page is evaluated from the same
 * field models the drift engine integrates, so what an analyst reads here is exactly what the
 * hindcast used.
 */
export default function EnvironmentalData() {
  const { now, world, navigate } = useStore();
  const [basemap, setBasemap] = useState<BasemapStyle>('bathymetry');
  const [field, setField] = useState<'current' | 'wind'>('current');
  const [probe, setProbe] = useState<LatLon>({ lat: 12.5, lon: 74.2 });
  const [hourOffset, setHourOffset] = useState(0);
  const [density, setDensity] = useState(16);
  const [tab, setTab] = useState('conditions');
  const [showCases, setShowCases] = useState(true);

  const sampleTime = now + hourOffset * 3600_000;
  const when = new Date(sampleTime);

  const vectors = useMemo(
    () =>
      sampleField({ north: 25, south: 3, east: 97, west: 64 }, when, density, Math.round(density * 0.78), field)
        .map((s) => ({ position: s.position, dirDeg: s.sample.dirTo, magnitude: field === 'current' ? s.sample.speed : s.sample.speed / 4 })),
    [when, density, field]
  );

  const wind = windAt(probe, when);
  const current = currentAt(probe, when);
  const stokes = stokesDrift(probe, when);
  const sea = seaStateAt(probe, when);
  const phase = monsoonPhase(when);

  // Total surface drift a slick would experience here: current + Stokes + 3% windage.
  const driftU = current.u + stokes.u + 0.03 * wind.u;
  const driftV = current.v + stokes.v + 0.03 * wind.v;
  const driftSpeed = Math.hypot(driftU, driftV);
  const driftDir = (Math.atan2(driftU, driftV) * 180) / Math.PI;

  const series = useMemo(() => {
    const hours: number[] = [];
    const windSpeed: number[] = [];
    const currentSpeed: number[] = [];
    const waveHeight: number[] = [];
    for (let h = -24; h <= 48; h += 3) {
      const t = new Date(now + h * 3600_000);
      hours.push(h);
      windSpeed.push(windAt(probe, t).speed);
      currentSpeed.push(currentAt(probe, t).speed * 10);
      waveHeight.push(seaStateAt(probe, t).significantWaveHeightM);
    }
    return { hours, windSpeed, currentSpeed, waveHeight };
  }, [probe, now]);

  const markers = useMemo<MapMarker[]>(() => {
    const out: MapMarker[] = [{
      id: 'probe', position: probe, kind: 'origin', color: '#dc2626', size: 8,
      label: 'Probe', sublabel: 'Click the map to move the sampling point', z: 5,
    }];
    if (showCases) {
      for (const c of world.cases) {
        out.push({
          id: c.id, position: { lat: c.detection.polygon.ring[0].lat, lon: c.detection.polygon.ring[0].lon },
          kind: 'case', color: '#111827', size: 5, label: c.id, sublabel: c.subRegion, z: 3,
        });
      }
    }
    for (const p of PORTS.filter((x) => x.tier === 1)) {
      out.push({ id: `p-${p.name}`, position: p, kind: 'port', color: '#64748b', size: 3, label: p.name, z: 1 });
    }
    return out;
  }, [probe, showCases, world.cases]);

  const detectability = sea.sarDetectability;
  const detTone = detectability === 'Optimal' ? 'green' : detectability.startsWith('Marginal') ? 'amber' : 'red';

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[340px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0 overflow-y-auto">
        <div className="px-3 py-2.5 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Activity className="w-4 h-4 text-blue-600" /> Environmental data</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">INCOIS ocean forcing · IMD wind grid</p>
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

            <Slider
              label="Time offset" value={hourOffset} onChange={setHourOffset} min={-48} max={72} step={1}
              format={(v) => (v === 0 ? 'now' : `${v > 0 ? '+' : ''}${v} h`)}
            />

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><Wind className="w-3 h-3" /> 10 m wind</p>
              <KeyValue cols={2} items={[
                ['Speed', `${wind.speed.toFixed(1)} m/s`],
                ['Knots', `${(wind.speed * 1.944).toFixed(1)} kn`],
                ['From', `${wind.dirFrom.toFixed(0)}° ${formatBearing(wind.dirFrom)}`],
                ['Beaufort', `${sea.beaufort} — ${sea.beaufortLabel}`],
              ]} />
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><Navigation className="w-3 h-3" /> Surface current</p>
              <KeyValue cols={2} items={[
                ['Speed', `${current.speed.toFixed(3)} m/s`],
                ['Knots', `${(current.speed * 1.944).toFixed(2)} kn`],
                ['Toward', `${current.dirTo.toFixed(0)}° ${formatBearing(current.dirTo)}`],
                ['U / V', `${current.u.toFixed(2)} / ${current.v.toFixed(2)}`],
              ]} />
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1.5 flex items-center gap-1.5"><Waves className="w-3 h-3" /> Sea state</p>
              <KeyValue cols={2} items={[
                ['Sig. wave height', `${sea.significantWaveHeightM} m`],
                ['Peak period', `${sea.peakPeriodS} s`],
                ['SST', `${sea.seaSurfaceTempC} °C`],
                ['Salinity', `${sea.salinityPsu} PSU`],
                ['Stokes drift', `${stokes.speed.toFixed(3)} m/s`],
                ['Stokes dir', `${stokes.dirTo.toFixed(0)}°`],
              ]} />
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded p-2.5">
              <p className="text-[10px] font-bold text-slate-700 uppercase mb-1.5">Resultant slick drift</p>
              <p className="text-[9.5px] text-slate-600 mb-2 leading-snug">
                Current + Stokes drift + 3% windage — the velocity the particle model integrates.
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
                sea surface appears dark; above it, wave breaking re-roughens the slick. Current wind here
                is {wind.speed.toFixed(1)} m/s.
              </p>
            </div>

            <div className="bg-gray-50 border border-gray-200 rounded p-2.5">
              <p className="text-[10px] font-bold text-gray-700 uppercase mb-1">Monsoon regime</p>
              <p className="text-xs font-bold text-gray-900">{monsoonLabel(when)}</p>
              <div className="mt-1.5 h-1.5 bg-gradient-to-r from-blue-400 via-gray-200 to-orange-400 rounded relative">
                <div className="absolute top-1/2 -translate-y-1/2 w-2 h-3 bg-gray-900 rounded-sm" style={{ left: `calc(${((phase + 1) / 2) * 100}% - 4px)` }} />
              </div>
              <div className="flex justify-between text-[9px] text-gray-500 mt-0.5"><span>NE monsoon</span><span>SW monsoon</span></div>
              <p className="text-[9.5px] text-gray-600 mt-1.5 leading-snug">
                The Indian Monsoon Current reverses with the season, so the same release point drifts in
                opposite directions in January and July.
              </p>
            </div>
          </div>
        )}

        {tab === 'forecast' && (
          <div className="p-3 space-y-4">
            <InfoBanner tone="blue" icon={<Info className="w-3.5 h-3.5" />}>
              72-hour window at the probe position, sampled every 3 hours. The vertical marker is the current time.
            </InfoBanner>
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Wind speed (m/s)</p>
              <LineChart
                series={[{ name: 'wind', color: '#2563eb', points: series.windSpeed }]}
                xLabels={['-24 h', 'now', '+24 h', '+48 h']} showArea
                markers={[{ x: 8, label: 'now', color: '#dc2626' }]}
                yFormat={(v) => v.toFixed(0)}
              />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Current speed (cm/s)</p>
              <LineChart
                series={[{ name: 'current', color: '#0891b2', points: series.currentSpeed.map((v) => v * 10) }]}
                xLabels={['-24 h', 'now', '+24 h', '+48 h']} showArea
                markers={[{ x: 8, label: 'now', color: '#dc2626' }]}
                yFormat={(v) => v.toFixed(0)}
              />
            </div>
            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Significant wave height (m)</p>
              <LineChart
                series={[{ name: 'hs', color: '#7c3aed', points: series.waveHeight }]}
                xLabels={['-24 h', 'now', '+24 h', '+48 h']} showArea
                markers={[{ x: 8, label: 'now', color: '#dc2626' }]}
                yFormat={(v) => v.toFixed(1)}
              />
            </div>
          </div>
        )}

        {tab === 'sources' && (
          <div className="p-3 space-y-2">
            {world.dataSources.filter((d) => d.kind === 'Ocean Model' || d.kind === 'Meteorology').map((d) => (
              <div key={d.id} className="border border-gray-200 rounded p-2.5">
                <div className="flex justify-between items-start gap-2 mb-1">
                  <span className="text-xs font-bold text-gray-900">{d.name}</span>
                  <Badge tone={d.status === 'Online' ? 'green' : d.status === 'Degraded' ? 'amber' : 'red'}>{d.status}</Badge>
                </div>
                <p className="text-[10px] text-gray-500 font-mono break-all mb-1.5">{d.endpoint}</p>
                <KeyValue cols={2} items={[
                  ['Provider', d.provider],
                  ['Latency', `${d.latencyMs} ms`],
                  ['Last sync', fmt.ago(d.lastSync, now)],
                  ['Quota used', `${d.quotaUsedPct}%`],
                ]} />
              </div>
            ))}
            <InfoBanner tone="amber">
              The field values on this page are produced by a parameterised model of the North Indian Ocean —
              the monsoon current reversal, the coastal current systems, the Lakshadweep eddy pair and the Bay of
              Bengal gyre. In deployment these calls resolve against the live INCOIS HOOFS and IMD grids.
            </InfoBanner>
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<Wind className="w-5 h-5" />} title="Wind" value={`${wind.speed.toFixed(1)} m/s`} trend={`${formatBearing(wind.dirFrom)} · Bft ${sea.beaufort}`} />
          <StatCard icon={<Navigation className="w-5 h-5" />} title="Current" value={`${(current.speed * 1.944).toFixed(2)} kn`} trend={`toward ${formatBearing(current.dirTo)}`} />
          <StatCard icon={<Waves className="w-5 h-5" />} title="Wave height" value={`${sea.significantWaveHeightM} m`} trend={`Tp ${sea.peakPeriodS} s`} />
          <StatCard icon={<Thermometer className="w-5 h-5" />} title="SST" value={`${sea.seaSurfaceTempC} °C`} trend={`${sea.salinityPsu} PSU`} />
          <StatCard icon={<Droplets className="w-5 h-5" />} title="Slick drift" value={`${(driftSpeed * 3.6 * 24).toFixed(0)} km/d`} accent={driftSpeed > 0.4 ? 'amber' : 'blue'} trend={`toward ${formatBearing((driftDir + 360) % 360)}`} />
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            initialCentre={{ lat: 13, lon: 79 }}
            initialZoom={3.9}
            markers={markers}
            vectors={vectors}
            vectorLabel={`${field === 'current' ? 'Surface current' : '10 m wind'} field · ${fmt.utc(sampleTime)}`}
            onMapClick={(p) => setProbe(p)}
            onMarkerClick={(m) => { if (m.kind === 'case') navigate({ tab: 'Investigation', caseId: m.id }); }}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex flex-col gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="bg-white rounded shadow-md border border-gray-300 p-2 w-52">
                  <Select
                    label="Vector field" value={field} onChange={(v) => setField(v as 'current' | 'wind')}
                    options={[{ value: 'current', label: 'Surface currents' }, { value: 'wind', label: '10 m wind' }]}
                  />
                  <div className="mt-2">
                    <Slider label="Grid density" value={density} onChange={setDensity} min={8} max={30} step={1} format={(v) => `${v} × ${Math.round(v * 0.78)}`} />
                  </div>
                  <div className="mt-1 pt-1.5 border-t border-gray-200">
                    <Toggle checked={showCases} onChange={setShowCases} label="Show detections" count={world.cases.length} />
                  </div>
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2 text-[10px] shadow-lg">
                <p className="font-bold text-gray-700 mb-1">Arrow length ∝ {field === 'current' ? 'current speed' : 'wind speed'}</p>
                <p className="text-gray-500">Arrows point in the direction of flow.</p>
                <p className="text-gray-500 mt-1">Red crosshair = sampling probe.</p>
              </div>
            }
          />
        </div>
      </section>
    </main>
  );
}
