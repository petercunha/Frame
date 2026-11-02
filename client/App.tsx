import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, ChevronRight, Clapperboard, Clock3, ExternalLink, Film, FolderOpen, Grid2X2, ImagePlus, Images, KeyRound, Layers3, LoaderCircle, Menu, Monitor, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Upload, WandSparkles, X } from 'lucide-react';
import type { Asset, AssetRole, Connection, GenerationInput, VideoJob, VideoModel } from '../shared/types';
import { estimateCost, terminalStatuses } from '../shared/types';
import Modal from './components/Modal';
import { api } from './api';

type View = 'studio' | 'library' | 'assets' | 'inspiration';
type Selection = GenerationInput['assets'][number];
const inspiration = [
  { title: 'Chase the golden hour', category: 'CINEMATIC', image: 'https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=800&q=85', prompt: 'A cinematic aerial shot over rolling green hills at golden hour. Warm sunlight filters through a soft morning haze, casting long shadows across the landscape. Slow, smooth camera movement, natural film grain, rich earth tones.' },
  { title: 'Find a different perspective', category: 'NATURE', image: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=800&q=85', prompt: 'An overhead drone shot of turquoise ocean waves meeting a pristine shore. White sea foam creates delicate patterns across the deep blue water. The camera slowly rises, revealing the vast, peaceful coastline. Photorealistic, soft afternoon light.' },
  { title: 'Make the everyday cinematic', category: 'LIFESTYLE', image: 'https://images.unsplash.com/photo-1442512595331-e89e73853f31?auto=format&fit=crop&w=800&q=85', prompt: 'An intimate close-up of a ceramic coffee cup on a sunlit wooden table. Wisps of steam curl upward in slow motion as morning light pours through a nearby window. Shallow depth of field, warm neutral colors, subtle camera push-in, 35mm film aesthetic.' },
];
const labels: Record<VideoJob['status'], string> = { pending: 'In queue', in_progress: 'Generating', completed: 'Ready', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired' };
const formatBytes = (size: number) => size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const money = (cost: number) => `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
const modelName = (model: VideoModel | undefined) => model?.name.split(': ').slice(-1)[0] || 'Choose a model';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export default function App() {
  const [view, setView] = useState<View>('studio');
  const [mobileNav, setMobileNav] = useState(false);
  const [models, setModels] = useState<VideoModel[]>([]);
  const [modelsError, setModelsError] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [jobs, setJobs] = useState<VideoJob[]>([]);
  const [connection, setConnection] = useState<Connection>({ connected: false, source: null });
  const [connectionLoaded, setConnectionLoaded] = useState(false);
  const [modelId, setModelId] = useState('alibaba/wan-3.0');
  const [prompt, setPrompt] = useState(() => { try { return localStorage.getItem('frame.prompt') || ''; } catch { return ''; } });
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState('720p');
  const [ratio, setRatio] = useState('16:9');
  const [size, setSize] = useState('');
  const [audio, setAudio] = useState(true);
  const [seed, setSeed] = useState('');
  const [upscale, setUpscale] = useState('');
  const [creativity, setCreativity] = useState('');
  const [provider, setProvider] = useState('');
  const [selections, setSelections] = useState<Selection[]>([]);
  const [mode, setMode] = useState<'text' | 'image' | 'reference'>('text');
  const [advanced, setAdvanced] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [previewTab, setPreviewTab] = useState<'preview' | 'history'>('preview');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [formError, setFormError] = useState('');
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState<'settings' | 'models' | 'assets' | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const uploadRole = useRef<AssetRole>('reference');
  const model = models.find(m => m.id === modelId);
  const activeJob = jobs.find(j => j.id === activeJobId);
  const activeCount = jobs.filter(j => !terminalStatuses.includes(j.status)).length;
  const completedCount = jobs.filter(j => j.status === 'completed').length;
  const selectedAssets = selections.map(s => ({ ...s, asset: assets.find(a => a.id === s.id) })).filter(s => s.asset !== undefined);
  const cost = estimateCost(model, model?.supported_durations?.length ? duration : undefined, resolution, audio);

  async function loadModels() {
    setModelsError('');
    try {
      const result = await api<{ models: VideoModel[] }>('/models');
      setModels(result.models.sort((a, b) => (a.id === 'alibaba/wan-3.0' ? -1 : b.id === 'alibaba/wan-3.0' ? 1 : a.name.localeCompare(b.name))));
      setModelId(current => result.models.some(m => m.id === current) ? current : result.models[0]?.id || '');
    } catch (error) { setModelsError(errorText(error)); }
  }
  useEffect(() => {
    void loadModels();
    void api<Connection>('/connection').then(setConnection).catch(e => setToast(errorText(e))).finally(() => setConnectionLoaded(true));
    void api<{ assets: Asset[] }>('/assets').then(r => setAssets(r.assets)).catch(e => setToast(errorText(e)));
    void api<{ jobs: VideoJob[] }>('/jobs').then(r => { setJobs(r.jobs); setActiveJobId(r.jobs[0]?.id ?? null); }).catch(e => setToast(errorText(e)));
  }, []);
  useEffect(() => { try { localStorage.setItem('frame.prompt', prompt); } catch { /* draft storage unavailable */ } }, [prompt]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 5500); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => {
    if (!activeCount) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { const result = await api<{ jobs: VideoJob[] }>('/jobs'); if (!stopped) setJobs(result.jobs); }
      catch (error) { if (!stopped) setToast(errorText(error)); }
      if (!stopped) timer = setTimeout(poll, 5000);
    }
    timer = setTimeout(poll, 3000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeCount]);
  useEffect(() => { setClipIndex(0); }, [activeJobId]);
  useEffect(() => {
    if (!model) return;
    setDuration(current => model.supported_durations?.includes(current) ? current : model.supported_durations?.[0] ?? 5);
    setResolution(current => model.supported_resolutions?.includes(current) ? current : model.supported_resolutions?.[0] ?? '');
    setRatio(current => model.supported_aspect_ratios?.includes(current) ? current : model.supported_aspect_ratios?.[0] ?? '');
    setSize(''); setSeed(''); setProvider(''); setUpscale(''); setCreativity('');
    setSelections(current => current.filter(s => s.role === 'reference' || model.supported_frame_images?.includes(s.role)));
    if (!model.supported_frame_images?.length) setMode(current => current === 'image' ? 'reference' : current);
  }, [modelId, model]);

  function navigate(next: View) { setView(next); setMobileNav(false); }
  function changeMode(next: typeof mode) {
    setMode(next); setSelections([]); setFormError('');
  }
  function attach(asset: Asset, role: AssetRole = 'reference') {
    setSelections(current => {
      const filtered = current.filter(s => s.id !== asset.id && (role === 'reference' ? s.role === 'reference' : s.role !== 'reference' && s.role !== role));
      return [...filtered, { id: asset.id, role }].slice(0, 12);
    });
    setMode(role === 'reference' ? 'reference' : 'image');
  }
  async function uploadFiles(files: File[], role: AssetRole = 'reference') {
    if (!files.length || uploading) return;
    if (files.length > 12 || files.some(f => f.size > 25 * 1024 * 1024)) { setToast('Choose up to 12 files, each 25 MB or smaller.'); return; }
    if (role !== 'reference' && (files.length > 1 || !files[0].type.startsWith('image/'))) { setToast('Choose one image for a frame.'); return; }
    setUploading(true); setFormError('');
    const data = new FormData(); files.forEach(file => data.append('files', file));
    try {
      const result = await api<{ assets: Asset[] }>('/assets', { method: 'POST', body: data });
      setAssets(current => [...result.assets, ...current]);
      if (view === 'studio') result.assets.forEach(asset => attach(asset, role));
      setToast(`${result.assets.length === 1 ? 'Asset' : `${result.assets.length} assets`} added to your workspace.`);
    } catch (error) { setFormError(errorText(error)); setToast(errorText(error)); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  function chooseFile(role: AssetRole = 'reference') { uploadRole.current = role; if (fileRef.current) { fileRef.current.accept = role === 'reference' ? 'image/*,video/*,audio/*' : 'image/*'; fileRef.current.multiple = role === 'reference'; fileRef.current.click(); } }
  async function removeAsset(id: string) {
    try { await api(`/assets/${id}`, { method: 'DELETE' }); setAssets(current => current.filter(a => a.id !== id)); setSelections(current => current.filter(a => a.id !== id)); setToast('Asset removed.'); }
    catch (error) { setToast(errorText(error)); }
  }
  async function removeJob(id: string) {
    try { await api(`/jobs/${id}`, { method: 'DELETE' }); setJobs(current => current.filter(j => j.id !== id)); if (activeJobId === id) setActiveJobId(null); setToast('Generation removed from your library.'); }
    catch (error) { setToast(errorText(error)); }
  }
  async function generate() {
    if (!connection.connected) { setModal('settings'); return; }
    if (!model) return;
    setFormError('');
    if (!prompt.trim() && !selections.some(s => s.role !== 'reference')) { setFormError('Describe your video, or add a first or last frame image.'); promptRef.current?.focus(); return; }
    let providerOptions: GenerationInput['provider'];
    if (provider.trim()) {
      try { providerOptions = JSON.parse(provider); if (!providerOptions?.options || Array.isArray(providerOptions.options)) throw new Error(); }
      catch { setFormError('Provider settings must be valid JSON with an "options" object.'); return; }
    }
    if (seed && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 2147483647)) { setFormError('Seed must be an integer from 0 to 2147483647.'); return; }
    const input: GenerationInput = {
      model: modelId, prompt, assets: selections,
      ...(model.supported_durations?.length ? { duration } : {}),
      ...(size ? { size } : { ...(model.supported_resolutions?.length ? { resolution } : {}), ...(model.supported_aspect_ratios?.length ? { aspect_ratio: ratio } : {}) }),
      ...(model.generate_audio === true ? { generate_audio: audio } : {}),
      ...(model.seed === true && seed ? { seed: Number(seed) } : {}),
      ...(model.upscale_factor && upscale ? { upscale_factor: Number(upscale) } : {}),
      ...(model.creativity?.length && creativity !== '' ? { creativity: Number(creativity) } : {}),
      ...(providerOptions ? { provider: providerOptions } : {}),
    };
    setSubmitting(true);
    try {
      const result = await api<{ job: VideoJob }>('/jobs', { method: 'POST', body: JSON.stringify(input) });
      setJobs(current => [result.job, ...current]); setActiveJobId(result.job.id); setPreviewTab('preview'); setToast('Your generation is in the queue. You can keep creating.');
    } catch (error) { setFormError(errorText(error)); }
    finally { setSubmitting(false); }
  }
  async function connect() {
    setConnecting(true); setConnectionError('');
    try { setConnection(await api<Connection>('/connection', { method: 'POST', body: JSON.stringify({ key: apiKey }) })); setApiKey(''); setModal(null); setToast('OpenRouter connected. Your studio is ready.'); }
    catch (error) { setConnectionError(errorText(error)); }
    finally { setConnecting(false); }
  }
  function reuse(job: VideoJob) {
    setModelId(job.input.model); setPrompt(job.input.prompt); setDuration(job.input.duration ?? 5); setResolution(job.input.resolution ?? ''); setRatio(job.input.aspect_ratio ?? '');
    // Model controls reset on model change; missing/deleted references are not silently reused.
    setSelections([]); setMode('text'); setView('studio'); setToast('Prompt and output settings copied. Reattach any references before generating.');
  }
  function useInspiration(index: number) { setPrompt(inspiration[index].prompt); navigate('studio'); setTimeout(() => promptRef.current?.focus(), 0); }
  function onDrop(event: DragEvent) { event.preventDefault(); setDragging(false); void uploadFiles(Array.from(event.dataTransfer.files)); }

  const assetThumb = (asset: Asset, large = false) => asset.kind === 'image' ? <img src={asset.url} alt={asset.name} loading="lazy" /> : asset.kind === 'video' ? <Film size={large ? 36 : 20} /> : <AudioLines size={large ? 36 : 20} />;
  const renderJob = (job: VideoJob, compact = false) => <article key={job.id} className={`job-card ${compact ? 'job-compact' : ''}`}>
    <button className="job-visual" onClick={() => { setActiveJobId(job.id); navigate('studio'); setPreviewTab('preview'); }} aria-label={`View ${job.title}`}>
      {job.status === 'completed' ? <><video src={`/api/jobs/${job.id}/content#t=0.1`} preload="metadata" muted playsInline /><span className="play-dot"><Film size={20} /></span></> : <div className={`job-placeholder ${job.status}`}>
        {!terminalStatuses.includes(job.status) ? <LoaderCircle className="spin" size={25} /> : <Film size={25} />}<span>{labels[job.status]}</span>
      </div>}
      <span className={`status-badge status-${job.status}`}>{labels[job.status]}</span>
    </button>
    <div className="job-copy"><h3 title={job.title}>{job.title}</h3><p>{models.find(m => m.id === job.input.model)?.name.split(': ').at(-1) || job.input.model.split('/')[1]} <span>·</span> {job.input.duration ? `${job.input.duration}s` : 'Auto'} <span>·</span> {job.input.resolution || job.input.size || 'Auto'}</p>
      <div className="job-actions"><button className="text-button" onClick={() => reuse(job)}><RefreshCw size={13} /> Reuse prompt</button>
        {terminalStatuses.includes(job.status) && <button className="icon-button small" aria-label={`Remove ${job.title}`} onClick={() => void removeJob(job.id)}><Trash2 size={14} /></button>}
      </div>
    </div>
  </article>;

  return <div className="app-shell">
    {mobileNav && <div className="nav-scrim" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
      <a href="#" className="brand" onClick={e => { e.preventDefault(); navigate('studio'); }} aria-label="Frame home"><span className="brand-mark"><span /><span /><span /></span><span>frame<span className="brand-period">.</span></span></a>
      <div className="workspace-picker"><span className="workspace-avatar">S</span><div><strong>My workspace</strong><span>Personal studio</span></div><Layers3 size={15} /></div>
      <button className="new-video" onClick={() => { navigate('studio'); setPrompt(''); setSelections([]); setActiveJobId(null); setFormError(''); setMode('text'); }}><Plus size={17} /> New video <span>↗</span></button>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">
        <button className={view === 'studio' ? 'active' : ''} onClick={() => navigate('studio')}><Clapperboard size={18} /> Video studio <span className="nav-dot" /></button>
        <button className={view === 'library' ? 'active' : ''} onClick={() => navigate('library')}><Grid2X2 size={18} /> My creations <span className="nav-count">{jobs.length}</span></button>
        <button className={view === 'assets' ? 'active' : ''} onClick={() => navigate('assets')}><FolderOpen size={18} /> Asset library <span className="nav-count">{assets.length}</span></button>
        <div className="nav-divider" />
        <button className={view === 'inspiration' ? 'active' : ''} onClick={() => navigate('inspiration')}><Sparkles size={18} /> Inspiration <span className="new-badge">NEW</span></button>
      </nav>
      <div className="sidebar-bottom">
        <div className="workspace-note"><div className="note-icon"><Film size={19} /></div><h3>A space for your ideas.</h3><p>{completedCount ? `${completedCount} video${completedCount === 1 ? '' : 's'} created. Keep the ideas rolling.` : 'From a spark of inspiration to your next great scene.'}</p><div className="note-rule" /><span><span className="green-dot" /> Powered by OpenRouter <ExternalLink size={11} /></span></div>
        <button className="sidebar-settings" onClick={() => setModal('settings')}><Settings2 size={17} /> Connection settings <ChevronRight size={14} /></button>
        <div className="profile"><span className="profile-avatar">Y</span><div><strong>Your studio</strong><span>Made for creating</span></div><span className="version">v1.0</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{{ studio: 'Video studio', library: 'My creations', assets: 'Asset library', inspiration: 'Inspiration' }[view]}</strong></div>
        <div className="topbar-actions"><a href="https://openrouter.ai/docs/guides/overview/multimodal/video-generation" target="_blank" rel="noreferrer" className="docs-link">How it works <ExternalLink size={12} /></a><span className="topbar-divider" /><button className={`connection-button ${connection.connected ? 'connected' : ''}`} onClick={() => setModal('settings')}><span className={connection.connected ? 'green-dot' : 'amber-dot'} />{!connectionLoaded ? 'Connecting…' : connection.connected ? 'OpenRouter connected' : 'Connect OpenRouter'}<ChevronDown size={13} /></button></div>
      </header>
      <main>
        <div className="page-heading"><div><div className="eyebrow"><span /> YOUR CREATIVE WORKSPACE</div><h1>{{ studio: 'Big ideas. Moving pictures.', library: 'Your ideas, brought to life.', assets: 'Every great scene starts somewhere.', inspiration: 'A little spark goes a long way.' }[view]}</h1><p>{{ studio: 'Turn a thought, an image, or a little inspiration into your next video.', library: 'All your generations, in one place. Pick up where inspiration left off.', assets: 'Keep your images, footage, and sound close to the creative process.', inspiration: 'Find a starting point. Make it something only you could imagine.' }[view]}</p></div>{view !== 'studio' && <button className="primary-button" onClick={() => view === 'assets' ? chooseFile() : navigate('studio')}><Plus size={16} />{view === 'assets' ? 'Upload assets' : 'Create a video'}</button>}</div>

        {view === 'studio' && <>
          <div className="studio-grid">
            <section className="composer card" aria-label="Video generation settings">
              <div className="card-topline"><div className="section-title"><WandSparkles size={18} /><h2>Create a video</h2></div><span className="subtle-label">LET’S MAKE SOMETHING</span></div>
              <div className="mode-tabs" aria-label="Generation mode">{(['text', 'image', 'reference'] as const).map(item => <button key={item} className={mode === item ? 'selected' : ''} onClick={() => changeMode(item)}>{item === 'text' ? <Film size={14} /> : item === 'image' ? <ImagePlus size={14} /> : <Images size={14} />}{item === 'text' ? 'Text to video' : item === 'image' ? 'Image to video' : 'References'}</button>)}</div>
              <div className="field-label"><label htmlFor="prompt">Your prompt</label><span>The more detail, the more possibility.</span></div>
              <div className="prompt-box"><textarea ref={promptRef} id="prompt" placeholder={'Imagine a scene. A place, a feeling, a story…\n\nDescribe what you want to see, how it moves, and what makes it yours.'} maxLength={10000} value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!submitting && !uploading) void generate(); } }} /><div className="prompt-footer"><span><Sparkles size={12} /> A little detail makes a big difference</span><span>{prompt.length.toLocaleString()} / 10,000</span></div></div>
              <div className="field-label assets-label"><span>{mode === 'image' ? 'Frame images' : 'Reference assets'} <span className="optional">Optional</span></span><button className="text-button" onClick={() => setModal('assets')}>From library <ChevronRight size={12} /></button></div>
              {mode === 'image' ? <div className="frame-slots">{(['first_frame', 'last_frame'] as const).filter(role => model?.supported_frame_images?.includes(role)).map(role => {
                const asset = selectedAssets.find(a => a.role === role)?.asset;
                return <div className="frame-slot" key={role}>{asset ? <><img src={asset.url} alt={role.replace('_', ' ')} /><button className="remove-selection" aria-label={`Remove ${role}`} onClick={() => setSelections(current => current.filter(s => s.role !== role))}><X size={12} /></button></> : <button onClick={() => chooseFile(role)} disabled={uploading}><ImagePlus size={20} /><span>{role === 'first_frame' ? 'First frame' : 'Last frame'}</span><small>Upload an image</small></button>}</div>;
              })}{!model?.supported_frame_images?.length && <p className="hint">This model does not expose frame control. Choose another model or use reference assets.</p>}</div> : <>
                <button className={`upload-zone ${dragging ? 'dragging' : ''}`} disabled={uploading} onClick={() => chooseFile()} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
                  <span className="upload-icon">{uploading ? <LoaderCircle className="spin" size={19} /> : <Upload size={19} />}</span><span><strong>{uploading ? 'Adding your assets…' : 'Drop assets here, or browse'}<span className="upload-plus"> +</span></strong><small>Images, video, or audio <span>·</span> Up to 25 MB each</small></span>
                </button>
                {selectedAssets.length > 0 && <div className="attached-assets">{selectedAssets.map(({ asset }) => asset && <div className="attached-asset" key={asset.id}><span className="asset-thumb">{assetThumb(asset)}</span><span title={asset.name}>{asset.name}</span><button className="icon-button small" aria-label={`Detach ${asset.name}`} onClick={() => setSelections(current => current.filter(s => s.id !== asset.id))}><X size={12} /></button></div>)}</div>}
              </>}
              {selectedAssets.some(s => s.asset?.kind !== 'image') && <div className="info-note">Video and audio guidance requires a supporting provider, such as BytePlus with Seedance 2+. Other providers may ignore these assets.</div>}
              <div className="composer-divider" />
              <div className="field-label"><label>Generation model</label><span className="live-label"><span className="green-dot" /> OpenRouter</span></div>
              <button className="model-select" onClick={() => { setModelSearch(''); setModal('models'); }}><span className="model-logo">{modelId.startsWith('alibaba/') ? 'wan' : <Layers3 size={20} />}</span><span className="model-detail"><strong>{modelName(model)}{modelId === 'alibaba/wan-3.0' && <span className="recommended-badge">RECOMMENDED</span>}</strong><small>{model?.id.split('/')[0] || 'Loading models…'} <span>·</span> {model?.supported_resolutions?.at(-1) || 'Flexible output'}{model?.generate_audio && ' · Audio support'}</small></span><ChevronDown size={16} /></button>
              {modelsError && <div className="form-error" role="alert">{modelsError}<button className="text-button" onClick={() => void loadModels()}>Retry model discovery</button></div>}
              <div className="output-settings">
                <div className="select-field"><label htmlFor="duration"><Clock3 size={12} /> Duration</label><div className="select-wrap"><select id="duration" disabled={!model?.supported_durations?.length} value={model?.supported_durations?.length ? duration : ''} onChange={e => setDuration(Number(e.target.value))}>{model?.supported_durations?.length ? model.supported_durations.map(n => <option key={n} value={n}>{n} seconds</option>) : <option value="">Automatic</option>}</select><ChevronDown size={13} /></div></div>
                <div className="select-field"><label htmlFor="resolution"><Monitor size={12} /> Resolution</label><div className="select-wrap"><select id="resolution" disabled={!!size || !model?.supported_resolutions?.length} value={resolution} onChange={e => setResolution(e.target.value)}>{model?.supported_resolutions?.length ? model.supported_resolutions.map(s => <option key={s}>{s}</option>) : <option value="">Automatic</option>}</select><ChevronDown size={13} /></div></div>
                <div className="select-field"><label htmlFor="ratio"><Grid2X2 size={12} /> Aspect ratio</label><div className="select-wrap"><select id="ratio" disabled={!!size || !model?.supported_aspect_ratios?.length} value={ratio} onChange={e => setRatio(e.target.value)}>{model?.supported_aspect_ratios?.length ? model.supported_aspect_ratios.map(s => <option key={s}>{s}</option>) : <option value="">Automatic</option>}</select><ChevronDown size={13} /></div></div>
              </div>
              <div className="audio-row"><div><AudioLines size={17} /><span>Generate audio <small>{model?.generate_audio === true ? 'Sound that fits the scene' : 'Controlled by this model'}</small></span></div><button role="switch" aria-checked={model?.generate_audio === true && audio} aria-label="Generate audio" disabled={model?.generate_audio !== true} className={`toggle ${model?.generate_audio === true && audio ? 'on' : ''}`} onClick={() => setAudio(!audio)}><span /></button></div>
              <button className="advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={14} /> Advanced settings <ChevronDown className={advanced ? 'rotated' : ''} size={14} /></button>
              {advanced && <div className="advanced-panel">
                {model?.upscale_factor && <div className="select-field"><label htmlFor="upscale">Upscale factor</label><input id="upscale" type="number" min={model.upscale_factor.min} max={model.upscale_factor.max} step="0.1" placeholder={`Automatic (${model.upscale_factor.min}–${model.upscale_factor.max}×)`} value={upscale} onChange={e => setUpscale(e.target.value)} /></div>}
                {!!model?.creativity?.length && <div className="select-field"><label htmlFor="creativity">Upscaling creativity</label><select id="creativity" value={creativity} onChange={e => setCreativity(e.target.value)}><option value="">Automatic</option>{model.creativity.map(value => <option key={value} value={value}>{value}</option>)}</select></div>}
                {model?.seed === true && <div className="select-field"><label htmlFor="seed">Seed <span className="optional">Optional</span></label><input id="seed" type="number" min="0" max="2147483647" placeholder="Random" value={seed} onChange={e => setSeed(e.target.value)} /><p className="hint">A fixed seed may help reproduce a result. Providers can vary.</p></div>}
                {!!model?.supported_sizes?.length && <div className="select-field"><label htmlFor="size">Exact dimensions</label><select id="size" value={size} onChange={e => setSize(e.target.value)}><option value="">Use resolution & aspect ratio</option>{model.supported_sizes.map(s => <option key={s}>{s}</option>)}</select></div>}
                {!!model?.allowed_passthrough_parameters.length && <div className="select-field"><label htmlFor="provider">Provider options (JSON)</label><textarea id="provider" value={provider} onChange={e => setProvider(e.target.value)} placeholder={'{ "options": { "provider-slug": { } } }'} /><p className="hint">Allowed: {model.allowed_passthrough_parameters.join(', ')}. Options are keyed by provider slug.</p></div>}
                {!model?.seed && !model?.supported_sizes?.length && !model?.allowed_passthrough_parameters.length && !model?.upscale_factor && !model?.creativity?.length && <p className="hint">This model has no additional exposed controls.</p>}
                {!!Object.keys(model?.pricing_skus || {}).length && <details className="pricing-details"><summary>Model pricing</summary>{Object.entries(model!.pricing_skus).map(([key, value]) => <div key={key}><span>{key.replaceAll('_', ' ')}</span><code>{value}</code></div>)}<p className="hint">SKU units vary. Your actual charge appears after generation.</p></details>}
              </div>}
              {formError && <div className="form-error" role="alert">{formError}</div>}
              <div className="generate-section"><button className="generate-button" disabled={submitting || uploading || !model || activeCount >= 3} onClick={() => void generate()}>{submitting ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}<span>{submitting ? 'Submitting your vision…' : activeCount >= 3 ? '3 generations running' : 'Generate video'}</span><ArrowRight size={17} /></button><div className="generation-footnote"><span>{cost === null ? 'Priced by your selected provider' : <>Estimated <strong>{money(cost)}</strong> / generation</>}</span><span>⌘ / Ctrl + Enter</span></div></div>
            </section>

            <section className="preview-column" aria-label="Video preview">
              <div className="preview-card card"><div className="preview-header"><div className="preview-tabs"><button className={previewTab === 'preview' ? 'selected' : ''} onClick={() => setPreviewTab('preview')}>Preview</button><button className={previewTab === 'history' ? 'selected' : ''} onClick={() => setPreviewTab('history')}>Recent <span>{jobs.length}</span></button></div><span className="preview-header-icon"><Monitor size={16} /></span></div>
                {previewTab === 'history' ? <div className="recent-list">{jobs.length ? jobs.slice(0, 8).map(job => renderJob(job, true)) : <div className="empty-small"><Clock3 size={28} /><h3>A fresh start.</h3><p>Your recent generations will appear here.</p></div>}</div> : <>
                  <div className={`preview-stage ${activeJob ? 'has-job' : ''}`}>
                    {!activeJob ? <><img className="preview-landscape" src="https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=1100&q=90" alt="Sunlight falling through a misty forest, a source of cinematic inspiration" /><div className="stage-shade" /><span className="inspiration-chip"><span /> ROOM TO IMAGINE</span><div className="stage-empty"><span className="stage-icon"><Clapperboard size={25} strokeWidth={1.4} /></span><h2>Your vision,<br /><em>in motion.</em></h2><p>Every great video starts with an idea.<br />Let’s bring yours to life.</p></div><div className="stage-bottom"><span>THE POSSIBILITIES ARE OPEN.</span><span className="frame-corner">↗</span></div></> : activeJob.status === 'completed' ? <video key={`${activeJob.id}-${clipIndex}`} className="result-video" src={`/api/jobs/${activeJob.id}/content?index=${clipIndex}`} controls playsInline autoPlay onError={() => setToast('Video playback is unavailable. Reconnect your key or try downloading the clip.')} /> : <div className="generation-state">{!terminalStatuses.includes(activeJob.status) ? <><div className="generation-orbit"><Sparkles size={28} /><span /></div><span className="status-badge">{labels[activeJob.status]}</span><h2>A little magic takes a moment.</h2><p>Your scene is coming together.<br />You can keep creating while we work.</p>{activeJob.pollError && <p className="poll-error">{activeJob.pollError} Status checks will retry automatically.</p>}</> : <><Film size={36} /><h2>{labels[activeJob.status]}</h2><p>{activeJob.error || 'This generation could not be completed. Adjust your prompt or try another provider.'}</p><button className="secondary-button" onClick={() => reuse(activeJob)}><RefreshCw size={14} /> Reuse prompt</button></>}</div>}
                  </div>
                  <div className="preview-caption"><div><span className={`preview-status-dot ${activeJob?.status === 'completed' ? 'green-dot' : ''}`} /><span>{activeJob ? labels[activeJob.status] === 'Ready' ? 'Your video is ready' : labels[activeJob.status] : 'Your canvas is waiting'}</span></div><span>{activeJob?.input.duration ? `${activeJob.input.duration}s · ` : ''}{activeJob?.input.resolution || activeJob?.input.size || resolution || 'Auto'} <span>·</span> {activeJob?.input.aspect_ratio || ratio || 'Auto'}</span></div>
                  <div className="preview-info">{activeJob ? <><p className="preview-prompt">{activeJob.input.prompt || 'Image-guided generation'}</p><div className="result-actions"><button className="secondary-button" onClick={() => reuse(activeJob)}><RefreshCw size={13} /> Reuse prompt</button>{activeJob.status === 'completed' && <a className="primary-button" href={`/api/jobs/${activeJob.id}/content?index=${clipIndex}&download=1`} download><ArrowDownToLine size={14} /> Download</a>}</div>{activeJob.outputCount > 1 && <label className="clip-select">Output clip<select value={clipIndex} onChange={e => setClipIndex(Number(e.target.value))}>{Array.from({ length: activeJob.outputCount }, (_, index) => <option key={index} value={index}>Clip {index + 1}</option>)}</select></label>}{activeJob.cost !== undefined && <span className="actual-cost">Actual cost: {money(activeJob.cost)}</span>}</> : <div className="preview-hint"><span className="hint-star"><Sparkles size={15} /></span><div><h3>A few words. A whole new world.</h3><p>Describe your scene, set the details, and hit generate. Your video will appear right here.</p></div></div>}</div>
                </>}
              </div>
              <div className="creative-note"><span className="creative-note-icon"><ShieldCheck size={18} /></span><p><strong>Your ideas stay yours.</strong><span>Assets stay in this workspace and are sent to OpenRouter when you generate.</span></p></div>
              <div className="tip-card"><span className="tip-eyebrow"><span className="tip-line" /> A LITTLE CREATIVE DIRECTION</span><p>Think like a director.<br /><span>Set the scene. Add movement. Find the light.</span></p><div className="tip-tags"><span>“slow camera push-in”</span><span>“soft morning light”</span></div></div>
            </section>
          </div>
          <section className="inspiration-section"><div className="inspiration-heading"><div><Sparkles size={17} /><h2>A starting point for your next story</h2></div><button className="text-button" onClick={() => navigate('inspiration')}>Explore inspiration <ArrowRight size={14} /></button></div><div className="inspiration-grid">{inspiration.map((item, index) => <button key={item.title} className="inspiration-card" onClick={() => useInspiration(index)}><img src={item.image} alt="" loading="lazy" /><div className="inspiration-gradient" /><span className="inspiration-category">{item.category}</span><span className="inspiration-title">{item.title}<span><ArrowRight size={17} /></span></span></button>)}</div></section>
        </>}

        {view === 'library' && <section className="library-section"><div className="library-toolbar"><div className="search-box"><Search size={16} /><input aria-label="Search creations" placeholder="Search your creations…" value={librarySearch} onChange={e => setLibrarySearch(e.target.value)} /></div><select aria-label="Filter by status" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">All generations</option><option value="completed">Ready to watch</option><option value="active">In progress</option><option value="failed">Failed</option></select><span className="subtle-label">{jobs.length} GENERATIONS</span></div><div className="creations-grid">{jobs.filter(job => job.title.toLowerCase().includes(librarySearch.toLowerCase()) && (statusFilter === 'all' || (statusFilter === 'active' ? !terminalStatuses.includes(job.status) : job.status === statusFilter))).map(job => renderJob(job))}</div>{!jobs.length && <div className="empty-library"><Film size={38} strokeWidth={1.3} /><h2>Your first scene is waiting.</h2><p>Create a video, and it will find a home right here.</p><button className="primary-button" onClick={() => navigate('studio')}><Plus size={16} /> Create your first video</button></div>}{!!jobs.length && !jobs.some(job => job.title.toLowerCase().includes(librarySearch.toLowerCase()) && (statusFilter === 'all' || (statusFilter === 'active' ? !terminalStatuses.includes(job.status) : job.status === statusFilter))) && <p className="empty-small">No matching generations. Try a different search or filter.</p>}</section>}

        {view === 'assets' && <section><div className="asset-drop-banner" onDragOver={e => e.preventDefault()} onDrop={onDrop}><Upload size={23} /><div><strong>{uploading ? 'Uploading your assets…' : 'A place for all your creative ingredients.'}</strong><p>Drag in images, footage, or audio. Up to 25 MB per file.</p></div><button className="secondary-button" disabled={uploading} onClick={() => chooseFile()}>Browse files</button></div><div className="asset-library-grid">{assets.map(asset => <article key={asset.id} className="asset-card card"><div className={`asset-preview asset-${asset.kind}`}>{asset.kind === 'image' ? assetThumb(asset, true) : asset.kind === 'video' ? <video src={asset.url} controls preload="metadata" /> : <><AudioLines size={34} /><audio src={asset.url} controls preload="metadata" /></>}</div><div className="asset-card-copy"><h3 title={asset.name}>{asset.name}</h3><p>{asset.kind.toUpperCase()} <span>·</span> {formatBytes(asset.size)}</p><div><button className="text-button" onClick={() => { attach(asset); navigate('studio'); }}>Use as reference <ArrowRight size={12} /></button><button className="icon-button" aria-label={`Delete ${asset.name}`} onClick={() => void removeAsset(asset.id)}><Trash2 size={14} /></button></div></div></article>)}</div>{!assets.length && <div className="empty-library"><FolderOpen size={38} strokeWidth={1.3} /><h2>Your creative toolkit starts here.</h2><p>Upload an image to set the scene, or add footage and sound for a supporting model.</p></div>}</section>}

        {view === 'inspiration' && <section className="inspiration-grid inspiration-expanded">{inspiration.map((item, index) => <article className="inspiration-detail card" key={item.title}><img src={item.image} alt={item.title} /><div><span className="eyebrow">{item.category}</span><h2>{item.title}</h2><p>{item.prompt}</p><button className="primary-button" onClick={() => useInspiration(index)}><WandSparkles size={15} /> Use this prompt <ArrowRight size={14} /></button></div></article>)}</section>}
        <footer className="page-footer"><span>Made for the way you imagine.</span><span><span className="footer-mark">f.</span> FRAME VIDEO STUDIO</span></footer>
      </main>
    </div>
    <input className="sr-only" tabIndex={-1} aria-label="Upload media files" ref={fileRef} type="file" multiple accept="image/*,video/*,audio/*" onChange={e => void uploadFiles(Array.from(e.target.files || []), uploadRole.current)} />
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast}</span><button className="icon-button small" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}

    {modal === 'settings' && <Modal title="Connect your studio" onClose={() => { setModal(null); setApiKey(''); setConnectionError(''); }}><div className="connection-illustration"><KeyRound size={28} /></div><p className="modal-intro">One key. A world of possibilities.</p><p className="modal-description">Connect OpenRouter to generate with Wan, Seedance, Veo, and other available video models. Generation costs are billed to your OpenRouter account.</p>{connection.connected && <div className="connected-state"><Check size={17} />{connection.source === 'environment' ? 'Using your server’s environment key.' : 'Your studio is connected.'}</div>}<form onSubmit={e => { e.preventDefault(); void connect(); }}><label className="input-label" htmlFor="api-key">OpenRouter API key</label><input autoComplete="off" id="api-key" type="password" placeholder="sk-or-v1-…" value={apiKey} onChange={e => setApiKey(e.target.value)} required minLength={10} /><p className="hint"><ShieldCheck size={12} /> Your key is held in server memory for up to 24 hours of inactivity. It is never saved in browser storage or on disk.</p>{connectionError && <div className="form-error" role="alert">{connectionError}</div>}<button type="submit" className="primary-button full-width" disabled={connecting || apiKey.length < 10}>{connecting ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={15} />}{connecting ? 'Checking your key…' : connection.connected ? 'Update API key' : 'Connect OpenRouter'}<ArrowRight size={15} /></button></form><div className="modal-bottom"><a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Get an API key <ExternalLink size={12} /></a>{connection.source === 'session' && <button className="text-button danger" onClick={async () => { try { setConnection(await api<Connection>('/connection', { method: 'DELETE' })); setToast('Session key removed.'); } catch (e) { setConnectionError(errorText(e)); } }}>Remove session key</button>}</div></Modal>}

    {modal === 'models' && <Modal title="Choose your creative engine" onClose={() => setModal(null)} wide><p className="modal-description">Live video models from OpenRouter. Available settings update automatically.</p><div className="search-box model-search"><Search size={17} /><input autoFocus placeholder="Search models or providers…" aria-label="Search video models" value={modelSearch} onChange={e => setModelSearch(e.target.value)} /></div><div className="model-list">{models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(modelSearch.toLowerCase())).map(m => <button className={`model-option ${modelId === m.id ? 'chosen' : ''}`} key={m.id} onClick={() => { setModelId(m.id); setModal(null); }}><span className="model-option-icon"><Layers3 size={20} /></span><span><strong>{m.name}{m.id === 'alibaba/wan-3.0' && <span className="recommended-badge">RECOMMENDED</span>}</strong><p>{m.description}</p><small>{m.supported_resolutions?.join(' · ') || 'Model-controlled output'}{m.generate_audio === true && ' · Audio'}{m.supported_durations?.length ? ` · ${Math.min(...m.supported_durations)}–${Math.max(...m.supported_durations)}s` : ''}</small></span>{modelId === m.id ? <Check size={18} /> : <ChevronRight size={16} />}</button>)}</div>{!models.length && <div className="empty-small"><p>{modelsError || 'Loading models…'}</p><button className="secondary-button" onClick={() => void loadModels()}>Refresh models</button></div>}</Modal>}

    {modal === 'assets' && <Modal title="Your creative ingredients" onClose={() => setModal(null)} wide><p className="modal-description">{mode === 'image' ? 'Choose an image for the first or last frame.' : 'Choose assets to guide this generation.'}</p><div className="asset-picker">{assets.filter(a => mode !== 'image' || a.kind === 'image').map(asset => <div className="asset-picker-row" key={asset.id}><span className="asset-picker-thumb">{assetThumb(asset)}</span><div><strong>{asset.name}</strong><small>{asset.kind} · {formatBytes(asset.size)}</small></div>{mode === 'image' ? <div className="frame-picker-actions">{model?.supported_frame_images?.map(role => <button key={role} className="secondary-button" onClick={() => { attach(asset, role as AssetRole); setModal(null); }}>{role === 'first_frame' ? 'First' : 'Last'}</button>)}</div> : <button className={`secondary-button ${selections.some(s => s.id === asset.id) ? 'is-selected' : ''}`} onClick={() => selections.some(s => s.id === asset.id) ? setSelections(current => current.filter(s => s.id !== asset.id)) : attach(asset)}>{selections.some(s => s.id === asset.id) ? <Check size={15} /> : <Plus size={15} />}{selections.some(s => s.id === asset.id) ? 'Added' : 'Add'}</button>}</div>)}</div>{!assets.length && <div className="empty-small"><FolderOpen size={28} /><p>Your asset library is empty. Upload your first creative ingredient.</p></div>}<button className="secondary-button full-width" disabled={uploading} onClick={() => { setModal(null); chooseFile(mode === 'image' ? 'first_frame' : 'reference'); }}><Upload size={15} /> Upload new assets</button></Modal>}
  </div>;
}
