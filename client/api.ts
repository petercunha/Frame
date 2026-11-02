export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers } });
  } catch { throw new Error('Could not reach the studio. Check your connection and try again.'); }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status}). Please try again.`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
