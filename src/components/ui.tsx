import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, Search, X, Play, Pause, SkipBack, SkipForward, Check, Download } from 'lucide-react';

export function Panel({
  title, subtitle, actions, children, className = '', bodyClass = '', dense,
}: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode;
  className?: string; bodyClass?: string; dense?: boolean;
}) {
  return (
    <div className={`bg-white rounded-lg shadow-sm border border-gray-200 flex flex-col min-h-0 ${className}`}>
      {(title || actions) && (
        <div className={`${dense ? 'px-3 py-2' : 'px-4 py-2.5'} border-b border-gray-200 flex justify-between items-center gap-3 bg-gray-50/60 rounded-t-lg flex-shrink-0`}>
          <div className="min-w-0">
            {title && <h3 className="font-bold text-gray-800 text-sm truncate">{title}</h3>}
            {subtitle && <p className="text-[11px] text-gray-500 truncate">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
        </div>
      )}
      <div className={`flex-1 min-h-0 ${bodyClass}`}>{children}</div>
    </div>
  );
}

const TIER_STYLES: Record<string, string> = {
  HIGH: 'bg-red-600 text-white',
  MEDIUM: 'bg-amber-500 text-white',
  LOW: 'bg-emerald-600 text-white',
};

const STATUS_STYLES: Record<string, string> = {
  'New': 'bg-blue-100 text-blue-800 border-blue-200',
  'Under Analysis': 'bg-indigo-100 text-indigo-800 border-indigo-200',
  'Attributed': 'bg-violet-100 text-violet-800 border-violet-200',
  'Verification Dispatched': 'bg-amber-100 text-amber-800 border-amber-200',
  'Verified': 'bg-teal-100 text-teal-800 border-teal-200',
  'Enforcement': 'bg-orange-100 text-orange-800 border-orange-200',
  'Closed': 'bg-gray-100 text-gray-700 border-gray-200',
  'Dismissed — Look-alike': 'bg-slate-100 text-slate-600 border-slate-200',
  'Online': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Healthy': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Degraded': 'bg-amber-100 text-amber-800 border-amber-200',
  'Offline': 'bg-red-100 text-red-700 border-red-200',
  'Active': 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Suspended': 'bg-red-100 text-red-700 border-red-200',
  'Pending': 'bg-amber-100 text-amber-800 border-amber-200',
};

export function Tier({ tier }: { tier: string }) {
  return <span className={`${TIER_STYLES[tier] ?? 'bg-gray-400 text-white'} text-[10px] font-bold px-1.5 py-0.5 rounded leading-none tracking-wide`}>{tier}</span>;
}

export function Badge({ children, tone = 'gray', className = '' }: { children: ReactNode; tone?: string; className?: string }) {
  const styles: Record<string, string> = {
    gray: 'bg-gray-100 text-gray-700 border-gray-200',
    blue: 'bg-blue-100 text-blue-800 border-blue-200',
    green: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-100 text-amber-800 border-amber-200',
    red: 'bg-red-100 text-red-700 border-red-200',
    violet: 'bg-violet-100 text-violet-800 border-violet-200',
    teal: 'bg-teal-100 text-teal-800 border-teal-200',
    slate: 'bg-slate-700 text-white border-slate-800',
  };
  return <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border leading-none ${styles[tone] ?? styles.gray} ${className}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded border leading-none ${STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700 border-gray-200'}`}>{status}</span>;
}

export function StatCard({
  icon, title, subtitle, value, trend, trendTone = 'neutral', onClick, accent = 'blue',
}: {
  icon: ReactNode; title: string; subtitle?: string; value: ReactNode; trend?: ReactNode;
  trendTone?: 'up' | 'down' | 'neutral'; onClick?: () => void; accent?: 'blue' | 'red' | 'amber' | 'green';
}) {
  const accents = {
    blue: 'bg-blue-50 text-blue-600', red: 'bg-red-50 text-red-600',
    amber: 'bg-amber-50 text-amber-600', green: 'bg-emerald-50 text-emerald-600',
  };
  const tones = { up: 'text-emerald-600', down: 'text-red-600', neutral: 'text-gray-500' };
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex items-center gap-3 text-left flex-1 min-w-[150px] ${
        onClick ? 'hover:border-blue-300 hover:shadow-md transition-all cursor-pointer' : 'cursor-default'
      }`}
    >
      <div className={`${accents[accent]} p-2.5 rounded-lg flex-shrink-0`}>{icon}</div>
      <div className="min-w-0">
        <h3 className="text-[10px] font-bold text-gray-600 uppercase tracking-wide truncate">{title}</h3>
        {subtitle && <p className="text-[9px] font-semibold text-gray-400">{subtitle}</p>}
        <div className="text-2xl font-black text-[#0a192f] mt-0.5 tracking-tight leading-none">{value}</div>
        {trend && <p className={`text-[10px] font-medium mt-1 truncate ${tones[trendTone]}`}>{trend}</p>}
      </div>
    </button>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  width?: string;
  align?: 'left' | 'right' | 'center';
  sortable?: boolean;
  /** Value used for sorting and CSV export. */
  value?: (row: T) => string | number;
  render?: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns, rows, onRowClick, selectedId, rowKey, empty = 'No records match the current filters.',
  dense, maxHeight, initialSort, stickyHeader = true,
}: {
  columns: Column<T>[]; rows: T[]; onRowClick?: (row: T) => void; selectedId?: string | null;
  rowKey: (row: T) => string; empty?: ReactNode; dense?: boolean; maxHeight?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' }; stickyHeader?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return rows;
    const out = [...rows].sort((a, b) => {
      const va = col.value!(a);
      const vb = col.value!(b);
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va).localeCompare(String(vb), undefined, { numeric: true });
    });
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, sort, columns]);

  const toggle = (key: string) => {
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));
  };

  const pad = dense ? 'px-2.5 py-1.5' : 'px-3 py-2';

  return (
    <div className="overflow-auto h-full" style={maxHeight ? { maxHeight } : undefined}>
      <table className="w-full text-xs text-left border-collapse">
        <thead className={`text-[10px] text-gray-600 bg-gray-50 border-b border-gray-200 ${stickyHeader ? 'sticky top-0 z-10' : ''}`}>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width ? { width: c.width } : undefined}
                className={`${pad} font-bold uppercase tracking-wide whitespace-nowrap ${
                  c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
                } ${c.sortable !== false && c.value ? 'cursor-pointer hover:text-blue-700 select-none' : ''}`}
                onClick={() => c.sortable !== false && c.value && toggle(c.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {c.header}
                  {c.sortable !== false && c.value && (
                    sort?.key === c.key
                      ? sort.dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                      : <ChevronsUpDown className="w-3 h-3 opacity-30" />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.length === 0 && (
            <tr><td colSpan={columns.length} className="px-3 py-10 text-center text-gray-400 text-xs">{empty}</td></tr>
          )}
          {sorted.map((row) => {
            const k = rowKey(row);
            const selected = selectedId === k;
            return (
              <tr
                key={k}
                onClick={() => onRowClick?.(row)}
                className={`${onRowClick ? 'cursor-pointer' : ''} ${
                  selected ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : 'hover:bg-gray-50'
                }`}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`${pad} ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''} ${c.className ?? ''}`}>
                    {c.render ? c.render(row) : String(c.value?.(row) ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SearchInput({
  value, onChange, placeholder = 'Search…', className = '',
}: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={`relative ${className}`}>
      <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-7 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 bg-white"
      />
      {value && (
        <button onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function Select({
  value, onChange, options, className = '', label,
}: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string; label?: string;
}) {
  return (
    <div className={className}>
      {label && <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">{label}</label>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function Toggle({ checked, onChange, label, count }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; count?: number }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-xs py-1 group select-none">
      <span
        onClick={(e) => { e.preventDefault(); onChange(!checked); }}
        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
          checked ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-300 group-hover:border-blue-400'
        }`}
      >
        {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
      </span>
      <span className="flex-1 text-gray-700 group-hover:text-gray-900">{label}</span>
      {count !== undefined && <span className="text-[10px] text-gray-400 font-mono">{count}</span>}
    </label>
  );
}

