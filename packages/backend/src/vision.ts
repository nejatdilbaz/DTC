import Anthropic from '@anthropic-ai/sdk';
import { Page } from 'puppeteer';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * The four phases an ad unit can be in.
 *
 * - `video`      : auto-playing pre-roll; nothing to interact with yet.
 * - `game_intro` : instruction screen ("Collect items", "Swipe to catch", etc.)
 * - `gameplay`   : the live interactive portion.
 * - `endcard`    : final call-to-action after gameplay ends.
 */
export type AdPhase = 'video' | 'game_intro' | 'gameplay' | 'endcard';

/**
 * The action `capture.ts` should execute during the current phase window.
 *
 * - `wait`        : do nothing (video pre-roll or endcard hold).
 * - `tap`         : single tap/click at the viewport centre.
 * - `swipe-catch` : horizontal swipe gestures to catch/collect falling items.
 */
export type AdAction = 'wait' | 'tap' | 'swipe-catch';

/** Raw structured response we expect back from Claude. */
interface VisionResponse {
  phase: AdPhase;
  action: AdAction;
  reasoning: string;
  /** Any collect/catch keywords Claude spotted in text on screen. */
  collectKeywords: string[];
}

/** Snapshot emitted by the state machine on every AI check. */
export interface PhaseSnapshot {
  phase: AdPhase;
  action: AdAction;
  reasoning: string;
  /** True when the heuristic memory override is in effect. */
  heuristicOverride: boolean;
  timestamp: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Seconds of forced swipe-catch action once collect/catch intent is locked. */
const SWIPE_CATCH_LOCK_DURATION_MS = 25_000;

/** Keywords that, when spotted during game_intro, activate the swipe-catch lock. */
const COLLECT_CATCH_KEYWORDS = ['collect', 'catch', 'stocking', 'basket'] as const;

/** How long to check the AI (ms). Randomised between CHECK_INTERVAL_MIN and MAX. */
const CHECK_INTERVAL_MIN_MS = 10_000;
const CHECK_INTERVAL_MAX_MS = 15_000;

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert at analyzing mobile ad screenshots.
You must respond ONLY with a JSON object — no markdown, no prose.

The JSON must have exactly these keys:
{
  "phase": "<video | game_intro | gameplay | endcard>",
  "action": "<wait | tap | swipe-catch>",
  "reasoning": "<one sentence>",
  "collectKeywords": ["<any collect/catch/stocking/basket words visible on screen>"]
}

Phase definitions:
- video: A video is auto-playing. There are no interactive UI elements yet.
- game_intro: An instruction screen is visible (e.g. "Collect items", "Swipe to catch", "Tap to play").
- gameplay: The interactive game is running — objects to interact with are present.
- endcard: A final CTA is shown ("Download", "Install Now", "Play Again") — the game has ended.

Action guidance (you may be overridden by external logic):
- video → wait
- game_intro → wait (let instructions finish)
- gameplay → choose tap or swipe-catch based on what you see
- endcard → wait

collectKeywords: List ONLY words/phrases from this set that are LITERALLY visible as text on screen:
  collect, catch, stocking, basket`.trim();

const USER_PROMPT = `Analyze this screenshot of a mobile ad unit. Respond with ONLY the JSON object.`;

// ── VisionStateMachine ────────────────────────────────────────────────────────

export class VisionStateMachine {
  private readonly client: Anthropic;

  // ── Heuristic memory ────────────────────────────────────────────────────────
  /** Set to true when collect/catch keywords are spotted during game_intro. */
  private collectCatchDetected = false;
  /** Timestamp (ms) when gameplay phase first began after a positive detection. */
  private gameplayStartedAt: number | null = null;

  // ── State ────────────────────────────────────────────────────────────────────
  private currentPhase: AdPhase = 'video';
  private lastSnapshot: PhaseSnapshot | null = null;

  // ── Interval handle ──────────────────────────────────────────────────────────
  private checkTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Start the state machine. It will probe the page every 10–15 seconds and
   * update internal state. The caller can read `currentAction()` at any time.
   */
  start(page: Page): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextCheck(page);
  }

  /** Stop the state machine and cancel any pending check. */
  stop(): void {
    this.running = false;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * The action that `capture.ts` should execute RIGHT NOW.
   * Applies the heuristic override before returning.
   */
  currentAction(): AdAction {
    return this.resolveAction(this.lastSnapshot?.action ?? 'wait');
  }

  /** The phase that was last detected. */
  currentPhase_(): AdPhase {
    return this.currentPhase;
  }

  /** The most recent snapshot, or null before the first check completes. */
  latestSnapshot(): PhaseSnapshot | null {
    return this.lastSnapshot;
  }

  // ── Core check ────────────────────────────────────────────────────────────────

  /**
   * Take a viewport screenshot, send it to Claude, parse the response, update
   * the state machine, and schedule the next check.
   */
  async checkPhase(page: Page): Promise<PhaseSnapshot> {
    const screenshotBuf = await page.screenshot({ type: 'png' }) as Buffer;
    const base64Image   = screenshotBuf.toString('base64');

    let visionResponse: VisionResponse;

    try {
      visionResponse = await this.callClaude(base64Image);
    } catch (err) {
      // On API failure, preserve the last known state so capture continues.
      console.error('[vision] Claude API error:', (err as Error).message);
      visionResponse = {
        phase: this.currentPhase,
        action: this.lastSnapshot?.action ?? 'wait',
        reasoning: 'AI check failed — maintaining last known state.',
        collectKeywords: [],
      };
    }

    this.updateMemory(visionResponse);

    const action      = this.resolveAction(visionResponse.action);
    const isOverride  = action !== visionResponse.action;

    const snapshot: PhaseSnapshot = {
      phase:             visionResponse.phase,
      action,
      reasoning:         visionResponse.reasoning,
      heuristicOverride: isOverride,
      timestamp:         Date.now(),
    };

    this.currentPhase = visionResponse.phase;
    this.lastSnapshot = snapshot;

    console.log(
      `[vision] phase=${snapshot.phase} action=${snapshot.action}` +
      (isOverride ? ' [heuristic-override]' : '') +
      ` — ${snapshot.reasoning}`,
    );

    return snapshot;
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private scheduleNextCheck(page: Page): void {
    if (!this.running) return;

    const delay =
      CHECK_INTERVAL_MIN_MS +
      Math.random() * (CHECK_INTERVAL_MAX_MS - CHECK_INTERVAL_MIN_MS);

    this.checkTimer = setTimeout(() => {
      void this.checkPhase(page)
        .catch((err) => console.error('[vision] checkPhase error:', (err as Error).message))
        .finally(() => this.scheduleNextCheck(page));
    }, delay);
  }

  /**
   * Update heuristic memory based on the latest AI response.
   *
   * Rules:
   * 1. If we're in `game_intro` and Claude spotted any collect/catch keywords,
   *    latch `collectCatchDetected = true` permanently.
   * 2. If we transition into `gameplay` and `collectCatchDetected` is true,
   *    record when gameplay started so we can apply the 25 s lock window.
   */
  private updateMemory(response: VisionResponse): void {
    // Rule 1: latch keyword detection during game_intro
    if (response.phase === 'game_intro' && !this.collectCatchDetected) {
      const foundKeyword = response.collectKeywords.some((kw) =>
        COLLECT_CATCH_KEYWORDS.includes(kw.toLowerCase() as typeof COLLECT_CATCH_KEYWORDS[number]),
      );
      if (foundKeyword) {
        this.collectCatchDetected = true;
        console.log(
          '[vision] heuristic lock activated — collect/catch intent detected:',
          response.collectKeywords.join(', '),
        );
      }
    }

    // Rule 2: record gameplay start time (only once, only when lock is armed)
    if (
      response.phase === 'gameplay' &&
      this.collectCatchDetected &&
      this.currentPhase !== 'gameplay'
    ) {
      this.gameplayStartedAt = Date.now();
      console.log('[vision] gameplay started — swipe-catch lock engaged for 25 s');
    }
  }

  /**
   * Apply the heuristic override:
   * If the lock is armed AND we are in gameplay AND within the 25 s window,
   * force `swipe-catch` regardless of what Claude returned.
   */
  private resolveAction(aiAction: AdAction): AdAction {
    if (
      this.collectCatchDetected &&
      this.currentPhase === 'gameplay' &&
      this.gameplayStartedAt !== null &&
      Date.now() - this.gameplayStartedAt < SWIPE_CATCH_LOCK_DURATION_MS
    ) {
      return 'swipe-catch';
    }
    return aiAction;
  }

  /** Call Claude claude-3-5-sonnet with the screenshot and return parsed JSON. */
  private async callClaude(base64Image: string): Promise<VisionResponse> {
    const message = await this.client.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: USER_PROMPT,
            },
          ],
        },
      ],
    });

    const raw = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    return this.parseResponse(raw);
  }

  /**
   * Parse Claude's response. Strips any accidental markdown fences before
   * JSON.parse so the pipeline is resilient to minor model formatting drift.
   */
  private parseResponse(raw: string): VisionResponse {
    const cleaned = raw
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim();

    let parsed: Partial<VisionResponse>;
    try {
      parsed = JSON.parse(cleaned) as Partial<VisionResponse>;
    } catch {
      throw new Error(`Could not parse Claude response as JSON: ${raw.slice(0, 200)}`);
    }

    const validPhases: AdPhase[]  = ['video', 'game_intro', 'gameplay', 'endcard'];
    const validActions: AdAction[] = ['wait', 'tap', 'swipe-catch'];

    const phase  = validPhases.includes(parsed.phase  as AdPhase)  ? (parsed.phase  as AdPhase)  : 'video';
    const action = validActions.includes(parsed.action as AdAction) ? (parsed.action as AdAction) : 'wait';

    return {
      phase,
      action,
      reasoning:       typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      collectKeywords: Array.isArray(parsed.collectKeywords)
        ? (parsed.collectKeywords as string[]).filter((k) => typeof k === 'string')
        : [],
    };
  }
}
