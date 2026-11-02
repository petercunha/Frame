import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { fileTypeFromFile } from 'file-type';
import { randomBytes, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Store, publicAsset, publicJob, type StoredAsset, type StoredJob } from './store';
import { OpenRouter, ApiError, type UpstreamJob } from './openrouter';
import { generationSchema, validateGeneration, buildRequest, referenceFile } from './generation';
import { DEFAULT_MAX_UPLOAD_BYTES, MAX_REFERENCE_BYTES, terminalStatuses, type AssetKind } from '../shared/types';
import { editsSchema, MediaService } from './media';
import { REFERENCE_PATH, ReferenceHost, type ReferencePublisher } from './reference-host';
import { promptRoutes } from './prompts';

declare global { namespace Express { interface Request { studioOwner: string } } }

interface AppOptions { store: Store; router?: OpenRouter; apiKey?: string; pollInterval?: number; maxUploadBytes?: number; references?: ReferencePublisher }

export function createApp({ store, router = new OpenRouter(), apiKey, pollInterval = 5000, maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, references = new ReferenceHost(resolve(store.directory, 'reference-exports'), { publicOrigin: process.env.REFERENCE_PUBLIC_ORIGIN }) }: AppOptions) {
  const app = express();
  const keys = new Map<string, { value: string; touched: number }>();
  const polls = new Map<string, ReturnType<typeof setTimeout>>();
  const media = new MediaService(store);
  const jobReferences = new Map<string, string[]>();
  app.use(REFERENCE_PATH, references.router);
  const polling = new Set<string>();
  let closed = false;
  const keyFor = (owner: string) => {
    const entry = keys.get(owner);
    if (entry && Date.now() - entry.touched > 24 * 60 * 60 * 1000) keys.delete(owner);
    else if (entry) { entry.touched = Date.now(); return entry.value; }
    return apiKey || undefined;
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.get('origin');
        if (origin) {
          let allowed = false;
          try { allowed = new URL(origin).host === req.get('host'); } catch { /* opaque or malformed origins */ }
          if (!allowed) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
        }
        if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
      }
      const cookie = req.get('cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith('frame_session='))?.slice('frame_session='.length);
      req.studioOwner = cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : randomBytes(32).toString('hex');
      if (req.studioOwner !== cookie) res.cookie('frame_session', req.studioOwner, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 365 * 24 * 60 * 60 * 1000 });
    }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/prompts', promptRoutes(store));

  function applyJob(job: StoredJob, upstream: UpstreamJob) {
    job.status = upstream.status;
    job.updatedAt = new Date().toISOString();
    if (upstream.error) job.error = typeof upstream.error === 'string' ? upstream.error : JSON.stringify(upstream.error);
    if (upstream.usage?.cost !== undefined) job.cost = upstream.usage.cost;
    job.outputCount = Math.max(upstream.unsigned_urls?.length ?? 0, upstream.urls?.length ?? 0, job.status === 'completed' ? 1 : 0);
    delete job.pollError;
  }
  function schedule(job: StoredJob, failures = 0) {
    if (closed || terminalStatuses.includes(job.status) || polls.has(job.id) || polling.has(job.id) || !keyFor(job.owner)) return;
    const timer = setTimeout(async () => {
      polls.delete(job.id);
      const key = keyFor(job.owner);
      if (!key || closed) return;
      polling.add(job.id);
      let nextFailures = 0;
      try {
        references.renew(jobReferences.get(job.id) ?? []);
        applyJob(job, await router.poll(key, job.upstreamId));
        await store.save();
        if (terminalStatuses.includes(job.status)) { await references.release(jobReferences.get(job.id) ?? []); jobReferences.delete(job.id); }
      } catch (error) {
        nextFailures = failures + 1;
        job.pollError = error instanceof Error ? error.message : 'Status check failed. Retrying.';
      } finally {
        polling.delete(job.id);
        schedule(job, nextFailures);
      }
    }, Math.min(pollInterval * 2 ** Math.min(failures, 4), 60_000));
    timer.unref();
    polls.set(job.id, timer);
  }
  function requireKey(owner: string) {
    const key = keyFor(owner);
    if (!key) throw new ApiError(401, 'Connect an OpenRouter API key to start generating.');
    return key;
  }
  const ownedAssets = (owner: string) => store.data.assets.filter(a => a.owner === owner);
  const findJob = (id: string, owner: string) => {
    const job = store.data.jobs.find(j => j.id === id && j.owner === owner);
    if (!job) throw new ApiError(404, 'Generation not found.');
    return job;
  };

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/config', (_req, res) => { res.json({ maxUploadBytes }); });
  app.get('/api/connection', (req, res) => {
    res.json({ connected: !!keyFor(req.studioOwner), source: keys.has(req.studioOwner) ? 'session' : apiKey ? 'environment' : null });
  });
  app.post('/api/connection', async (req, res) => {
    const { key } = z.object({ key: z.string().trim().min(10).max(500) }).parse(req.body);
    await router.validateKey(key);
    keys.set(req.studioOwner, { value: key, touched: Date.now() });
    store.data.jobs.filter(j => j.owner === req.studioOwner).forEach(j => schedule(j));
    res.json({ connected: true, source: 'session' });
  });
  app.delete('/api/connection', (req, res) => {
    keys.delete(req.studioOwner);
    res.json({ connected: !!apiKey, source: apiKey ? 'environment' : null });
  });
  app.get('/api/models', async (_req, res) => { res.json({ models: await router.models() }); });
  app.get('/api/assets', (req, res) => { res.json({ assets: ownedAssets(req.studioOwner).map(publicAsset).reverse() }); });

  const upload = multer({
    storage: multer.diskStorage({ destination: store.uploads, filename: (_req, _file, done) => done(null, randomUUID()) }),
    limits: { fileSize: maxUploadBytes, files: 12, fields: 0 },
  }).array('files', 12);
  app.post('/api/assets', (req, res, next) => {
    upload(req, res, error => {
      if (!error) return next();
      const files = (req.files ?? []) as Express.Multer.File[];
      void Promise.allSettled(files.map(f => unlink(f.path))).then(() => next(error));
    });
  }, async (req, res) => {
    const files = (req.files ?? []) as Express.Multer.File[];
    try {
      if (!files.length) throw new ApiError(400, 'Choose at least one image, video, or audio file.');
      const assets: StoredAsset[] = [];
      for (const file of files) {
        const detected = await fileTypeFromFile(file.path);
        const supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/opus', 'video/ogg'];
        if (!detected || !supported.includes(detected.mime)) throw new ApiError(400, `“${file.originalname}” is not a supported media file. Try JPG, PNG, WebP, GIF, AVIF, MP4, MOV, WebM, MP3, WAV, OGG, FLAC, M4A, or AAC.`);
        let mime = detected.mime;
        if (file.mimetype.startsWith('audio/') && ['video/mp4', 'video/webm', 'video/ogg'].includes(mime)) mime = mime.replace('video/', 'audio/');
        const id = randomUUID();
        assets.push({ id, name: file.originalname.slice(0, 200), mime, kind: mime.split('/')[0] as AssetKind, size: file.size, createdAt: new Date().toISOString(), url: `/api/assets/${id}/content`, filename: file.filename, owner: req.studioOwner });
      }
      store.data.assets.push(...assets);
      await store.save();
      res.status(201).json({ assets: assets.map(publicAsset) });
    } catch (error) { await Promise.allSettled(files.map(f => unlink(f.path))); throw error; }
  });
  app.get('/api/assets/:id/content', (req, res) => {
    const asset = ownedAssets(req.studioOwner).find(a => a.id === req.params.id);
    if (!asset) throw new ApiError(404, 'Asset not found.');
    res.type(asset.mime).sendFile(resolve(store.uploads, asset.filename), { dotfiles: 'allow' });
  });
  app.get('/api/assets/:id/editor', async (req, res) => {
    const asset = ownedAssets(req.studioOwner).find(a => a.id === req.params.id);
    if (!asset) throw new ApiError(404, 'Asset not found.');
    await media.inspect(asset);
    res.json({ asset: publicAsset(asset) });
  });
  app.post('/api/assets/:id/prepare', async (req, res) => {
    const asset = ownedAssets(req.studioOwner).find(a => a.id === req.params.id);
    if (!asset) throw new ApiError(404, 'Asset not found.');
    await media.prepare(asset, editsSchema.parse(req.body));
    res.status(202).json({ asset: publicAsset(asset) });
  });
  app.get('/api/assets/:id/prepared/:versionId/content', (req, res) => {
    const asset = ownedAssets(req.studioOwner).find(a => a.id === req.params.id);
    const version = asset?.versions?.find(v => v.id === req.params.versionId);
    if (!version) throw new ApiError(404, 'Prepared input not found.');
    res.type(version.mime).sendFile(resolve(store.prepared, version.filename), { dotfiles: 'allow' });
  });
  app.delete('/api/assets/:id/prepared', async (req, res) => {
    const asset = ownedAssets(req.studioOwner).find(a => a.id === req.params.id);
    if (!asset) throw new ApiError(404, 'Asset not found.');
    if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) throw new ApiError(409, 'Wait for preparation to finish before restoring the original input.');
    delete asset.prepared; delete asset.preparation;
    await store.save();
    res.json({ asset: publicAsset(asset) });
  });
  app.delete('/api/assets/:id', async (req, res) => {
    const asset = ownedAssets(req.studioOwner).find(a => a.id === req.params.id);
    if (!asset) throw new ApiError(404, 'Asset not found.');
    const usedBy = store.data.prompts.find(prompt => prompt.owner === req.studioOwner && prompt.versions.some(version => version.assets.some(reference => reference.id === asset.id)));
    if (usedBy) throw new ApiError(409, `This asset is kept by “${usedBy.title}” and its version history. Delete that saved prompt first if you want to remove the original.`);
    if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) throw new ApiError(409, 'Wait for preparation to finish before removing this asset.');
    store.data.assets = store.data.assets.filter(a => a !== asset);
    await store.save();
    await unlink(resolve(store.uploads, asset.filename)).catch(() => {});
    await Promise.allSettled((asset.versions ?? []).map(version => unlink(resolve(store.prepared, version.filename))));
    res.status(204).end();
  });

  app.get('/api/jobs', (req, res) => {
    const jobs = store.data.jobs.filter(j => j.owner === req.studioOwner);
    jobs.forEach(j => schedule(j));
    res.json({ jobs: jobs.map(publicJob).reverse() });
  });
  const submitting = new Set<string>();
  app.post('/api/jobs', async (req, res) => {
    const key = requireKey(req.studioOwner);
    const input = generationSchema.parse(req.body);
    if (submitting.has(req.studioOwner)) throw new ApiError(429, 'A generation is already being submitted. Please wait.');
    if (store.data.jobs.filter(j => j.owner === req.studioOwner && !terminalStatuses.includes(j.status)).length >= 3) throw new ApiError(429, 'You can run up to three generations at once. Wait for one to finish.');
    submitting.add(req.studioOwner);
    const referenceIds: string[] = [];
    let accepted = false;
    try {
      const model = (await router.models()).find(m => m.id === input.model);
      if (!model) throw new ApiError(400, 'That model is no longer available. Choose another model.');
      const assets = ownedAssets(req.studioOwner);
      validateGeneration(input, model, assets);
      input.assets = input.assets.map(selection => {
        const asset = assets.find(a => a.id === selection.id)!;
        if (asset.preparation && ['queued', 'processing'].includes(asset.preparation.status)) throw new ApiError(409, 'A selected asset is still being prepared. Wait for it to finish before generating.');
        return { ...selection, preparedId: selection.preparedId === undefined ? asset.prepared?.id ?? null : selection.preparedId };
      });
      const total = input.assets.reduce((bytes, selection) => {
        const asset = assets.find(a => a.id === selection.id)!;
        const file = referenceFile(asset, selection.preparedId);
        if (file.size > MAX_REFERENCE_BYTES) throw new ApiError(413, `“${asset.name}” is larger than 25 MB. Open its editor to trim or resize the input. Your original stays in the library.`);
        return bytes + file.size;
      }, 0);
      if (total > 50 * 1024 * 1024) throw new ApiError(413, 'Use at most 50 MB of references per generation.');
      const body = await buildRequest(input, assets, store.uploads, store.prepared, async source => {
        const reference = await references.publish(source); referenceIds.push(reference.id); return reference.url;
      });
      const upstream = await router.submit(key, body);
      const now = new Date().toISOString();
      const job: StoredJob = { id: randomUUID(), upstreamId: upstream.id, owner: req.studioOwner, title: input.prompt.slice(0, 80) || 'Image to video', status: upstream.status, input, createdAt: now, updatedAt: now, outputCount: 0 };
      applyJob(job, upstream);
      store.data.jobs.push(job);
      jobReferences.set(job.id, referenceIds);
      accepted = true;
      await store.save();
      if (terminalStatuses.includes(job.status)) { await references.release(referenceIds); jobReferences.delete(job.id); }
      schedule(job);
      res.status(202).json({ job: publicJob(job) });
    } finally { if (!accepted) await references.release(referenceIds); submitting.delete(req.studioOwner); }
  });
  app.get('/api/jobs/:id/content', async (req, res) => {
    const job = findJob(String(req.params.id), req.studioOwner);
    if (job.status !== 'completed') throw new ApiError(409, 'This video is not ready yet.');
    const index = z.coerce.number().int().min(0).max(job.outputCount - 1).parse(req.query.index ?? 0);
    const response = await router.content(requireKey(req.studioOwner), job.upstreamId, index, req.get('range'));
    res.status(response.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (req.query.download === '1') res.attachment(`frame-${job.id.slice(0, 8)}-${index + 1}.mp4`);
    if (!response.body) throw new ApiError(502, 'OpenRouter returned an empty video.');
    try { await pipeline(Readable.fromWeb(response.body as never), res); }
    catch (error) { if (!res.destroyed) throw error; }
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    const job = findJob(String(req.params.id), req.studioOwner);
    if (!terminalStatuses.includes(job.status)) throw new ApiError(409, 'Wait until this generation finishes before removing it.');
    store.data.jobs = store.data.jobs.filter(j => j !== job);
    await store.save();
    res.status(204).end();
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API endpoint not found.' }); });
  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.type('json');
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
    if (error.status === 404 || error.code === 'ENOENT') return res.status(404).json({ error: 'This file is no longer available in local storage.' });
    if (error.status === 416) return res.status(416).json({ error: 'The requested media range is outside the file.' });
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.') || 'Request'}: ${i.message}`).join('; ') });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `Each original must be ${Math.round(maxUploadBytes / 1024 / 1024)} MB or smaller.` : 'Upload up to 12 files at a time, using the files field.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error('Studio request failed:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
  };
  app.use(errorHandler);
  return { app, close: async () => { closed = true; media.close(); polls.forEach(clearTimeout); polls.clear(); keys.clear(); await references.close(); } };
}
