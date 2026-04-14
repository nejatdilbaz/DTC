import type { CaptureRequest, CaptureResult, Recording } from './types';

const BASE = '/api';

export async function captureAdUnit(req: CaptureRequest): Promise<CaptureResult> {
  const res = await fetch(`${BASE}/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error ?? res.statusText);
  }

  return res.json() as Promise<CaptureResult>;
}

export async function fetchRecordings(): Promise<Recording[]> {
  const res = await fetch(`${BASE}/recordings`);
  if (!res.ok) throw new Error('Failed to load recordings');
  const data = (await res.json()) as { recordings: Recording[] };
  return data.recordings;
}
