import { useEffect, useMemo, useState } from 'react';
import {
  Megaphone, Send, MessageSquare, CheckCircle2, Radio, Link2,
  MapPin, Languages, Bell, Layers, FileDown, Plus, ShieldAlert,
} from 'lucide-react';
import { useStore, fmt } from './store/store';
import { MapView, type BasemapStyle, type MapMarker, type MapCircle, type MapPolygon, BasemapSwitch } from './components/MapView';
import {
  Badge, Button, KeyValue, Toggle, Select, Field, TextInput, TextArea, Slider,
  InfoBanner, Tabs, StatCard, EmptyState, Modal, DataTable, ProvenanceBadge, triggerDownload, type Column,
} from './components/ui';
import { analysePolygon, haversineKm } from './lib/geo';
import { distanceToCoastKm } from './data/geography';
import type { CommunityAlert, SightingReport } from './data/types';

const CHANNELS = ['SMS', 'Cell broadcast', 'Community Radio', 'Coastal Siren', 'App Push'] as const;
const LANGUAGES = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Marathi', 'Gujarati', 'Odia', 'Bengali', 'Konkani'];
const SEVERITIES: SightingReport['severity'][] = ['Sheen', 'Patchy Oil', 'Heavy Oil', 'Tar Balls', 'Debris / Containers', 'Fire'];

/** Coastal districts with approximate coastal reference points, used to pre-select the nearest ones. */
const DISTRICTS: { name: string; region: string; lat: number; lon: number }[] = [
  { name: 'Kachchh', region: 'Arabian Sea', lat: 22.8, lon: 69.7 }, { name: 'Devbhumi Dwarka', region: 'Arabian Sea', lat: 22.24, lon: 68.97 },
  { name: 'Jamnagar', region: 'Arabian Sea', lat: 22.47, lon: 70.06 }, { name: 'Porbandar', region: 'Arabian Sea', lat: 21.64, lon: 69.6 },
  { name: 'Mumbai Suburban', region: 'Arabian Sea', lat: 19.1, lon: 72.82 }, { name: 'Raigad', region: 'Arabian Sea', lat: 18.5, lon: 72.9 },
  { name: 'Ratnagiri', region: 'Arabian Sea', lat: 16.99, lon: 73.28 },
  { name: 'Sindhudurg', region: 'Goa Coast', lat: 16.0, lon: 73.48 }, { name: 'North Goa', region: 'Goa Coast', lat: 15.55, lon: 73.75 },
  { name: 'South Goa', region: 'Goa Coast', lat: 15.2, lon: 73.93 }, { name: 'Uttara Kannada', region: 'Goa Coast', lat: 14.8, lon: 74.12 },
  { name: 'Kasaragod', region: 'Kerala Coast', lat: 12.5, lon: 74.98 }, { name: 'Kannur', region: 'Kerala Coast', lat: 11.87, lon: 75.36 },
  { name: 'Kozhikode', region: 'Kerala Coast', lat: 11.25, lon: 75.77 }, { name: 'Thrissur', region: 'Kerala Coast', lat: 10.5, lon: 76.05 },
  { name: 'Ernakulam', region: 'Kerala Coast', lat: 9.97, lon: 76.24 }, { name: 'Alappuzha', region: 'Kerala Coast', lat: 9.49, lon: 76.32 },
  { name: 'Kollam', region: 'Kerala Coast', lat: 8.88, lon: 76.59 }, { name: 'Thiruvananthapuram', region: 'Kerala Coast', lat: 8.5, lon: 76.93 },
  { name: 'Thoothukudi', region: 'Tamil Nadu Coast', lat: 8.76, lon: 78.15 }, { name: 'Ramanathapuram', region: 'Tamil Nadu Coast', lat: 9.28, lon: 79.1 },
  { name: 'Nagapattinam', region: 'Tamil Nadu Coast', lat: 10.77, lon: 79.85 }, { name: 'Mayiladuthurai', region: 'Tamil Nadu Coast', lat: 11.03, lon: 79.85 },
  { name: 'Cuddalore', region: 'Tamil Nadu Coast', lat: 11.75, lon: 79.78 }, { name: 'Chennai', region: 'Tamil Nadu Coast', lat: 13.08, lon: 80.29 },
  { name: 'Tiruvallur', region: 'Tamil Nadu Coast', lat: 13.3, lon: 80.32 },
  { name: 'South 24 Parganas', region: 'Bay of Bengal', lat: 21.65, lon: 88.08 }, { name: 'Purba Medinipur', region: 'Bay of Bengal', lat: 21.63, lon: 87.52 },
  { name: 'Balasore', region: 'Bay of Bengal', lat: 21.49, lon: 87.0 }, { name: 'Bhadrak', region: 'Bay of Bengal', lat: 20.8, lon: 86.95 },
  { name: 'Kendrapara', region: 'Bay of Bengal', lat: 20.5, lon: 86.75 }, { name: 'Jagatsinghpur', region: 'Bay of Bengal', lat: 20.26, lon: 86.67 },
  { name: 'South Andaman', region: 'Andaman Sea', lat: 11.62, lon: 92.72 }, { name: 'North & Middle Andaman', region: 'Andaman Sea', lat: 12.9, lon: 92.9 },
  { name: 'Nicobar', region: 'Andaman Sea', lat: 8.0, lon: 93.5 }, { name: 'Lakshadweep', region: 'Lakshadweep Sea', lat: 10.57, lon: 72.64 },
];

