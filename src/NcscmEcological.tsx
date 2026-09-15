import { useEffect, useMemo, useState } from 'react';
import { Leaf, Shield, AlertTriangle, Waves, Layers, FileDown, Anchor, Clock, Fish } from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, BasemapSwitch, type BasemapStyle, type MapMarker, type MapPolygon, type MapPath, type MapCircle } from './components/MapView';
import {
  Badge, Button, KeyValue, Toggle, Select, SearchInput, InfoBanner, Tabs,
  EmptyState, StatCard, triggerDownload, ProvenanceBadge,
} from './components/ui';
import { ECOLOGICAL_AREAS, PORTS } from './data/geography';
import { analysePolygon } from './lib/geo';

/**
 * Ecological sensitivity and response planning.
 *
 * Translates the forecast drift envelope into an actionable protection order: which habitat
 * is closest, how long until the envelope reaches it, and therefore which stretch of coast
 * gets boom deployment first.
 */
export default function NcscmEcological() {
  const { world, now, selectedCaseId, setSelectedCaseId, getAnalysis, navigate, revision } = useStore();
  const [basemap, setBasemap] = useState<BasemapStyle>('bathymetry');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [minSensitivity, setMinSensitivity] = useState('all');
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [tab, setTab] = useState('priority');
  const [layers, setLayers] = useState({ areas: true, forecast: true, slick: true, ports: false });
  const [layersOpen, setLayersOpen] = useState(false);

  const openCases = useMemo(
    () => world.cases.filter((c) => !['Closed', 'Dismissed — Look-alike'].includes(c.status)),
    [world.cases, revision]
  );

  const activeCase = world.cases.find((c) => c.id === selectedCaseId) ?? openCases[0] ?? null;
  const analysis = activeCase ? getAnalysis(activeCase.id) : null;

  useEffect(() => {
    if (!selectedCaseId && openCases.length) setSelectedCaseId(openCases[0].id);
  }, [selectedCaseId, openCases, setSelectedCaseId]);

  const areas = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ECOLOGICAL_AREAS.filter((a) => {
      if (q && !`${a.name} ${a.state} ${a.category}`.toLowerCase().includes(q)) return false;
      if (category !== 'all' && a.category !== category) return false;
      if (minSensitivity !== 'all' && a.sensitivity < Number(minSensitivity)) return false;
      return true;
    });
  }, [query, category, minSensitivity]);

  /** Response priority: sensitivity weighted against proximity and time to impact. */
  const priority = useMemo(() => {
    if (!analysis) return [];
    return analysis.threatenedAreas
      .map((t) => {
        const area = ECOLOGICAL_AREAS.find((a) => a.id === t.id)!;
        const proximityTerm = Math.max(0, 1 - t.distanceKm / 200);
        const urgencyTerm = t.hoursToImpact !== null ? Math.max(0.35, 1 - t.hoursToImpact / 72) : 0;
        const score = area.sensitivity / 5 * 0.45 + proximityTerm * 0.3 + urgencyTerm * 0.25;
        const action = t.hoursToImpact !== null
          ? 'Deploy containment boom at the seaward approach immediately'
          : t.distanceKm < 40
          ? 'Pre-position boom and skimmer; place response crew on standby'
          : t.distanceKm < 120
          ? 'Monitor. Re-evaluate on the next satellite pass'
          : 'No action — outside the credible impact envelope';
        return { ...t, area, score, action };
      })
      .sort((a, b) => b.score - a.score);
  }, [analysis]);

  const mapData = useMemo(() => {
    const polygons: MapPolygon[] = [];
    const paths: MapPath[] = [];
    const circles: MapCircle[] = [];
    const markers: MapMarker[] = [];

    if (layers.areas) {
      for (const a of areas) {
        const t = analysis?.threatenedAreas.find((x) => x.id === a.id);
        const threatened = t && t.hoursToImpact !== null;
        const near = t && t.distanceKm < 60;
        const sel = a.id === selectedArea;
        polygons.push({
          id: a.id, rings: [a.ring],
          fill: threatened ? 'rgba(220,38,38,0.28)' : near ? 'rgba(245,158,11,0.24)' : `rgba(16,185,129,${0.08 + a.sensitivity * 0.03})`,
          stroke: threatened ? '#dc2626' : near ? '#f59e0b' : '#059669',
          strokeWidth: sel ? 2.6 : 1.3, selected: sel, z: sel ? 3 : 1,
        });
        const c = analysePolygon(a.ring).centroid;
        markers.push({
          id: `m-${a.id}`, position: c, kind: 'case',
          color: threatened ? '#dc2626' : near ? '#f59e0b' : '#059669',
          size: 3 + a.sensitivity, label: a.name, sublabel: `${a.category} · sensitivity ${a.sensitivity}/5`,
          selected: sel, pulse: !!threatened, z: 6,
          meta: t ? { Distance: `${t.distanceKm.toFixed(1)} km`, Impact: t.hoursToImpact !== null ? `${t.hoursToImpact} h` : 'Not in envelope' } : { Area: `${a.areaKm2} km²` },
        });
      }
    }

    if (activeCase && analysis) {
      if (layers.slick) {
        polygons.push({
          id: 'slick', rings: [activeCase.detection.polygon.ring, ...(activeCase.detection.polygon.fragments ?? [])],
          fill: 'rgba(15,23,42,0.75)', stroke: '#0f172a', strokeWidth: 1.4, z: 5, effect: 'oil',
        });
      }
      if (layers.forecast) {
        paths.push({ id: 'fc', points: analysis.forecast.path, stroke: '#06b6d4', strokeWidth: 2.4, arrow: true, flow: true, z: 4 });
        for (const h of analysis.forecast.horizons) {
          circles.push({
            id: `h-${h.hours}`, centre: h.centroid, radiusKm: Math.max(h.spreadKm, 1.5),
            fill: 'rgba(6,182,212,0.12)', stroke: '#06b6d4', dash: '4 3', label: `+${h.hours} h`,
          });
        }
      }
    }

    if (layers.ports) {
      for (const p of PORTS) {
        markers.push({ id: `p-${p.name}`, position: p, kind: 'port', color: '#64748b', size: 3.5, label: p.name, z: 2 });
      }
    }

    return { polygons, paths, circles, markers };
  }, [areas, analysis, activeCase, layers, selectedArea]);

  const exportBriefing = () => {
    if (!activeCase || !analysis) return;
    const lines = [
      'ECOLOGICAL EXPOSURE BRIEFING',
      '='.repeat(60), '',
      `Case reference : ${activeCase.id}`,
      `Case           : ${activeCase.title}`,
      `Location       : ${activeCase.subRegion}`,
      `Incident       : ${fmt.precise(activeCase.incidentTime, activeCase.facts.incident.timePrecision)}`,
      `Observation    : ${fmt.utc(activeCase.detection.acquiredAt)} (${activeCase.detection.observationSource})`,
      `Detection      : ${fmt.confidence(activeCase)} — ${analysis.assessment.verdict}`,
      `Oil type       : ${activeCase.oilType}`,
      `Oil quantity   : ${activeCase.oilQuantityTonnes != null ? `${activeCase.oilQuantityTonnes} t` : 'not reported'}`,
      `Wind forcing   : ${analysis.sampler.sources.wind}`,
      `Current forcing: ${analysis.sampler.sources.current}`,
      `Prepared       : ${fmt.utc(now)}`,
      '', 'HINDCAST ORIGIN', '-'.repeat(60),
      `Position       : ${analysis.hindcast.estimatedOrigin.lat.toFixed(4)}N ${analysis.hindcast.estimatedOrigin.lon.toFixed(4)}E`,
      `Time           : ${fmt.utc(analysis.hindcast.estimatedTime)} (± ${analysis.hindcast.timeWindowHours.toFixed(1)} h)`,
      `Uncertainty    : ± ${analysis.hindcast.uncertaintyRadiusKm.toFixed(1)} km`,
      '', 'FORECAST DRIFT', '-'.repeat(60),
      ...analysis.forecast.horizons.map((h) => `  +${String(h.hours).padStart(2)} h : ${h.centroid.lat.toFixed(3)}N ${h.centroid.lon.toFixed(3)}E  (spread ± ${h.spreadKm.toFixed(1)} km)`),
      '', 'RESPONSE PRIORITY', '-'.repeat(60),
      ...priority.slice(0, 8).flatMap((p, i) => [
        `${i + 1}. ${p.name}  [${p.category}, sensitivity ${p.sensitivity}/5, ${p.state}]`,
        `   Distance to envelope : ${p.distanceKm.toFixed(1)} km`,
        `   Time to impact       : ${p.hoursToImpact !== null ? `${p.hoursToImpact} h` : 'outside envelope'}`,
        `   Peak season          : ${p.area.peakSeason}`,
        `   Recommended action   : ${p.action}`,
        '',
      ]),
      'NOTE', '-'.repeat(60),
      'Distances are measured to the forecast spread envelope, not the centre line.',
      'Forecast spread grows with time; treat horizons beyond 48 h as indicative only.',
      'Sensitive-area outlines are approximate; official NCSCM shapefiles have not been integrated.',
      'This is a retrospective replay of a real incident, not an operational forecast.',
      '',
      `Generated by OceanSpill prototype (SIH PS 26143)`,
    ];
    triggerDownload(`${activeCase.id}-ecological-briefing.txt`, lines.join('\n'));
  };

  const selected = ECOLOGICAL_AREAS.find((a) => a.id === selectedArea);

  return (
    <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
      <aside className="w-full lg:w-[290px] xl:w-[340px] bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col flex-shrink-0 max-h-[46vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Leaf className="w-4 h-4 text-emerald-600" /> Ecological sensitivity</h2>
          <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1.5">{ECOLOGICAL_AREAS.length} sites · approximate outlines <ProvenanceBadge p="modelled" /></p>
          <p className="text-[11px] text-gray-400 mt-0.5 leading-normal">Official NCSCM shapefiles pending; outlines are hand-drawn from published maps.</p>
        </div>

        <div className="p-2 border-b border-gray-200">
          <Select label="Active case" value={activeCase?.id ?? ''} onChange={(v) => setSelectedCaseId(v)}
            options={world.cases.map((c) => ({ value: c.id, label: c.title }))} />
        </div>

        <Tabs fill active={tab} onChange={setTab} tabs={[
          { id: 'priority', label: 'Response priority', count: priority.filter((p) => p.distanceKm < 250).length },
          { id: 'register', label: 'Area register', count: areas.length },
        ]} />

        {tab === 'priority' && (
          <div className="flex-1 overflow-y-auto">
            {!analysis ? (
              <EmptyState title="No active case" body="Select a case to evaluate ecological exposure." />
            ) : priority.filter((p) => p.distanceKm < 250).length === 0 ? (
              <EmptyState icon={<Leaf className="w-10 h-10" />} title="No area at risk"
                body="No designated sensitive area lies within 250 km of the forecast envelope for this case." />
            ) : (
              <>
                <div className="p-3 border-b border-gray-200">
                  <p className="text-[11px] text-gray-500 leading-normal">
                    Ranked by habitat sensitivity, distance to the forecast envelope, and time until the
                    envelope arrives. Distances are to the spread boundary, not the centre line.
                  </p>
                </div>
                {priority.filter((p) => p.distanceKm < 250).map((p, i) => (
                  <div key={p.id} onClick={() => setSelectedArea(p.id === selectedArea ? null : p.id)}
                    className={`px-2.5 py-2 border-b border-gray-100 cursor-pointer ${
                      p.id === selectedArea ? 'bg-blue-50' : 'hover:bg-gray-50'
                    } ${p.hoursToImpact !== null ? 'border-l-[3px] border-l-red-500' : p.distanceKm < 60 ? 'border-l-[3px] border-l-amber-500' : 'border-l-[3px] border-l-transparent'}`}>
                    <div className="flex items-start gap-2">
                      <div className={`w-5 h-5 rounded flex items-center justify-center text-[11px] font-black flex-shrink-0 ${
                        i === 0 ? 'bg-red-600 text-white' : i < 3 ? 'bg-amber-500 text-white' : 'bg-gray-300 text-gray-700'}`}>{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-bold text-gray-900 leading-snug">{p.name}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <Badge tone={p.sensitivity >= 5 ? 'red' : p.sensitivity >= 4 ? 'amber' : 'green'}>S{p.sensitivity}/5</Badge>
                          <span className="text-[11px] text-gray-500">{p.category}</span>
                        </div>
                        <div className="flex gap-3 mt-1 text-[11px]">
                          <span className="text-gray-600">Distance <b className="font-mono text-gray-900">{p.distanceKm.toFixed(1)} km</b></span>
                          {p.hoursToImpact !== null && (
                            <span className="text-red-700 font-bold flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" /> impact in {p.hoursToImpact} h
                            </span>
                          )}
                        </div>
                        <p className={`text-[11px] mt-1 leading-normal ${p.hoursToImpact !== null ? 'text-red-700 font-semibold' : 'text-gray-600'}`}>
                          {p.action}
                        </p>
                        {p.id === selectedArea && (
                          <div className="mt-2 space-y-2">
                            <p className="text-[11px] text-gray-600 leading-normal">{p.area.notes}</p>
                            <KeyValue cols={2} items={[
                              ['Extent', `${fmt.num(p.area.areaKm2)} km²`],
                              ['State', p.state],
                              ['Peak season', p.area.peakSeason],
                              ['Priority score', p.score.toFixed(2)],
                            ]} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {tab === 'register' && (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="p-2 space-y-3 border-b border-gray-200">
              <SearchInput value={query} onChange={setQuery} placeholder="Name, state or category…" />
              <div className="grid grid-cols-2 gap-2">
                <Select value={category} onChange={setCategory}
                  options={[{ value: 'all', label: 'All categories' }, ...Array.from(new Set(ECOLOGICAL_AREAS.map((a) => a.category))).map((c) => ({ value: c, label: c }))]} />
                <Select value={minSensitivity} onChange={setMinSensitivity}
                  options={[{ value: 'all', label: 'Any sensitivity' }, { value: '5', label: 'Critical (5)' }, { value: '4', label: 'High (4+)' }, { value: '3', label: 'Moderate (3+)' }]} />
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {areas.map((a) => (
                <button key={a.id} onClick={() => setSelectedArea(a.id === selectedArea ? null : a.id)}
                  className={`w-full text-left px-2.5 py-2 border-b border-gray-100 ${a.id === selectedArea ? 'bg-blue-50' : 'hover:bg-gray-50'}`}>
                  <div className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                      <p className="text-[12px] font-bold text-gray-900 leading-snug">{a.name}</p>
                      <p className="text-[11px] text-gray-500">{a.category} · {a.state}</p>
                    </div>
                    <Badge tone={a.sensitivity >= 5 ? 'red' : a.sensitivity >= 4 ? 'amber' : 'green'}>S{a.sensitivity}</Badge>
                  </div>
                  {a.id === selectedArea && (
                    <div className="mt-1.5">
                      <p className="text-[11px] text-gray-600 leading-normal">{a.notes}</p>
                      <KeyValue cols={2} items={[['Extent', `${fmt.num(a.areaKm2)} km²`], ['Peak season', a.peakSeason]]} />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 min-h-[72vh] lg:min-h-0 flex flex-col flex-shrink-0 lg:flex-shrink">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<Shield className="w-4 h-4" />} title="Critical sites" value={ECOLOGICAL_AREAS.filter((a) => a.sensitivity >= 5).length}
            trend="sensitivity 5 of 5" accent="red" />
          <StatCard icon={<AlertTriangle className="w-4 h-4" />} title="In forecast envelope"
            value={priority.filter((p) => p.hoursToImpact !== null).length} trend="for the active case" accent="amber" />
          <StatCard icon={<Waves className="w-4 h-4" />} title="Within 60 km"
            value={priority.filter((p) => p.distanceKm < 60).length} trend="pre-positioning range" />
          <StatCard icon={<Fish className="w-4 h-4" />} title="Protected extent"
            value={`${fmt.num(Math.round(ECOLOGICAL_AREAS.reduce((s, a) => s + a.areaKm2, 0) / 1000))}k`} trend="km² under designation" accent="green" />
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={exportBriefing} disabled={!activeCase} icon={<FileDown className="w-3 h-3" />}>Export briefing</Button>
            {activeCase && (
              <Button size="sm" variant="primary" onClick={() => navigate({ tab: 'SACHET / SAMUDRA', caseId: activeCase.id })} icon={<Anchor className="w-3 h-3" />}>
                Issue advisory
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            polygons={mapData.polygons} paths={mapData.paths} circles={mapData.circles} markers={mapData.markers}
            initialCentre={{ lat: 15, lon: 80 }} initialZoom={3.9}
            onMarkerClick={(m) => setSelectedArea(m.id.replace('m-', ''))}
            fitTo={selected ? selected.ring : undefined} fitKey={selectedArea ?? 'none'}
            overlay={
              <div className="absolute top-3 left-3 z-20 flex gap-2 items-start">
                <BasemapSwitch value={basemap} onChange={setBasemap} />
                <div className="relative">
                  <button onClick={() => setLayersOpen((o) => !o)}
                    className="bg-white rounded shadow-md border border-gray-300 px-2.5 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Layers
                  </button>
                  {layersOpen && (
                    <div className="absolute top-full mt-1 left-0 bg-white rounded shadow-xl border border-gray-300 p-3 w-52 z-30">
                      <Toggle checked={layers.areas} onChange={(v) => setLayers({ ...layers, areas: v })} label="Protected areas" count={areas.length} />
                      <Toggle checked={layers.slick} onChange={(v) => setLayers({ ...layers, slick: v })} label="Reported slick / location" />
                      <Toggle checked={layers.forecast} onChange={(v) => setLayers({ ...layers, forecast: v })} label="Forecast envelope" />
                      <Toggle checked={layers.ports} onChange={(v) => setLayers({ ...layers, ports: v })} label="Ports & terminals" />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-3 text-[11px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Exposure</h4>
                <Sw color="#dc2626" label="Inside forecast envelope" />
                <Sw color="#f59e0b" label="Within 60 km" />
                <Sw color="#059669" label="Designated, not at risk" />
                <div className="border-t border-gray-200 mt-1.5 pt-1.5 flex items-center gap-2 text-gray-600">
                  <div className="w-4 border-t-2 border-cyan-500" /><span>Forecast drift</span>
                </div>
              </div>
            }
          />
        </div>

        {activeCase && analysis && (
          <div className="border-t border-gray-200 bg-white px-3 py-2 flex-shrink-0">
            <InfoBanner tone={priority.some((p) => p.hoursToImpact !== null) ? 'red' : 'blue'}
              icon={<AlertTriangle className="w-3.5 h-3.5" />}>
              {priority.some((p) => p.hoursToImpact !== null)
                ? <>The forecast envelope for <b>{activeCase.id}</b> reaches <b>{priority.find((p) => p.hoursToImpact !== null)!.name}</b> within {priority.find((p) => p.hoursToImpact !== null)!.hoursToImpact} hours. This page is designed to be exported and shared with the state coastal management authority, not held internally.</>
                : <>No designated area is inside the forecast envelope for <b>{activeCase.id}</b>. Nearest protected habitat is <b>{priority[0]?.name ?? 'none within 400 km'}</b>{priority[0] ? ` at ${priority[0].distanceKm.toFixed(1)} km` : ''}.</>}
            </InfoBanner>
          </div>
        )}
      </section>
    </main>
  );
}

function Sw({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <div className="w-3.5 h-2.5 rounded-sm border" style={{ background: `${color}44`, borderColor: color }} />
      <span className="text-gray-700">{label}</span>
    </div>
  );
}
