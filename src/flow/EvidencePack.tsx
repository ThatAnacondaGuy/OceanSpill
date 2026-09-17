import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Download, FileText, Radar, Ship, Waves } from 'lucide-react';
import { useStore, fmt } from '../store/store';
import { Badge, Button, InfoBanner, KeyValue, Panel, ProvenanceBadge, triggerDownload } from '../components/ui';
import { ArtifactImage } from '../components/ArtifactImage';
import { reportPdf, serverMode, textToSections } from '../data/server';
import { buildEvidenceRecord, evidenceGaps } from './evidence';

/**
 * The last stage: what this case produced, and what it could not.
 *
 * The whole-register analytics page used to sit here, which meant the end of one case's pipeline
 * showed incident counts by decade for every spill since 1970. Interesting, and nothing to do with
 * the case just worked. This shows that case: the radar image, the origin the model reached, where
 * the oil is going, who was near it, what is at risk, and — at the top, not buried — what is still
 * unproven.
 *
 * The export is the same record the archive produces, signed by the server when one is running.
 */
export function EvidencePack() {
  const { world, now, flowCaseId, selectedCaseId, getAnalysis, weights, notify, currentUser } = useStore();
  const [busy, setBusy] = useState(false);

  const spill = world.cases.find((c) => c.id === (flowCaseId ?? selectedCaseId)) ?? world.cases[0] ?? null;
  const analysis = spill ? getAnalysis(spill.id) : null;

  const record = useMemo(
    () => (spill ? buildEvidenceRecord({ spill, analysis, world, weights, now }) : []),
    [spill, analysis, world, weights, now]
  );
  const gaps = useMemo(() => (spill ? evidenceGaps(spill, analysis) : []), [spill, analysis]);

  if (!spill) return null;

  const quicklook = spill.detection.sarMeasurements[0] ?? null;
  const ranked = analysis?.ranked ?? [];
  const areas = analysis?.threatenedAreas ?? [];

  const exportPdf = async () => {
    setBusy(true);
    try {
      if (serverMode) {
        const filename = await reportPdf({
          caseId: spill.id,
          kind: 'evidence-pack',
          title: `Evidence pack — ${spill.id}`,
          subtitle: spill.title,
          footnote: `Prepared by ${currentUser.name}, ${currentUser.agency}. Attribution scores are a prioritisation tool, not evidence of discharge.`,
          sections: textToSections(record.join('\n')),
        });
        notify({ kind: 'success', title: 'Signed evidence pack exported', body: filename });
      } else {
        // Without a server there is nothing to sign with, so the export says so rather than
        // producing a document that looks authoritative and is not.
        triggerDownload(`${spill.id}-evidence-pack.txt`, record.join('\n'));
        notify({
          kind: 'info',
          title: 'Evidence pack exported unsigned',
          body: 'Signing needs the server. This copy carries no signature and cannot be verified.',
        });
      }
    } catch (e) {
      notify({ kind: 'error', title: 'Not exported', body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
      <Panel title={`Evidence pack — ${spill.id}`} subtitle={spill.title}>
        <div className="p-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <ProvenanceBadge p={spill.facts.officiallyConfirmed ? 'real' : 'modelled'} />
            <Badge tone="blue">{spill.status}</Badge>
            <Badge tone="gray">{spill.workflowStage}</Badge>
            <Badge tone="gray">{record.length} lines</Badge>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" onClick={() => triggerDownload(`${spill.id}-evidence-pack.txt`, record.join('\n'))} icon={<FileText className="w-3 h-3" />}>
                Text
              </Button>
              <Button size="sm" variant="primary" onClick={() => void exportPdf()} disabled={busy} icon={<Download className="w-3 h-3" />}>
                {serverMode ? 'Signed PDF' : 'Export (unsigned)'}
              </Button>
            </div>
          </div>
          {!serverMode && (
            <InfoBanner tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5" />}>
              The server signs these documents so they can be checked later. Without it running, an export
              carries no signature and should not be presented as an authenticated record.
            </InfoBanner>
          )}
        </div>
      </Panel>

      {/* What the record cannot support, before anything it can. Somebody reading this months from
          now cannot ask, so the limits go first rather than in a footnote. */}
      <Panel title="What this case cannot show" subtitle="Read before the findings, not after">
        <div className="p-3">
          {gaps.length === 0 ? (
            <p className="text-[0.75rem] text-emerald-700 flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" /> Every input the analysis needed was available.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {gaps.map((g) => (
                <li key={g} className="text-[0.75rem] text-gray-700 flex gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                  {g}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Panel title="Radar" subtitle={quicklook ? quicklook.scene : 'No scene processed'}>
          <div className="p-3">
            {quicklook ? (
              <>
                <ArtifactImage path={quicklook.quicklook} alt={`Processed radar scene ${quicklook.scene}`} className="w-full rounded border border-gray-200" />
                <p className="text-[0.6875rem] text-gray-500 mt-1.5">{quicklook.method}</p>
                <KeyValue cols={2} items={[
                  ['Polarisation', quicklook.polarisation],
                  ['Pixel spacing', `${quicklook.parameters.pixelSpacingM ?? '—'} m`],
                  ['Dark spots', String(quicklook.spots.length)],
                  ['Sea mean', quicklook.sea.meanDb != null ? `${quicklook.sea.meanDb} dB` : '—'],
                ]} />
              </>
            ) : (
              <p className="text-[0.75rem] text-gray-500 flex gap-2">
                <Radar className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                No radar scene has been processed for this case, so there is no image and no measured contrast.
                The extent in this record comes from the published report.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Where it came from" subtitle="Hindcast result">
          <div className="p-3">
            {analysis ? (
              <KeyValue cols={1} items={[
                ['Estimated origin', `${analysis.hindcast.estimatedOrigin.lat.toFixed(4)} N, ${analysis.hindcast.estimatedOrigin.lon.toFixed(4)} E`],
                ['Estimated time', fmt.utc(analysis.hindcast.estimatedTime)],
                ['Uncertainty', `± ${analysis.hindcast.uncertaintyRadiusKm.toFixed(1)} km, ± ${analysis.hindcast.timeWindowHours.toFixed(1)} h`],
                ['Wind forcing', analysis.sampler.sources.wind],
                ['Current forcing', analysis.sampler.sources.current],
                ['Windage', fmt.pct(analysis.hindcast.params.windage)],
                ['Diffusivity', `${analysis.hindcast.params.diffusivity} m²/s`],
                ['Ensemble', `${analysis.hindcast.ensemble.length} members, ${analysis.hindcast.params.particles} particles`],
              ]} />
            ) : (
              <p className="text-[0.75rem] text-gray-500">No analysis: the forcing for this position and time was not available.</p>
            )}
          </div>
        </Panel>

        <Panel title="Who was near it" subtitle={`${ranked.length} scored, ${analysis?.excluded.length ?? 0} set aside`}>
          <div className="divide-y divide-gray-100">
            {ranked.length === 0 && (
              <p className="p-3 text-[0.75rem] text-gray-500 flex gap-2">
                <Ship className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                No vessel was transmitting inside the release window. That is a finding: treat it as a
                possible dark vessel rather than as an absence of traffic.
              </p>
            )}
            {ranked.slice(0, 5).map((s) => {
              const v = world.vesselsByMmsi.get(s.mmsi);
              return (
                <div key={s.mmsi} className="px-3 py-2 flex items-center gap-2">
                  <span className="text-[0.6875rem] font-bold text-gray-400 w-4">{s.rank}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.8125rem] font-semibold text-gray-900 truncate">{v?.name ?? s.mmsi}</p>
                    <p className="text-[0.6875rem] text-gray-500">
                      CPA {s.cpaKm.toFixed(1)} km · Δt {s.deltaTimeMin.toFixed(0)} min
                      {s.darkDuringWindow && ' · AIS gap in window'}
                    </p>
                  </div>
                  <span className="text-[0.8125rem] font-black text-gray-700">{(s.total * 100).toFixed(0)}</span>
                </div>
              );
            })}
            {analysis && (
              <p className="px-3 py-2 text-[0.65625rem] text-gray-500">
                Verdict: <b>{analysis.verdict.band}</b> — {analysis.verdict.label}. The score orders vessels
                that were transmitting; it is not a probability of guilt.
              </p>
            )}
          </div>
        </Panel>

        <Panel title="What is at risk" subtitle={`${areas.length} designated area${areas.length === 1 ? '' : 's'} in the envelope`}>
          <div className="divide-y divide-gray-100">
            {areas.length === 0 && (
              <p className="p-3 text-[0.75rem] text-gray-500 flex gap-2">
                <Waves className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                No designated area lies inside the forecast envelope.
              </p>
            )}
            {areas.slice(0, 6).map((t) => (
              <div key={t.id} className="px-3 py-2">
                <p className="text-[0.8125rem] font-semibold text-gray-900">{t.name}</p>
                <p className="text-[0.6875rem] text-gray-500">
                  {t.category} · {t.state} · sensitivity {t.sensitivity}/5 · {t.distanceKm.toFixed(1)} km
                  {t.hoursToImpact !== null ? ` · envelope arrives in ${t.hoursToImpact} h` : ' · not reached in the forecast'}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="The record" subtitle="Every input, its provenance, and every decision taken">
        <pre className="p-3 text-[0.6875rem] font-mono text-gray-700 whitespace-pre-wrap max-h-[26rem] overflow-y-auto leading-relaxed">
          {record.join('\n')}
        </pre>
      </Panel>
    </main>
  );
}