function districtsNear(p: { lat: number; lon: number }): string[] {
  return [...DISTRICTS].sort((a, b) => haversineKm(p, a) - haversineKm(p, b)).map((d) => d.name);
}

const SEVERITY_COLOR: Record<SightingReport['severity'], string> = {
  'Heavy Oil': '#dc2626', 'Patchy Oil': '#f97316', Sheen: '#f59e0b', 'Tar Balls': '#78350f', 'Debris / Containers': '#2563eb', Fire: '#7c3aed',
};

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** OASIS CAP 1.2 message, the format the NDMA SACHET gateway ingests. */
function capXml(a: CommunityAlert): string {
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const circle = `${a.centre.lat.toFixed(4)},${a.centre.lon.toFixed(4)} ${a.noGoRadiusKm.toFixed(1)}`;
  const infos = (a.languages.length ? a.languages : ['English']).map((lang) => `  <info>
    <language>${escapeXml(lang)}</language>
    <category>Env</category>
    <event>Oil pollution</event>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Observed</certainty>
    <senderName>${escapeXml(a.issuer)}</senderName>
    <headline>${escapeXml(a.headline)}</headline>
    <description>${escapeXml(a.body)}</description>
    <instruction>Avoid the marked area. Do not handle floating oil or tar balls. Report sightings to the nearest Coast Guard station.</instruction>${a.validUntil ? `\n    <expires>${iso(a.validUntil)}</expires>` : ''}
    <area>
      <areaDesc>${escapeXml(a.districts.join(', '))}</areaDesc>
      <circle>${circle}</circle>
    </area>
  </info>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- DRAFT generated by the OceanSpill prototype. Not issued. Publishing requires NDMA SACHET authorisation. -->
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>${escapeXml(a.id)}</identifier>
  <sender>oceanspill-prototype</sender>
  <sent>${iso(a.issuedAt)}</sent>
  <status>Draft</status>
  <msgType>Alert</msgType>
  <scope>Restricted</scope>
  <note>Case ${escapeXml(a.caseId)}; channels: ${escapeXml(a.channel.join(', '))}</note>
${infos}
</alert>
`;
}

export default function SachetSamudra() {
  const { world, now, selectedCaseId, setSelectedCaseId, getAnalysis, draftAlert, linkSighting, verifySighting, navigate, revision } = useStore();
  const [tab, setTab] = useState('compose');
  const [basemap, setBasemap] = useState<BasemapStyle>('map');
  const [selectedSighting, setSelectedSighting] = useState<string | null>(null);
  const [linkModal, setLinkModal] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [severityFilter, setSeverityFilter] = useState('all');
  const [verifiedFilter, setVerifiedFilter] = useState('all');
  const [layers, setLayers] = useState({ sightings: true, zones: true, slicks: true });
  const [layersOpen, setLayersOpen] = useState(false);

  const activeCase = world.cases.find((c) => c.id === selectedCaseId) ?? world.cases[0] ?? null;
  const analysis = activeCase ? getAnalysis(activeCase.id) : null;

  // Composer state, pre-filled from the selected case.
  const [channels, setChannels] = useState<string[]>(['SMS', 'Cell broadcast']);
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
    const official = activeCase.facts.impact.fishingRestrictionNm;
    const r = official ? Math.round(official * 1.852) : Math.max(8, Math.round(spread + shape.majorAxisKm));
    setRadius(r);
    setDistricts(districtsNear(activeCase.facts.incident.position).slice(0, 3));
    const local = { 'Kerala Coast': 'Malayalam', 'Tamil Nadu Coast': 'Tamil', 'Goa Coast': 'Konkani', 'Bay of Bengal': 'Bengali' }[activeCase.region];
    setLanguages(['English', 'Hindi', ...(local ? [local] : [])]);
    setHeadline(`Oil pollution advisory — ${activeCase.subRegion.split(',')[0]}`);
    const offshore = Math.round(distanceToCoastKm(shape.centroid));
    setBody(
      `Oil pollution has been reported ${offshore > 2 ? `about ${offshore} km offshore ` : 'along the coast '}near ${activeCase.subRegion}. ` +
      `Oil may drift over the next ${validHours} hours. ` +
      `Fishing craft are advised to avoid the marked area. Do not handle floating oil, tar balls or washed-up containers. ` +
      `Nets exposed to oil must be cleaned before reuse. Report any sighting to the nearest Coast Guard station.`
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
      circles.push({
        id: 'nogo', centre: activeCase.facts.incident.position, radiusKm: radius,
        fill: 'rgba(220,38,38,0.14)', stroke: '#dc2626', dash: '6 4', label: `Draft zone ${radius} km`,
      });
    }
    if (layers.slicks) {
      for (const c of world.cases) {
        if (c.status === 'Dismissed — Look-alike') continue;
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
          id: s.id, position: s.position, kind: 'sighting', color: SEVERITY_COLOR[s.severity],
          size: s.verified ? 7 : 5, selected: s.id === selectedSighting,
          label: `${s.severity} — ${s.district}`, sublabel: `${s.reporter} · ${fmt.utcShort(s.receivedAt)}`,
          z: s.verified ? 7 : 6,
          meta: { Source: s.source, Data: s.provenance === 'real' ? 'Public record' : 'Logged this session', Verified: s.verified ? 'Yes' : 'Pending' },
        });
      }
    }
    for (const a of world.alerts) {
      if (a.status === 'Issued (official)' || a.status === 'Draft') {
        circles.push({
          id: `a-${a.id}`, centre: a.centre, radiusKm: a.noGoRadiusKm,
          fill: a.status === 'Draft' ? 'rgba(245,158,11,0.08)' : 'rgba(37,99,235,0.08)',
          stroke: a.status === 'Draft' ? '#f59e0b' : '#2563eb', dash: '4 4', opacity: 0.8,
          label: a.status === 'Draft' ? a.id : 'Official restriction',
        });
      }
    }
    return { markers, circles, polygons };
  }, [sightings, activeCase, analysis, radius, layers, selectedSighting, world.cases, world.alerts, revision]);

  const canDraft = channels.length > 0 && languages.length > 0 && districts.length > 0 && headline.trim() && body.trim() && activeCase;

  const doDraft = () => {
    if (!activeCase || !analysis) return;
    draftAlert({
      caseId: activeCase.id, issuedAt: now, channel: channels, languages, districts,
      headline: headline.trim(), body: body.trim(), noGoRadiusKm: radius,
      centre: activeCase.facts.incident.position, validUntil: now + validHours * 3600_000,
    });
    setTab('log');
  };

  const sightingColumns: Column<SightingReport>[] = [
    {
      key: 'received', header: 'Time (UTC)', width: '110px', value: (s) => s.receivedAt,
      render: (s) => (
        <div><div className="font-mono text-gray-800">{fmt.utcShort(s.receivedAt)}</div>
        <div className="text-[9px] text-gray-400">{fmt.ago(s.receivedAt, now)}</div></div>
      ),
    },
    {
      key: 'reporter', header: 'Reported by', value: (s) => s.reporter,
      render: (s) => (
        <div className="min-w-0">
          <div className="font-semibold text-gray-900 flex items-center gap-1">{s.reporter} <ProvenanceBadge p={s.provenance} /></div>
          <div className="text-[9.5px] text-gray-500 truncate" title={s.description}>{s.description}</div>
        </div>
      ),
    },
    { key: 'district', header: 'Area', width: '120px', value: (s) => s.district },
    {
      key: 'severity', header: 'Type', width: '118px', value: (s) => s.severity,
      render: (s) => <Badge tone={s.severity === 'Heavy Oil' || s.severity === 'Fire' ? 'red' : s.severity === 'Patchy Oil' ? 'amber' : s.severity === 'Debris / Containers' ? 'blue' : 'gray'}>{s.severity}</Badge>,
    },
    {
      key: 'case', header: 'Linked case', width: '150px', value: (s) => s.linkedCaseId ?? '',
      render: (s) => s.linkedCaseId
        ? <button onClick={(e) => { e.stopPropagation(); navigate({ tab: 'Investigation', caseId: s.linkedCaseId! }); }}
            className="text-blue-600 hover:underline font-semibold text-left truncate max-w-[140px]">{world.cases.find((c) => c.id === s.linkedCaseId)?.title ?? s.linkedCaseId}</button>
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

  const official = world.alerts.filter((a) => a.status === 'Issued (official)');
  const drafts = world.alerts.filter((a) => a.status === 'Draft');

  return (
    <main className="flex-1 min-h-0 flex overflow-hidden">
      <aside className="w-[380px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2"><Megaphone className="w-4 h-4 text-amber-600" /> SACHET / SAMUDRA</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">Draft CAP alerts and field observation reports</p>
        </div>

        <Tabs active={tab} onChange={setTab} tabs={[
          { id: 'compose', label: 'Compose' },
          { id: 'log', label: 'Alert log', count: world.alerts.length },
        ]} />

        {tab === 'compose' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <Field label="Case">
              <Select value={activeCase?.id ?? ''} onChange={setSelectedCaseId}
                options={world.cases.map((c) => ({ value: c.id, label: c.title }))} />
            </Field>

            {activeCase?.facts.impact.fishingRestrictionNm && (
              <InfoBanner tone="blue" icon={<ShieldAlert className="w-3.5 h-3.5" />}>
                Authorities issued a {activeCase.facts.impact.fishingRestrictionNm} nm fishing restriction for this incident. The zone below is pre-filled from it.
              </InfoBanner>
            )}

            <Field label="Headline"><TextInput value={headline} onChange={setHeadline} /></Field>

            <Field label="Advisory text" hint="Written once; SACHET handles translation and delivery after NDMA authorisation.">
              <TextArea value={body} onChange={setBody} rows={6} />
            </Field>

            <div>
              <p className="text-[10px] font-bold text-gray-600 uppercase mb-1">Channels requested</p>
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
                {(activeCase ? districtsNear(activeCase.facts.incident.position).slice(0, 8) : []).map((d) => (
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
              Pre-filled from the official restriction when one exists, otherwise from the 24-hour forecast spread.
            </p>
            <Slider label="Valid for" value={validHours} onChange={setValidHours} min={6} max={96} step={6} format={(v) => `${v} h`} />

            <Button variant="primary" className="w-full justify-center" disabled={!canDraft} onClick={doDraft} icon={<Send className="w-3.5 h-3.5" />}>
              Draft CAP alert
            </Button>

            <InfoBanner tone="amber" icon={<Radio className="w-3.5 h-3.5" />}>
              This prototype only drafts a CAP 1.2 message you can download. Sending it through SACHET needs NDMA
              authorisation, so no delivery or reach figures are shown.
            </InfoBanner>
          </div>
        )}

        {tab === 'log' && (
          <div className="flex-1 overflow-y-auto">
            {world.alerts.length === 0 ? (
              <EmptyState icon={<Bell className="w-10 h-10" />} title="No alerts" body="Official restrictions from the case records and drafts from this session appear here." />
            ) : world.alerts.map((a) => (
              <div key={a.id} className="px-3 py-2.5 border-b border-gray-100">
                <div className="flex justify-between items-start gap-2 mb-1">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-gray-900">{a.headline}</p>
                    <p className="text-[9.5px] text-gray-500 font-mono">{a.id} · {a.caseId}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <Badge tone={a.status === 'Issued (official)' ? 'blue' : a.status === 'Draft' ? 'amber' : 'gray'}>{a.status}</Badge>
                    <ProvenanceBadge p={a.provenance} />
                  </div>
                </div>
                <p className="text-[10px] text-gray-600 leading-snug line-clamp-2">{a.body}</p>
                <div className="mt-1.5">
                  <KeyValue cols={2} items={[
                    [a.status === 'Draft' ? 'Drafted' : 'Issued', a.status === 'Draft' ? fmt.utcShort(a.issuedAt) : fmt.date(a.issuedAt)],
                    ['Valid until', a.validUntil != null ? fmt.utcShort(a.validUntil) : 'Not published'],
                    ['Area', a.districts.join(', ')],
                    ['By', a.issuer],
                    ['Zone', `${a.noGoRadiusKm.toFixed(1)} km radius`],
                    ['Channels', a.channel.join(', ')],
                  ]} />
                </div>
                <div className="flex items-center gap-2 mt-1.5">
                  {a.source && <a href={a.source} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline">Source</a>}
                  {a.status === 'Draft' && (
                    <Button size="sm" onClick={() => triggerDownload(`${a.id}.cap.xml`, capXml(a), 'application/xml')} icon={<FileDown className="w-3 h-3" />}>
                      CAP XML
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-3 flex-wrap">
          <StatCard icon={<ShieldAlert className="w-4 h-4" />} title="Official restrictions" value={official.length} trend="from case records" accent="blue" />
          <StatCard icon={<Megaphone className="w-4 h-4" />} title="Drafts" value={drafts.length} trend="this session, not sent" accent="amber" />
          <StatCard icon={<MessageSquare className="w-4 h-4" />} title="Field reports" value={world.sightings.length}
            trend={`${world.sightings.filter((s) => s.provenance === 'real').length} from public records`} />
          <StatCard icon={<Link2 className="w-4 h-4" />} title="Linked to cases"
            value={world.sightings.filter((s) => s.linkedCaseId).length} trend="corroborating evidence" accent="green" />
        </div>

        <div className="flex-1 min-h-0 relative">
          <MapView
            basemap={basemap}
            markers={mapData.markers} circles={mapData.circles} polygons={mapData.polygons}
            initialCentre={{ lat: 15, lon: 80 }} initialZoom={3.9}
            fitTo={activeCase ? (() => {
              const p = activeCase.facts.incident.position;
              const d = radius / 111 + 0.3;
              return [{ lat: p.lat - d, lon: p.lon - d }, { lat: p.lat + d, lon: p.lon + d }];
            })() : undefined} fitKey={activeCase?.id}
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
                      <Toggle checked={layers.sightings} onChange={(v) => setLayers({ ...layers, sightings: v })} label="Field reports" count={sightings.length} />
                      <Toggle checked={layers.zones} onChange={(v) => setLayers({ ...layers, zones: v })} label="Draft zone" />
                      <Toggle checked={layers.slicks} onChange={(v) => setLayers({ ...layers, slicks: v })} label="Reported slicks" />
                    </div>
                  )}
                </div>
              </div>
            }
            legend={
              <div className="absolute bottom-16 left-3 z-20 bg-white/95 backdrop-blur border border-gray-300 rounded p-2.5 text-[10px] shadow-lg">
                <h4 className="font-bold mb-1.5 text-gray-700 uppercase">Report type</h4>
                {Object.entries(SEVERITY_COLOR).map(([l, c]) => (
                  <div key={l} className="flex items-center gap-2 mb-1">
                    <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-b-[8px] border-l-transparent border-r-transparent" style={{ borderBottomColor: c }} />
                    <span className="text-gray-700">{l}</span>
                  </div>
                ))}
                <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-200">
                  <div className="w-4 border-t-2 border-dashed border-blue-600" /><span className="text-gray-700">Official restriction</span>
                </div>
              </div>
            }
          />
        </div>

        <div className="h-[250px] border-t border-gray-200 bg-white flex-shrink-0 flex flex-col">
          <div className="px-3 py-1.5 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
            <span className="text-[11px] font-bold text-gray-700 flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" /> Field observation reports — {sightings.length}
            </span>
            <div className="flex gap-2">
              <Select value={severityFilter} onChange={setSeverityFilter}
                options={[{ value: 'all', label: 'All types' }, ...SEVERITIES.map((s) => ({ value: s, label: s }))]} />
              <Select value={verifiedFilter} onChange={setVerifiedFilter}
                options={[{ value: 'all', label: 'All reports' }, { value: 'verified', label: 'Verified only' }, { value: 'unverified', label: 'Awaiting verification' }]} />
              <Button size="sm" onClick={() => setReportOpen(true)} icon={<Plus className="w-3 h-3" />}>Log report</Button>
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
      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} />
    </main>
  );
}

function ReportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { world, selectedCaseId, addSighting } = useStore();
  const c = world.cases.find((x) => x.id === selectedCaseId) ?? world.cases[0];
  const [reporter, setReporter] = useState('');
  const [district, setDistrict] = useState('');
  const [severity, setSeverity] = useState<SightingReport['severity']>('Tar Balls');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [link, setLink] = useState(true);

  useEffect(() => {
    if (!open || !c) return;
    setDistrict(districtsNear(c.facts.incident.position)[0]);
    setLat(c.facts.incident.position.lat.toFixed(4));
    setLon(c.facts.incident.position.lon.toFixed(4));
  }, [open, c?.id]);

  const latN = Number(lat);
  const lonN = Number(lon);
  const valid = reporter.trim() && description.trim() && Number.isFinite(latN) && Number.isFinite(lonN) && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180;

  return (
    <Modal open={open} onClose={onClose} title="Log a field observation" subtitle="Recorded in this session as unverified."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid} onClick={() => {
        addSighting({
          reporter: reporter.trim(), district, severity, description: description.trim(),
          position: { lat: latN, lon: lonN }, linkedCaseId: link && c ? c.id : undefined, source: 'Entered by analyst',
        });
        setReporter(''); setDescription('');
        onClose();
      }}>Log report</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Reported by"><TextInput value={reporter} onChange={setReporter} placeholder="Name, boat or station" /></Field>
          <Field label="District">
            <Select value={district} onChange={setDistrict}
              options={DISTRICTS.map((d) => ({ value: d.name, label: d.name }))} />
          </Field>
          <Field label="Type">
            <Select value={severity} onChange={(v) => setSeverity(v as SightingReport['severity'])} options={SEVERITIES.map((s) => ({ value: s, label: s }))} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Lat"><TextInput value={lat} onChange={setLat} /></Field>
            <Field label="Lon"><TextInput value={lon} onChange={setLon} /></Field>
          </div>
        </div>
        <Field label="What was seen"><TextArea value={description} onChange={setDescription} rows={3} /></Field>
        {c && <Toggle checked={link} onChange={setLink} label={`Link to ${c.title}`} />}
      </div>
    </Modal>
  );
}

function LinkModal({ open, onClose, sightingId, onLink }: { open: boolean; onClose: () => void; sightingId: string | null; onLink: (caseId: string) => void }) {
  const { world } = useStore();
  const s = world.sightings.find((x) => x.id === sightingId);
  const [pick, setPick] = useState('');

  // Rank cases by how close the report is to each incident, so the obvious match is first.
  const ranked = useMemo(() => {
    if (!s) return [];
    return world.cases.map((c) => {
      const p = c.facts.incident.position;
      const d = Math.hypot((p.lat - s.position.lat) * 110.6, (p.lon - s.position.lon) * 111.3 * Math.cos((s.position.lat * Math.PI) / 180));
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
            {s.position.lat.toFixed(3)}° N  {s.position.lon.toFixed(3)}° E · {fmt.utc(s.receivedAt)}
          </p>
        </div>
        <Field label="Candidate cases (nearest first)">
          <div className="space-y-1">
            {ranked.slice(0, 5).map(({ c, d }) => (
              <button key={c.id} onClick={() => setPick(c.id)}
                className={`w-full text-left px-2 py-1.5 rounded border ${pick === c.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-400'}`}>
                <div className="flex justify-between items-center gap-2">
                  <div className="min-w-0">
                    <span className="text-[11px] font-bold text-gray-900">{c.title}</span>
                    <span className="text-[10px] text-gray-600 ml-2 truncate">{c.subRegion}</span>
                  </div>
                  <span className="text-[10px] font-mono text-gray-500 flex-shrink-0">{d.toFixed(0)} km</span>
                </div>
                <p className="text-[9.5px] text-gray-400 mt-0.5">Incident {fmt.precise(c.incidentTime, c.facts.incident.timePrecision)}</p>
              </button>
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