export function Slider({
  value, onChange, min, max, step = 1, label, format, className = '',
}: {
  value: number; onChange: (v: number) => void; min: number; max: number; step?: number;
  label?: ReactNode; format?: (v: number) => string; className?: string;
}) {
  return (
    <div className={className}>
      {label && (
        <div className="flex justify-between items-baseline mb-1">
          <label className="text-[10px] font-bold text-gray-600 uppercase">{label}</label>
          <span className="text-[11px] font-mono font-semibold text-blue-700">{format ? format(value) : value}</span>
        </div>
      )}
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 accent-blue-600 cursor-pointer"
      />
    </div>
  );
}

export function ScoreBar({ label, value, tone = 'blue', detail }: { label: string; value: number; tone?: string; detail?: string }) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-500', red: 'bg-red-500', amber: 'bg-amber-500',
    green: 'bg-emerald-500', violet: 'bg-violet-500', slate: 'bg-slate-500',
  };
  return (
    <div>
      <div className="flex justify-between items-baseline text-[10px] mb-0.5">
        <span className="text-gray-600 font-semibold">{label}</span>
        <span className="font-mono font-bold text-gray-900">{(value * 100).toFixed(0)}</span>
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${tones[tone] ?? tones.blue} rounded-full transition-all duration-500`} style={{ width: `${Math.max(1, Math.min(100, value * 100))}%` }} />
      </div>
      {detail && <p className="text-[9px] text-gray-500 mt-0.5 leading-tight">{detail}</p>}
    </div>
  );
}

export function Modal({
  open, onClose, title, subtitle, children, footer, width = 'max-w-2xl',
}: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode;
  children: ReactNode; footer?: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/45 backdrop-blur-sm" onClick={onClose}>
      <div className={`bg-white rounded-lg shadow-2xl w-full ${width} max-h-[88vh] flex flex-col`} onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-start gap-4 flex-shrink-0">
          <div>
            <h3 className="font-bold text-gray-900">{title}</h3>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 p-1 -m-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg flex justify-end gap-2 flex-shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

export function Button({
  children, onClick, variant = 'secondary', size = 'md', disabled, className = '', title, icon,
}: {
  children?: ReactNode; onClick?: (e: React.MouseEvent) => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
  size?: 'sm' | 'md'; disabled?: boolean; className?: string; title?: string; icon?: ReactNode;
}) {
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 border-blue-600 disabled:bg-blue-300 disabled:border-blue-300',
    secondary: 'bg-white text-gray-700 hover:bg-gray-50 border-gray-300 disabled:text-gray-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 border-red-600 disabled:bg-red-300 disabled:border-red-300',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 border-emerald-600 disabled:bg-emerald-300',
    ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 border-transparent',
  };
  const sizes = { sm: 'px-2 py-1 text-[11px]', md: 'px-3 py-1.5 text-xs' };
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      className={`${variants[variant]} ${sizes[size]} border rounded font-semibold transition-colors inline-flex items-center gap-1.5 disabled:cursor-not-allowed ${className}`}
    >
      {icon}{children}
    </button>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-bold text-gray-600 uppercase mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export function TextInput({
  value, onChange, placeholder, type = 'text', className = '', mono,
}: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; className?: string; mono?: boolean }) {
  return (
    <input
      type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className={`w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 ${mono ? 'font-mono' : ''} ${className}`}
    />
  );
}

export function TextArea({
  value, onChange, placeholder, rows = 4, className = '',
}: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; className?: string }) {
  return (
    <textarea
      value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
      className={`w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 resize-y ${className}`}
    />
  );
}

export function Tabs({
  tabs, active, onChange, className = '',
}: { tabs: { id: string; label: ReactNode; count?: number }[]; active: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div className={`flex border-b border-gray-200 overflow-x-auto ${className}`}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition-colors flex items-center gap-1.5 ${
            active === t.id ? 'border-blue-600 text-blue-700 bg-blue-50/50' : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50'
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${active === t.id ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'}`}>{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Timeline scrubber with transport controls, used for AIS replay and drift animation. */
export function TimeScrubber({
  min, max, value, onChange, format, playing, onPlayToggle, speed, onSpeedChange, marks = [],
}: {
  min: number; max: number; value: number; onChange: (v: number) => void; format: (v: number) => string;
  playing: boolean; onPlayToggle: () => void; speed: number; onSpeedChange: (s: number) => void;
  marks?: { t: number; color: string; label: string }[];
}) {
  const span = Math.max(1, max - min);
  return (
    <div className="bg-white border-t border-gray-200 px-3 py-2 flex items-center gap-3">
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(min)} title="Jump to start" className="p-1.5 hover:bg-gray-100 rounded text-gray-700"><SkipBack className="w-3.5 h-3.5" /></button>
        <button onClick={onPlayToggle} title={playing ? 'Pause' : 'Play'} className="p-1.5 bg-blue-600 hover:bg-blue-700 rounded text-white">
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <button onClick={() => onChange(max)} title="Jump to end" className="p-1.5 hover:bg-gray-100 rounded text-gray-700"><SkipForward className="w-3.5 h-3.5" /></button>
      </div>

      <div className="flex-1 relative">
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 bg-gray-200 rounded pointer-events-none" />
        {marks.map((m, i) => (
          <div
            key={i}
            title={m.label}
            className="absolute top-1/2 -translate-y-1/2 w-0.5 h-4 pointer-events-none z-10"
            style={{ left: `${((m.t - min) / span) * 100}%`, background: m.color }}
          />
        ))}
        <input
          type="range" min={min} max={max} step={Math.max(1, span / 600)} value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="relative w-full accent-blue-600 cursor-pointer z-20 bg-transparent"
        />
      </div>

      <div className="font-mono text-[11px] font-bold text-gray-900 whitespace-nowrap tabular-nums">{format(value)}</div>

      <select
        value={speed}
        onChange={(e) => onSpeedChange(Number(e.target.value))}
        className="text-[11px] border border-gray-300 rounded px-1.5 py-1 bg-white font-semibold"
        title="Playback speed"
      >
        {[1, 2, 4, 8, 16, 32].map((s) => <option key={s} value={s}>{s}×</option>)}
      </select>
    </div>
  );
}

