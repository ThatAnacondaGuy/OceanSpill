import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Circle, Clock, FileCheck, Loader2, Megaphone, Radar, RefreshCw, Ship, XCircle,
} from 'lucide-react';
import { useStore, fmt, type CaseAnalysis } from './store/store';
import { Badge, Button, EmptyState, InfoBanner, Panel, ProvenanceBadge, StatCard } from './components/ui';
import {
  fetchMonitoring, promoteDetection, reviewDetection, serverMode, type Detection, type MonitoringSummary,
} from './data/server';
import type { SpillCase } from './data/types';

/**
 * What to do, in order, when something is found.
 *
 * The rest of the system is a set of tools: a map, a drift model, a vessel ranking, an alerting
 * page. Which of them to open, in what order, and what counts as finished was knowledge an operator
 * had to carry in their head. This page holds the procedure instead, tracks where each case has got
 * to, and says what the next action is.
 *
 * The steps are not decoration. Each one reads the real state of the case, so a step counts as done
 * only when the work behind it was actually done.
 */

const HOUR = 3_600_000;

type StepState = 'done' | 'current' | 'waiting';

interface Step {
  n: number;
  title: string;
  what: string;
  state: StepState;
  detail: string;
  goTo: { tab: string; section?: string; label: string };
}

/**
 * Steps 1-4 gather inputs and can be done in any order; 5-8 are decisions taken in sequence. So a
 * case can sit at step 6 with step 1 never finished, and calling step 1 "next" would be wrong. It is
 * outstanding, which is a different thing and says so.
 */
function outstandingNotNext(steps: Step[], current: Step | undefined): boolean {
  return current != null && steps.some((s) => s.n > current.n && s.state === 'done');
}

/** The steps for a case, read from what has actually been recorded against it. */
function stepsForCase(spill: SpillCase, analysis: CaseAnalysis | null, enforcementCount: number, alertCount: number): Step[] {
  const measured = spill.detection.status === 'sar-processed';
  const ranked = analysis?.ranked.length ?? 0;
  const threatened = analysis?.threatenedAreas.length ?? 0;
  const stage = spill.workflowStage;
  const dispatched = stage !== 'Awaiting Dispatch';

  const step = (n: number, title: string, what: string, done: boolean, detail: string, goTo: Step['goTo']): Step => ({
    n, title, what, detail, goTo, state: done ? 'done' : 'waiting',
  });

  const steps: Step[] = [
    step(1, 'Measure the slick', 'Area, contrast and shape taken off the radar scene', measured,
      measured
        ? `${spill.detection.sarMeasurements.length} scene${spill.detection.sarMeasurements.length === 1 ? '' : 's'} processed`
        : spill.detection.scenes.length
        ? `${spill.detection.scenes.length} scene${spill.detection.scenes.length === 1 ? '' : 's'} found in the catalogue, none processed yet`
        : 'No scene found in the search window — extent comes from the report, not from measurement',
      { tab: 'Investigation', section: 'detection', label: 'Open the scene' }),

    step(2, 'Work out where it came from', 'Run the slick backwards through the wind and current', analysis != null,
      analysis
        ? `Origin ${analysis.attributionOrigin.lat.toFixed(3)} N, ${analysis.attributionOrigin.lon.toFixed(3)} E, uncertain to ± ${analysis.hindcast.uncertaintyRadiusKm.toFixed(1)} km`
        : 'Needs forcing data for this position and time',
      { tab: 'Investigation', section: 'drift', label: 'Open the hindcast' }),

    step(3, 'Reconstruct the traffic', 'Every vessel in the release window, filtered and scored', ranked > 0,
      ranked > 0
        ? `${ranked} vessel${ranked === 1 ? '' : 's'} scored, ${analysis!.excluded.length} set aside · leader ${(analysis!.ranked[0].total * 100).toFixed(0)}%`
        : 'No AIS track intersected the window — treat as a possible dark vessel',
      { tab: 'Vessel Analysis', label: 'Open the traffic' }),

    step(4, 'Judge what is at risk', 'Protected areas inside the forecast envelope, and what the shore is made of', analysis != null,
      threatened > 0
        ? `${threatened} designated area${threatened === 1 ? '' : 's'} within the envelope`
        : analysis
        ? 'No designated area inside the forecast envelope'
        : 'Needs the forecast',
      { tab: 'NCSCM Ecological', label: 'Open the impact view' }),

    step(5, 'Send someone to look', 'A patrol or a sample confirms it on the water', dispatched,
      dispatched ? `Workflow at "${stage}"` : 'Nobody has been dispatched yet',
      { tab: 'Workflow', label: 'Move the workflow' }),

    step(6, 'Warn the coast', 'An advisory where people will be affected', alertCount > 0 || spill.alertDispatched,
      alertCount > 0 ? `${alertCount} advisory drafted` : 'No advisory drafted',
      { tab: 'SACHET / SAMUDRA', label: 'Draft an advisory' }),

    step(7, 'Record the action taken', 'Inspection, detention, fine or referral against the party', enforcementCount > 0,
      enforcementCount > 0 ? `${enforcementCount} action${enforcementCount === 1 ? '' : 's'} on record` : 'Nothing recorded yet',
      { tab: 'Offender Registry', label: 'Record an action' }),

    step(8, 'Close with the evidence', 'A signed record of every input and every decision', stage === 'Closed',
      stage === 'Closed' ? 'Case closed' : 'Open',
      { tab: 'Case Archive', label: 'Produce the record' }),
  ];

  // The first step that is not done is the one to do now.
  const next = steps.find((s) => s.state === 'waiting');
  if (next) next.state = 'current';
  return steps;
}

