// Establish the HttpOnly workspace cookie once before concurrent startup reads.
// Otherwise a slower first response could replace the session after an upload.
let sessionReady: Promise<void> | undefined;
function ensureSession() {
  sessionReady ??= fetch('/api/health').then(response => {
    if (!response.ok) throw new Error('The studio is not ready.');
  }).catch(error => { sessionReady = undefined; throw error; });
  return sessionReady;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    await ensureSession();
    response = await fetch(`/api${path}`, { ...init, headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers } });
  } catch { throw new Error('Could not reach the studio. Check your connection and try again.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export async function uploadAssets<T>(files: File[], onProgress: (progress: number) => void): Promise<T> {
  await ensureSession();
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/assets');
    request.responseType = 'json';
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onerror = () => reject(new Error('The upload was interrupted. Your original file is unchanged; please try again.'));
    request.onabort = () => reject(new Error('The upload was cancelled.'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve(request.response);
      else reject(new Error(request.response?.error || `Upload failed (${request.status}). Please try again.`));
    };
    const data = new FormData(); files.forEach(file => data.append('files', file));
    request.send(data);
  });
}
