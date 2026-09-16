import type { LatLon } from '../lib/geo';
import ECOLOGICAL_AREAS_FILE from '../../shared/ecological-areas.json';

const ll = (lat: number, lon: number): LatLon => ({ lat, lon });

/**
 * Simplified but geographically faithful outline of the Indian mainland, traced from the
 * Rann of Kutch clockwise around the peninsula to the Sundarbans and closed along the
 * northern land border. Used for landmasking and for the basemap.
 */
export const INDIA_MAINLAND: LatLon[] = [
  // West coast, north to south. Gulf of Kachchh and Gulf of Khambhat are traced in and
  // back out so the ring never crosses itself.
  ll(23.9, 68.2), ll(23.1, 68.55), ll(22.75, 69.05), ll(22.55, 69.6), ll(22.62, 70.25),
  ll(22.45, 70.55), ll(22.3, 70.05), ll(22.1, 69.45), ll(21.85, 69.2), ll(21.62, 69.6),
  ll(21.15, 70.05), ll(20.88, 70.45), ll(20.72, 70.98), ll(20.95, 71.55), ll(21.35, 72.05),
  ll(21.85, 72.45), ll(22.3, 72.62), ll(21.85, 72.72), ll(21.35, 72.82), ll(20.85, 72.78),
  ll(20.4, 72.82), ll(19.9, 72.75), ll(19.08, 72.85), ll(18.6, 72.9), ll(17.98, 73.15),
  ll(17.0, 73.28), ll(16.2, 73.45), ll(15.5, 73.78), ll(14.8, 74.1), ll(14.0, 74.45),
  ll(13.0, 74.78), ll(12.3, 75.0), ll(11.6, 75.55), ll(11.25, 75.78), ll(10.55, 76.05),
  ll(9.97, 76.28), ll(9.2, 76.5), ll(8.7, 76.75), ll(8.38, 77.0),
  // Southern tip and the Gulf of Mannar / Palk Bay coast.
  ll(8.08, 77.55), ll(8.35, 78.0), ll(8.8, 78.15), ll(9.28, 78.85), ll(9.45, 79.2),
  ll(9.28, 79.32), ll(9.62, 79.15), ll(10.0, 79.42), ll(10.35, 79.5), ll(10.77, 79.85),
  // East coast, south to north.
  ll(11.4, 79.78), ll(11.93, 79.83), ll(12.62, 80.2), ll(13.08, 80.29), ll(13.6, 80.3),
  ll(14.4, 80.15), ll(15.2, 80.1), ll(15.75, 80.4), ll(16.17, 81.15), ll(16.32, 81.75),
  ll(16.98, 82.25), ll(17.4, 82.9), ll(17.72, 83.3), ll(18.3, 84.1), ll(19.27, 84.9),
  ll(19.8, 85.6), ll(20.28, 86.62), ll(20.75, 87.0), ll(21.5, 87.5), ll(21.65, 88.15),
  ll(22.0, 88.6), ll(22.6, 88.9),
  // Northern land border, simplified to a smooth arc back to the Rann of Kutch.
  ll(23.5, 88.6), ll(24.8, 88.1), ll(26.0, 88.4), ll(26.8, 89.3), ll(27.3, 88.1),
  ll(27.9, 86.0), ll(28.6, 83.5), ll(29.6, 80.5), ll(30.7, 78.5), ll(32.2, 76.8),
  ll(32.6, 74.9), ll(30.2, 74.6), ll(28.0, 72.3), ll(26.2, 70.4), ll(24.5, 69.6),
];

export const SRI_LANKA: LatLon[] = [
  ll(9.82, 80.05), ll(9.6, 80.55), ll(9.0, 80.9), ll(8.4, 81.3), ll(7.8, 81.65),
  ll(7.0, 81.85), ll(6.3, 81.75), ll(5.95, 81.2), ll(5.93, 80.55), ll(6.4, 80.0),
  ll(7.2, 79.85), ll(8.0, 79.75), ll(8.8, 79.75), ll(9.4, 79.9),
];

