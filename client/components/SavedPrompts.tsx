import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Check, Clock3, LoaderCircle, Pencil, RotateCcw, Search, Trash2 } from 'lucide-react';
import type { PromptVersion, SavedPrompt } from '../../shared/types';
import { api } from '../api';
import Modal from './Modal';
import './saved-prompts.css';

const message = (error: unknown) => error instanceof Error ? error.message : 'Could not load saved prompts. Please retry.';
const timestamp = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function SavePrompt({ text, saved, onClose, onSaved }: { text: string; saved?: SavedPrompt | null; onClose: () => void; onSaved: (prompt: SavedPrompt) => void }) {
  const [title, setTitle] = useState(saved?.title ?? text.trim().split('\n')[0].slice(0, 70));
  const [content, setContent] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(asNew = false) {
    setSaving(true); setError('');
    try {
      const result = await api<{ prompt: SavedPrompt }>(saved && !asNew ? `/prompts/${saved.id}` : '/prompts', {
        method: saved && !asNew ? 'PUT' : 'POST', body: JSON.stringify({ title, text: content, ...(saved && !asNew ? { expectedVersion: saved.version } : {}) }),
      });
      onSaved(result.prompt);
    } catch (error) { setError(message(error)); }
    finally { setSaving(false); }
  }
  return <Modal title={saved ? 'Save a prompt revision' : 'Save your prompt'} onClose={onClose} wide className="save-prompt-modal">
    <p className="modal-description">{saved ? `Currently version ${saved.version}. Your previous versions stay in the history.` : 'Give this idea a name. You can reuse it, refine it, and come back to earlier versions.'}</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="input-label" htmlFor="saved-prompt-title">Prompt name</label><input id="saved-prompt-title" autoFocus required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="A quiet forest at sunrise" />
      <label className="input-label" htmlFor="saved-prompt-text">Prompt</label><textarea id="saved-prompt-text" required maxLength={10000} value={content} onChange={event => setContent(event.target.value)} />
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="prompt-save-actions">{saved && <button className="secondary-button" type="button" disabled={saving || !title.trim() || !content.trim()} onClick={() => void save(true)}>Save as new prompt</button>}<button className="primary-button" type="submit" disabled={saving || !title.trim() || !content.trim()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Bookmark size={15} />}{saving ? 'Saving…' : saved ? 'Save revision' : 'Save prompt'}</button></div>
    </form>
  </Modal>;
}

