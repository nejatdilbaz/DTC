import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import puppeteer, { Browser, Page } from 'puppeteer';
import ffmpeg from 'fluent-ffmpeg';

const app = express();
const PORT = process.env.PORT ?? 5000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json());

// Directory where recorded .mov files will be stored
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Serve completed recordings for download
app.use('/recordings', express.static(RECORDINGS_DIR));

// ── Types ─────────────────────────────────────────────────────────────────────
interface CaptureRequest {
  url: string;
  /** Duration of the recording in seconds (default: 10) */
  duration?: number;
  /** Viewport width (default: 1280) */
  width?: number;
  /** Viewport height (default: 720) */
  height?: number;
}

interface CaptureResult {
  jobId: string;
  filename: string;
  downloadUrl: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Launches a headless Chromium instance, navigates to `url`, captures
 * individual screenshots for `duration` seconds, then stitches them into a
 * QuickTime-compatible .mov file using ffmpeg.
 */
async function captureAdUnit(
  url: string,
  duration: number,
  width: number,
  height: number,
  jobId: string,
): Promise<string> {
  const framesDir = path.join(RECORDINGS_DIR, `frames-${jobId}`);
  fs.mkdirSync(framesDir, { recursive: true });

  const outputFile = path.join(RECORDINGS_DIR, `${jobId}.mov`);

  let browser: Browser | null = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page: Page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Capture frames at ~10 fps for the requested duration
    const fps = 10;
    const totalFrames = duration * fps;
    const frameInterval = 1000 / fps;

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, `frame-${String(i).padStart(5, '0')}.png`);
      await page.screenshot({ path: framePath });
      await new Promise((resolve) => setTimeout(resolve, frameInterval));
    }
  } finally {
    await browser?.close();
  }

  // Encode frames → .mov (H.264 inside a QuickTime container)
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, 'frame-%05d.png'))
      .inputOptions(['-framerate 10'])
      .videoCodec('libx264')
      .outputOptions([
        '-pix_fmt yuv420p',
        '-movflags +faststart',
      ])
      .output(outputFile)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });

  // Clean up temporary frame images
  fs.rmSync(framesDir, { recursive: true, force: true });

  return outputFile;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/capture
 * Body: { url, duration?, width?, height? }
 * Returns the job ID and a download URL for the finished .mov file.
 */
app.post('/api/capture', async (req: Request, res: Response, next: NextFunction) => {
  const { url, duration = 10, width = 1280, height = 720 } = req.body as CaptureRequest;

  if (!url) {
    res.status(400).json({ error: '`url` is required.' });
    return;
  }

  const jobId = uuidv4();

  try {
    await captureAdUnit(url, duration, width, height, jobId);

    const result: CaptureResult = {
      jobId,
      filename: `${jobId}.mov`,
      downloadUrl: `/recordings/${jobId}.mov`,
    };

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/recordings
 * Returns a list of previously recorded .mov files.
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