export const ANDAMAN_NICOBAR: LatLon[][] = [
  [ll(13.6, 92.9), ll(13.3, 93.1), ll(12.6, 93.0), ll(12.2, 92.85), ll(12.5, 92.7), ll(13.2, 92.75)],
  [ll(11.9, 92.75), ll(11.5, 92.95), ll(11.0, 92.8), ll(11.3, 92.6), ll(11.7, 92.6)],
  [ll(10.9, 92.6), ll(10.5, 92.75), ll(10.2, 92.6), ll(10.55, 92.45)],
  [ll(9.2, 92.8), ll(8.9, 93.0), ll(8.6, 92.85), ll(8.95, 92.7)],
  [ll(7.5, 93.6), ll(7.1, 93.9), ll(6.75, 93.85), ll(6.9, 93.55), ll(7.3, 93.5)],
];

export const LAKSHADWEEP: LatLon[] = [
  ll(11.22, 72.78), ll(10.85, 73.05), ll(10.57, 72.64), ll(11.68, 72.18), ll(12.0, 71.98),
  ll(10.07, 73.63), ll(9.23, 73.05), ll(8.28, 73.05),
];

export const NEIGHBOURS: { name: string; ring: LatLon[] }[] = [
  {
    name: 'PAKISTAN',
    ring: [ll(24.8, 67.0), ll(25.4, 66.0), ll(25.2, 64.0), ll(25.0, 61.6), ll(28.0, 62.0),
           ll(30.0, 66.0), ll(31.0, 70.0), ll(29.0, 71.5), ll(26.0, 69.5), ll(24.2, 68.2)],
  },
  {
    name: 'BANGLADESH',
    ring: [ll(22.3, 91.8), ll(21.6, 92.0), ll(22.0, 92.3), ll(23.2, 92.5), ll(24.5, 92.2),
           ll(25.2, 91.0), ll(25.0, 89.5), ll(26.3, 88.9), ll(24.5, 88.1), ll(23.5, 88.6),
           ll(22.6, 88.9), ll(21.9, 89.5), ll(21.8, 90.6)],
  },
  {
    name: 'MYANMAR',
    ring: [ll(21.0, 92.4), ll(19.5, 93.4), ll(17.8, 94.4), ll(16.5, 94.6), ll(15.9, 96.0),
           ll(14.5, 97.8), ll(12.4, 98.6), ll(10.5, 98.7), ll(12.0, 99.1), ll(15.0, 98.2),
           ll(17.0, 97.6), ll(19.0, 97.0), ll(21.5, 96.5), ll(24.0, 95.0), ll(26.0, 95.3),
           ll(27.5, 97.0), ll(28.0, 95.0), ll(26.6, 92.8), ll(24.0, 92.6), ll(22.0, 92.3)],
  },
  {
    name: 'OMAN',
    ring: [ll(22.5, 59.8), ll(20.5, 58.8), ll(18.9, 57.7), ll(17.0, 55.0), ll(16.7, 53.1),
           ll(19.0, 53.5), ll(22.0, 55.2), ll(24.0, 55.8), ll(24.5, 57.0), ll(23.5, 58.5)],
  },
];

/**
 * Indian EEZ (200 nautical mile limit) approximated as an offset from the coastal baseline,
 * including the Lakshadweep and Andaman & Nicobar extensions.
 */
export const INDIA_EEZ: LatLon[] = [
  ll(23.0, 67.4), ll(21.5, 66.6), ll(19.5, 66.6), ll(17.0, 67.6), ll(14.5, 69.0),
  ll(12.0, 69.5), ll(9.5, 70.0), ll(7.5, 71.0), ll(6.0, 72.5), ll(5.5, 74.5),
  ll(6.2, 76.5), ll(7.2, 77.5), ll(7.0, 79.0), ll(6.5, 81.0), ll(7.5, 82.5),
  ll(9.5, 83.5), ll(11.5, 84.0), ll(13.5, 85.0), ll(15.5, 86.0), ll(17.5, 87.5),
  ll(19.0, 88.8), ll(20.5, 89.6), ll(21.6, 89.4), ll(21.5, 88.2), ll(20.28, 86.62),
  ll(18.3, 84.1), ll(16.17, 81.15), ll(13.6, 80.3), ll(10.77, 79.85), ll(9.28, 79.35),
  ll(8.08, 77.55), ll(9.97, 76.28), ll(12.3, 75.0), ll(15.5, 73.78), ll(19.08, 72.85),
  ll(21.6, 72.2), ll(22.4, 69.8), ll(23.9, 68.2),
];

