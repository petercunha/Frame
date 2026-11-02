import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ApiProvider } from '../shared/types';

export const providerSchema = z.enum(['openrouter', 'wan']);
const workspaceSchema = z.object({
  provider: providerSchema,
  keys: z.object({ openrouter: z.string().optional(), wan: z.string().optional() }),
});
type Workspace = z.infer<typeof workspaceSchema>;

// Kept separate from exportable studio data. Never returned by the API.
export class Connections {
  private workspaces: Record<string, Workspace> = {};
  private writes: Promise<void> = Promise.resolve();
  private readonly path: string;
  constructor(directory: string) { this.path = resolve(directory, 'credentials.json'); }
  async init() {
    try {
      this.workspaces = z.record(z.string().regex(/^[a-f0-9]{64}$/), workspaceSchema).parse(JSON.parse(await readFile(this.path, 'utf8')));
      await chmod(this.path, 0o600);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  provider(owner: string): ApiProvider { return this.workspaces[owner]?.provider ?? 'openrouter'; }
  key(owner: string, provider: ApiProvider) { return this.workspaces[owner]?.keys[provider]; }
  update(owner: string, provider: ApiProvider, key?: string | null) {
    const operation = this.writes.then(async () => {
      const workspace = structuredClone(this.workspaces[owner] ?? { provider, keys: {} });
      workspace.provider = provider;
      if (key === null) delete workspace.keys[provider];
      else if (key !== undefined) workspace.keys[provider] = key;
      const next = { ...this.workspaces, [owner]: workspace };
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      this.workspaces = next;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
