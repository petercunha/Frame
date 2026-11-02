import { useEffect, useRef, useState } from 'react';
import { ArrowRight, AudioLines, Check, Crop, Film, Image, LoaderCircle, LockKeyhole, Maximize2, Pause, Play, RotateCcw, Scissors, Volume2 } from 'lucide-react';
import type { Asset, AssetEdits, CropRegion } from '../../shared/types';
import { preparedDimensions } from '../../shared/types';
import { api } from '../api';
import { formatBytes, formatTime, inputSummary, isPreparing } from '../media';
import Modal from './Modal';
import CropSurface from './CropSurface';
import './asset-editor.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not open this asset. Please try again.';
function initialEdits(asset: Asset): AssetEdits {
  return asset.prepared?.edits ?? {
    ...(asset.kind !== 'audio' ? { maxWidth: 1280, maxHeight: 1280 } : {}),
    ...(asset.kind !== 'image' ? { start: 0, end: asset.metadata?.duration } : {}),
  };
}

export default function AssetEditor({ asset: initialAsset, onUpdate, onClose }: { asset: Asset; onUpdate: (asset: Asset) => void; onClose: () => void }) {
  const [asset, setAsset] = useState(initialAsset);
  const [draft, setDraft] = useState<AssetEdits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'edit' | 'prepared'>('edit');
  const [aspect, setAspect] = useState<string>('free');
  const [currentTime, setCurrentTime] = useState(0);
  const [playingSelection, setPlayingSelection] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const media = useRef<HTMLMediaElement | null>(null);
  const updateCallback = useRef(onUpdate); updateCallback.current = onUpdate;
  const savedId = useRef<string | null>(null);
  const busy = saving || isPreparing(asset);
  const metadata = asset.metadata;
  const sourceDuration = metadata?.duration ?? 0;
  const start = draft?.start ?? 0;
  const end = draft?.end ?? sourceDuration;
  const dimensions = metadata && draft ? preparedDimensions(metadata, draft, asset.kind) : null;
  const changed = !!draft && (!asset.prepared || JSON.stringify(draft) !== JSON.stringify(asset.prepared.edits));

  useEffect(() => {
    let active = true;
    api<{ asset: Asset }>(`/assets/${initialAsset.id}/editor`).then(result => {
      if (!active) return;
      setAsset(result.asset); setDraft(initialEdits(result.asset)); updateCallback.current(result.asset);
    }).catch(error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initialAsset.id]);

  useEffect(() => {
    if (!isPreparing(asset)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<{ asset: Asset }>(`/assets/${asset.id}/editor`);
        if (!active) return;
        setAsset(result.asset); updateCallback.current(result.asset);
        if (!isPreparing(result.asset)) {
          if (result.asset.preparation?.status === 'completed' && result.asset.prepared && savedId.current === result.asset.prepared.id) {
            setDraft(result.asset.prepared.edits); setView('prepared'); setPreviewError(false); savedId.current = null;
          }
          return;
        }
      } catch (error) { if (active) setError(errorText(error)); }
      if (active) timer = setTimeout(refresh, 1200);
    }
    timer = setTimeout(refresh, 500);
    return () => { active = false; clearTimeout(timer); };
  }, [asset.id, asset.preparation?.id, asset.preparation?.status]);

  function update(edits: Partial<AssetEdits>) {
    setDraft(current => ({ ...current, ...edits })); setView('edit'); setError('');
  }
  function chooseAspect(value: string) {
    setAspect(value);
    if (!metadata?.width || !metadata.height) return;
    if (value === 'original') { update({ crop: null }); return; }
    if (value === 'free') return;
    const [a, b] = value.split(':').map(Number);
    const normalizedRatio = (a / b) / (metadata.width / metadata.height);
    const width = normalizedRatio > 1 ? 1 : normalizedRatio;
    const height = normalizedRatio > 1 ? 1 / normalizedRatio : 1;
    update({ crop: { x: (1 - width) / 2, y: (1 - height) / 2, width, height } });
  }
  async function save() {
    if (!draft || busy) return;
    setError(''); setSaving(true); media.current?.pause(); setPlayingSelection(false);
    try {
      const result = await api<{ asset: Asset }>(`/assets/${asset.id}/prepare`, { method: 'POST', body: JSON.stringify(draft) });
      savedId.current = result.asset.preparation?.id ?? null;
      setAsset(result.asset); updateCallback.current(result.asset);
      if (result.asset.preparation?.status === 'completed') { setView('prepared'); setDraft(result.asset.prepared!.edits); }
    } catch (error) { setError(errorText(error)); }
    finally { setSaving(false); }
  }
  async function restoreOriginal() {
    setSaving(true); setError('');
    try {
      const result = await api<{ asset: Asset }>(`/assets/${asset.id}/prepared`, { method: 'DELETE' });
      setAsset(result.asset); updateCallback.current(result.asset); setDraft(initialEdits(result.asset)); setView('edit');
    } catch (error) { setError(errorText(error)); }
    finally { setSaving(false); }
  }
  async function playSelection() {
    if (!media.current) return;
    if (playingSelection && !media.current.paused) { media.current.pause(); setPlayingSelection(false); return; }
    media.current.currentTime = start; setPlayingSelection(true);
    try { await media.current.play(); } catch { setPlayingSelection(false); setError('Your browser cannot play this original. You can still set times and prepare a compatible input.'); }
  }
  const source = view === 'prepared' && asset.prepared ? asset.prepared.url : asset.url;
  const kindIcon = asset.kind === 'image' ? <Image size={17} /> : asset.kind === 'video' ? <Film size={17} /> : <AudioLines size={17} />;
  const timingEvents = {
    onLoadedMetadata: () => { if (media.current) { media.current.currentTime = view === 'edit' ? start : 0; setCurrentTime(media.current.currentTime); } },
    onPause: () => setPlayingSelection(false),
    onTimeUpdate: () => {
      if (!media.current) return;
      setCurrentTime(media.current.currentTime);
      if (view === 'edit' && playingSelection && media.current.currentTime >= end) { media.current.pause(); setPlayingSelection(false); }
    },
    onError: () => setPreviewError(true),
  };
  const renderMedia = () => asset.kind === 'image'
    ? <img key={source} src={source} alt={asset.name} onError={() => setPreviewError(true)} />
    : <video key={source} ref={element => { media.current = element; }} src={source} controls={view === 'prepared'} playsInline preload="metadata" muted={!!draft?.mute} {...timingEvents} />;

  return <Modal title="Edit reference" onClose={onClose} wide className="asset-editor-modal">
    <div className="editor-file-header"><span className="editor-file-icon">{kindIcon}</span><div><strong title={asset.name}>{asset.name}</strong><span>{asset.kind.toUpperCase()} · {metadata?.width ? `${metadata.width} × ${metadata.height} · ` : ''}{sourceDuration ? `${formatTime(sourceDuration)} · ` : ''}{formatBytes(asset.size)}</span></div><span className="original-preserved"><LockKeyhole size={12} /> Original preserved</span></div>
    {loading ? <div className="editor-loading"><LoaderCircle size={25} className="spin" /><p>Opening your original…</p></div> : !draft ? <div className="editor-loading"><p className="form-error">{error}</p><button className="secondary-button" onClick={onClose}>Back to library</button></div> : <>
      <div className="editor-body">
        <div className="editor-workspace">
          <div className="editor-preview-tabs"><button className={view === 'edit' ? 'active' : ''} onClick={() => { setView('edit'); setPreviewError(false); setPlayingSelection(false); }}>Edit original</button><button disabled={!asset.prepared} className={view === 'prepared' ? 'active' : ''} onClick={() => { setView('prepared'); setPreviewError(false); setPlayingSelection(false); }}><Check size={12} /> Prepared input</button><span>{view === 'prepared' ? 'WHAT THE MODEL WILL RECEIVE' : asset.kind === 'audio' ? 'FIND THE MOMENT' : 'DRAG THE CORNERS TO CROP'}</span></div>
          <div className={`editor-preview-stage ${asset.kind === 'audio' ? 'editor-audio-stage' : ''}`}>
            {asset.kind === 'audio' ? <div className="audio-editor-preview"><div className="audio-art"><AudioLines size={65} strokeWidth={1} /><span /><span /></div><h3>A little sound. Just the right moment.</h3><p>{view === 'prepared' && asset.prepared?.metadata.duration ? `${formatTime(asset.prepared.metadata.duration)} prepared for your scene` : 'Choose the section that belongs in your scene.'}</p><audio key={source} ref={element => { media.current = element; }} src={source} controls preload="metadata" {...timingEvents} /></div>
              : view === 'edit' && metadata?.width && metadata.height ? <CropSurface width={metadata.width} height={metadata.height} crop={draft.crop} aspect={aspect.includes(':') ? Number(aspect.split(':')[0]) / Number(aspect.split(':')[1]) : null} disabled={busy} onChange={(crop: CropRegion) => update({ crop })}>{renderMedia()}</CropSurface>
              : renderMedia()}
            {previewError && <p className="editor-media-error">This browser cannot preview the original format. Set your selection and save to prepare a compatible input.</p>}
          </div>
          {asset.kind !== 'image' && view === 'edit' && <div className="source-playback"><button className="secondary-button" onClick={() => void playSelection()} disabled={busy}>{playingSelection ? <Pause size={12} /> : <Play size={12} />}{playingSelection ? 'Pause selection' : 'Play selection'}</button><span>{formatTime(currentTime)} <span>/ {formatTime(sourceDuration)}</span></span><input aria-label="Preview position" type="range" min="0" max={sourceDuration || 1} step="0.01" value={Math.min(currentTime, sourceDuration)} onChange={event => { if (media.current) { media.current.currentTime = Number(event.target.value); setCurrentTime(Number(event.target.value)); } }} /></div>}
          {asset.kind !== 'image' && <section className="editor-trim-section"><div className="editor-section-heading"><Scissors size={14} /><h3>Keep the part that matters</h3><button type="button" onClick={() => { const from = Math.min(view === 'prepared' ? start + currentTime : currentTime, Math.max(0, sourceDuration - 0.05)); update({ start: from, end: Math.min(from + 5, sourceDuration) }); }} disabled={busy} title="Use five seconds from the playhead">Use 5s here</button></div><div className="trim-timeline"><div className="trim-track" /><div className="trim-selection" style={{ left: `${sourceDuration ? start / sourceDuration * 100 : 0}%`, width: `${sourceDuration ? (end - start) / sourceDuration * 100 : 100}%` }} /><input disabled={busy} className="trim-range" aria-label="Trim start" type="range" min="0" max={sourceDuration} step="0.01" value={start} onChange={event => update({ start: Math.min(Number(event.target.value), end - 0.05) })} /><input disabled={busy} className="trim-range" aria-label="Trim end" type="range" min="0" max={sourceDuration} step="0.01" value={end} onChange={event => update({ end: Math.max(Number(event.target.value), start + 0.05) })} /></div><div className="timeline-labels"><span>00:00.0</span><span>{formatTime(sourceDuration)}</span></div><fieldset className="trim-time-fields" disabled={busy}><label>Start <span className="time-input"><input aria-label="Start time in seconds" type="number" min="0" max={Math.max(0, end - 0.05)} step="0.01" value={Number(start.toFixed(3))} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) update({ start: Math.max(0, Math.min(event.target.valueAsNumber, end - 0.05)) }); }} /><span>sec</span></span></label><ArrowRight size={14} /><label>End <span className="time-input"><input aria-label="End time in seconds" type="number" min={start + 0.05} max={sourceDuration} step="0.01" value={Number(end.toFixed(3))} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) update({ end: Math.min(sourceDuration, Math.max(event.target.valueAsNumber, start + 0.05)) }); }} /><span>sec</span></span></label><div className="trim-duration"><strong>{Number((end - start).toFixed(2))}s</strong><span>selected</span></div></fieldset></section>}
          <div className="editor-original-note"><LockKeyhole size={13} /><p>Edits are saved to a separate input. Your full-quality original stays in the library.</p></div>
        </div>
        <aside className="editor-controls"><fieldset disabled={busy}>
          {asset.kind !== 'audio' && <><section><div className="editor-section-heading"><Crop size={15} /><h3>Shape your frame</h3></div><p className="editor-help">Choose a ratio, then drag to frame the part you want.</p><div className="crop-preset-buttons">{['original', 'free', '1:1', '16:9', '9:16', '4:3'].map(value => <button key={value} type="button" className={aspect === value ? 'selected' : ''} onClick={() => chooseAspect(value)}>{value === 'original' ? 'Full frame' : value === 'free' ? 'Free crop' : value}</button>)}</div><details className="crop-fine-tune"><summary>Fine-tune crop</summary><div className="crop-numbers">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{({ x: 'Left', y: 'Top', width: 'Width', height: 'Height' })[key]} %<input aria-label={`Crop ${key} percent`} type="number" min={key === 'width' || key === 'height' ? 1 : 0} max="100" step="0.1" value={Number(((draft.crop ?? { x: 0, y: 0, width: 1, height: 1 })[key] * 100).toFixed(1))} onChange={event => {
            if (!Number.isFinite(event.target.valueAsNumber)) return;
            const crop = { ...(draft.crop ?? { x: 0, y: 0, width: 1, height: 1 }), [key]: Math.max(key === 'width' || key === 'height' ? 0.01 : 0, Math.min(1, event.target.valueAsNumber / 100)) };
            crop.x = Math.min(crop.x, 1 - crop.width); crop.y = Math.min(crop.y, 1 - crop.height); setAspect('free'); update({ crop });
          }} /></label>)}</div></details></section>
          <section><div className="editor-section-heading"><Maximize2 size={15} /><h3>Input size</h3></div><p className="editor-help">Set a maximum. We keep the proportions and never upscale.</p><div className="size-preset-buttons">{[720, 1280, 1920].map(value => <button key={value} type="button" className={draft.maxWidth === value && draft.maxHeight === value ? 'selected' : ''} onClick={() => update({ maxWidth: value, maxHeight: value })}>{value}px</button>)}<button type="button" className={!draft.maxWidth && !draft.maxHeight ? 'selected' : ''} onClick={() => update({ maxWidth: undefined, maxHeight: undefined })}>Original</button></div><div className="max-size-fields"><label>Max width<input aria-label="Maximum width" type="number" min="16" max="16384" placeholder="Original" value={draft.maxWidth ?? ''} onChange={event => update({ maxWidth: event.target.value === '' ? undefined : event.target.valueAsNumber })} /></label><span>×</span><label>Max height<input aria-label="Maximum height" type="number" min="16" max="16384" placeholder="Original" value={draft.maxHeight ?? ''} onChange={event => update({ maxHeight: event.target.value === '' ? undefined : event.target.valueAsNumber })} /></label></div></section></>}
          {asset.kind === 'video' && metadata?.hasAudio && <section className="editor-audio-control"><span><Volume2 size={16} /> Keep original audio</span><button role="switch" aria-label="Keep original audio" aria-checked={!draft.mute} className={`toggle ${!draft.mute ? 'on' : ''}`} onClick={() => update({ mute: !draft.mute })}><span /></button></section>}
          <section className="prepared-summary"><div className="editor-section-heading"><Check size={15} /><h3>Your model input</h3></div><div className="summary-line"><span>Format</span><strong>{asset.kind === 'image' ? 'PNG' : asset.kind === 'video' ? 'MP4' : 'WAV'}</strong></div>{dimensions && <div className="summary-line"><span>Dimensions</span><strong>{dimensions.width} × {dimensions.height}</strong></div>}{asset.kind !== 'image' && <div className="summary-line"><span>Duration</span><strong>{Number((end - start).toFixed(2))} seconds</strong></div>}{asset.kind === 'video' && <div className="summary-line"><span>Audio</span><strong>{metadata?.hasAudio && !draft.mute ? 'Included' : 'No audio'}</strong></div>}{asset.prepared && !changed && <div className="summary-line"><span>File size</span><strong>{formatBytes(asset.prepared.size)}</strong></div>}<p>Only the prepared input is sent when you generate. Up to 25 MB per asset.</p></section>
          {metadata?.animated && <p className="editor-help">For animated images, the prepared input uses the first frame. The animated original is preserved.</p>}
        </fieldset></aside>
      </div>
      {(error || asset.preparation?.status === 'failed') && <div className="editor-error form-error" role="alert">{error || asset.preparation?.error}</div>}
      {busy && <div className="preparation-progress" role="status"><div><LoaderCircle className="spin" size={14} /><strong>{asset.preparation?.status === 'queued' ? 'Waiting to prepare…' : 'Preparing your input…'}</strong><span>{Math.round((asset.preparation?.progress ?? 0) * 100)}%</span></div><progress max="1" value={asset.preparation?.progress ?? 0} /><p>You can close the editor. Preparation continues in your workspace.</p></div>}
      <footer className="editor-footer"><div><button className="text-button" disabled={busy} onClick={() => { setAspect('free'); update({ crop: null, maxWidth: undefined, maxHeight: undefined, start: asset.kind !== 'image' ? 0 : undefined, end: asset.kind !== 'image' ? sourceDuration : undefined, mute: false }); }}><RotateCcw size={13} /> Reset edits</button>{asset.prepared && <button className="text-button" disabled={busy} onClick={() => void restoreOriginal()}>Use original input</button>}</div><div><button className="secondary-button" onClick={onClose}>{busy ? 'Close' : 'Done'}</button><button className="primary-button" disabled={busy || !changed} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={15} /> : !changed ? <Check size={15} /> : <Check size={15} />}{busy ? 'Preparing…' : !changed ? 'Input saved' : 'Save input'}</button></div></footer>
      {asset.prepared && !busy && <div className="editor-saved-caption"><Check size={11} /> Prepared input: {inputSummary(asset)}{changed ? ' · Unsaved changes' : ' · Ready for generation'}</div>}
    </>}
  </Modal>;
}
