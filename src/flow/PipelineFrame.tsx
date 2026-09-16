import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import { useStore, fmt } from '../store/store';
import { Badge } from '../components/ui';
import { STAGES, stageIndex } from './pipeline';

/**
 * The frame every pipeline stage sits inside.
 *
 * It does three things the old tab bar could not. It shows the whole pipeline at once, so a visitor
 * can see the shape of the thing rather than guessing it from a row of unrelated page names. It
 * shows each stage doing its work before showing the result, so the numbers on screen are visibly
 * the output of something rather than a layout. And it hands off to the next stage from here, so
 * nobody has to go back to a menu between every step.
 *
 * About the pacing: the work is real and has already run — the hindcast integrated, the vessels were
 * scored, the forcing was sampled — but it finishes in well under a second. The lines below are the
 * actual steps with the actual counts; what is deliberate is the rate they appear at, because a
 * result that flashes past teaches nobody anything. Nothing is being faked, and nothing is waiting
 * on a timer that pretends to be computation.
 */

/** How long each step's line waits before appearing. Presentation, not computation. */
const STEP_MS = 260;

function StageRunning({ steps, onDone }: { steps: { label: string; value: string | null }[]; onDone: () => void }) {
  const [shown, setShown] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    if (shown >= steps.length) {
      const t = window.setTimeout(() => done.current(), 340);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => window.clearTimeout(t);
  }, [shown, steps.length]);

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <ul className="space-y-1.5">
          {steps.slice(0, shown).map((s) => (
            <li key={s.label} className="flex items-start gap-2 text-[0.8125rem]">
              <Check className="w-3.5 h-3.5 text-emerald-600 mt-0.5 flex-shrink-0" />
              <span className="text-gray-700 flex-1">{s.label}</span>
              <span className={`font-mono text-[0.75rem] flex-shrink-0 ${s.value ? 'text-gray-900 font-semibold' : 'text-gray-400 italic'}`}>
                {s.value ?? 'not available'}
              </span>
            </li>
          ))}
          {shown < steps.length && (
            <li className="flex items-start gap-2 text-[0.8125rem]">
              <Loader2 className="w-3.5 h-3.5 text-blue-600 mt-0.5 flex-shrink-0 animate-spin" />
              <span className="text-gray-500">{steps[shown].label}…</span>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

export function PipelineFrame({ tab, children }: { tab: string; children: ReactNode }) {
  const { world, flowCaseId, runStages, goToStage, exitFlow, startFlow, selectedCaseId, getAnalysis, access } = useStore();
  const [running, setRunning] = useState<string | null>(null);
  const played = useRef(new Set<string>());

  const spill = world.cases.find((c) => c.id === flowCaseId) ?? null;
  const selected = world.cases.find((c) => c.id === selectedCaseId) ?? world.cases[0] ?? null;
  const analysis = spill ? getAnalysis(spill.id) : null;
  const index = stageIndex(tab);

  // Stages the signed-in role cannot open are not part of this operator's pipeline at all: they are
  // skipped rather than shown locked, so Next never lands on a page that refuses to render.
  const visible = useMemo(() => STAGES.filter((s) => access(s.tab) !== 'none'), [access]);
  const position = visible.findIndex((s) => s.tab === tab);
  const next = position >= 0 ? visible[position + 1] : undefined;

  const steps = useMemo(
    () => (spill && index >= 0 ? STAGES[index].steps(spill, analysis) : []),
    [spill, analysis, index]
  );

  // Each stage plays its work once per visit to the pipeline. Coming back to a stage already seen
  // shows the page straight away, because the operator has watched it run.
  const key = `${flowCaseId}|${tab}`;
  useEffect(() => {
    if (!spill || index < 0) return;
    if (played.current.has(key)) return;
    played.current.add(key);
    setRunning(tab);
  }, [key, spill, index, tab]);

  // Leaving the pipeline entirely clears what has been played, so a fresh run plays again.
  useEffect(() => {
    if (!flowCaseId) played.current.clear();
  }, [flowCaseId]);

  // A stage reached without a case running — from the global search, say. The page still works on
  // whatever is selected, but it is a stage and should offer the pipeline rather than dead-end.
  if (!spill || index < 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {index >= 0 && selected && (
          <div className="bg-amber-50 border-b border-amber-200 px-3 py-1.5 flex items-center gap-2 flex-wrap flex-shrink-0">
            <span className="text-[0.75rem] text-amber-900">
              <b>{STAGES[index].short}</b> on its own. It is stage {index + 1} of the pipeline.
            </span>
            <button
              onClick={() => startFlow(selected.id)}
              className="ml-auto bg-blue-600 text-white hover:bg-blue-700 px-2.5 py-1 rounded text-[0.71875rem] font-semibold inline-flex items-center gap-1.5"
            >
              Run the pipeline on {selected.id} <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        )}
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="bg-white border-b border-gray-200 flex-shrink-0">
        <div className="px-3 py-1.5 flex items-center gap-2 flex-wrap border-b border-gray-100">
          <Badge tone="red">Running</Badge>
          <span className="text-[0.8125rem] font-bold text-gray-900 truncate max-w-[26rem]">{spill.title}</span>
          <span className="text-[0.6875rem] text-gray-500">{fmt.precise(spill.incidentTime, spill.facts.incident.timePrecision)}</span>
          <button
            onClick={exitFlow}
            className="ml-auto text-[0.6875rem] text-gray-500 hover:text-gray-900 flex items-center gap-1"
          >
            <X className="w-3 h-3" /> Leave the pipeline
          </button>
        </div>

        <div className="px-2 py-1.5 flex items-center gap-1 overflow-x-auto no-scrollbar">
          {visible.map((s, i) => {
            const seen = runStages.includes(s.tab);
            const current = s.tab === tab;
            return (
              <button
                key={s.tab}
                onClick={() => seen && goToStage(s.tab)}
                disabled={!seen}
                title={s.purpose}
                aria-current={current ? 'step' : undefined}
                className={`flex items-center gap-1.5 px-2 py-1 rounded text-[0.71875rem] font-semibold whitespace-nowrap flex-shrink-0 transition-colors ${
                  current ? 'bg-blue-600 text-white'
                    : seen ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    : 'text-gray-400 cursor-default'
                }`}
              >
                <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[0.625rem] ${
                  current ? 'bg-white/25' : seen ? 'bg-emerald-600 text-white' : 'border border-gray-300'
                }`}>
                  {seen && !current ? <Check className="w-2.5 h-2.5" /> : i + 1}
                </span>
                {s.short}
              </button>
            );
          })}
        </div>
      </div>

      {running === tab ? (
        <StageRunning steps={steps} onDone={() => setRunning(null)} />
      ) : (
        <>
          <div className="flex-1 min-h-0 flex flex-col">{children}</div>
          <div className="bg-white border-t border-gray-200 px-3 py-2 flex items-center gap-3 flex-shrink-0">
            <p className="text-[0.6875rem] text-gray-500 min-w-0 truncate">
              {position + 1} of {visible.length} · {STAGES[index].purpose}
            </p>
            {next ? (
              <button
                onClick={() => goToStage(next.tab)}
                className="ml-auto bg-blue-600 text-white hover:bg-blue-700 px-3.5 py-2 rounded text-xs font-semibold inline-flex items-center gap-1.5 flex-shrink-0"
              >
                Next: {next.short} <ArrowRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={exitFlow}
                className="ml-auto bg-emerald-600 text-white hover:bg-emerald-700 px-3.5 py-2 rounded text-xs font-semibold inline-flex items-center gap-1.5 flex-shrink-0"
              >
                <Check className="w-3.5 h-3.5" /> Finish
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
