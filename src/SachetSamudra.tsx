import { useEffect, useMemo, useState } from 'react';
import {
  Megaphone, Send, MessageSquare, CheckCircle2, Radio, Link2,
  MapPin, Camera, Languages, Users, Bell, Layers,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, type BasemapStyle, type MapMarker, type MapCircle, type MapPolygon, BasemapSwitch } from './components/MapView';
import {
  Badge, Button, KeyValue, Toggle, Select, Field, TextInput, TextArea, Slider,
  InfoBanner, Tabs, StatCard, EmptyState, Modal, DataTable, type Column,
} from './components/ui';
import { analysePolygon } from './lib/geo';
import { distanceToCoastKm } from './data/geography';
import type { SightingReport } from './data/types';

const CHANNELS = ['SMS', 'WhatsApp', 'Community Radio', 'Coastal Siren', 'App Push'] as const;
const LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Marathi', 'Gujarati', 'Odia', 'Bengali', 'Konkani'];

const DISTRICTS_BY_REGION: Record<string, string[]> = {
  'Arabian Sea': ['Jamnagar', 'Devbhumi Dwarka', 'Porbandar', 'Kachchh', 'Mumbai Suburban', 'Raigad', 'Ratnagiri'],
  'Bay of Bengal': ['Kendrapara', 'Jagatsinghpur', 'Bhadrak', 'Balasore', 'Puri', 'East Godavari', 'Visakhapatnam'],
  'Kerala Coast': ['Ernakulam', 'Thrissur', 'Alappuzha', 'Kollam', 'Kozhikode'],
  'Tamil Nadu Coast': ['Chennai', 'Tiruvallur', 'Cuddalore', 'Nagapattinam', 'Ramanathapuram', 'Thoothukudi'],
  'Andaman Sea': ['South Andaman', 'North & Middle Andaman', 'Nicobar'],
  'Lakshadweep Sea': ['Lakshadweep', 'Kavaratti', 'Minicoy'],
};