export const ANDAMAN_EEZ: LatLon[] = [
  ll(15.5, 91.0), ll(15.2, 94.5), ll(13.0, 95.5), ll(10.0, 95.0), ll(7.5, 95.2),
  ll(5.5, 94.5), ll(5.2, 92.5), ll(6.5, 91.0), ll(9.0, 90.3), ll(12.0, 90.2), ll(14.5, 90.4),
];

/** Every landmass ring, used for coastline distance queries. */
const ALL_COASTS: LatLon[][] = [INDIA_MAINLAND, SRI_LANKA, ...ANDAMAN_NICOBAR, ...NEIGHBOURS.map((n) => n.ring)];

/**
 * Great-circle distance in km from a point to the nearest coastline vertex across every
 * landmass, including the island groups. The crude "distance to the mainland meridian"
 * approximation used inside the drift model is wrong by an order of magnitude in the
 * Andaman Sea, so anything shown to an operator uses this instead.
 */
export function distanceToCoastKm(p: LatLon): number {
  let best = Infinity;
  for (const ring of ALL_COASTS) {
    for (const v of ring) {
      const dLat = (v.lat - p.lat) * 110.574;
      const dLon = (v.lon - p.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
      const d = Math.hypot(dLat, dLon);
      if (d < best) best = d;
    }
  }
  // Lakshadweep atolls are drawn as points rather than rings.
  for (const v of LAKSHADWEEP) {
    const dLat = (v.lat - p.lat) * 110.574;
    const dLon = (v.lon - p.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
    const d = Math.hypot(dLat, dLon);
    if (d < best) best = d;
  }
  return best;
}

export interface Port {
  name: string;
  state: string;
  lat: number;
  lon: number;
  /** Major cargo/oil terminal ports get a larger symbol and feed the traffic model. */
  tier: 1 | 2;
  oilTerminal: boolean;
}

export const PORTS: Port[] = [
  { name: 'Kandla (Deendayal)', state: 'Gujarat', lat: 23.02, lon: 70.22, tier: 1, oilTerminal: true },
  { name: 'Mundra', state: 'Gujarat', lat: 22.84, lon: 69.72, tier: 1, oilTerminal: true },
  { name: 'Jamnagar / Sikka', state: 'Gujarat', lat: 22.43, lon: 69.82, tier: 1, oilTerminal: true },
  { name: 'Porbandar', state: 'Gujarat', lat: 21.63, lon: 69.6, tier: 2, oilTerminal: false },
  { name: 'Hazira', state: 'Gujarat', lat: 21.1, lon: 72.65, tier: 2, oilTerminal: true },
  { name: 'Mumbai (JNPT)', state: 'Maharashtra', lat: 18.95, lon: 72.95, tier: 1, oilTerminal: true },
  { name: 'Mumbai High', state: 'Offshore', lat: 19.5, lon: 71.4, tier: 1, oilTerminal: true },
  { name: 'Ratnagiri', state: 'Maharashtra', lat: 16.99, lon: 73.3, tier: 2, oilTerminal: false },
  { name: 'Mormugao', state: 'Goa', lat: 15.41, lon: 73.8, tier: 1, oilTerminal: false },
  { name: 'New Mangalore', state: 'Karnataka', lat: 12.92, lon: 74.8, tier: 1, oilTerminal: true },
  { name: 'Kochi', state: 'Kerala', lat: 9.97, lon: 76.26, tier: 1, oilTerminal: true },
  { name: 'Vizhinjam', state: 'Kerala', lat: 8.38, lon: 76.99, tier: 1, oilTerminal: false },
  { name: 'Tuticorin (V.O.C.)', state: 'Tamil Nadu', lat: 8.76, lon: 78.18, tier: 1, oilTerminal: false },
  { name: 'Chennai', state: 'Tamil Nadu', lat: 13.1, lon: 80.3, tier: 1, oilTerminal: true },
  { name: 'Ennore (Kamarajar)', state: 'Tamil Nadu', lat: 13.24, lon: 80.34, tier: 1, oilTerminal: true },
  { name: 'Krishnapatnam', state: 'Andhra Pradesh', lat: 14.28, lon: 80.12, tier: 2, oilTerminal: false },
  { name: 'Visakhapatnam', state: 'Andhra Pradesh', lat: 17.69, lon: 83.29, tier: 1, oilTerminal: true },
  { name: 'Gangavaram', state: 'Andhra Pradesh', lat: 17.6, lon: 83.24, tier: 2, oilTerminal: false },
  { name: 'Paradip', state: 'Odisha', lat: 20.26, lon: 86.67, tier: 1, oilTerminal: true },
  { name: 'Dhamra', state: 'Odisha', lat: 20.79, lon: 86.98, tier: 2, oilTerminal: false },
  { name: 'Haldia', state: 'West Bengal', lat: 22.03, lon: 88.1, tier: 1, oilTerminal: true },
  { name: 'Kolkata', state: 'West Bengal', lat: 22.55, lon: 88.31, tier: 2, oilTerminal: false },
  { name: 'Port Blair', state: 'Andaman & Nicobar', lat: 11.62, lon: 92.73, tier: 2, oilTerminal: false },
  { name: 'Kavaratti', state: 'Lakshadweep', lat: 10.57, lon: 72.64, tier: 2, oilTerminal: false },
];

export type EsaCategory =
  | 'Mangrove'
  | 'Coral Reef'
  | 'Marine National Park'
  | 'Turtle Nesting'
  | 'Seagrass'
  | 'Ramsar Wetland';

export interface EcologicalArea {
  id: string;
  name: string;
  category: EsaCategory;
  state: string;
  /** NCSCM sensitivity index, 1 (low) to 5 (critical). */
  sensitivity: 1 | 2 | 3 | 4 | 5;
  areaKm2: number;
  ring: LatLon[];
  notes: string;
  /** Months when the site is most vulnerable (breeding/nesting/spawning). */
  peakSeason: string;
}

/**
 * Protected and ecologically sensitive areas, in shared/ecological-areas.json so the pipeline can
 * fetch the real mapped boundary for each one (see `oceanspill protected-areas`).
 */
export const ECOLOGICAL_AREAS: EcologicalArea[] = ECOLOGICAL_AREAS_FILE.areas as EcologicalArea[];

/**
 * Traffic corridors used both as a shipping-lane overlay and as the spine for AIS track
 * synthesis. Nine Degree Channel and the Gulf of Aden approach are the known high-risk
 * segments for ship-to-ship transfer and bilge discharge.
 */
export interface Corridor {
  id: string;
  name: string;
  waypoints: LatLon[];
  /** Vessels per day transiting the corridor. */
  density: number;
  riskNote: string;
  highRisk: boolean;
}

export const CORRIDORS: Corridor[] = [
  {
    id: 'COR-9DEG',
    name: 'Nine Degree Channel (Gulf → Malacca)',
    waypoints: [ll(9.1, 71.0), ll(9.0, 73.0), ll(8.7, 76.0), ll(7.6, 79.0), ll(6.6, 82.0), ll(6.2, 85.0)],
    density: 178,
    riskNote: 'Primary Gulf–Far East tanker artery. Persistent cluster of AIS gaps and STS transfers south of Minicoy.',
    highRisk: true,
  },
  {
    id: 'COR-KUTCH',
    name: 'Gulf of Kachchh Approach',
    waypoints: [ll(22.4, 68.2), ll(22.3, 69.0), ll(22.4, 69.7), ll(22.7, 70.1)],
    density: 64,
    riskNote: 'Jamnagar/Vadinar VLCC approach. Tank-washing detected on outbound legs after discharge.',
    highRisk: true,
  },
  {
    id: 'COR-MUMBAI',
    name: 'Mumbai High Offshore Field',
    waypoints: [ll(19.9, 71.0), ll(19.5, 71.4), ll(19.1, 71.9), ll(18.9, 72.6)],
    density: 88,
    riskNote: 'Dense platform-supply traffic mixing with commercial transits; produced-water sheens common.',
    highRisk: false,
  },
  {
    id: 'COR-BOB-N',
    name: 'North Bay of Bengal Lane',
    waypoints: [ll(21.2, 88.6), ll(20.4, 87.4), ll(19.6, 86.4), ll(18.4, 85.2), ll(17.6, 84.0)],
    density: 71,
    riskNote: 'Paradip–Haldia coastal run passing within 25 km of Gahirmatha turtle sanctuary.',
    highRisk: true,
  },
  {
    id: 'COR-PALK',
    name: 'Palk Bay / Gulf of Mannar Transit',
    waypoints: [ll(9.6, 79.6), ll(9.0, 79.3), ll(8.4, 78.6), ll(8.0, 77.9)],
    density: 42,
    riskNote: 'Shallow reef-adjacent route; small-tonnage traffic with poor AIS compliance.',
    highRisk: false,
  },
  {
    id: 'COR-ANDAMAN',
    name: 'Andaman Sea Approach (Malacca Feeder)',
    waypoints: [ll(13.4, 94.2), ll(12.2, 93.6), ll(10.8, 93.2), ll(9.0, 93.4), ll(7.2, 94.0)],
    density: 96,
    riskNote: 'Malacca-bound feeder crossing the Andaman EEZ; frequent slow-steaming and loitering.',
    highRisk: true,
  },
  {
    id: 'COR-CHENNAI',
    name: 'Chennai–Ennore Approach',
    waypoints: [ll(13.6, 81.2), ll(13.3, 80.7), ll(13.15, 80.4), ll(13.05, 80.32)],
    density: 55,
    riskNote: 'Ennore terminal approach; historical site of the 2017 Kamarajar Port collision spill.',
    highRisk: false,
  },
];

export interface SeaLabel {
  name: string;
  lat: number;
  lon: number;
  size: 'lg' | 'md' | 'sm';
}

export const SEA_LABELS: SeaLabel[] = [
  { name: 'ARABIAN SEA', lat: 15.5, lon: 66.5, size: 'lg' },
  { name: 'BAY OF BENGAL', lat: 14.5, lon: 87.0, size: 'lg' },
  { name: 'LACCADIVE SEA', lat: 7.5, lon: 74.5, size: 'md' },
  { name: 'ANDAMAN SEA', lat: 10.5, lon: 95.5, size: 'md' },
  { name: 'GULF OF MANNAR', lat: 8.6, lon: 78.7, size: 'sm' },
  { name: 'PALK STRAIT', lat: 9.9, lon: 79.6, size: 'sm' },
  { name: 'GULF OF KACHCHH', lat: 22.6, lon: 69.4, size: 'sm' },
  { name: 'INDIAN OCEAN', lat: 3.0, lon: 80.0, size: 'lg' },
];

export interface CountryLabel {
  name: string;
  lat: number;
  lon: number;
}

export const COUNTRY_LABELS: CountryLabel[] = [
  { name: 'INDIA', lat: 22.5, lon: 78.5 },
  { name: 'SRI LANKA', lat: 7.6, lon: 80.7 },
  { name: 'BANGLADESH', lat: 23.8, lon: 90.3 },
  { name: 'MYANMAR', lat: 21.0, lon: 95.5 },
  { name: 'PAKISTAN', lat: 27.5, lon: 66.5 },
  { name: 'OMAN', lat: 20.5, lon: 56.5 },
  { name: 'MALDIVES', lat: 3.9, lon: 73.3 },
];