/** Drives a value between bounds while `playing` is true. */
export function usePlayback(min: number, max: number, initial?: number) {
  const [value, setValue] = useState(initial ?? min);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const raf = useRef<number>(0);
  const last = useRef(0);

  useEffect(() => {
    setValue((v) => Math.min(max, Math.max(min, v)));
  }, [min, max]);

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = now - last.current;
      last.current = now;
      setValue((v) => {
        const step = ((max - min) / 42000) * dt * speed;
        const next = v + step;
        if (next >= max) { setPlaying(false); return max; }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, min, max]);

  return { value, setValue, playing, setPlaying, speed, setSpeed, toggle: () => setPlaying((p) => !p) };
}

export function Sparkline({ points, color = '#2563eb', height = 28, fill = true }: { points: number[]; color?: string; height?: number; fill?: boolean }) {
  if (points.length < 2) return <div style={{ height }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const w = 100;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${height - ((p - min) / span) * (height - 4) - 2}`).join('L');
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" style={{ height, width: '100%' }}>
      {fill && <path d={`M0,${height}L${d}L${w},${height}Z`} fill={color} opacity="0.13" />}
      <path d={`M${d}`} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BarChart({
  data, height = 140, color = '#2563eb', valueFormat, horizontal,
}: {
  data: { label: string; value: number; color?: string }[]; height?: number; color?: string;
  valueFormat?: (v: number) => string; horizontal?: boolean;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  if (horizontal) {
    return (
      <div className="space-y-1.5">
        {data.map((d) => (
          <div key={d.label} className="flex items-center gap-2">
            <div className="w-28 text-[10px] text-gray-600 truncate text-right flex-shrink-0" title={d.label}>{d.label}</div>
            <div className="flex-1 h-4 bg-gray-100 rounded-sm overflow-hidden">
              <div className="h-full rounded-sm transition-all duration-500" style={{ width: `${(d.value / max) * 100}%`, background: d.color ?? color }} />
            </div>
            <div className="w-12 text-[10px] font-mono font-bold text-gray-800 text-right flex-shrink-0">
              {valueFormat ? valueFormat(d.value) : d.value}
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="flex-1 flex flex-col items-center gap-1 min-w-0 group">
          <div className="text-[9px] font-mono font-bold text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity">
            {valueFormat ? valueFormat(d.value) : d.value}
          </div>
          <div
            className="w-full rounded-t transition-all duration-500 hover:opacity-80"
            style={{ height: `${Math.max(2, (d.value / max) * (height - 34))}px`, background: d.color ?? color }}
            title={`${d.label}: ${valueFormat ? valueFormat(d.value) : d.value}`}
          />
          <div className="text-[9px] text-gray-500 truncate w-full text-center" title={d.label}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

export function LineChart({
  series, height = 160, xLabels, yFormat, showArea = false, markers = [],
}: {
  series: { name: string; color: string; points: number[]; dash?: string }[];
  height?: number; xLabels?: string[]; yFormat?: (v: number) => string; showArea?: boolean;
  markers?: { x: number; label: string; color: string }[];
}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div style={{ height }} />;
  const min = Math.min(...all, 0);
  const max = Math.max(...all);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.points.length));
  const W = 320;
  const H = height;
  const padL = 34;
  const padB = 18;
  const padT = 8;
  const plotW = W - padL - 6;
  const plotH = H - padB - padT;

  const xAt = (i: number) => padL + (i / Math.max(1, n - 1)) * plotW;
  const yAt = (v: number) => padT + plotH - ((v - min) / span) * plotH;

  const ticks = [min, min + span / 2, max];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={yAt(t)} x2={W - 6} y2={yAt(t)} stroke="#e5e7eb" strokeWidth="1" />
          <text x={padL - 4} y={yAt(t) + 3} textAnchor="end" fontSize="8" fill="#9ca3af" fontFamily="ui-monospace, monospace">
            {yFormat ? yFormat(t) : t.toFixed(1)}
          </text>
        </g>
      ))}
      {markers.map((m, i) => (
        <g key={i}>
          <line x1={xAt(m.x)} y1={padT} x2={xAt(m.x)} y2={padT + plotH} stroke={m.color} strokeWidth="1.2" strokeDasharray="3 2" />
          <text x={xAt(m.x) + 3} y={padT + 8} fontSize="8" fill={m.color} fontWeight="700">{m.label}</text>
        </g>
      ))}
      {series.map((s) => {
        const d = s.points.map((p, i) => `${xAt(i)},${yAt(p)}`).join('L');
        return (
          <g key={s.name}>
            {showArea && <path d={`M${padL},${padT + plotH}L${d}L${xAt(s.points.length - 1)},${padT + plotH}Z`} fill={s.color} opacity="0.1" />}
            <path d={`M${d}`} fill="none" stroke={s.color} strokeWidth="1.8" strokeDasharray={s.dash} strokeLinejoin="round" />
          </g>
        );
      })}
      {xLabels && xLabels.map((l, i) => {
        const idx = Math.round((i / Math.max(1, xLabels.length - 1)) * (n - 1));
        return <text key={i} x={xAt(idx)} y={H - 5} textAnchor="middle" fontSize="8" fill="#9ca3af">{l}</text>;
      })}
    </svg>
  );
}

export function Donut({ segments, size = 110, thickness = 18, centreLabel, centreSub }: {
  segments: { label: string; value: number; color: string }[]; size?: number; thickness?: number;
  centreLabel?: ReactNode; centreSub?: ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
        {segments.map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color}
              strokeWidth={thickness} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}
            >
              <title>{`${s.label}: ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      {(centreLabel || centreSub) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-xl font-black text-gray-900 leading-none">{centreLabel}</div>
          {centreSub && <div className="text-[9px] text-gray-500 font-semibold mt-0.5">{centreSub}</div>}
        </div>
      )}
    </div>
  );
}

