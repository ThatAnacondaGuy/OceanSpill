import { haversineKm } from '../lib/geo';
import type { CaseAnalysis } from '../store/store';
import type { SpillCase, Vessel } from '../data/types';

/**
 * What a liability case would need, assembled from what the system actually knows.
 *
 * This deliberately does not compute a fine. Quantum under Indian law turns on the statute invoked,
 * the tribunal, the tonnage limit that applies, and findings of fact a tribunal makes and software
 * does not — and a confident rupee figure on a screen would be read as an assessment when it is a
 * guess. What the system can honestly do is gather the facts counsel would ask for first, say which
 * regimes are engaged by those facts, and be explicit about which elements are not yet evidenced.
 *
 * Every statute below is named at the level this project can stand behind. Section-level citation and
 * quantum are marked as requiring legal verification, because they do.
 */

export interface LiabilityFactor {
  label: string;
  value: string;
  /** True when this is established from a source, false when it is modelled or absent. */
  evidenced: boolean;
  note?: string;
}

export interface LiabilityRegime {
  statute: string;
  provides: string;
  engagedBy: string;
  /** False when the facts do not currently engage this regime. */
  engaged: boolean;
}

export interface LiabilityAssessment {
  factors: LiabilityFactor[];
  regimes: LiabilityRegime[];
  /** Elements a claim would turn on that the system cannot currently evidence. */
  unevidenced: string[];
  /** Recorded outcome, when an authority has already acted. */
  recorded: { authority: string; action: string; party: string; amountInr?: number; note?: string }[];
  /** Distance from the baseline, which decides whether it is territorial sea or EEZ. */
  offshoreKm: number | null;
}

/** Roughly where the coast is for this case, from the nearest point the pipeline resolved. */
function offshoreDistanceKm(spill: SpillCase): number | null {
  const coast = spill.facts.impact?.shoreDistanceKm;
  if (typeof coast === 'number') return coast;
  return null;
}

