/**
 * Circular seal for the system header: a ship's wheel over sea waves inside a double ring.
 * It is an original mark in the formal style of public-sector portals, not a government emblem.
 */
export function Seal({ size = 52 }: { size?: number }) {
  const spokes = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="OceanWatch seal" className="flex-shrink-0">
      <circle cx="32" cy="32" r="31" fill="#0b2a55" />
      <circle cx="32" cy="32" r="28.5" fill="none" stroke="#c9a449" strokeWidth="1.6" />
      <circle cx="32" cy="32" r="25.5" fill="none" stroke="#c9a449" strokeWidth="0.6" strokeDasharray="1.2 1.6" />
      <g stroke="#e8d59a" strokeWidth="1.6" strokeLinecap="round">
        {spokes.map((a, i) => (
          <line key={i} x1={32 + Math.cos(a) * 6} y1={27 + Math.sin(a) * 6} x2={32 + Math.cos(a) * 14} y2={27 + Math.sin(a) * 14} />
        ))}
      </g>
      <circle cx="32" cy="27" r="10" fill="none" stroke="#e8d59a" strokeWidth="2" />
      <circle cx="32" cy="27" r="3" fill="#e8d59a" />
      <path d="M11 41c3.5-2.4 7-2.4 10.5 0s7 2.4 10.5 0 7-2.4 10.5 0 7 2.4 10.5 0" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M14 47c3-2 6-2 9 0s6 2 9 0 6-2 9 0 6 2 9 0" fill="none" stroke="#7fb3e6" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
