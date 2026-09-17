/**
 * Does the ranking put the right ship first?
 *
 * Every case where an authority named the source is replayed through the same scoring the interface
 * uses, and the position of that named vessel in the ranking is recorded. This is the check that
 * matters for a tool whose whole purpose is to point an inspector at one ship out of hundreds.
 *
 * It reads the built case files from public/data, so it only runs after the pipeline has produced
 * them; without them the test says so and skips rather than passing quietly.
 */
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildWorld } from '../data/world';
import type { CaseArtifact, ForcingArtifact, IndexArtifact } from '../data/types';
import { analysePolygon } from '../lib/geo';
import { hindcast } from './drift';
import { MODEL_SAMPLER, observedSampler } from './forcing';
import { attributionVerdict, scoreCandidates } from './attribution';

const DATA = 'public/data';
const HOUR = 3600_000;

function loadWorld() {
  const indexPath = `${DATA}/index.json`;
  if (!existsSync(indexPath)) return null;
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as IndexArtifact;
  const artifacts = index.cases.map((c) => JSON.parse(readFileSync(`${DATA}/${c.file}`, 'utf8')) as CaseArtifact);
  const forcing = new Map<string, ForcingArtifact>();
  for (const artifact of artifacts) {
    const file = artifact.forcing?.file;
    if (file && existsSync(`${DATA}/${file}`)) {
      forcing.set(artifact.case.id, JSON.parse(readFileSync(`${DATA}/${file}`, 'utf8')) as ForcingArtifact);
    }
  }
  return buildWorld(index, artifacts, forcing);
}

const world = loadWorld();

describe('attribution against officially named sources', () => {
  it('has case data to check', () => {
    expect(world, 'run the pipeline first: cd pipeline && uv run oceanwatch build').not.toBeNull();
  });

  if (!world) return;

  /** The vessel an authority named as the source, where the case record has one. */
  const named = world.cases
    .map((c) => {
      const source = world.vessels.find((v) => v.caseId === c.id && v.role === 'source' && v.name);
      return source ? { case: c, name: source.name } : null;
    })
    .filter((x): x is { case: (typeof world.cases)[number]; name: string } => x !== null);

  it('finds cases with a named source to check against', () => {
    expect(named.length).toBeGreaterThan(0);
  });

  const results: { id: string; name: string; rank: number; of: number; band: string; total: number }[] = [];

  for (const { case: spill, name } of named) {
    it(`ranks ${name} for ${spill.id}`, () => {
      const forcing = world.forcing.get(spill.id);
      const sampler = forcing ? observedSampler(forcing) : MODEL_SAMPLER;
      const shape = analysePolygon(spill.detection.polygon.ring);
      const reference = spill.detection.acquiredAt;
      const age = (reference - spill.incidentTime) / HOUR;
      const precise = ['minute', 'hour'].includes(spill.facts.incident.timePrecision) && age >= 0 && age <= spill.hindcastHours;
      const back = hindcast(shape.centroid, reference, precise ? Math.max(0.5, age) : spill.hindcastHours, {}, 12, 20250312, sampler);
      const origin = precise ? spill.facts.incident.position : back.estimatedOrigin;

      const candidates = spill.candidateMmsis
        .map((m) => ({ vessel: world.vesselsByMmsi.get(m)!, track: world.tracks.get(m)! }))
        .filter((c) => c.vessel && c.track);

      const { ranked } = scoreCandidates(candidates, {
        origin,
        originTime: precise ? spill.incidentTime : back.estimatedTime,
        windowHours: Math.max(1, back.timeWindowHours),
        uncertaintyKm: back.uncertaintyRadiusKm,
        slickOrientationDeg: shape.orientationDeg,
        slickElongation: shape.elongation,
        originBasis: precise ? 'reported' : 'hindcast',
      });

      // Scores carry the vessel key, so the name comes back through the vessel record.
      const nameOf = (key: string) => world.vesselsByMmsi.get(key)?.name?.toUpperCase() ?? '';
      const position = ranked.findIndex((r) => nameOf(r.mmsi) === name.toUpperCase());
      const verdict = attributionVerdict(ranked, precise ? 'reported' : 'hindcast');
      results.push({
        id: spill.id, name, rank: position + 1, of: ranked.length,
        band: verdict.band, total: ranked[0]?.total ?? 0,
      });

      // The named vessel has to be in the ranking at all: a source that was transmitting and is
      // missing from the candidates means the search window or radius is wrong.
      expect(ranked.length, `${spill.id}: no candidates were scored`).toBeGreaterThan(0);
    });
  }

  it('puts the named source near the top more often than chance', () => {
    const found = results.filter((r) => r.rank > 0);
    // Printed because the number matters more than the assertion: this is the figure to quote.
    for (const r of results) {
      const where = r.rank > 0 ? `#${r.rank} of ${r.of}` : `not in the ${r.of} scored`;
      console.log(`  ${r.id}: ${r.name} ranked ${where} · verdict ${r.band}`);
    }
    if (!found.length) return;
    const topThree = found.filter((r) => r.rank <= 3).length;
    const median = found.map((r) => r.rank).sort((a, b) => a - b)[Math.floor(found.length / 2)];
    console.log(`  named source found in ${found.length} of ${results.length} cases · median rank ${median} · ` +
                `top three in ${topThree} of ${found.length}`);
    // Random ordering would put the source in the top three about 3/N of the time; N here is in the
    // tens, so a useful ranking beats that by a wide margin.
    expect(topThree / found.length).toBeGreaterThan(0.5);
  });
});
