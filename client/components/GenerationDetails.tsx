import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { providerNames, type VideoJob } from '../../shared/types';
import { inputSummary } from '../media';
import Modal from './Modal';
import './generation-details.css';

export const formatPrice = (cost: number) => `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
export function generationTime(milliseconds: number | undefined) {
  if (milliseconds === undefined) return 'Not recorded';
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function StorageStatus({ job, onRetry }: { job: VideoJob; onRetry?: () => void }) {
  if (job.status !== 'completed') return null;
  return <span className={`storage-status storage-${job.storage?.status ?? 'pending'}`}>
    {job.storage?.status === 'saved' ? 'Saved on this computer' : job.storage?.status === 'failed' ? 'Local save needs attention' : 'Saving video on this computer…'}
    {job.storage?.status === 'failed' && onRetry && <button className="text-button" onClick={onRetry}>Retry save</button>}
  </span>;
}
export function GenerationFacts({ job }: { job: VideoJob }) {
  return <dl className="generation-facts">
    <div><dt>Price</dt><dd>{job.cost !== undefined ? `${formatPrice(job.cost)} USD` : 'Not reported'}</dd></div>
    <div><dt>Generation time</dt><dd>{generationTime(job.generationTimeMs)}</dd></div>
    <div><dt>Aspect ratio</dt><dd>{job.input.aspect_ratio || 'Automatic'}</dd></div>
    <div><dt>References</dt><dd>{job.input.assets.length}</dd></div>
  </dl>;
}
export default function GenerationDetails({ job, onClose, onReuse, onRetry }: { job: VideoJob; onClose: () => void; onReuse: () => void; onRetry: () => void }) {
  const date = (value?: string) => value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
  return <Modal title="Generation details" onClose={onClose} wide className="generation-details">
    <p className="modal-description">{job.modelName || job.input.model} · {providerNames[job.apiProvider ?? 'openrouter']}</p>
    <GenerationFacts job={job} />
    <dl className="generation-facts">
      <div><dt>Video duration</dt><dd>{job.input.duration ? `${job.input.duration} seconds` : 'Automatic'}</dd></div>
      <div><dt>Resolution</dt><dd>{job.input.resolution || job.input.size || 'Automatic'}</dd></div>
      <div><dt>Submitted</dt><dd>{date(job.createdAt)}</dd></div>
      <div><dt>Finished</dt><dd>{date(job.finishedAt)}</dd></div>
      {job.estimatedCost !== undefined && <div><dt>Original estimate</dt><dd>{formatPrice(job.estimatedCost)} USD</dd></div>}
      {job.input.generate_audio !== undefined && <div><dt>Generate audio</dt><dd>{job.input.generate_audio ? 'On' : 'Off'}</dd></div>}
      {job.input.seed !== undefined && <div><dt>Seed</dt><dd>{job.input.seed}</dd></div>}
      {job.input.upscale_factor !== undefined && <div><dt>Upscale factor</dt><dd>{job.input.upscale_factor}×</dd></div>}
      {job.input.creativity !== undefined && <div><dt>Creativity</dt><dd>{job.input.creativity}</dd></div>}
    </dl>
    <p className="hint">Generation time includes queueing and is measured when Frame observes the result.</p>
    <h3>Prompt</h3><p className="generation-full-prompt">{job.input.prompt || 'Media-guided generation'}</p>
    {!!job.input.assets.length && <><h3>Reference materials</h3><div className="generation-references">{job.input.assets.map(selection => {
      const reference = job.references?.find(reference => reference.id === selection.id && reference.role === selection.role);
      return <div key={selection.id}>{reference?.snapshot.kind === 'image' && <img src={reference.snapshot.prepared?.url ?? reference.snapshot.url} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} />}<span><strong>{reference?.snapshot.name ?? 'Reference asset'}</strong><small>{selection.role.replaceAll('_', ' ')}{reference ? ` · ${inputSummary(reference.snapshot)}` : ''}</small></span></div>;
    })}</div><p className="hint">Reuse restores the original input versions that are still available in your library.</p></>}
    {job.input.provider && <details className="generation-extra"><summary>Provider options</summary><pre>{JSON.stringify(job.input.provider, null, 2)}</pre></details>}
    <StorageStatus job={job} onRetry={onRetry} />
    {job.storage?.error && <p className="hint">{job.storage.error}</p>}
    <div className="generation-detail-actions"><button className="secondary-button" onClick={onReuse}><RefreshCw size={14} /> Reuse prompt</button>{job.status === 'completed' && <a className="primary-button" href={`/api/jobs/${job.id}/content?download=1`} download><ArrowDownToLine size={14} /> Download video</a>}</div>
  </Modal>;
}