function ageLabel(ms: number): { text: string; overdue: boolean } {
  const hours = ms / HOUR;
  if (hours < 1) return { text: `${Math.max(1, Math.round(ms / 60_000))} min old`, overdue: false };
  if (hours < 48) return { text: `${hours.toFixed(1)} h old`, overdue: hours > 12 };
  return { text: `${(hours / 24).toFixed(1)} days old`, overdue: true };
}

export default function LiveOperations() {
  const { world, now, navigate, getAnalysis, selectedCaseId, setSelectedCaseId, canEdit, notify, refreshState, revision } = useStore();
  const [summary, setSummary] = useState<MonitoringSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!serverMode) return;
    try {
      setSummary(await fetchMonitoring());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The monitoring service could not be reached.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const active = world.cases.find((c) => c.id === selectedCaseId) ?? world.cases[0] ?? null;
  const analysis = active ? getAnalysis(active.id) : null;

  const steps = useMemo(() => {
    if (!active) return [];
    const enforcement = world.enforcement.filter((e) => e.caseId === active.id).length;
    const alerts = world.alerts.filter((a) => a.caseId === active.id).length;
    return stepsForCase(active, analysis, enforcement, alerts);
    // `revision` changes whenever someone records an action, which is what steps 5-8 read.
  }, [active, analysis, world, revision]);

  const detections = summary?.newDetections ?? [];
  const oldest = detections.length ? Math.min(...detections.map((d) => d.acquiredAt)) : null;

  const act = async (d: Detection, action: 'promote' | 'dismiss') => {
    setBusy(d.id);
    try {
      if (action === 'promote') {
        const result = await promoteDetection(d.id);
        notify({
          kind: 'success',
          title: 'Case being opened',
          body: `The pipeline is assembling the forcing, coastline and traffic for this detection (job ${result.job.id}). It will appear once the build finishes.`,
        });
      } else {
        await reviewDetection(d.id, 'dismissed');
        notify({ kind: 'info', title: 'Dismissed as a look-alike', body: 'Recorded with your name against it.' });
      }
      await Promise.all([load(), refreshState()]);
    } catch (e) {
      notify({ kind: 'error', title: 'Not recorded', body: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const done = steps.filter((s) => s.state === 'done').length;
  const current = steps.find((s) => s.state === 'current');
  const skipped = outstandingNotNext(steps, current);

  return (
    <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
      <aside className="w-full lg:w-[330px] xl:w-[370px] bg-white border-b lg:border-b-0 lg:border-r border-gray-200 flex flex-col flex-shrink-0 max-h-[52vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50">
          <h2 className="font-bold text-gray-900 text-sm flex items-center gap-2">
            <Radar className="w-4 h-4 text-blue-600" /> Watch queue
          </h2>
          <p className="text-[0.6875rem] text-gray-500 mt-0.5">
            {serverMode
              ? 'Dark patches the watcher found, oldest first. Nothing here is a spill until someone says so.'
              : 'Watching areas needs the server running. The procedure on the right still applies to any case.'}
          </p>
        </div>

        {error && <div className="px-3 py-2 text-[0.75rem] text-amber-900 bg-amber-50 border-b border-amber-200">{error}</div>}

        <div className="flex-1 overflow-y-auto">
          {!serverMode ? (
            <EmptyState
              icon={<Radar className="w-10 h-10" />}
              title="No live feed"
              body="Start the server to watch areas for new detections. The recorded cases are unaffected."
            />
          ) : detections.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="w-10 h-10" />}
              title="Nothing waiting"
              body={summary ? `${summary.scenesLastWeek} scenes checked in the last week. Nothing is waiting for review.` : 'Checking…'}
            />
          ) : (
            [...detections]
              .sort((a, b) => a.acquiredAt - b.acquiredAt)
              .map((d) => {
                const age = ageLabel(now - d.acquiredAt);
                return (
                  <div key={d.id} className="px-3 py-2.5 border-b border-gray-100">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[0.8125rem] font-bold text-gray-900">{d.areaKm2.toFixed(1)} km² dark patch</p>
                        <p className="text-[0.6875rem] text-gray-500">
                          {d.position.lat.toFixed(3)} N, {d.position.lon.toFixed(3)} E
                        </p>
                        <p className="text-[0.6875rem] text-gray-400 truncate" title={d.sceneId}>
                          {d.sceneId}
                        </p>
                      </div>
                      <Badge tone={age.overdue ? 'red' : 'gray'}>{age.text}</Badge>
                    </div>
                    <div className="flex gap-1.5 mt-2 items-center">
                      {busy === d.id ? (
                        <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                      ) : canEdit('Investigation') ? (
                        <>
                          <Button size="sm" variant="primary" onClick={() => void act(d, 'promote')} icon={<ArrowRight className="w-3 h-3" />}>
                            Open a case
                          </Button>
                          <Button size="sm" onClick={() => void act(d, 'dismiss')} icon={<XCircle className="w-3 h-3" />}>
                            Look-alike
                          </Button>
                        </>
                      ) : (
                        <span className="text-[0.6875rem] text-gray-500">Waiting for an analyst to review</span>
                      )}
                    </div>
                  </div>
                );
              })
          )}
        </div>

        {serverMode && summary && (
          <div className="px-3 py-2 border-t border-gray-200 bg-gray-50 text-[0.6875rem] text-gray-600 space-y-0.5">
            <p>
              {summary.monitoredAreas.length} area{summary.monitoredAreas.length === 1 ? '' : 's'} watched · {summary.scenesLastDay} scene
              {summary.scenesLastDay === 1 ? '' : 's'} today
            </p>
            <p>
              {summary.queued} queued · {summary.running} running{summary.failedLastDay ? ` · ${summary.failedLastDay} failed today` : ''}
            </p>
            <p className="text-gray-400">Satellite passes are hours apart and the AIS feed runs days behind. This is a watch, not a live picture.</p>
          </div>
        )}
      </aside>

      <section className="flex-1 min-w-0 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-3 py-2 flex items-center gap-2 flex-wrap">
          <StatCard
            icon={<AlertTriangle className="w-4 h-4" />}
            title="Waiting for review"
            value={detections.length}
            trend={oldest ? `oldest ${ageLabel(now - oldest).text}` : 'nothing waiting'}
          />
          <StatCard
            icon={<CheckCircle2 className="w-4 h-4" />}
            title="Steps completed"
            value={`${done}/${steps.length}`}
            trend={active ? active.id : 'no case selected'}
          />
          <StatCard
            icon={<Clock className="w-4 h-4" />}
            title="Case age"
            value={active ? fmt.hoursOrDays((now - active.incidentTime) / HOUR) : '—'}
            trend="since the reported time"
          />
          <div className="ml-auto">
            <Button size="sm" onClick={() => void load()} icon={<RefreshCw className="w-3 h-3" />} disabled={!serverMode}>
              Refresh
            </Button>
          </div>
        </div>

        {!active ? (
          <EmptyState title="No case selected" body="Choose a case to see where it has got to." />
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
            <Panel title={active.title} subtitle={`${active.region} · ${active.subRegion}`}>
              <div className="p-3">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <ProvenanceBadge p={active.facts.officiallyConfirmed ? 'real' : 'modelled'} />
                  <Badge tone="blue">{active.status}</Badge>
                  <Badge tone="gray">{active.workflowStage}</Badge>
                  <select
                    value={active.id}
                    onChange={(e) => setSelectedCaseId(e.target.value)}
                    className="ml-auto text-[0.75rem] border border-gray-300 rounded px-2 py-1 max-w-[18rem]"
                    aria-label="Case"
                  >
                    {world.cases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </div>
                {current ? (
                  <InfoBanner tone="amber" icon={<ArrowRight className="w-3.5 h-3.5" />}>
                    <b>
                      {skipped ? 'Still outstanding' : 'Next'}: step {current.n} — {current.title}.
                    </b>{' '}
                    {current.what}
                    {skipped && '. Later steps were taken without it'}.
                    {!canEdit('Investigation') && ' Your role can see this but not act on it.'}
                  </InfoBanner>
                ) : (
                  <InfoBanner tone="green" icon={<FileCheck className="w-3.5 h-3.5" />}>
                    Every step on this case is complete.
                  </InfoBanner>
                )}
              </div>
            </Panel>

            <Panel title="Procedure" subtitle="Each step reads the case, so it is ticked only when the work was done">
              <ol className="divide-y divide-gray-100">
                {steps.map((s) => (
                  <li key={s.n} className={`px-3 py-2.5 flex items-start gap-3 ${s.state === 'current' ? 'bg-amber-50' : ''}`}>
                    <span className="mt-0.5 flex-shrink-0">
                      {s.state === 'done' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      ) : s.state === 'current' ? (
                        <Circle className="w-4 h-4 text-amber-500" strokeWidth={3} />
                      ) : (
                        <Circle className="w-4 h-4 text-gray-300" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[0.8125rem] font-semibold text-gray-900">
                        {s.n}. {s.title}
                        {s.state === 'current' && (
                          <span className="ml-2 text-[0.6875rem] font-bold text-amber-700 uppercase">
                            {skipped ? 'outstanding' : 'do this next'}
                          </span>
                        )}
                      </p>
                      <p className="text-[0.75rem] text-gray-600">{s.what}</p>
                      <p className="text-[0.6875rem] text-gray-500 mt-0.5">{s.detail}</p>
                    </div>
                    <Button
                      size="sm"
                      variant={s.state === 'current' ? 'primary' : undefined}
                      onClick={() => navigate({ tab: s.goTo.tab, caseId: active.id, section: s.goTo.section })}
                    >
                      {s.goTo.label}
                    </Button>
                  </li>
                ))}
              </ol>
            </Panel>

            <Panel title="What this case is waiting on">
              <div className="p-3 text-[0.75rem] text-gray-700 space-y-1.5">
                {analysis && analysis.ranked.length === 0 && (
                  <p className="flex gap-2">
                    <Ship className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                    No vessel was transmitting inside the release window. That is a finding, not a gap in the tool: treat it as a possible dark
                    vessel and look for one in the imagery.
                  </p>
                )}
                {active.detection.status !== 'sar-processed' && (
                  <p className="flex gap-2">
                    <Radar className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                    No radar scene has been processed here, so the extent comes from the report rather than from measurement, and the contrast
                    checks have nothing to judge.
                  </p>
                )}
                {analysis && analysis.hindcast.uncertaintyRadiusKm > 20 && (
                  <p className="flex gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                    The origin is uncertain to ± {analysis.hindcast.uncertaintyRadiusKm.toFixed(0)} km, wide enough that the vessel ranking is a
                    shortlist rather than an answer.
                  </p>
                )}
                {!active.alertDispatched && analysis && analysis.threatenedAreas.length > 0 && (
                  <p className="flex gap-2">
                    <Megaphone className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
                    {analysis.threatenedAreas.length} protected area{analysis.threatenedAreas.length === 1 ? ' is' : 's are'} inside the forecast
                    envelope and no advisory has been drafted.
                  </p>
                )}
                {analysis && analysis.ranked.length > 0 && active.detection.status === 'sar-processed' && analysis.hindcast.uncertaintyRadiusKm <= 20 && (
                  <p className="text-gray-500">Nothing outstanding on the inputs. The remaining steps are decisions for an operator.</p>
                )}
              </div>
            </Panel>
          </div>
        )}
      </section>
    </main>
  );
}
