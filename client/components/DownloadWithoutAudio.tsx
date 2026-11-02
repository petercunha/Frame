import { useState } from 'react';
import { LoaderCircle, VolumeX } from 'lucide-react';
import { api } from '../api';
import './download-without-audio.css';

export default function DownloadWithoutAudio({ jobId, index = 0 }: { jobId: string; index?: number }) {
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    setPreparing(true); setError('');
    try {
      const { url } = await api<{ url: string }>(`/jobs/${jobId}/without-audio`, { method: 'POST', body: JSON.stringify({ index }) });
      // Download from disk without buffering a potentially large clip in browser memory.
      const link = document.createElement('a'); link.href = url; link.download = '';
      document.body.append(link); link.click(); link.remove();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not prepare this download. Please try again.'); }
    finally { setPreparing(false); }
  }
  return <div className="silent-download-control">
    <button type="button" className="secondary-button" disabled={preparing} onClick={() => void download()}>{preparing ? <LoaderCircle className="spin" size={14} /> : <VolumeX size={14} />}{preparing ? 'Preparing download…' : 'Download without audio'}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
