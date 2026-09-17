import type { CaseAnalysis } from '../store/store';
import type { SpillCase } from '../data/types';

/**
 * The pipeline a spill goes through, in order.
 *
 * These used to be tabs. That was the mistake: a row of destinations tells an operator nothing about
 * what to do first, and it tells a visitor nothing about how the system works. They are not places,
 * they are stages — a case enters at Investigation and comes out the far end with an evidence pack,
 * and each stage hands off to the next without anybody going back to a menu to choose again.
 *
 * A case reaches the pipeline two ways: the live markers on the dashboard, or a row in the incident
 * list. Both open the same first stage on the same case. There is one pipeline, not two.
 */

export interface StageStep {
  /** What the stage is doing, phrased as work rather than as a label. */
  label: string;
  /** What it found, filled from the real analysis. Null when the input was not available. */
  value: string | null;
}

export interface Stage {
  /** The page this stage shows. Also the key used by the access matrix. */
  tab: string;
  /** Short name for the progress strip. */
  short: string;
  /** What this stage is for, in one line. */
  purpose: string;
  /**
   * The real work behind the stage, read from the analysis that has already run. These are counts
   * and measurements, not decoration: if a step has no value it says so rather than inventing one.
   */
  steps: (spill: SpillCase, analysis: CaseAnalysis | null) => StageStep[];
}

const km = (n: number, digits = 1) => `${n.toFixed(digits)} km`;

