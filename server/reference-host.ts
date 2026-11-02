import express, { type Router } from 'express';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { MAX_REFERENCE_BYTES, type AssetKind } from '../shared/types';
import { ApiError } from './openrouter';
import { waitForReferenceEndpoint } from './reference-readiness';

export interface ReferenceSource { path: string; mime: string; kind: AssetKind }
export interface PublishedReference { id: string; url: string }
export interface ReferencePublisher {
  router: Router;
  publish(source: ReferenceSource): Promise<PublishedReference>;
  release(ids: string[]): Promise<void>;
  renew(ids: string[]): void;
  close(): Promise<void>;
}
export const REFERENCE_PATH = '/_frame_references';
const LIFETIME = 2 * 60 * 60 * 1000;

export function httpsOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(503, 'Reference hosting needs a valid public HTTPS address.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || ['0.0.0.0', '[::1]'].includes(host)) {
    throw new ApiError(503, 'Reference hosting must use a publicly reachable HTTPS origin, without a path or login credentials.');
  }
  return url.origin;
}

export class ReferenceHost implements ReferencePublisher {
  readonly router = express.Router();
  private grants = new Map<string, { path: string; mime: string; filename: string; expires: number }>();
  private server?: Server;
  private tunnel?: ChildProcess;
  private origin?: string;
  private starting?: Promise<string>;
  private warming?: Promise<void>;
  private readyOrigin?: string;
  private readinessToken = randomBytes(32).toString('hex');
  private abort = new AbortController();
  private closed = false;
  private sweep: ReturnType<typeof setInterval>;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private directory: string, private options: { publicOrigin?: string; lifetime?: number; now?: () => number } = {}) {
    this.router.get('/.ready/:token', (req, res) => {
      if (req.params.token !== this.readinessToken) return res.status(404).end();
      res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }).type('text').send(`frame-reference-ready:${this.readinessToken}`);
    });
    this.router.get('/:token/:filename', async (req, res, next) => {
      const grant = this.grants.get(String(req.params.token));
      if (!grant || grant.expires <= this.now() || req.params.filename !== grant.filename) return res.status(404).end();
      res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.type(grant.mime).sendFile(grant.path, { dotfiles: 'allow' }, error => { if (error && !res.headersSent) next(error); });
    });
    // This router can also run on its own. It never serves studio pages or APIs.
    this.router.use((_req, res) => { res.status(404).end(); });
    this.router.use(((error: { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) return next(error);
      res.status(error.status === 416 ? 416 : 404).end();
    }) as express.ErrorRequestHandler);
    this.sweep = setInterval(() => { void this.prune(); }, 60_000);
    this.sweep.unref();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private lifetime() { return this.options.lifetime ?? LIFETIME; }

  async publish(source: ReferenceSource): Promise<PublishedReference> {
    if (this.closed) throw new ApiError(503, 'Reference hosting is shutting down. Please retry after restarting Frame.');
    if (!['video', 'audio'].includes(source.kind)) throw new ApiError(400, 'Only video and audio inputs need HTTPS hosting.');
    const info = await stat(source.path);
    if (!info.isFile() || info.size > MAX_REFERENCE_BYTES) throw new ApiError(413, 'Prepare this input below 25 MB before generating.');
    this.cancelIdle();
    const origin = this.options.publicOrigin ? httpsOrigin(this.options.publicOrigin) : await this.ensureTunnel();
    if (!this.options.publicOrigin && this.readyOrigin !== origin) {
      this.warming ??= waitForReferenceEndpoint(origin, `${REFERENCE_PATH}/.ready/${this.readinessToken}`, `frame-reference-ready:${this.readinessToken}`, { signal: this.abort.signal }).then(() => { this.readyOrigin = origin; }).finally(() => { this.warming = undefined; });
      await this.warming;
    }
    if (!this.options.publicOrigin && (!this.tunnel || this.tunnel.exitCode !== null || this.tunnel.killed || this.origin !== origin)) throw new ApiError(503, 'HTTPS reference sharing was interrupted. Please retry. No generation was submitted.');
    const id = randomBytes(32).toString('hex');
    const extension = ({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/ogg': 'ogv', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm' } as Record<string, string>)[source.mime];
    if (!extension) throw new ApiError(400, 'Prepare this reference as MP4 video or WAV audio before generating.');
    const filename = `input.${extension}`;
    const path = resolve(this.directory, `${id}.${extension}`);
    await mkdir(this.directory, { recursive: true });
    // A snapshot stays valid even if the user deletes or re-edits the library asset.
    await copyFile(source.path, path);
    if (this.closed) { await unlink(path).catch(() => {}); throw new ApiError(503, 'Reference hosting was stopped. Please retry.'); }
    this.grants.set(id, { path, mime: source.mime, filename, expires: this.now() + this.lifetime() });
    this.cancelIdle();
    return { id, url: `${origin}${REFERENCE_PATH}/${id}/${filename}` };
  }
  renew(ids: string[]) { for (const id of ids) { const grant = this.grants.get(id); if (grant) grant.expires = this.now() + this.lifetime(); } }
  async release(ids: string[]) {
    const paths: string[] = [];
    for (const id of ids) { const grant = this.grants.get(id); if (grant) { paths.push(grant.path); this.grants.delete(id); } }
    await Promise.allSettled(paths.map(path => unlink(path)));
    if (!this.grants.size && !this.closed && !this.idle && !this.starting && !this.warming) {
      this.idle = setTimeout(() => { this.stopTunnel(); this.idle = undefined; }, 10 * 60_000);
      this.idle.unref();
    }
  }
  private async prune() {
    await this.release([...this.grants.entries()].filter(([, grant]) => grant.expires <= this.now()).map(([id]) => id));
    // Clean snapshots left behind by an interrupted process after their lifetime.
    const files = await readdir(this.directory).catch(() => []);
    await Promise.allSettled(files.filter(name => /^[a-f0-9]{64}\.[a-z0-9]+$/.test(name) && !this.grants.has(name.split('.')[0])).map(async name => {
      const path = resolve(this.directory, name);
      if ((await stat(path)).mtimeMs < this.now() - this.lifetime()) await unlink(path);
    }));
  }
  private async ensureTunnel() {
    this.cancelIdle();
    if (this.origin && this.tunnel && this.tunnel.exitCode === null && !this.tunnel.killed) return this.origin;
    if (!this.starting) this.starting = this.startTunnel().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async startTunnel() {
    // cloudflared is imported lazily so text/image generations need no tunnel or binary.
    const { bin, install } = await import('cloudflared');
    const binary = process.env.CLOUDFLARED_BIN || bin;
    try { await access(binary); }
    catch {
      if (process.env.CLOUDFLARED_BIN) throw new ApiError(503, 'The configured cloudflared executable was not found. Check CLOUDFLARED_BIN.');
      try { await install(binary); } catch { throw new ApiError(503, 'Could not install HTTPS reference sharing. Check your connection, or run npm exec cloudflared bin install and retry.'); }
    }
    if (this.closed) throw new ApiError(503, 'Reference hosting was stopped.');
    if (!this.server) {
      const application = express(); application.disable('x-powered-by'); application.use(REFERENCE_PATH, this.router); application.use((_req, res) => { res.status(404).end(); });
      this.server = createServer(application);
      await new Promise<void>((resolvePromise, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', () => { this.server!.off('error', reject); resolvePromise(); }); });
      this.server.unref();
    }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new ApiError(503, 'Could not start HTTPS reference sharing.');
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${address.port}`, '--protocol', 'http2', '--metrics', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.tunnel = child;
    // No request URLs, tokens, file contents, or API keys are written to logs.
    const origin = await new Promise<string>((resolvePromise, reject) => {
      let announced: string | undefined;
      let connected = false;
      let settled = false;
      let recent = '';
      const timer = setTimeout(() => fail(), 60_000);
      const fail = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill('SIGTERM');
        reject(new ApiError(503, 'Could not establish HTTPS links for video/audio references. Check your connection and retry, or configure REFERENCE_PUBLIC_ORIGIN for your hosted server.'));
      };
      const output = (data: Buffer) => {
        recent = (recent + data.toString()).slice(-16000);
        const match = recent.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
        if (match) announced = match[0];
        if (/Registered tunnel connection/.test(recent)) connected = true;
        if (announced && connected && !settled) {
          settled = true; clearTimeout(timer); resolvePromise(httpsOrigin(announced));
        }
      };
      child.stdout.on('data', output); child.stderr.on('data', output);
      child.on('error', fail);
      child.on('exit', () => { if (this.tunnel === child) { this.origin = undefined; this.readyOrigin = undefined; this.tunnel = undefined; } fail(); });
    });
    if (this.closed || child.exitCode !== null || child.killed) throw new ApiError(503, 'HTTPS reference sharing was interrupted. Please retry.');
    this.origin = origin;
    return origin;
  }
  private cancelIdle() { if (this.idle) clearTimeout(this.idle); this.idle = undefined; }
  private stopTunnel() { this.origin = undefined; this.readyOrigin = undefined; this.tunnel?.kill('SIGTERM'); this.tunnel = undefined; }
  async close() {
    this.closed = true; this.abort.abort(); clearInterval(this.sweep); this.cancelIdle();
    this.stopTunnel(); this.server?.closeAllConnections(); this.server?.close();
    await this.release([...this.grants.keys()]);
  }
}
