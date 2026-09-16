/**
 * Talking to the OceanSpill server.
 *
 * The site runs two ways. Without VITE_API_URL it reads the case files the pipeline wrote and keeps
 * changes in this browser, which is how the recorded-case demo runs. With VITE_API_URL set it signs
 * in against real accounts and every change goes to the server. The pages are the same either way:
 * the server hands back the same JSON the files contain.
 */

const RAW_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
export const API_BASE = RAW_BASE.replace(/\/+$/, '');
export const serverMode = API_BASE.length > 0;

const TOKEN_KEY = 'oceanspill.token.v1';

export class ApiError extends Error {
  readonly status: number;
  /** The server is asking for the code from the account's authenticator app. */
  readonly mfaRequired: boolean;

  constructor(status: number, message: string, mfaRequired = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.mfaRequired = mfaRequired;
  }
}

export interface Account {
  id: string;
  name: string;
  email: string;
  role: string;
  agency: string;
  status: 'Active' | 'Suspended' | 'Pending';
  clearance: 'Restricted' | 'Confidential' | 'Secret';
  lastLogin: number;
  mfa: boolean;
  hasPassword: boolean;
}

export interface ServerNotification {
  id: number;
  createdAt: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string;
  target: string | null;
  module: string | null;
}

let token: string | null = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  // Storage disabled: the sign-in simply lasts until the page is closed.
}

/** Called when the server says the session is over, so the app can return to the sign-in screen. */
let onSignedOut: (() => void) | null = null;

export function setSignedOutHandler(fn: (() => void) | null) {
  onSignedOut = fn;
}

export function hasToken(): boolean {
  return Boolean(token);
}

function keepToken(value: string | null) {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Not kept between visits; the app still works for this one.
  }
}

function headers(extra?: HeadersInit): Headers {
  const h = new Headers(extra);
  if (token) h.set('Authorization', `Bearer ${token}`);
  return h;
}

async function failure(res: Response): Promise<ApiError> {
  let message = `Request failed (HTTP ${res.status})`;
  let mfa = false;
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === 'string') message = detail;
    else if (detail && typeof detail === 'object') {
      message = detail.message ?? message;
      mfa = Boolean(detail.mfaRequired);
    } else if (Array.isArray(body?.detail)) {
      message = body.detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join('; ') || message;
    }
  } catch {
    // Not a JSON body; the status text is all there is.
  }
  return new ApiError(res.status, message, mfa);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: headers(init.headers) });
  if (res.status === 401 && token) {
    // The session expired or was ended elsewhere.
    keepToken(null);
    onSignedOut?.();
  }
  if (!res.ok) throw await failure(res);
  return res;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => send<T>('GET', path),
  post: <T>(path: string, body?: unknown) => send<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => send<T>('PATCH', path, body),

  /** A case artifact or supporting file, at the same path the static site uses. */
  data: <T>(path: string) => send<T>('GET', `/api/data/${path}`),

  /** A file the browser cannot fetch with a header, such as a SAR quicklook, as an object URL. */
  async objectUrl(path: string): Promise<string> {
    const res = await request(`/api/data/${path}`);
    return URL.createObjectURL(await res.blob());
  },

  async download(path: string, init?: RequestInit): Promise<{ blob: Blob; filename: string }> {
    const res = await request(path, init);
    const disposition = res.headers.get('content-disposition') ?? '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return { blob: await res.blob(), filename: match?.[1] ?? 'document.pdf' };
  },
};

export async function signIn(email: string, password: string, code?: string): Promise<Account> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, code: code || null }),
  });
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as { token: string; user: Account };
  keepToken(body.token);
  return body.user;
}

export async function signOut(): Promise<void> {
  try {
    await api.post('/api/auth/logout');
  } catch {
    // Already gone as far as the server is concerned; clearing the token locally is enough.
  }
  keepToken(null);
}

export function whoAmI(): Promise<Account> {
  return api.get<Account>('/api/auth/me');
}

export function changePassword(current: string, next: string): Promise<{ ok: boolean }> {
  return api.post('/api/auth/password', { current, new: next });
}

export function startMfaSetup(): Promise<{ secret: string; uri: string }> {
  return api.post('/api/auth/mfa/setup');
}

export function enableMfa(code: string): Promise<Account> {
  return api.post('/api/auth/mfa/enable', { code });
}

/**
 * Live notifications. EventSource cannot send an Authorization header and a token in the URL would
 * end up in server logs, so the stream is read from a normal authenticated response instead.
 */
export function streamNotifications(since: number, onNotification: (n: ServerNotification) => void): () => void {
  const controller = new AbortController();

  (async () => {
    let cursor = since;
    // Reconnect with a widening gap, so a server restart does not turn into a request flood.
    for (let attempt = 0; !controller.signal.aborted; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/api/events?since=${cursor}`, {
          headers: headers({ Accept: 'text/event-stream' }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream failed: HTTP ${res.status}`);
        attempt = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut = buffer.indexOf('\n\n');
          while (cut >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            cut = buffer.indexOf('\n\n');
            const data = frame.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim();
            if (!data) continue;
            const payload = JSON.parse(data);
            if (frame.includes('event: notification')) {
              cursor = payload.id;
              onNotification(payload as ServerNotification);
            } else if (typeof payload.since === 'number') {
              cursor = payload.since;
            }
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4))));
    }
  })();

  return () => controller.abort();
}