export default function SachetSamudra() {
  const { world, now, selectedCaseId, setSelectedCaseId, getAnalysis, dispatchAlert, linkSighting, verifySighting, navigate, revision } = useStore();
  const [tab, setTab] = useState('compose');
  const [basemap, setBasemap] = useState<BasemapStyle>('map');
  const [selectedSighting, setSelectedSighting] = useState<string | null>(null);
  const [linkModal, setLinkModal] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [verifiedFilter, setVerifiedFilter] = useState('all');
  const [layers, setLayers] = useState({ sightings: true, zones: true, slicks: true });
  const [layersOpen, setLayersOpen] = useState(false);

  const activeCase = world.cases.find((c) => c.id === selectedCaseId) ?? world.cases[0] ?? null;
  const analysis = activeCase ? getAnalysis(activeCase.id) : null;

  // Composer state, pre-filled from the selected case.
  const [channels, setChannels] = useState<string[]>(['SMS', 'WhatsApp']);
  const [languages, setLanguages] = useState<string[]>(['English', 'Hindi']);
  const [districts, setDistricts] = useState<string[]>([]);
  const [headline, setHeadline] = useState('');
  const [body, setBody] = useState('');
  const [radius, setRadius] = useState(15);
  const [validHours, setValidHours] = useState(48);

  useEffect(() => {
    if (!activeCase || !analysis) return;
    const shape = analysePolygon(activeCase.detection.polygon.ring);
    const spread = analysis.forecast.horizons.find((h) => h.hours === 24)?.spreadKm ?? 10;
    const r = Math.max(8, Math.round(spread + shape.majorAxisKm));
    setRadius(r);
    setDistricts(DISTRICTS_BY_REGION[activeCase.region]?.slice(0, 3) ?? []);
    setHeadline(`Oil slick advisory — ${activeCase.region}`);
    setBody(
      `An oil slick has been detected approximately ${Math.round(distanceToCoastKm(shape.centroid))} km offshore in the ${activeCase.subRegion}. ` +
      `The slick is drifting and is expected to remain a hazard for the next ${validHours} hours. ` +
      `Fishing craft are advised to avoid the marked area. Do not handle floating oil or tar balls. ` +
      `Nets exposed to oil must be cleaned before reuse. Report any sighting to the nearest Coast Guard station or through the SAMUDRA app.`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCase?.id]);

  const sightings = useMemo(() => {
    return world.sightings.filter((s) => {
      if (severityFilter !== 'all' && s.severity !== severityFilter) return false;
      if (verifiedFilter === 'verified' && !s.verified) return false;
      if (verifiedFilter === 'unverified' && s.verified) return false;
      return true;
    }).sort((a, b) => b.receivedAt - a.receivedAt);
  }, [world.sightings, severityFilter, verifiedFilter, revision]);

  const mapData = useMemo(() => {
    const markers: MapMarker[] = [];
    const circles: MapCircle[] = [];
    const polygons: MapPolygon[] = [];

    if (layers.zones && activeCase && analysis) {
      const shape = analysePolygon(activeCase.detection.polygon.ring);
      circles.push({
        id: 'nogo', centre: shape.centroid, radiusKm: radius,
        fill: 'rgba(220,38,38,0.14)', stroke: '#dc2626', dash: '6 4', label: `No-go zone ${radius} km`,
      });
    }
    if (layers.slicks) {
      for (const c of world.cases) {
        if (['Closed', 'Dismissed — Look-alike'].includes(c.status)) continue;
        polygons.push({
          id: `s-${c.id}`, rings: [c.detection.polygon.ring],
          fill: 'rgba(15,23,42,0.7)', stroke: '#0f172a', strokeWidth: 1.2,
          z: c.id === activeCase?.id ? 4 : 2,
        });
      }
    }
    if (layers.sightings) {
      for (const s of sightings) {
        markers.push({
          id: s.id, position: s.position, kind: 'sighting',
          color: s.severity === 'Heavy Oil' ? '#dc2626' : s.severity === 'Patchy Oil' ? '#f97316'
            : s.severity === 'Tar Balls' ? '#78350f' : s.severity === 'Dead Fish' ? '#7c3aed' : '#f59e0b',
          size: s.verified ? 7 : 5, selected: s.id === selectedSighting,
          label: `${s.severity} — ${s.district}`, sublabel: `${s.reporter} · ${fmt.ago(s.receivedAt, now)}`,
          z: s.verified ? 7 : 6,
          meta: { Boat: s.boatRegistration, Photos: s.photos, Verified: s.verified ? 'Yes' : 'Pending' },
        });
      }
    }
    // Dispatched alert zones.
    for (const a of world.alerts) {
      if (a.status === 'Dispatched') {
        circles.push({
          id: `a-${a.id}`, centre: a.centre, radiusKm: a.noGoRadiusKm,
          fill: 'rgba(245,158,11,0.1)', stroke: '#f59e0b', dash: '4 4', opacity: 0.75, label: a.id,
        });
      }
    }
    return { markers, circles, polygons };
  }, [sightings, activeCase, analysis, radius, layers, selectedSighting, world.cases, world.alerts, now]);

  const estimatedReach = useMemo(() => {
    const perDistrict = 4800;
    return channels.reduce((sum, ch) => {
      const base = ch === 'SMS' ? perDistrict * districts.length
        : ch === 'WhatsApp' ? Math.round(perDistrict * districts.length * 0.61)
        : ch === 'App Push' ? Math.round(perDistrict * districts.length * 0.22)
        : ch === 'Coastal Siren' ? districts.length * 3 : districts.length * 2;
      return sum + base;
    }, 0);
  }, [channels, districts]);

  const canDispatch = channels.length > 0 && languages.length > 0 && districts.length > 0 && headline.trim() && body.trim() && activeCase;

  const doDispatch = () => {
    if (!activeCase || !analysis) return;
    const shape = analysePolygon(activeCase.detection.polygon.ring);
    dispatchAlert({
      caseId: activeCase.id, issuedAt: now, channel: channels as any, languages, districts,
      headline: headline.trim(), body: body.trim(), noGoRadiusKm: radius,
      centre: shape.centroid, validUntil: now + validHours * 3600_000,
    });
    setTab('log');
  };

  const sightingColumns: Column<SightingReport>[] = [
    {
      key: 'received', header: 'Received', width: '104px', value: (s) => s.receivedAt,
      render: (s) => (
        <div><div className="font-mono text-gray-800">{fmt.utcShort(s.receivedAt)}</div>
        <div className="text-[9px] text-gray-400">{fmt.ago(s.receivedAt, now)}</div></div>
      ),
    },
    {
      key: 'reporter', header: 'Reporter', value: (s) => s.reporter,
      render: (s) => (
        <div><div className="font-semibold text-gray-900">{s.reporter}</div>
        <div className="text-[9.5px] text-gray-500 font-mono">{s.boatRegistration}</div></div>
      ),
    },
    { key: 'district', header: 'District', width: '124px', value: (s) => s.district },
    {
      key: 'severity', header: 'Severity', width: '96px', value: (s) => s.severity,
      render: (s) => <Badge tone={s.severity === 'Heavy Oil' ? 'red' : s.severity === 'Patchy Oil' ? 'amber' : s.severity === 'Dead Fish' ? 'violet' : 'gray'}>{s.severity}</Badge>,
    },
    { key: 'lang', header: 'Language', width: '86px', value: (s) => s.language },
    {
      key: 'photos', header: 'Media', width: '62px', align: 'center', value: (s) => s.photos,
      render: (s) => <span className="inline-flex items-center gap-0.5 text-gray-600"><Camera className="w-3 h-3" />{s.photos}</span>,
    },
    {
      key: 'case', header: 'Linked case', width: '124px', value: (s) => s.linkedCaseId ?? '',
      render: (s) => s.linkedCaseId
        ? <button onClick={(e) => { e.stopPropagation(); navigate({ tab: 'Investigation', caseId: s.linkedCaseId! }); }}
            className="font-mono text-blue-600 hover:underline font-semibold">{s.linkedCaseId}</button>
        : <span className="text-gray-300">—</span>,
    },
    {
      key: 'status', header: 'Status', width: '150px', sortable: false,
      render: (s) => (
        <div className="flex gap-1">
          {s.verified
            ? <Badge tone="green"><CheckCircle2 className="w-2.5 h-2.5" /> Verified</Badge>
            : <Button size="sm" onClick={(e) => { e.stopPropagation(); verifySighting(s.id); }}>Verify</Button>}
          {!s.linkedCaseId && <Button size="sm" onClick={(e) => { e.stopPropagation(); setLinkModal(s.id); }} icon={<Link2 className="w-3 h-3" />}>Link</Button>}
        </div>
      ),
    },
  ];

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[380px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Megaphone className="w-4 h-4 text-amber-600" /> SACHET / SAMUDRA</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Community alerting and crowdsourced sightings</p>
        </div>

        <Tabs active={tab} onChange={setTab} tabs={[
          { id: 'compose', label: 'Compose' },
          { id: 'log', label: 'Dispatch log', count: world.alerts.length },
        ]} />

        {tab === 'compose' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <Field label="Case reference">
              <Select value={activeCase?.id ?? ''} onChange={setSelectedCaseId}
                options={world.cases.map((c) => ({ value: c.id, label: `${c.id} — ${c.subRegion}` }))} />
            </Field>

            <Field label="Headline"><TextInput value={headline} onChange={setHeadline} /></Field>

            <Field label="Advisory text" hint="Dispatched through the NDMA SACHET gateway and translated into the selected languages.">
              <TextArea value={body} onChange={setBody} rows={6} />
            </Field>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Channels</p>
              <div className="grid grid-cols-2 gap-x-2">
                {CHANNELS.map((ch) => (
                  <Toggle key={ch} checked={channels.includes(ch)}
                    onChange={(v) => setChannels(v ? [...channels, ch] : channels.filter((c) => c !== ch))}
                    label={ch} />
                ))}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1 flex items-center gap-1.5"><Languages className="w-3 h-3" /> Languages</p>
              <div className="flex flex-wrap gap-1">
                {LANGUAGES.map((l) => (
                  <button key={l} onClick={() => setLanguages(languages.includes(l) ? languages.filter((x) => x !== l) : [...languages, l])}
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                      languages.includes(l) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Coastal districts</p>
              <div className="flex flex-wrap gap-1">
                {(DISTRICTS_BY_REGION[activeCase?.region ?? ''] ?? []).map((d) => (
                  <button key={d} onClick={() => setDistricts(districts.includes(d) ? districts.filter((x) => x !== d) : [...districts, d])}
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${
                      districts.includes(d) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-600 border-gray-300 hover:border-emerald-400'}`}>
                    {d}
                  </button>
                ))}
              </div>
              {districts.length === 0 && <p className="text-[10px] text-amber-700 mt-1">Select at least one district.</p>}
            </div>

            <Slider label="No-go radius" value={radius} onChange={setRadius} min={3} max={60} step={1} format={(v) => `${v} km`} />
            <p className="text-[9.5px] text-gray-500 -mt-1 leading-snug">
              Pre-filled from the 24-hour forecast spread plus the slick's long axis, so the zone covers where
              the oil will be, not only where it is.
            </p>
            <Slider label="Valid for" value={validHours} onChange={setValidHours} min={6} max={96} step={6} format={(v) => `${v} h`} />

            <div className="bg-blue-50 border border-blue-200 rounded p-2.5">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-bold text-blue-900 uppercase">Estimated reach</span>
                <span className="text-base font-black text-blue-900">{fmt.num(estimatedReach)}</span>
              </div>
              <p className="text-[10px] text-blue-800">
                {districts.length} district{districts.length === 1 ? '' : 's'} · {channels.length} channel{channels.length === 1 ? '' : 's'} · {languages.length} language{languages.length === 1 ? '' : 's'}
              </p>
            </div>

            <Button variant="primary" className="w-full justify-center" disabled={!canDispatch} onClick={doDispatch} icon={<Send className="w-3.5 h-3.5" />}>
              Dispatch through SACHET
            </Button>

            <InfoBanner tone="blue" icon={<Radio className="w-3.5 h-3.5" />}>
              Alerts route through NDMA's existing SACHET gateway and INCOIS's coastal dissemination network
              rather than a new channel. Fisherfolk already receive warnings this way; adding another app would
              reduce reach, not increase it.
            </InfoBanner>
          </div>
        )}

        {tab === 'log' && (
          <div className="flex-1 overflow-y-auto">
            {world.alerts.length === 0 ? (
              <EmptyState icon={<Bell className="w-10 h-10" />} title="No alerts dispatched" />
            ) : world.alerts.map((a) => {
              const delivered = a.reach.reduce((s, r) => s + r.delivered, 0);
              const failed = a.reach.reduce((s, r) => s + r.failed, 0);
              return (
                <div key={a.id} className="px-3 py-2.5 border-b border-gray-100">
                  <div className="flex justify-between items-start gap-2 mb-1">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold text-gray-900">{a.headline}</p>
                      <p className="text-[9.5px] text-gray-500 font-mono">{a.id} · {a.caseId}</p>
                    </div>
                    <Badge tone={a.status === 'Dispatched' ? 'green' : a.status === 'Expired' ? 'gray' : 'amber'}>{a.status}</Badge>
                  </div>
                  <p className="text-[10px] text-gray-600 leading-snug line-clamp-2">{a.body}</p>
                  <div className="mt-1.5">
                    <KeyValue cols={2} items={[
                      ['Issued', fmt.utcShort(a.issuedAt)],
                      ['Valid until', fmt.utcShort(a.validUntil)],
                      ['Districts', a.districts.join(', ')],
                      ['Languages', a.languages.join(', ')],
                    ]} />
                  </div>
                  <div className="mt-1.5 space-y-1">
                    {a.reach.map((r) => (
                      <div key={r.channel} className="flex items-center gap-2 text-[9.5px]">
                        <span className="w-24 text-gray-600 flex-shrink-0">{r.channel}</span>
                        <div className="flex-1 h-1.5 bg-gray-200 rounded overflow-hidden">
                          <div className="h-full bg-emerald-500" style={{ width: `${(r.delivered / Math.max(r.sent, 1)) * 100}%` }} />
                        </div>
                        <span className="font-mono text-gray-700 w-20 text-right flex-shrink-0">{fmt.num(r.delivered)}/{fmt.num(r.sent)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[9.5px] text-gray-500 mt-1">
                    {fmt.num(delivered)} delivered · {fmt.num(failed)} failed
                    {failed > 0 && ` (${((failed / (delivered + failed)) * 100).toFixed(1)}% failure)`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<Megaphone className="w-4 h-4" />} title="Alerts issued" value={world.alerts.length} trend="all time" accent="amber" />
          <StatCard icon={<Users className="w-4 h-4" />} title="Recipients reached"
            value={fmt.num(world.alerts.reduce((s, a) => s + a.reach.reduce((x, r) => x + r.delivered, 0), 0))} trend="delivered messages" accent="green" />
          <StatCard icon={<MessageSquare className="w-4 h-4" />} title="Sighting reports" value={world.sightings.length}
            trend={`${world.sightings.filter((s) => !s.verified).length} awaiting verification`} />
          <StatCard icon={<Link2 className="w-4 h-4" />} title="Linked to cases"
            value={world.sightings.filter((s) => s.linkedCaseId).length} trend="used as corroborating evidence" />
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            markers={mapData.markers} circles={mapData.circles} polygons={mapData.polygons}
            initialCentre={{ lat: 15, lon: 80 }} initialZoom={3.9}
            onMarkerClick={(m) => setSelectedSighting(m.id === selectedSighting ? null : m.id)}
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
                      <Toggle checked={layers.sightings} onChange={(v) => setLayers({ ...layers, sightings: v })} label="Sighting reports" count={sightings.length} />
                      <Toggle checked={layers.zones} onChange={(v) => setLayers({ ...layers, zones: v })} label="No-go zone (draft)" />
                      <Toggle checked={layers.slicks} onChange={(v) => setLayers({ ...layers, slicks: v })} label="Active slicks" />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Sighting severity</h4>
                {[['#dc2626', 'Heavy oil'], ['#f97316', 'Patchy oil'], ['#f59e0b', 'Sheen'], ['#78350f', 'Tar balls'], ['#7c3aed', 'Dead fish']].map(([c, l]) => (
                  <div key={l} className="flex items-center gap-2 mb-1">
                    <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-b-[8px] border-l-transparent border-r-transparent" style={{ borderBottomColor: c }} />
                    <span className="text-gray-700">{l}</span>
                  </div>
                ))}
                <p className="text-[9px] text-gray-400 mt-1">Larger markers are verified reports.</p>
              </div>
            }
          />
        </div>

        <div className="h-[250px] border-t border-gray-200 bg-white flex-shrink-0 flex flex-col">
          <div className="px-3 py-1.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
            <span className="text-[11px] font-bold text-gray-700 flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" /> Fisherfolk sighting inbox — {sightings.length} reports
            </span>
            <div className="flex gap-2">
              <Select value={severityFilter} onChange={setSeverityFilter}
                options={[{ value: 'all', label: 'All severities' }, ...['Sheen', 'Patchy Oil', 'Heavy Oil', 'Tar Balls', 'Dead Fish'].map((s) => ({ value: s, label: s }))]} />
              <Select value={verifiedFilter} onChange={setVerifiedFilter}
                options={[{ value: 'all', label: 'All reports' }, { value: 'verified', label: 'Verified only' }, { value: 'unverified', label: 'Awaiting verification' }]} />
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <DataTable columns={sightingColumns} rows={sightings} rowKey={(s) => s.id} dense
              selectedId={selectedSighting} onRowClick={(s) => setSelectedSighting(s.id === selectedSighting ? null : s.id)}
              initialSort={{ key: 'received', dir: 'desc' }} />
          </div>
        </div>
      </section>

      <LinkModal open={!!linkModal} onClose={() => setLinkModal(null)} sightingId={linkModal}
        onLink={(caseId) => { if (linkModal) linkSighting(linkModal, caseId); setLinkModal(null); }} />
    </main>
  );
}

function LinkModal({ open, onClose, sightingId, onLink }: { open: boolean; onClose: () => void; sightingId: string | null; onLink: (caseId: string) => void }) {
  const { world, now } = useStore();
  const s = world.sightings.find((x) => x.id === sightingId);
  const [pick, setPick] = useState('');

  // Rank cases by how close the sighting is to each slick, so the obvious match is first.
  const ranked = useMemo(() => {
    if (!s) return [];
    return world.cases.map((c) => {
      const shape = analysePolygon(c.detection.polygon.ring);
      const d = Math.hypot((shape.centroid.lat - s.position.lat) * 110.6, (shape.centroid.lon - s.position.lon) * 111.3 * Math.cos((s.position.lat * Math.PI) / 180));
      return { c, d };
    }).sort((a, b) => a.d - b.d);
  }, [s, world.cases]);

  useEffect(() => { if (ranked.length) setPick(ranked[0].c.id); }, [sightingId, ranked.length]);

  if (!s) return null;
  return (
    <Modal open={open} onClose={onClose} title={`Link ${s.id} to a case`}
      subtitle="Attaches the report as corroborating evidence on the case record."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!pick} onClick={() => onLink(pick)}>Link report</Button></>}>
      <div className="space-y-3">
        <div className="bg-gray-50 border border-gray-200 rounded p-2.5">
          <div className="flex items-center gap-2 mb-1">
            <MapPin className="w-3.5 h-3.5 text-gray-500" />
            <span className="text-[11px] font-bold text-gray-900">{s.reporter} — {s.district}</span>
            <Badge tone={s.severity === 'Heavy Oil' ? 'red' : 'amber'}>{s.severity}</Badge>
          </div>
          <p className="text-[11px] text-gray-700 leading-relaxed italic">"{s.description}"</p>
          <p className="text-[10px] text-gray-500 mt-1.5 font-mono">
            {s.position.lat.toFixed(3)}° N  {s.position.lon.toFixed(3)}° E · {fmt.utc(s.receivedAt)} · {s.language}
          </p>
        </div>
        <Field label="Candidate cases (nearest first)">
          <div className="space-y-1">
            {ranked.slice(0, 5).map(({ c, d }) => (
              <button key={c.id} onClick={() => setPick(c.id)}
                className={`w-full text-left px-2 py-1.5 rounded border ${pick === c.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-400'}`}>
                <div className="flex justify-between items-center gap-2">
                  <div className="min-w-0">
                    <span className="text-[11px] font-bold font-mono text-gray-900">{c.id}</span>
                    <span className="text-[10px] text-gray-600 ml-2 truncate">{c.subRegion}</span>
                  </div>
                  <span className="text-[10px] font-mono text-gray-500 flex-shrink-0">{d.toFixed(0)} km</span>
                </div>
                <p className="text-[9.5px] text-gray-400 mt-0.5">Detected {fmt.ago(c.detection.acquiredAt, now)}</p>
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
