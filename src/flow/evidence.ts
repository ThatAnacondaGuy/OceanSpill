import { fmt } from '../store/store';
import { analysePolygon } from '../lib/geo';
import { MODEL_STATUS, driftCalibrationNote, modelScoreLine } from '../engine/detection';
import type { CaseAnalysis } from '../store/store';
import type { World } from '../data/world';
import type { AuditEntry, SpillCase } from '../data/types';
import type { ScoringWeights } from '../engine/attribution';

/**
 * The record a case leaves behind: every input, where it came from, and every decision taken.
 *
 * This is the end of the pipeline, and it is the only artifact that outlives the screen. It has to
 * carry the things that would otherwise be lost — which forcing was used, how far the model was
 * trusted, what the checks could not answer — because somebody reading it months later cannot ask.
 *
 * Written once and used twice: the archive exports it for any case, and the pipeline's last stage
 * shows it for the case being run. One builder, so the two can never drift apart and disagree about
 * the same incident.
 */

export interface EvidenceInputs {
  spill: SpillCase;
  analysis: CaseAnalysis | null;
  world: World;
  weights: ScoringWeights;
  now: number;
}

const RULE = '='.repeat(72);
const THIN = '-'.repeat(72);

export function buildEvidenceRecord({ spill: c, analysis: a, world, weights, now }: EvidenceInputs): string[] {
  const shape = analysePolygon(c.detection.polygon.ring);
  const events: AuditEntry[] = world.audit.filter((e) => e.target === c.id).sort((x, y) => x.t - y.t);
  const L: string[] = [];

  L.push(RULE, `CHAIN OF CUSTODY RECORD — ${c.id}`, RULE, '');
  L.push('CLASSIFICATION: RESTRICTED — For Official Use');
  L.push(`Exported: ${fmt.utc(now)}`, '');
  L.push(`Case             : ${c.title}`);
  L.push('NOTE: Retrospective replay of a real incident. Vessel tracks are synthetic where real AIS was unavailable.', '');

  L.push('1. SOURCE RECORD', THIN);
  L.push(`  Incident time    : ${fmt.precise(c.incidentTime, c.facts.incident.timePrecision)} (precision: ${c.facts.incident.timePrecision})`);
  L.push(`  Position         : ${c.facts.incident.position.lat.toFixed(4)}N ${c.facts.incident.position.lon.toFixed(4)}E ± ${c.facts.incident.positionPrecisionKm} km (${c.facts.incident.positionSource})`);
  L.push(`  Official finding : ${c.facts.officialFindings}`);
  L.push(`  Officially confirmed: ${c.facts.officiallyConfirmed ? 'yes' : 'no'}`);
  L.push(`  Oil              : ${c.facts.oil.modelType}${c.facts.oil.spilledTonnes != null ? `, ${c.facts.oil.spilledTonnes} t released` : ', released quantity not published'}`);
  L.push('  Sources:');
  for (const src of c.facts.sources) L.push(`    - ${src.title}`, `      ${src.url}`);
  L.push('');

  L.push('2. OBSERVATION AND DETECTION', THIN);
  L.push(`  Reference obs.   : ${fmt.utc(c.detection.acquiredAt)} (${c.detection.observationSource})`);
  L.push(`  Geometry basis   : ${c.detection.geometryBasis}`);
  for (const g of c.detection.geometryAssumptions) L.push(`    assumption: ${g}`);
  L.push(`  SAR catalogue    : ${c.detection.scenes.length} scene(s)`);
  for (const sc of c.detection.scenes) L.push(`    ${sc.name} (${sc.provider}, ${fmt.utc(sc.start)}${sc.coversIncident ? ', covers incident' : ''})`);
  L.push(`  Scenes processed : ${c.detection.sarMeasurements.length}`);
  for (const m of c.detection.sarMeasurements) {
    L.push(`    ${m.scene} — ${m.method}`);
    L.push(`      quicklook: ${m.quicklook}`);
    if (m.vessels) {
      L.push(`      radar vessels: ${m.vessels.length} detected by ${m.vesselModel?.name ?? 'the ship detector'}`);
    } else if (m.vesselsUnavailable) {
      L.push(`      radar vessels: not attempted — ${m.vesselsUnavailable}`);
    }
  }
  L.push(`  Segmentation     : ${MODEL_STATUS.trained ? `${MODEL_STATUS.version} (${modelScoreLine(MODEL_STATUS.models.sarSegmentation)})` : 'not run (no trained model yet)'}`);
  if (c.detection.classProbabilities) {
    const cp = c.detection.classProbabilities;
    L.push(`  Model score      : oil ${cp.oil.toFixed(3)}, not oil ${cp.notOil.toFixed(3)} (${c.detection.modelVersion ?? 'model'})`);
  } else {
    L.push('  Model score      : none — no trained detector has run over this position');
  }
  if (a) {
    L.push(`  Detection basis  : ${a.assessment.confidenceBasis} (${a.assessment.verdict})`, '');
    L.push('  Cross-checks applied:');
    for (const ch of a.assessment.checks) {
      L.push(`    [${ch.status.toUpperCase()}] ${ch.name} (w ${ch.weight.toFixed(2)})`);
      L.push(`           ${ch.detail}`);
    }
    L.push('');
  }

  L.push('3. GEOMETRY', THIN);
  L.push(`  Centroid    : ${shape.centroid.lat.toFixed(5)}N ${shape.centroid.lon.toFixed(5)}E`);
  L.push(`  Area        : ${shape.areaKm2.toFixed(3)} km²`);
  L.push(`  Perimeter   : ${shape.perimeterKm.toFixed(2)} km`);
  L.push(`  Major axis  : ${shape.majorAxisKm.toFixed(3)} km`);
  L.push(`  Elongation  : ${shape.elongation.toFixed(3)}`);
  L.push(`  Orientation : ${shape.orientationDeg.toFixed(1)}°`);
  L.push(`  Vertices    : ${c.detection.polygon.ring.length}`, '');

  if (a) {
    L.push('4. HINDCAST', THIN);
    L.push('  Method       : Lagrangian particle tracking (current + Stokes + windage)');
    L.push(`  Wind forcing : ${a.sampler.sources.wind}`);
    L.push(`  Current      : ${a.sampler.sources.current}`);
    L.push(`  Integration  : ${c.hindcastHours} h backward, ${a.hindcast.params.stepMinutes} min timestep`);
    L.push(`  Particles    : ${a.hindcast.params.particles}   Ensemble: ${a.hindcast.ensemble.length} members`);
    L.push(`  Windage      : ${fmt.pct(a.hindcast.params.windage)}   Diffusivity: ${a.hindcast.params.diffusivity} m²/s`);
    L.push(`  Origin       : ${a.hindcast.estimatedOrigin.lat.toFixed(5)}N ${a.hindcast.estimatedOrigin.lon.toFixed(5)}E`);
    L.push(`  Origin time  : ${fmt.utc(a.hindcast.estimatedTime)}`);
    L.push(`  Uncertainty  : ± ${a.hindcast.uncertaintyRadiusKm.toFixed(2)} km, ± ${a.hindcast.timeWindowHours.toFixed(2)} h`);
    // The circle is only worth as much as the buoy test says it is, and that belongs in the record.
    const cal = driftCalibrationNote();
    if (cal) L.push(`  Calibration  : ${cal.line}`);
    L.push('');

    L.push('5. FORECAST', THIN);
    L.push(`  Integration  : ${c.forecastHours} h forward from the reference observation`);
    for (const h of a.forecast.horizons) {
      L.push(`    +${String(h.hours).padStart(3)} h  ${h.centroid.lat.toFixed(4)}N ${h.centroid.lon.toFixed(4)}E  spread ± ${h.spreadKm.toFixed(1)} km  (${fmt.utc(h.time)})`);
    }
    L.push('');

    L.push('6. CONDITIONS AND WEATHERING', THIN);
    L.push(`  Wind         : ${a.conditions.wind.speed.toFixed(1)} m/s from ${a.conditions.wind.dirFrom.toFixed(0)}° (${a.conditions.wind.origin})`);
    L.push(`  Current      : ${a.conditions.current.speed.toFixed(2)} m/s toward ${a.conditions.current.dirTo.toFixed(0)}° (${a.conditions.current.origin})`);
    L.push(`  Sea state    : ${a.conditions.sea.significantWaveHeightM.toFixed(1)} m Hs, ${a.conditions.sea.beaufortLabel}, SST ${a.conditions.sea.seaSurfaceTempC.toFixed(1)} C`);
    if (a.weathering) {
      L.push(`  Slick age    : ${a.weathering.ageHours.toFixed(1)} h`);
      L.push(`  Evaporated   : ${a.weathering.evaporatedPct.toFixed(1)} %`);
      L.push(`  Water content: ${a.weathering.waterContentPct.toFixed(1)} %`);
      L.push(`  Thickness    : ${a.weathering.thicknessUm.toFixed(2)} um   Appearance: ${a.weathering.appearance}`);
      L.push(`  Remaining    : ${a.weathering.remainingPct.toFixed(1)} % of the release still on the surface`);
    } else {
      L.push('  Weathering   : not computed — the incident time is not precise enough to age the oil');
    }
    L.push('');

    L.push('7. ATTRIBUTION', THIN);
    L.push(`  AIS provider : ${c.aisProvider}`);
    L.push(`  AIS window   : ${fmt.utc(c.aisWindow.start)} → ${fmt.utc(c.aisWindow.end)}`);
    L.push(`  Weights      : proximity ${weights.proximity}, temporality ${weights.temporality}, `
      + `trajectory ${weights.trajectory}, behaviour ${weights.behaviour}, prior ${weights.vesselPrior}`);
    L.push(`  Window       : ${fmt.utc(a.windowStart)} → ${fmt.utc(a.windowEnd)}`);
    L.push(`  Search radius: ${a.searchRadiusKm.toFixed(1)} km`);
    L.push(`  Origin basis : ${a.originBasis}`);
    L.push(`  Verdict      : ${a.verdict.band} — ${a.verdict.label}`, '');
    L.push('  The score orders the vessels that were transmitting. It is not a probability of guilt,');
    L.push('  and a vessel that was silent cannot appear in it at all.', '');
    for (const s of a.ranked) {
      const v = world.vesselsByMmsi.get(s.mmsi);
      L.push(`  Rank ${s.rank}: ${v?.name ?? s.mmsi}  (${v ? fmt.vesselId(v) : s.mmsi}, flag ${v?.flag ?? '—'}, ${v?.provenance === 'real' ? 'real vessel, synthetic track' : 'SYNTHETIC vessel'})`);
      L.push(`    Total ${(s.total * 100).toFixed(1)} = prox ${(s.proximity * 100).toFixed(0)} · temp ${(s.temporality * 100).toFixed(0)} · `
        + `traj ${(s.trajectory * 100).toFixed(0)} · behav ${(s.behaviour * 100).toFixed(0)} · prior ${(s.vesselPrior * 100).toFixed(0)}`);
      L.push(`    CPA ${s.cpaKm.toFixed(2)} km at ${fmt.utc(s.cpaTime)} (Δt ${s.deltaTimeMin.toFixed(0)} min)`);
      if (s.darkDuringWindow) L.push(`    AIS DARK for ${s.darkMinutes} minutes within the window`);
      for (const r of s.reasons) L.push(`    - ${r}`);
      L.push('');
    }
    if (a.excluded.length) {
      L.push('  Excluded from scoring:');
      for (const e of a.excluded) L.push(`    ${e.name} (${e.mmsi}) — ${e.reason}`);
      L.push('');
    }

    L.push('8. ENVIRONMENTAL EXPOSURE', THIN);
    if (a.threatenedAreas.length === 0) {
      L.push('  No designated area lies inside the forecast envelope.');
    } else {
      for (const t of a.threatenedAreas) {
        L.push(`  ${t.name} (${t.category}, ${t.state})`);
        L.push(`    sensitivity ${t.sensitivity}/5, ${t.distanceKm.toFixed(1)} km away`
          + (t.hoursToImpact !== null ? `, envelope arrives in ${t.hoursToImpact} h` : ', not reached within the forecast'));
      }
    }
    L.push('');
  }

  L.push('9. HUMAN DECISION TRAIL', THIN);
  L.push(`  Status ${c.status} · workflow ${c.workflowStage} · assigned to ${c.assignedTo}`);
  if (events.length === 0) L.push('  No recorded action against this case.');
  for (const e of events) {
    L.push(`  ${fmt.utc(e.t)}  ${e.actor} (${e.role}) [${e.provenance}]`);
    L.push(`    ${e.action}: ${e.detail}`);
  }
  L.push('');

  const alerts = world.alerts.filter((x) => x.caseId === c.id);
  const actions = world.enforcement.filter((x) => x.caseId === c.id);
  if (alerts.length || actions.length) {
    L.push('10. RESPONSE AND ENFORCEMENT', THIN);
    for (const al of alerts) L.push(`  Advisory ${fmt.utc(al.issuedAt)} — ${al.headline} (${al.districts.join(', ')})`);
    for (const ac of actions) L.push(`  ${ac.type} against ${ac.party} — ${ac.authority}${ac.reference ? ` (${ac.reference})` : ''}`);
    L.push('');
  }

  if (c.lookalikeReason) {
    L.push('11. RECLASSIFICATION', THIN);
    L.push(`  ${c.lookalikeReason}`, '');
  }

  L.push(RULE);
  L.push('This record lists every input with its provenance. Attribution scores are a prioritisation');
  L.push('tool derived from spatio-temporal correlation and do not constitute evidence of discharge.');
  if (c.warnings.length) {
    L.push('', 'Data warnings:');
    for (const w of c.warnings) L.push(`  - ${w}`);
  }
  L.push(RULE);
  return L;
}

