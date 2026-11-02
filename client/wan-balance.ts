import { useCallback, useEffect, useRef, useState } from 'react';
import { terminalStatuses, type Connection, type VideoJob, type WanAccountBalance } from '../shared/types';
import { api } from './api';

export interface WanBalanceState {
  data: WanAccountBalance | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

export function useWanBalance(connection: Connection, jobs: VideoJob[], paused: boolean): WanBalanceState {
  const [result, setResult] = useState<{ connection: Connection; data: WanAccountBalance } | null>(null);
  const [failure, setFailure] = useState<{ connection: Connection; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const enabled = connection.provider === 'wan' && connection.connected && !paused;
  const current = useRef({ connection, enabled });
  current.current = { connection, enabled };

  const refresh = useCallback(async () => {
    if (!enabled || current.current.connection !== connection || !current.current.enabled) return;
    const sequence = ++request.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    busy.current = true; setLoading(true); setFailure(null);
    try {
      const data = await api<WanAccountBalance>('/wan/balance', { signal: abort.signal });
      if (sequence === request.current && !abort.signal.aborted) setResult({ connection, data });
    } catch (error) {
      if (sequence === request.current && !abort.signal.aborted) {
        setResult(null); setFailure({ connection, message: error instanceof Error ? error.message : 'Could not fetch your Wan balance. Please try again.' });
      }
    } finally {
      if (sequence === request.current) { busy.current = false; setLoading(false); }
    }
  }, [connection, enabled]);

  useEffect(() => {
    setResult(null); setFailure(null); setLoading(false);
    if (!enabled) return;
    void refresh();
    const update = () => { if (document.visibilityState === 'visible' && !busy.current) void refresh(); };
    const timer = setInterval(update, 60_000);
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update);
      ++request.current; controller.current?.abort(); busy.current = false;
    };
  }, [enabled, refresh]);

  const terminalJobs = jobs.filter(job => job.apiProvider === 'wan' && terminalStatuses.includes(job.status)).map(job => `${job.id}:${job.status}`).sort().join('|');
  const previous = useRef(terminalJobs);
  useEffect(() => {
    if (previous.current !== terminalJobs && enabled) void refresh();
    previous.current = terminalJobs;
  }, [terminalJobs, enabled, refresh]);

  return {
    data: enabled && result?.connection === connection ? result.data : null,
    error: enabled && failure?.connection === connection ? failure.message : '',
    loading: connection.connected && (paused || loading), refresh,
  };
}
