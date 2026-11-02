import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ApiError } from './openrouter';
import type { VideoModel, GenerationInput } from '../shared/types';
import type { StoredAsset } from './store';
import type { ReferenceSource } from './reference-host';

export const generationSchema = z.object({
  model: z.string().min(1).max(200), prompt: z.string().trim().max(10_000).default(''),
  duration: z.number().int().positive().optional(), resolution: z.string().max(30).optional(),
  aspect_ratio: z.string().max(30).optional(), size: z.string().max(30).optional(),
  generate_audio: z.boolean().optional(), seed: z.number().int().min(0).max(2_147_483_647).optional(),
  upscale_factor: z.number().positive().optional(), creativity: z.number().int().optional(),
  assets: z.array(z.object({ id: z.uuid(), role: z.enum(['reference', 'first_frame', 'last_frame']), preparedId: z.uuid().nullable().optional() })).max(12).default([]),
  provider: z.object({ options: z.record(z.string().max(100), z.record(z.string().max(100), z.unknown())) }).optional(),
});

export function validateGeneration(input: GenerationInput, model: VideoModel, assets: StoredAsset[]) {
  if (!input.prompt && !input.assets.some(a => a.role !== 'reference')) throw new ApiError(400, 'Add a prompt or a first/last frame image.');
  for (const [field, supported] of [
    ['duration', model.supported_durations], ['resolution', model.supported_resolutions],
    ['aspect_ratio', model.supported_aspect_ratios], ['size', model.supported_sizes],
  ] as const) {
    const value = input[field];
    if (value !== undefined && (!supported?.length || !(supported as (string | number)[]).includes(value))) {
      throw new ApiError(400, `${field} is not supported by this model. Refresh the model options.`);
    }
  }
  if (input.size && (input.resolution || input.aspect_ratio)) throw new ApiError(400, 'Choose exact size or resolution and aspect ratio.');
  if (input.generate_audio !== undefined && model.generate_audio !== true) throw new ApiError(400, 'This model does not expose an audio generation control.');
  if (input.seed !== undefined && model.seed !== true) throw new ApiError(400, 'This model does not support a seed.');
  if (input.upscale_factor !== undefined && (!model.upscale_factor || input.upscale_factor < model.upscale_factor.min || input.upscale_factor > model.upscale_factor.max)) throw new ApiError(400, 'The upscale factor is outside this model’s supported range.');
  if (input.creativity !== undefined && !model.creativity?.includes(input.creativity)) throw new ApiError(400, 'This model does not support that creativity setting.');
  const roles = new Set<string>();
  for (const selection of input.assets) {
    const asset = assets.find(a => a.id === selection.id);
    if (!asset) throw new ApiError(400, 'A selected asset no longer exists.');
    if (roles.has(selection.id)) throw new ApiError(400, 'The same asset cannot be attached twice.');
    roles.add(selection.id);
    if (selection.role !== 'reference') {
      if (asset.kind !== 'image') throw new ApiError(400, 'First and last frames must be images.');
      if (!model.supported_frame_images?.includes(selection.role)) throw new ApiError(400, `This model does not support ${selection.role.replace('_', ' ')}.`);
      if (roles.has(selection.role)) throw new ApiError(400, 'Choose only one image for each frame.');
      roles.add(selection.role);
    }
  }
  if (input.assets.some(a => a.role === 'reference') && input.assets.some(a => a.role !== 'reference')) {
    throw new ApiError(400, 'Use frame images or reference assets in one generation. Frame images take precedence at OpenRouter.');
  }
  for (const options of Object.values(input.provider?.options ?? {})) {
    for (const name of Object.keys(options)) {
      if (!model.allowed_passthrough_parameters.includes(name)) throw new ApiError(400, `Provider option "${name}" is not allowed by this model.`);
    }
  }
}

export function referenceFile(asset: StoredAsset, preparedId?: string | null) {
  const id = preparedId === undefined ? asset.prepared?.id : preparedId;
  if (!id) return { filename: asset.filename, mime: asset.mime, size: asset.size, prepared: false };
  const version = asset.versions?.find(version => version.id === id);
  if (!version) throw new ApiError(400, 'A prepared input is no longer available. Reattach this asset or save its edits again.');
  return { filename: version.filename, mime: version.mime, size: version.size, prepared: true };
}

export async function buildRequest(input: GenerationInput, assets: StoredAsset[], uploads: string, prepared = resolve(uploads, '..', 'prepared'), publish?: (source: ReferenceSource) => Promise<string>) {
  const { assets: selections, ...body } = input;
  const references: Record<string, unknown>[] = [];
  const frames: Record<string, unknown>[] = [];
  for (const selection of selections) {
    const asset = assets.find(a => a.id === selection.id)!;
    const file = referenceFile(asset, selection.preparedId);
    const path = resolve(file.prepared ? prepared : uploads, file.filename);
    let url: string;
    if (asset.kind === 'image') url = `data:${file.mime};base64,${(await readFile(path)).toString('base64')}`;
    else {
      if (!publish) throw new ApiError(503, 'Video and audio references need HTTPS hosting. Restart Frame to enable temporary reference links.');
      url = await publish({ path, mime: file.mime, kind: asset.kind });
      if (!url.startsWith('https://')) throw new ApiError(503, 'Reference hosting did not return an HTTPS URL. No generation was submitted.');
    }
    const type = `${asset.kind}_url`;
    const reference = { type, [type]: { url } };
    if (selection.role === 'reference') references.push(reference);
    else frames.push({ ...reference, frame_type: selection.role });
  }
  return { ...body, ...(references.length ? { input_references: references } : {}), ...(frames.length ? { frame_images: frames } : {}) };
}
