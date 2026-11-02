export type AssetKind = 'image' | 'video' | 'audio';
export type AssetRole = 'reference' | 'first_frame' | 'last_frame';
export type JobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
export const terminalStatuses: JobStatus[] = ['completed', 'failed', 'cancelled', 'expired'];

export interface VideoModel {
  id: string;
  name: string;
  description: string;
  supported_durations: number[] | null;
  supported_resolutions: string[] | null;
  supported_aspect_ratios: string[] | null;
  supported_sizes: string[] | null;
  supported_frame_images: string[] | null;
  generate_audio: boolean | null;
  seed: boolean | null;
  upscale_factor?: { min: number; max: number } | null;
  creativity?: number[] | null;
  pricing_skus: Record<string, string>;
  allowed_passthrough_parameters: string[];
}

export interface Asset {
  id: string;
  name: string;
  mime: string;
  kind: AssetKind;
  size: number;
  createdAt: string;
  url: string;
  metadata?: MediaMetadata;
  prepared?: PreparedAsset;
  preparation?: { id: string; status: 'queued' | 'processing' | 'completed' | 'failed'; progress: number; error?: string };
}

export interface MediaMetadata {
  width?: number;
  height?: number;
  duration?: number;
  hasAudio?: boolean;
  animated?: boolean;
}

export interface CropRegion { x: number; y: number; width: number; height: number }
export interface AssetEdits {
  crop?: CropRegion | null;
  maxWidth?: number;
  maxHeight?: number;
  start?: number;
  end?: number;
  mute?: boolean;
}
export interface PreparedAsset {
  id: string;
  mime: string;
  size: number;
  url: string;
  metadata: MediaMetadata;
  edits: AssetEdits;
  createdAt: string;
}

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
export function preparedDimensions(metadata: MediaMetadata, edits: AssetEdits, kind: AssetKind) {
  if (!metadata.width || !metadata.height) return null;
  const crop = edits.crop;
  let width = Math.max(1, Math.floor(metadata.width * (crop?.width ?? 1)));
  let height = Math.max(1, Math.floor(metadata.height * (crop?.height ?? 1)));
  const scale = Math.min(1, edits.maxWidth ? edits.maxWidth / width : 1, edits.maxHeight ? edits.maxHeight / height : 1);
  width = Math.max(1, Math.floor(width * scale));
  height = Math.max(1, Math.floor(height * scale));
  if (kind === 'video') { width = Math.max(2, width - width % 2); height = Math.max(2, height - height % 2); }
  return { width, height };
}

export interface GenerationInput {
  model: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  size?: string;
  generate_audio?: boolean;
  seed?: number;
  upscale_factor?: number;
  creativity?: number;
  assets: { id: string; role: AssetRole; preparedId?: string | null }[];
  provider?: { options: Record<string, Record<string, unknown>> };
}

export interface VideoJob {
  id: string;
  upstreamId: string;
  title: string;
  status: JobStatus;
  input: GenerationInput;
  createdAt: string;
  updatedAt: string;
  error?: string;
  pollError?: string;
  cost?: number;
  outputCount: number;
}

export interface Connection {
  connected: boolean;
  source: 'environment' | 'session' | null;
}

// Only unambiguous output-second SKUs are used. Other pricing schemes need
// provider-specific accounting and are intentionally not guessed.
export function estimateCost(model: VideoModel | undefined, duration: number | undefined, resolution: string, audio: boolean): number | null {
  if (!model || !duration) return null;
  const prices = model.pricing_skus;
  const keys = audio
    ? [`duration_seconds_with_audio_${resolution.toLowerCase()}`, `duration_seconds_with_audio`]
    : [];
  keys.push(`duration_seconds_${resolution.toLowerCase()}`, 'duration_seconds');
  for (const key of keys) {
    if (prices[key] !== undefined && Number.isFinite(Number(prices[key]))) return duration * Number(prices[key]);
  }
  for (const key of [`cents_per_video_output_second_${resolution.toLowerCase()}`, `cents_per_second_output_${resolution.toLowerCase()}`, 'cents_per_second_output']) {
    if (prices[key] !== undefined && Number.isFinite(Number(prices[key]))) return duration * Number(prices[key]) / 100;
  }
  return null;
}