export function KeyValue({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <div className={`grid gap-x-4 gap-y-1.5 text-[11px]`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))` }}>
      {items.map(([k, v], i) => (
        <div key={i} className="flex justify-between gap-2 border-b border-gray-100 pb-1 min-w-0">
          <span className="text-gray-500 flex-shrink-0">{k}</span>
          <span className="font-semibold text-gray-900 text-right truncate">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function InfoBanner({ children, tone = 'blue', icon }: { children: ReactNode; tone?: 'blue' | 'amber' | 'red' | 'green'; icon?: ReactNode }) {
  const tones = {
    blue: 'bg-blue-50 border-blue-200 text-blue-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
    red: 'bg-red-50 border-red-200 text-red-900',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  };
  return (
    <div className={`${tones[tone]} border rounded px-3 py-2 text-[11px] flex gap-2 items-start`}>
      {icon && <div className="flex-shrink-0 mt-0.5">{icon}</div>}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8 text-gray-400">
      {icon && <div className="mb-3 opacity-40">{icon}</div>}
      <p className="font-semibold text-gray-600 text-sm">{title}</p>
      {body && <p className="text-xs mt-1 max-w-sm leading-relaxed">{body}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Builds a CSV from table columns and triggers a client-side download. */
export function downloadCsv<T>(filename: string, columns: Column<T>[], rows: T[]) {
  const esc = (s: unknown) => {
    const v = String(s ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const header = columns.map((c) => esc(typeof c.header === 'string' ? c.header : c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.value ? c.value(r) : '')).join(',')).join('\n');
  triggerDownload(filename, `${header}\n${body}`, 'text/csv;charset=utf-8');
}

export function triggerDownload(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function ExportButton({ onExport, label = 'Export CSV' }: { onExport: () => void; label?: string }) {
  return <Button size="sm" onClick={onExport} icon={<Download className="w-3 h-3" />}>{label}</Button>;
}
