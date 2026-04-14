import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { captureAdUnit, Orientation } from './capture';

const app = express();
const PORT = process.env.PORT ?? 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json());

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

app.use('/recordings', express.static(RECORDINGS_DIR));

// ── Types ─────────────────────────────────────────────────────────────────────
interface CaptureRequest {
  url: string;
  orientation?: Orientation;
  /** Duration in seconds (default: 10) */
  duration?: number;
  /** Anthropic API key; overrides ANTHROPIC_API_KEY env var if provided */
  anthropicApiKey?: string;
}

interface CaptureResult {
  jobId: string;
  filename: string;
  downloadUrl: string;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/capture
 * Body: { url, orientation?, duration? }
 */
app.post('/api/capture', async (req: Request, res: Response, next: NextFunction) => {
  const { url, orientation = 'landscape', duration = 10, anthropicApiKey } = req.body as CaptureRequest;

  if (!url) {
    res.status(400).json({ error: '`url` is required.' });
    return;
  }

  if (orientation !== 'portrait' && orientation !== 'landscape') {
    res.status(400).json({ error: '`orientation` must be "portrait" or "landscape".' });
    return;
  }

  try {
    const outputPath = await captureAdUnit({
      url,
      orientation,
      duration,
      outputDir: RECORDINGS_DIR,
      anthropicApiKey,
    });

    const filename = path.basename(outputPath);
    const jobId    = filename.replace('.mov', '');

    const result: CaptureResult = {
      jobId,
      filename,
      downloadUrl: `/recordings/${filename}`,
    };

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/recordings
 * Returns a list of previously recorded .mov files, newest-first.
 */
app.get('/api/recordings', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const files = fs
      .readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith('.mov'))
      .map((filename) => ({
        filename,
        downloadUrl: `/recordings/${filename}`,
        createdAt: fs.statSync(path.join(RECORDINGS_DIR, filename)).birthtime,
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json({ recordings: files });
  } catch (err) {
    next(err);
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: err.message ?? 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Ad Preview Capture backend listening on http://localhost:${PORT}`);
});

export default app;
