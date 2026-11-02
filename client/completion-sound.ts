import { useEffect, useRef, useState } from 'react';
import { terminalStatuses, type VideoJob } from '../shared/types';

export function useCompletionSound(jobs: VideoJob[]) {
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem('frame.completionSound') !== 'off'; } catch { return true; } });
  const context = useRef<AudioContext | null>(null);
  const previous = useRef(new Map<string, VideoJob['status']>());
  const unlock = () => {
    try {
      context.current ??= new AudioContext();
      if (context.current.state === 'suspended') void context.current.resume().catch(() => {});
    } catch { /* audio is unavailable in this browser */ }
  };
  useEffect(() => {
    try { localStorage.setItem('frame.completionSound', enabled ? 'on' : 'off'); } catch { /* storage unavailable */ }
    if (!enabled) return;
    // Browsers permit audio after a user gesture. Unlock it while the user works.
    window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);
    return () => { window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
  }, [enabled]);
  useEffect(() => () => { void context.current?.close().catch(() => {}); context.current = null; }, []);

  function ding() {
    const audio = context.current;
    if (!enabled || !audio || audio.state !== 'running') return;
    const now = audio.currentTime;
    // A short bell with a soft attack and decaying harmonics; no external audio.
    for (const [frequency, volume, decay] of [[1046.5, 0.2, 0.75], [2093, 0.065, 0.48], [3139.5, 0.025, 0.3]]) {
      const oscillator = audio.createOscillator(); const gain = audio.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + 0.008); gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.start(now); oscillator.stop(now + decay);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  }
  useEffect(() => {
    const completed = jobs.some(job => {
      const status = previous.current.get(job.id);
      return status !== undefined && !terminalStatuses.includes(status) && job.status === 'completed';
    });
    previous.current = new Map(jobs.map(job => [job.id, job.status]));
    if (completed) ding();
  }, [jobs]);
  return { soundEnabled: enabled, toggleSound: () => { if (!enabled) unlock(); setEnabled(value => !value); }, ding };
}