export function assessLiability(
  spill: SpillCase,
  analysis: CaseAnalysis | null,
  party: Vessel | null,
): LiabilityAssessment {
  const oil = spill.facts.oil;
  const offshoreKm = offshoreDistanceKm(spill);
  const areas = analysis?.threatenedAreas ?? [];
  const leader = analysis?.ranked[0] ?? null;

  const factors: LiabilityFactor[] = [
    {
      label: 'Incident established',
      value: spill.facts.officiallyConfirmed ? 'Confirmed by an authority' : 'Not officially confirmed',
      evidenced: spill.facts.officiallyConfirmed,
      note: spill.facts.officiallyConfirmed ? undefined : 'A claim needs the discharge itself proved, not inferred from imagery.',
    },
    {
      label: 'Quantity discharged',
      value: oil.spilledTonnes != null ? `${oil.spilledTonnes} t (${oil.modelType})` : 'Not published',
      evidenced: oil.spilledTonnes != null,
      note: oil.spilledTonnes != null ? oil.spilledNote : 'Quantum under most heads scales with quantity; without it, damage must be proved directly.',
    },
    {
      label: 'Party identified',
      value: party ? `${party.name}${party.flag ? ` (${party.flag})` : ''}` : leader ? `Leading candidate only: ${leader.mmsi}` : 'Not identified',
      evidenced: Boolean(party) && spill.facts.officiallyConfirmed,
      note: party ? undefined : 'Attribution by AIS correlation orders candidates; it does not identify a discharger.',
    },
    {
      label: 'Registered owner',
      value: party?.operator ?? 'Not established',
      evidenced: Boolean(party?.registryVerified),
      note: party?.registryVerified ? party.registrySource ?? undefined : 'Liability attaches to the registered owner; this needs a registry extract.',
    },
    {
      label: 'Location',
      value: offshoreKm != null
        ? `${offshoreKm.toFixed(0)} km offshore — ${offshoreKm <= 22.2 ? 'within the territorial sea' : 'beyond the territorial sea, within the EEZ if under 370 km'}`
        : `${spill.region}, distance from baseline not computed`,
      evidenced: offshoreKm != null,
      note: 'Which maritime zone the discharge occurred in decides which enforcement powers apply.',
    },
    {
      label: 'Protected areas affected',
      value: areas.length ? `${areas.length} designated area${areas.length === 1 ? '' : 's'} inside the forecast envelope` : 'None inside the forecast envelope',
      evidenced: false,
      note: 'Modelled exposure, not observed damage. A compensation claim needs surveyed damage.',
    },
    {
      label: 'Prior record',
      value: party ? `${party.priorOffences} prior offence${party.priorOffences === 1 ? '' : 's'}${party.pscDetentions != null ? `, ${party.pscDetentions} PSC detentions` : ''}` : 'No party identified',
      evidenced: Boolean(party?.registryVerified),
      note: party?.sanctionsChecked ? undefined : 'Sanctions and detention history need a registry check.',
    },
  ];

  const identified = Boolean(party) && spill.facts.officiallyConfirmed;
  const isVessel = spill.sourceType === 'vessel';

  const regimes: LiabilityRegime[] = [
    {
      statute: 'Merchant Shipping Act 1958 — Part XB (civil liability for oil pollution damage)',
      provides: 'Strict liability of the registered owner for pollution damage, with limitation by tonnage and compulsory insurance, giving effect to the Civil Liability Convention.',
      engagedBy: 'A discharge of persistent oil from a ship, with the owner identified.',
      engaged: isVessel && identified,
    },
    {
      statute: 'Merchant Shipping Act 1958 — Part XC (prevention and containment of pollution)',
      provides: 'Powers to direct, detain and intervene, and offences for discharge contrary to the Act.',
      engagedBy: 'A discharge from a ship in Indian waters.',
      engaged: isVessel && spill.facts.officiallyConfirmed,
    },
    {
      statute: 'Environment (Protection) Act 1986',
      provides: 'Penalties for contravention of environmental standards and directions.',
      engagedBy: 'Any discharge of a pollutant in excess of prescribed standards.',
      engaged: spill.facts.officiallyConfirmed,
    },
    {
      statute: 'Water (Prevention and Control of Pollution) Act 1974',
      provides: 'Offences and directions in respect of polluting matter entering a stream, well or sea.',
      engagedBy: 'Polluting matter entering coastal water.',
      engaged: spill.facts.officiallyConfirmed,
    },
    {
      statute: 'National Green Tribunal Act 2010',
      provides: 'Relief and compensation to victims of pollution, and restitution of the environment, applying the polluter-pays principle.',
      engagedBy: 'A substantial question relating to the environment arising from the incident.',
      engaged: spill.facts.officiallyConfirmed && areas.length > 0,
    },
    {
      statute: 'Indian Ports Act 1908',
      provides: 'Offences for pollution of port waters and powers of the port authority.',
      engagedBy: 'A discharge within port limits.',
      engaged: /port|harbour|creek/i.test(spill.subRegion),
    },
    {
      statute: 'Coast Guard Act 1978',
      provides: 'The Coast Guard’s enforcement and pollution-response functions in the maritime zones.',
      engagedBy: 'Any marine pollution incident in the Indian maritime zones.',
      engaged: true,
    },
  ];

  const unevidenced: string[] = [];
  if (!spill.facts.officiallyConfirmed) unevidenced.push('The discharge itself is not officially confirmed.');
  if (oil.spilledTonnes == null) unevidenced.push('No published quantity, so quantum cannot be scaled to volume.');
  if (!party) unevidenced.push('No party has been identified — only ranked candidates.');
  if (party && !party.registryVerified) unevidenced.push('Ownership is not established from a registry extract.');
  if (spill.aisProvider !== 'gfw' && spill.aisProvider !== 'dgll') {
    unevidenced.push('Vessel tracks are estimated rather than real AIS, so the correlation has no evidential weight.');
  }
  unevidenced.push('No oil fingerprint match: forensic comparison of a water sample against a bunker sample is what links a vessel to a slick.');

  const recorded = (spill.facts.legal ?? []).map((l) => ({
    authority: l.authority, action: l.action, party: l.party, amountInr: l.amountInr, note: l.note,
  }));

  return { factors, regimes, unevidenced, recorded, offshoreKm };
}

/** Straight-line distance to the nearest ecological area, used where the shore distance is absent. */
export function nearestAreaKm(spill: SpillCase, areas: { ring: { lat: number; lon: number }[] }[]): number | null {
  let best: number | null = null;
  for (const a of areas) {
    for (const p of a.ring) {
      const d = haversineKm(spill.facts.incident.position, p);
      if (best == null || d < best) best = d;
    }
  }
  return best;
}
