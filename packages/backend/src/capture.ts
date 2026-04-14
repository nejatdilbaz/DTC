import path from 'path';
import fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { VisionStateMachine, AdAction } from './vision';

// ── Constants ─────────────────────────────────────────────────────────────────

export type Orientation = 'portrait' | 'landscape';

const VIEWPORT: Record<Orientation, { width: number; height: number }> = {
  portrait:  { width: 412, height: 915 },
  landscape: { width: 915, height: 412 },
};

const DEVICE_SCALE_FACTOR = 2;

// Target frame interval in ms. Puppeteer screenshot latency typically keeps
// real throughput at 15–25 fps; we record actual timestamps and report the
// true average fps to ffmpeg so timing stays accurate.
const FRAME_INTERVAL_MS = 33; // ~30 fps target

const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  url: string;
  orientation: Orientation;
  /** Recording duration in seconds */
  duration: number;
  /** Optional override for the output directory */
  outputDir?: string;
  /** Optional Anthropic API key; falls back to ANTHROPIC_API_KEY env var */
  anthropicApiKey?: string;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Launches a headless Chromium instance, navigates to `url`, runs the
 * AI-powered phase state machine to drive interactions, streams
 * Puppeteer screenshot buffers directly into an ffmpeg stdin pipe, and
 * encodes a QuickTime-compatible .MOV file using H.264 at CRF 18.
 *
 * @returns Absolute path of the completed .mov file.
 */
export async function captureAdUnit(options: CaptureOptions): Promise<string> {
  const { url, orientation, duration, outputDir = RECORDINGS_DIR, anthropicApiKey } = options;

  fs.mkdirSync(outputDir, { recursive: true });

  const jobId      = uuidv4();
  const outputFile = path.join(outputDir, `${jobId}.mov`);

  const { width, height } = VIEWPORT[orientation];
  const physicalWidth      = width  * DEVICE_SCALE_FACTOR;
  const physicalHeight     = height * DEVICE_SCALE_FACTOR;

  let browser: Browser | null = null;
  const vision = new VisionStateMachine(anthropicApiKey);

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        // Required to prevent video buffering / rendering stalls in headless mode
        '--disable-gpu-sandbox',
        '--use-gl=angle',
        // Additional stability flags for headless rendering
        '--disable-software-rasterizer',
        '--ignore-gpu-blocklist',
      ],
    });

    const page: Page = await browser.newPage();

    await page.setViewport({
      width,
      height,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

    // Run an immediate first check so we know the starting phase before any
    // frames are captured, then let the machine schedule subsequent checks.
    await vision.checkPhase(page);
    vision.start(page);

    // ── Frame capture loop ────────────────────────────────────────────────────

    const frames: Buffer[]          = [];
    const frameTimestamps: number[] = [];

    const captureStart = Date.now();
    const durationMs   = duration * 1_000;

    await new Promise<void>((resolveCapture, rejectCapture) => {
      const tick = async () => {
        if (Date.now() - captureStart >= durationMs) {
          resolveCapture();
          return;
        }

        try {
          // Execute interaction dictated by the vision state machine BEFORE
          // taking the screenshot so the recorded frame reflects the result.
          await executeAction(page, vision.currentAction(), width, height);

          const buf = await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: physicalWidth, height: physicalHeight },
          }) as Buffer;

          frames.push(buf);
          frameTimestamps.push(Date.now());

          const elapsed   = Date.now() - captureStart;
          const tickStart = frameTimestamps.at(-1) ?? captureStart;
          const nextDelay = Math.max(0, FRAME_INTERVAL_MS - (Date.now() - tickStart));

          if (elapsed + nextDelay < durationMs) {
            setTimeout(() => void tick().catch(rejectCapture), nextDelay);
          } else {
            resolveCapture();
          }
        } catch (err) {
          rejectCapture(err);
        }
      };

      setTimeout(() => void tick().catch(rejectCapture), 0);
    });

    vision.stop();
    await browser.close();
    browser = null;

    if (frames.length === 0) {
      throw new Error('No frames were captured.');
    }

    // Compute the true average fps from recorded timestamps.
    const actualDurationSec =
      (frameTimestamps[frameTimestamps.length - 1] - frameTimestamps[0]) / 1_000;
    const measuredFps = Math.round(frames.length / Math.max(actualDurationSec, 0.001));
    const inputFps    = Math.min(Math.max(measuredFps, 1), 60);

    console.log(
      `[capture] ${frames.length} frames in ${actualDurationSec.toFixed(2)}s → ${inputFps} fps`,
    );

    await encodeFramesToMov(frames, inputFps, physicalWidth, physicalHeight, outputFile);

    return outputFile;
  } finally {
    vision.stop();
    await browser?.close();
  }
}

