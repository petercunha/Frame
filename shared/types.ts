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
  assets: { id: string; role: AssetRole }[];
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
