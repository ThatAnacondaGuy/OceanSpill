import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Radar, RefreshCw, XCircle } from 'lucide-react';
import { useStore, fmt } from '../store/store';
import { fetchMonitoring, reviewDetection, type Detection, type MonitoringSummary } from '../data/server';
import { Badge, Button } from './ui';

/**
 * What the watcher has found since the recorded cases: scenes over the monitored areas and the
 * candidate slicks waiting for someone to look at them.
 *
 * Only shown when the site runs against a server, because that is where the watching happens.
 */
export function LiveMonitoring() {
  const { canEdit, notify, refreshState, now } = useStore();
  const [summary, setSummary] = useState<MonitoringSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await fetchMonitoring());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The monitoring service could not be reached.');
    }
  }, []);

  useEffect(() => {
    void load();
    const h = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(h);
  }, [load]);

  const review = async (d: Detection, status: 'confirmed' | 'dismissed') => {
    setBusy(d.id);
    try {
      await reviewDetection(d.id, status);
      notify({
        kind: 'success',
        title: status === 'confirmed' ? 'Detection confirmed' : 'Detection dismissed as a look-alike',
        body: `${d.areaKm2.toFixed(1)} km² near ${d.position.lat.toFixed(3)}, ${d.position.lon.toFixed(3)}`,
      });
      await Promise.all([load(), refreshState()]);
    } catch (e) {
      notify({ kind: 'error', title: 'Not recorded', body: e instanceof Error ? e.message : 'The server could not be reached.' });
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return (
      <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-[0.75rem] text-amber-900 flex items-center gap-2">
        <Radar className="w-3.5 h-3.5 flex-shrink-0" /> Live monitoring is unavailable: {error}
      </div>
    );
  }
  if (!summary) return null;

  const watching = summary.monitoredAreas.length;
  const detections = summary.newDetections;

  return (
    <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex-shrink-0">
      <div className="flex items-center justify-between gap-3 flex-wrap gap-y-1.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="bg-violet-600 text-white p-1.5 rounded"><Radar className="w-4 h-4" /></div>
          <div className="min-w-0">
            <h3 className="font-bold text-gray-900 text-sm flex items-center gap-2">
              Live monitoring
              {detections.length > 0 && <Badge tone="amber">{detections.length} to review</Badge>}
            </h3>
            <p className="text-[0.75rem] text-gray-500">
              {watching === 0
                ? 'No planning areas are being watched yet — mark one as monitored in Satellite Tasking.'
                : `Watching ${watching} area${watching > 1 ? 's' : ''} · ${summary.scenesLastWeek} scene${summary.scenesLastWeek === 1 ? '' : 's'} catalogued this week` +
                  (summary.lastScene ? ` · last ${fmt.ago(summary.lastScene, now)}` : '')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[0.75rem] text-gray-500">
          {summary.queued + summary.running > 0 && <span>{summary.running} running · {summary.queued} queued</span>}
          {summary.failedLastDay > 0 && <Badge tone="red">{summary.failedLastDay} failed today</Badge>}
          <Button size="sm" onClick={() => void load()} icon={<RefreshCw className="w-3 h-3" />}>Refresh</Button>
        </div>
      </div>

      {detections.length > 0 && (
        <div className="mt-2 border border-gray-200 rounded divide-y divide-gray-100 max-h-56 overflow-y-auto">
          {detections.map((d) => (
            <div key={d.id} className="px-3 py-2 flex items-center justify-between gap-3 flex-wrap gap-y-1.5">
              <div className="min-w-0">
                <p className="text-[0.75rem] font-semibold text-gray-900 truncate">
                  {d.areaKm2.toFixed(1)} km² dark area · {d.position.lat.toFixed(3)}, {d.position.lon.toFixed(3)}
                </p>
                <p className="text-[0.6875rem] text-gray-500 truncate" title={d.sceneId}>
                  {fmt.utc(d.acquiredAt)} · {d.sceneId}
                </p>
                <p className="text-[0.6875rem] text-gray-400 truncate">{d.method}</p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {busy === d.id ? (
                  <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                ) : canEdit('Investigation') ? (
                  <>
                    <Button size="sm" variant="primary" onClick={() => void review(d, 'confirmed')} icon={<CheckCircle2 className="w-3 h-3" />}>
                      Confirm
                    </Button>
                    <Button size="sm" onClick={() => void review(d, 'dismissed')} icon={<XCircle className="w-3 h-3" />}>
                      Look-alike
                    </Button>
                  </>
                ) : (
                  <span className="text-[0.6875rem] text-gray-500">Awaiting analyst review</span>
                )}
              </div>
            </div>
          ))}
          <p className="px-3 py-1.5 text-[0.6875rem] text-gray-500 bg-gray-50">
            Dark areas found by the detector. They are candidates, not confirmed spills: low wind, algae films and
            ship wakes look the same to radar.
          </p>
        </div>
      )}
    </div>
  );
}