export function SavedPrompts({ onClose, onUse, onEdit, onUpdate, onRemove }: { onClose: () => void; onUse: (prompt: SavedPrompt) => void; onEdit: (prompt: SavedPrompt) => void; onUpdate: (prompt: SavedPrompt) => void; onRemove: (id: string) => void }) {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<{ prompt: SavedPrompt; versions: PromptVersion[] } | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { void api<{ prompts: SavedPrompt[] }>('/prompts').then(result => setPrompts(result.prompts)).catch(error => setError(message(error))).finally(() => setLoading(false)); }, []);
  async function history(prompt: SavedPrompt) {
    setWorking(true); setError(''); setNotice('');
    try { const result = await api<{ prompt: SavedPrompt; versions: PromptVersion[] }>(`/prompts/${prompt.id}`); setDetail(result); setSelectedVersion(result.prompt.version); }
    catch (error) { setError(message(error)); }
    finally { setWorking(false); }
  }
  async function restore() {
    if (!detail || selectedVersion === null) return;
    setWorking(true); setError('');
    try {
      const result = await api<{ prompt: SavedPrompt; versions: PromptVersion[] }>(`/prompts/${detail.prompt.id}/restore`, { method: 'POST', body: JSON.stringify({ version: selectedVersion, expectedVersion: detail.prompt.version }) });
      setDetail(result); setPrompts(current => current.map(prompt => prompt.id === result.prompt.id ? result.prompt : prompt)); onUpdate(result.prompt);
      setNotice(`Restored version ${selectedVersion} as version ${result.prompt.version}. All earlier versions are still available.`); setSelectedVersion(result.prompt.version);
    } catch (error) { setError(message(error)); }
    finally { setWorking(false); }
  }
  async function remove(id: string) {
    setWorking(true); setError('');
    try { await api(`/prompts/${id}`, { method: 'DELETE' }); setPrompts(current => current.filter(prompt => prompt.id !== id)); onRemove(id); setDeleting(null); }
    catch (error) { setError(message(error)); }
    finally { setWorking(false); }
  }
  const version = detail?.versions.find(version => version.version === selectedVersion);
  const filtered = prompts.filter(prompt => `${prompt.title} ${prompt.text}`.toLowerCase().includes(search.toLowerCase()));
  return <Modal title={detail ? 'Prompt version history' : 'Your saved prompts'} onClose={onClose} wide className="saved-prompts-modal">
    {detail ? <>
      <button className="text-button prompt-back" onClick={() => { setDetail(null); setNotice(''); setError(''); }}><ArrowLeft size={13} /> Back to saved prompts</button>
      <div className="prompt-history-heading"><div><h3>{detail.prompt.title}</h3><p>Every change has a place. Restore a version without losing what came after.</p></div><button className="primary-button" onClick={() => onUse(detail.prompt)}>Use current prompt <ArrowRight size={13} /></button></div>
      <div className="prompt-history-grid"><div className="prompt-version-list" aria-label="Prompt versions">{detail.versions.map(item => <button key={item.version} className={selectedVersion === item.version ? 'selected' : ''} onClick={() => { setSelectedVersion(item.version); setNotice(''); }}><span><strong>Version {item.version}</strong>{item.version === detail.prompt.version && <span className="prompt-version-tag">CURRENT</span>}</span><small>{timestamp(item.createdAt)}</small>{item.restoredFrom && <small>Restored from v{item.restoredFrom}</small>}</button>)}</div><div className="prompt-version-preview"><div><span>VERSION {version?.version}</span><button className="text-button" disabled={working || selectedVersion === detail.prompt.version} onClick={() => void restore()}><RotateCcw size={12} /> Restore this version</button></div><h4>{version?.title}</h4><pre>{version?.text}</pre></div></div>
    </> : <>
      <p className="modal-description">Ideas worth keeping. Load a favorite, refine it, or revisit an earlier version.</p><div className="search-box"><Search size={16} /><input aria-label="Search saved prompts" placeholder="Find a prompt…" value={search} onChange={event => setSearch(event.target.value)} /></div>
      {loading ? <div className="empty-small"><LoaderCircle className="spin" size={24} /><p>Opening your prompt collection…</p></div> : !prompts.length ? <div className="empty-small"><Bookmark size={28} /><h3>A place for your best ideas.</h3><p>Write a prompt in the studio, then choose Save prompt.</p></div> : <div className="saved-prompt-list">{filtered.map(prompt => <article key={prompt.id} className="saved-prompt-card"><div className="saved-prompt-title"><h3>{prompt.title}</h3><span>v{prompt.version}</span></div><p>{prompt.text}</p><div className="saved-prompt-meta"><span>Updated {timestamp(prompt.updatedAt)}</span><span>{prompt.version} {prompt.version === 1 ? 'version' : 'versions'}</span></div><div className="saved-prompt-actions"><button className="primary-button" onClick={() => onUse(prompt)}>Use prompt <ArrowRight size={12} /></button><button className="secondary-button" disabled={working} aria-label={`History for ${prompt.title}`} onClick={() => void history(prompt)}><Clock3 size={12} /> History</button><button className="icon-button" aria-label={`Edit saved prompt ${prompt.title}`} onClick={() => onEdit(prompt)}><Pencil size={14} /></button><button className="icon-button" aria-label={`Delete saved prompt ${prompt.title}`} onClick={() => setDeleting(prompt.id)}><Trash2 size={14} /></button></div>{deleting === prompt.id && <div className="prompt-delete-confirm"><p>Delete this prompt and all its versions?</p><button className="text-button" onClick={() => setDeleting(null)}>Keep prompt</button><button className="secondary-button danger" disabled={working} onClick={() => void remove(prompt.id)}>Delete prompt</button></div>}</article>)}</div>}
      {!!prompts.length && !filtered.length && <div className="empty-small">No matching prompts. Try a different search.</div>}
    </>}
    {notice && <div className="prompt-restore-notice" role="status"><Check size={14} />{notice}</div>}{error && <div className="form-error" role="alert">{error}</div>}
  </Modal>;
}
