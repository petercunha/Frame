import type { Asset } from '../shared/types';

export function formatBytes(size: number) {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}
export function formatTime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${remainder}`;
}
export function inputSummary(asset: Asset) {
  const metadata = asset.prepared?.metadata ?? asset.metadata;
  return [metadata?.duration ? `${Number(metadata.duration.toFixed(2))}s` : '', metadata?.width ? `${metadata.width} × ${metadata.height}` : '', formatBytes(asset.prepared?.size ?? asset.size)].filter(Boolean).join(' · ');
}
export function isPreparing(asset: Asset) { return !!asset.preparation && ['queued', 'processing'].includes(asset.preparation.status); }