export const STAGES: Stage[] = [
  {
    tab: 'Investigation',
    short: 'Investigation',
    purpose: 'Measure the slick and work back to where it came from',
    steps: (spill, analysis) => [
      {
        label: 'Reading the radar scenes',
        value: spill.detection.sarMeasurements.length
          ? `${spill.detection.sarMeasurements.length} processed`
          : spill.detection.scenes.length
          ? `${spill.detection.scenes.length} in the catalogue, none processed`
          : null,
      },
      {
        label: 'Measuring the slick outline',
        value: analysis ? `${analysis.assessment.shape.areaKm2.toFixed(1)} km², ${analysis.assessment.shape.elongation.toFixed(1)}:1 elongation` : null,
      },
      {
        label: 'Running the look-alike checks',
        value: analysis
          ? `${analysis.assessment.checks.filter((c) => c.status !== 'pending').length} of ${analysis.assessment.checks.length} answered`
          : null,
      },
      {
        label: 'Integrating the drift backwards',
        value: analysis ? `${spill.hindcastHours} h, ${analysis.hindcast.ensemble.length} ensemble members` : null,
      },
      {
        label: 'Estimating the release point',
        value: analysis
          ? `${analysis.attributionOrigin.lat.toFixed(3)} N, ${analysis.attributionOrigin.lon.toFixed(3)} E ± ${km(analysis.hindcast.uncertaintyRadiusKm)}`
          : null,
      },
    ],
  },
  {
    tab: 'Vessel Analysis',
    short: 'Vessels',
    purpose: 'Find which ships could have been there when it was released',
    steps: (spill, analysis) => [
      { label: 'Loading AIS tracks for the window', value: `${spill.candidateMmsis.length || (analysis ? analysis.ranked.length + analysis.excluded.length : 0)} vessels in the feed` },
      {
        label: 'Filtering to the release window',
        value: analysis ? `${analysis.excluded.length} set aside, ${analysis.ranked.length} kept` : null,
      },
      {
        label: 'Scoring proximity and timing',
        value: analysis && analysis.ranked.length
          ? `leader at ${(analysis.ranked[0].total * 100).toFixed(0)}%`
          : analysis
          ? 'nothing was transmitting in the window'
          : null,
      },
      {
        label: 'Judging whether that is enough',
        value: analysis ? analysis.verdict.band : null,
      },
    ],
  },
  {
    tab: 'Environmental Data',
    short: 'Environment',
    purpose: 'The wind, current and sea state the oil is sitting in',
    steps: (_spill, analysis) => [
      {
        label: 'Sampling wind at the incident',
        value: analysis ? `${analysis.conditions.wind.speed.toFixed(1)} m/s from ${analysis.conditions.wind.dirFrom.toFixed(0)}°` : null,
      },
      {
        label: 'Sampling surface current',
        value: analysis ? `${analysis.conditions.current.speed.toFixed(2)} m/s toward ${analysis.conditions.current.dirTo.toFixed(0)}°` : null,
      },
      {
        label: 'Reading sea state',
        value: analysis ? `${analysis.conditions.sea.significantWaveHeightM.toFixed(1)} m significant height, ${analysis.conditions.sea.beaufortLabel}` : null,
      },
      {
        // Only when the incident time is precise enough to say how old the oil is. Weathering an
        // unknown age forward would produce a number with nothing behind it.
        label: 'Weathering the oil forward',
        value: analysis?.weathering
          ? `${analysis.weathering.evaporatedPct.toFixed(0)}% evaporated, ${analysis.weathering.appearance}`
          : null,
      },
    ],
  },
  {
    tab: 'Satellite Tasking',
    short: 'Tasking',
    purpose: 'What has flown over, and what to ask for next',
    steps: (spill) => [
      { label: 'Searching the catalogues', value: `${spill.detection.sarProviders.length} provider${spill.detection.sarProviders.length === 1 ? '' : 's'} queried` },
      { label: 'Scenes covering the incident', value: spill.detection.scenes.length ? `${spill.detection.scenes.length} found` : null },
      { label: 'Planning the next acquisition', value: 'awaiting an operator decision' },
    ],
  },
  {
    tab: 'NCSCM Ecological',
    short: 'Ecology',
    purpose: 'What the oil will reach, and how long there is to protect it',
    steps: (_spill, analysis) => [
      {
        label: 'Projecting the forecast envelope',
        value: analysis ? `${analysis.forecast.horizons.length} horizons out to ${analysis.forecast.horizons.at(-1)?.hours ?? 0} h` : null,
      },
      {
        label: 'Testing designated areas against it',
        value: analysis ? `${analysis.threatenedAreas.length} inside the envelope` : null,
      },
      {
        label: 'Time to the nearest one',
        value: analysis && analysis.threatenedAreas.length
          ? `${analysis.threatenedAreas[0].hoursToImpact ?? '—'} h to ${analysis.threatenedAreas[0].name}`
          : null,
      },
    ],
  },
  {
    tab: 'SACHET / SAMUDRA',
    short: 'Alerting',
    purpose: 'Warn the coast and the fleet where people will be affected',
    steps: (_spill, analysis) => [
      {
        label: 'Finding the coast within reach',
        value: analysis ? `${analysis.threatenedAreas.length} area${analysis.threatenedAreas.length === 1 ? '' : 's'} to cover` : null,
      },
      { label: 'Drafting a CAP message', value: 'ready for an operator to issue' },
      { label: 'Publishing through NDMA', value: null },
    ],
  },
  {
    tab: 'Reports',
    short: 'Evidence',
    purpose: 'A signed record of every input and every decision',
    steps: (spill, analysis) => [
      { label: 'Collecting the inputs used', value: `${Object.keys(spill.forcingSources ?? {}).length} forcing sources, ${spill.detection.sarProviders.length} imagery providers` },
      { label: 'Collecting the decisions taken', value: `workflow at "${spill.workflowStage}"` },
      { label: 'Recording what is still unproven', value: analysis ? `${analysis.assessment.checks.filter((c) => c.status === 'pending').length} checks unanswered` : null },
    ],
  },
];

export const STAGE_TABS = STAGES.map((s) => s.tab);

export function stageIndex(tab: string): number {
  return STAGES.findIndex((s) => s.tab === tab);
}

export function isStageTab(tab: string): boolean {
  return stageIndex(tab) >= 0;
}

/**
 * The two most recent cases, treated as the ones running now.
 *
 * Nothing is invented for this: they are recorded cases like the others, and the only difference is
 * that the dashboard marks them as live and the pipeline opens on them first. Spills are not
 * frequent, so one or two at a time is what a real watch floor looks like.
 */
export const LIVE_CASE_COUNT = 2;

export function liveCaseIds(cases: SpillCase[]): string[] {
  return [...cases]
    .sort((a, b) => b.incidentTime - a.incidentTime)
    .slice(0, LIVE_CASE_COUNT)
    .map((c) => c.id);
}