/** What is missing from the record, said plainly, so a reader is not left to infer it. */
export function evidenceGaps(spill: SpillCase, analysis: CaseAnalysis | null): string[] {
  const gaps: string[] = [];
  if (spill.detection.status !== 'sar-processed') {
    gaps.push('No radar scene has been processed, so the extent comes from the report rather than from measurement.');
  }
  if (!spill.detection.classProbabilities) {
    gaps.push('No trained detector has scored this patch, so the model-dependent checks are unanswered.');
  }
  if (analysis && analysis.ranked.length === 0) {
    gaps.push('No vessel was transmitting inside the release window, so nothing could be ranked.');
  }
  if (analysis && analysis.hindcast.uncertaintyRadiusKm > 20) {
    gaps.push(`The origin is uncertain to ± ${analysis.hindcast.uncertaintyRadiusKm.toFixed(0)} km, wide enough that the ranking is a shortlist.`);
  }
  const pending = analysis?.assessment.checks.filter((c) => c.status === 'pending').length ?? 0;
  if (pending) gaps.push(`${pending} of the look-alike checks could not be answered from the inputs available.`);
  if (spill.aisProvider !== 'gfw' && spill.aisProvider !== 'dgll') {
    gaps.push('Vessel tracks are estimated rather than real AIS, so the correlation carries no evidential weight.');
  }
  return gaps;
}
