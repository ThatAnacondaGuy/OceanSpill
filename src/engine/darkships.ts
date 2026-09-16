import { haversineKm } from '../lib/geo';
import { interpolateTrack } from './attribution';
import type { RadarVessel, SarMeasurement, VesselTrack } from '../data/types';

/**
 * Ships the radar saw that the AIS feed did not.
 *
 * Everything else in the attribution chain works from AIS, which means it can only ever consider a
 * vessel that chose to be seen. The radar has no such courtesy: a hull returns a bright echo whether
 * or not the transmitter is on. Lining the two up at the moment the satellite passed is what turns
 * "a bright object at 13.4 N" into "a vessel here was not transmitting".
 *
 * The match is deliberately generous. A ship moves up to a kilometre between AIS reports, the radar
 * position is a pixel centroid, and geolocation carries its own error — so a near miss is a match,
 * and only a radar target with nothing anywhere near it is called dark. Being generous here means
 * under-reporting dark ships, which is the right direction to be wrong in: naming a transmitting
 * vessel as dark is an accusation, missing one is a gap.
 */

/** A radar target within this distance of an interpolated AIS position is that vessel. */
export const MATCH_RADIUS_KM = 2.0;

export interface DarkShipResult {
  /** Radar targets with no AIS vessel near them at scene time. */
  dark: RadarVessel[];
  /** Radar targets matched to a transmitting vessel, with the key it matched. */
  matched: { vessel: RadarVessel; key: string; separationKm: number }[];
  /** Scene time the comparison was made at. */
  at: number;
  /** How many AIS tracks had a position at that moment to compare against. */
  tracksInWindow: number;
}

/**
 * Compare one processed scene's radar vessels against the AIS tracks for the case.
 *
 * Returns null when the comparison cannot be made honestly: no vessel detection was run, the window
 * was too coarse to resolve a ship, or no AIS track covers the moment the scene was taken. In that
 * last case every radar target would look dark, which would be an artefact of the feed rather than a
 * finding about the water.
 */
export function findDarkShips(
  measurement: SarMeasurement,
  tracks: Map<string, VesselTrack>,
  sceneTime: number,
): DarkShipResult | null {
  const radar = measurement.vessels;
  if (!radar) return null;

  const positions: { key: string; lat: number; lon: number }[] = [];
  for (const [key, track] of tracks) {
    const ping = interpolateTrack(track, sceneTime);
    if (ping) positions.push({ key, lat: ping.lat, lon: ping.lon });
  }

  // With nothing to compare against, every target is "dark" by default, which says more about the
  // feed than about the sea. Better to report that the comparison could not be made.
  if (positions.length === 0) return null;

  const dark: RadarVessel[] = [];
  const matched: DarkShipResult['matched'] = [];
  for (const target of radar) {
    let best: { key: string; km: number } | null = null;
    for (const p of positions) {
      const km = haversineKm(target.position, p);
      if (!best || km < best.km) best = { key: p.key, km };
    }
    if (best && best.km <= MATCH_RADIUS_KM) matched.push({ vessel: target, key: best.key, separationKm: best.km });
    else dark.push(target);
  }
  return { dark, matched, at: sceneTime, tracksInWindow: positions.length };
}

/** One line an operator can read: what the radar found, and how much of it was transmitting. */
export function darkShipSummary(result: DarkShipResult | null, measurement: SarMeasurement): string {
  if (measurement.vessels === undefined) return 'No vessel detection was run on this scene.';
  if (measurement.vesselsUnavailable) return measurement.vesselsUnavailable;
  if (!result) {
    const count = measurement.vessels?.length ?? 0;
    return `${count} vessel${count === 1 ? '' : 's'} in the radar, and no AIS track covers the moment the scene was taken, so none of them can be called dark.`;
  }
  const total = result.dark.length + result.matched.length;
  if (total === 0) return `No vessel in the radar, against ${result.tracksInWindow} AIS track${result.tracksInWindow === 1 ? '' : 's'} at scene time.`;
  if (result.dark.length === 0) return `${total} vessel${total === 1 ? '' : 's'} in the radar, all of them transmitting.`;
  return `${total} vessel${total === 1 ? '' : 's'} in the radar, ${result.dark.length} with no AIS within ${MATCH_RADIUS_KM} km at scene time.`;
}