// ── Interaction executor ──────────────────────────────────────────────────────

/**
 * Execute the action prescribed by the state machine on the given page.
 *
 * - `wait`        : no-op.
 * - `tap`         : single mouse click at the logical viewport centre.
 * - `swipe-catch` : a horizontal swipe across the centre of the viewport,
 *                   simulating the catching gesture used in collect/catch games.
 *                   Direction alternates each call so the item is "caught"
 *                   from both sides across the 25 s window.
 */
let swipeDirection: 1 | -1 = 1; // +1 = left→right, -1 = right→left

async function executeAction(
  page: Page,
  action: AdAction,
  viewportWidth: number,
  viewportHeight: number,
): Promise<void> {
  const cx = viewportWidth  / 2;
  const cy = viewportHeight / 2;

  switch (action) {
    case 'wait':
      return;

    case 'tap':
      await page.mouse.click(cx, cy);
      return;

    case 'swipe-catch': {
      // Swipe 40% of the viewport width in the current direction.
      const swipeRange = viewportWidth * 0.4;
      const startX     = cx - swipeDirection * swipeRange / 2;
      const endX       = cx + swipeDirection * swipeRange / 2;

      await page.mouse.move(startX, cy);
      await page.mouse.down();
      // Interpolate across 10 steps to produce a smooth gesture.
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
          startX + (endX - startX) * (i / steps),
          cy,
          { steps: 1 },
        );
        await delay(8);
      }
      await page.mouse.up();

      swipeDirection = swipeDirection === 1 ? -1 : 1;
      return;
    }
  }
}

// ── Encoding ──────────────────────────────────────────────────────────────────

/**
 * Writes `frames` (PNG buffers) into an ffmpeg stdin pipe and encodes them
 * as an H.264 .MOV file with CRF 18 and yuv420p pixel format.
 */
function encodeFramesToMov(
  frames: Buffer[],
  fps: number,
  width: number,
  height: number,
  outputFile: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const evenWidth  = width  % 2 === 0 ? width  : width  - 1;
    const evenHeight = height % 2 === 0 ? height : height - 1;

    const command = ffmpeg()
      .input('pipe:0')
      .inputOptions([
        '-f image2pipe',
        '-vcodec png',
        `-framerate ${fps}`,
      ])
      .videoCodec('libx264')
      .outputOptions([
        '-crf 18',
        '-pix_fmt yuv420p',
        '-movflags +faststart',
        `-vf scale=${evenWidth}:${evenHeight}`,
      ])
      .output(outputFile)
      .on('start', (cmd: string) => console.log('[ffmpeg] started:', cmd))
      .on('end', () => {
        console.log('[ffmpeg] encoding complete:', outputFile);
        resolve();
      })
      .on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
        console.error('[ffmpeg] error:', err.message);
        if (stderr) console.error('[ffmpeg] stderr:', stderr);
        reject(err);
      });

    const ffmpegProc = command.run() as unknown as { stdin?: NodeJS.WritableStream };
    const proc =
      ffmpegProc?.stdin
        ? ffmpegProc
        : (command as unknown as { _ffmpegProc?: { stdin?: NodeJS.WritableStream } })
            ._ffmpegProc;

    const stdin = proc?.stdin as NodeJS.WritableStream | undefined;

    if (!stdin) {
      reject(new Error('Could not obtain ffmpeg stdin stream.'));
      return;
    }

    (async () => {
      for (const frame of frames) {
        await new Promise<void>((res, rej) => {
          const canContinue = stdin.write(frame, (err) => {
            if (err) rej(err);
            else res();
          });
          if (!canContinue) stdin.once('drain', res);
        });
      }
      stdin.end();
    })().catch(reject);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
