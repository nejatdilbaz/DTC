import { useState, useEffect, useCallback } from 'react';
import { captureAdUnit, fetchRecordings } from './api';
import type { CaptureStatus, Recording } from './types';

const DEFAULT_DURATION = 10;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

export default function App() {
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [latestDownload, setLatestDownload] = useState('');

  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(false);

  const loadRecordings = useCallback(async () => {
    setLoadingRecordings(true);
    try {
      setRecordings(await fetchRecordings());
    } catch {
      // non-critical — silently ignore
    } finally {
      setLoadingRecordings(false);
    }
  }, []);

  useEffect(() => {
    void loadRecordings();
  }, [loadRecordings]);

  const handleCapture = async () => {
    if (!url.trim()) return;
    setStatus('capturing');
    setErrorMsg('');
    setLatestDownload('');

    try {
      const result = await captureAdUnit({ url: url.trim(), duration, width, height });
      setLatestDownload(result.downloadUrl);
      setStatus('done');
      void loadRecordings();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  };

  const isCapturing = status === 'capturing';

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900 px-6 py-4">
        <div className="mx-auto max-w-5xl flex items-center gap-3">
          <span className="text-2xl">🎬</span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Ad Preview Capture</h1>
            <p className="text-xs text-gray-400">Load AdUnit / Craftsman+ URLs and record to .MOV</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10 space-y-10">
        {/* Capture Form */}
        <section className="rounded-2xl border border-gray-800 bg-gray-900 p-6 space-y-6">
          <h2 className="text-lg font-semibold">New Capture</h2>

          {/* URL */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-300" htmlFor="url">
              Ad Unit URL
            </label>
            <input
              id="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-adunit-or-craftsman-url.com"
              disabled={isCapturing}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm placeholder-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* Options row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberInput
              id="duration"
              label="Duration (s)"
              value={duration}
              min={1}
              max={120}
              disabled={isCapturing}
              onChange={setDuration}
            />
            <NumberInput
              id="width"
              label="Width (px)"
              value={width}
              min={320}
              max={3840}
              disabled={isCapturing}
              onChange={setWidth}
            />
            <NumberInput
              id="height"
              label="Height (px)"
              value={height}
              min={240}
              max={2160}
              disabled={isCapturing}
              onChange={setHeight}
            />
          </div>

          {/* Feedback */}
          {status === 'done' && latestDownload && (
            <div className="rounded-lg border border-emerald-700 bg-emerald-950 px-4 py-3 text-sm text-emerald-300 flex items-center justify-between gap-4">
              <span>Recording complete!</span>
              <a
                href={latestDownload}
                download
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 transition-colors"
              >
                Download .MOV
              </a>
            </div>
          )}

          {status === 'error' && (
            <div className="rounded-lg border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-300">
              <span className="font-medium">Error: </span>{errorMsg}
            </div>
          )}

          {/* CTA */}
          <button
            onClick={() => void handleCapture()}
            disabled={isCapturing || !url.trim()}
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isCapturing ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner />
                Capturing… this may take a moment
              </span>
            ) : (
              'Start Capture'
            )}
          </button>
        </section>

        {/* Recordings List */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Previous Recordings</h2>
            <button
              onClick={() => void loadRecordings()}
              disabled={loadingRecordings}
              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors"
            >
              {loadingRecordings ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {recordings.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">
              No recordings yet. Start a capture above.
            </p>
          ) : (
            <ul className="divide-y divide-gray-800 rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden">
              {recordings.map((rec) => (
                <RecordingRow key={rec.filename} recording={rec} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface NumberInputProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
}

function NumberInput({ id, label, value, min, max, disabled, onChange }: NumberInputProps) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-300" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
      />
    </div>
  );
}

interface RecordingRowProps {
  recording: Recording;
}

function RecordingRow({ recording }: RecordingRowProps) {
  const date = new Date(recording.createdAt);
  const label = isNaN(date.getTime())
    ? recording.filename
    : date.toLocaleString();

  return (
    <li className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-800/50 transition-colors">
      <div>
        <p className="text-sm font-medium truncate max-w-xs">{recording.filename}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
      <a
        href={recording.downloadUrl}
        download
        className="ml-4 shrink-0 rounded-md border border-indigo-700 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-900 transition-colors"
      >
        Download
      </a>
    </li>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}
