/**
 * CapacitorSttEngine restart-stitching (meditation-pal-cddo).
 *
 * Android's SpeechRecognizer endpoints on a short pause; the engine treats each
 * end-of-speech as a segment boundary and relaunches, only submitting the turn
 * after the configured silence window. The native plugin is mocked so we can
 * drive its event contract by hand: partials arrive as 'partialResults', the
 * segment's FINAL transcript arrives as a 'partialResults' event AFTER a
 * 'listeningState: stopped', and start() resolves empty in partial mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const H = vi.hoisted(() => ({
    listeners: new Map<string, (d: unknown) => void>(),
    // The PATCHED plugin (patches/) fires listeningState 'ready' from
    // onReadyForSpeech when the recognizer comes up; the engine's startup
    // watchdog keys on it. Mirror that by default so launches don't look hung
    // (a specific test overrides this to simulate one). The stock plugin's
    // 'started' is onBeginningOfSpeech - user SPEECH, not launch - and never
    // fires on a quiet mic.
    start: vi.fn(async () => {
        H.listeners.get('listeningState')?.({ status: 'ready' });
        return undefined as unknown;
    }),
    stop: vi.fn(async () => undefined as unknown),
}));

vi.mock('@capacitor-community/speech-recognition', () => ({
    SpeechRecognition: {
        available: async () => ({ available: true }),
        checkPermissions: async () => ({ speechRecognition: 'granted' }),
        requestPermissions: async () => ({ speechRecognition: 'granted' }),
        start: H.start,
        stop: H.stop,
        addListener: async (event: string, cb: (d: unknown) => void) => {
            H.listeners.set(event, cb);
            return { remove: async () => {} };
        },
    },
}));

import { CapacitorSttEngine } from '../ui/src/adapters/capacitor-stt.js';
import type { SttEvent } from '../src/platform/stt.js';

// Consume the engine's async iterator in the background, collecting events.
function collect(engine: CapacitorSttEngine): { events: SttEvent[]; finished: Promise<void> } {
    const events: SttEvent[] = [];
    const finished = (async () => {
        for await (const e of engine.start()) events.push(e);
    })();
    return { events, finished };
}

const partial = (text: string): void =>
    H.listeners.get('partialResults')?.({ matches: [text] });
const stopped = (): void => H.listeners.get('listeningState')?.({ status: 'stopped' });
const nativeError = (message: string): void =>
    H.listeners.get('listeningState')?.({ status: 'error', message });
const finals = (events: SttEvent[]): SttEvent[] => events.filter((e) => e.type === 'final');

beforeEach(() => {
    H.listeners.clear();
    H.start.mockClear();
    H.stop.mockClear();
    // The engine emits greppable [stt-native] diagnostics (for adb logcat);
    // silence them here so the test output stays readable.
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// submitDelayMs well past the 700ms settle + 50ms relaunch gap, so the restart
// always happens before the end-of-turn timer could fire - the real-world case.
const OPTS = { language: 'en-US', submitDelayMs: 5000, submitMaxDelayMs: 5000 };

describe('CapacitorSttEngine restart-stitching', () => {
    it('a post-stop final does not end the turn - it relaunches to catch a continuation', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60); // permission + 50ms reset, listeners, launch #1
        expect(H.start).toHaveBeenCalledTimes(1);
        // The endpointer hint (meditation-pal-lbl5) rides every launch.
        expect(H.start.mock.calls[0]![0]).toMatchObject({ silenceLengthMs: 12000, popup: false });

        partial('I notice'); // live speech
        stopped(); // Android end-of-speech
        partial('I notice'); // FINAL delivered after 'stopped'

        await vi.advanceTimersByTimeAsync(800); // past settle + relaunch gap
        // The regression guard: the post-stop final must NOT have submitted the
        // turn; the recognizer is relaunched instead.
        expect(H.start).toHaveBeenCalledTimes(2);
        expect(finals(events)).toEqual([]);
    });

    it('stitches segments across a pause into one final after the silence window', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('I notice');
        stopped();
        partial('I notice');
        await vi.advanceTimersByTimeAsync(800); // relaunch #2

        partial('a tightness'); // user resumes on the relaunched segment
        stopped();
        partial('a tightness');
        await vi.advanceTimersByTimeAsync(800); // relaunch #3

        // Now stay silent past the end-of-turn window. The window is the 5000ms
        // budget PLUS the deaf-teardown credit from each relaunch (the mic can't
        // hear during a restart, so that time isn't counted as silence), so this
        // must clear the raw budget by a comfortable margin.
        await vi.advanceTimersByTimeAsync(6000);

        expect(finals(events)).toEqual([{ type: 'final', text: 'I notice a tightness' }]);
        await finished;
    });

    it('credits deaf teardown time so a short word + think-pause is not truncated (the "yeah" bug)', async () => {
        // A low pause budget where the ~750ms settle + relaunch would, uncredited,
        // race the end-of-turn timer and ship the first word alone - exactly the
        // "'yeah, I'm feeling a little optimism' sent just 'yeah'" report.
        const engine = new CapacitorSttEngine({
            language: 'en-US',
            submitDelayMs: 1500,
            submitMaxDelayMs: 1500,
        });
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('yeah'); // a short first word...
        stopped(); // ...Android endpoints almost immediately
        partial('yeah'); // post-stop final
        await vi.advanceTimersByTimeAsync(800); // settle + relaunch #2 (deaf gap credited)

        // Past the raw 1500ms budget from the first word (the uncredited deadline
        // was ~1560ms): the turn must still be open - the deaf gap was credited,
        // not spent. Without the fix, 'yeah' would already have submitted alone.
        await vi.advanceTimersByTimeAsync(1100);
        expect(finals(events)).toEqual([]);

        // The continuation lands on the relaunched mic and stitches on.
        partial('I feel some optimism');
        stopped();
        partial('I feel some optimism');
        await vi.advanceTimersByTimeAsync(3000); // silence past the window

        expect(finals(events)).toEqual([
            { type: 'final', text: 'yeah I feel some optimism' },
        ]);
        await finished;
    });

    it('relaunches when the first start() hangs with no ready event (sluggish cold start)', async () => {
        // The reported failure: the first native start() after a cold session
        // start silently hangs - no 'ready', no partial, no error - and only
        // the 15s idle backstop ended the turn. Simulate that hang on launch #1;
        // later launches use the default mock (which emits 'ready').
        H.start.mockImplementationOnce(async () => undefined as unknown);
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60); // launch #1 - hangs
        expect(H.start).toHaveBeenCalledTimes(1);

        // The startup watchdog (2500ms), not the 15s idle timer, catches it.
        await vi.advanceTimersByTimeAsync(2600);
        expect(H.start).toHaveBeenCalledTimes(2);

        // The relaunched segment is live and transcribes normally.
        partial('hello there');
        stopped();
        partial('hello there');
        await vi.advanceTimersByTimeAsync(8000);
        expect(finals(events)).toEqual([{ type: 'final', text: 'hello there' }]);
    });

    it('does not cut off before the silence window elapses', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('still forming a thought');
        stopped();
        partial('still forming a thought');

        // A pause shorter than the window: no final yet.
        await vi.advanceTimersByTimeAsync(2000);
        expect(finals(events)).toEqual([]);
    });

    it('a silent turn ends with no final (no restart) so the loop starts fresh', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);
        expect(H.start).toHaveBeenCalledTimes(1);

        stopped(); // end-of-speech with nothing heard
        await vi.advanceTimersByTimeAsync(800); // settle fires -> submit no-speech

        expect(finals(events)).toEqual([]);
        expect(H.start).toHaveBeenCalledTimes(1); // never relaunched
        await finished;
    });

    it('does NOT relaunch a live recognizer just because the user is quiet', async () => {
        // The watchdog regression this patch exists for: 'started' only fires
        // on user SPEECH, so keying liveness on it made every quiet stretch
        // look like a hung start - the live recognizer was torn down every
        // 2.5s and speech landing in a relaunch gap was clipped. With 'ready'
        // as the liveness signal, a quiet mic must stay untouched.
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60); // launch; mock emits 'ready'
        expect(H.start).toHaveBeenCalledTimes(1);

        // Well past the 2.5s watchdog, still short of the 15s idle backstop.
        await vi.advanceTimersByTimeAsync(10000);
        expect(H.start).toHaveBeenCalledTimes(1); // no churn
        expect(finals(events)).toEqual([]);

        // And speech arriving after the long quiet transcribes normally.
        partial('here now');
        stopped();
        partial('here now');
        await vi.advanceTimersByTimeAsync(8000);
        expect(finals(events)).toEqual([{ type: 'final', text: 'here now' }]);
    });

    it('a native silence timeout ends an empty turn instead of hanging invisibly', async () => {
        // With the plugin patch, SPEECH_TIMEOUT/NO_MATCH arrive as 'error'
        // events. On a turn with no speech they end it cleanly (previously the
        // recognizer died silently and only the idle backstop recovered).
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        nativeError('No speech input');
        await vi.advanceTimersByTimeAsync(10);

        expect(finals(events)).toEqual([]);
        expect(events.filter((e) => e.type === 'error')).toEqual([]); // benign
        expect(H.start).toHaveBeenCalledTimes(1);
        await finished;
    });

    it('a silence timeout mid-turn relaunches to catch a continuation', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('I notice');
        stopped();
        partial('I notice');
        await vi.advanceTimersByTimeAsync(800); // fold + relaunch #2

        // Segment 2 hears nothing and times out natively mid-pause.
        nativeError('No match');
        await vi.advanceTimersByTimeAsync(100); // relaunch #3
        expect(H.start).toHaveBeenCalledTimes(3);
        expect(finals(events)).toEqual([]); // turn still open

        partial('a warmth'); // continuation lands on the relaunched mic
        stopped();
        partial('a warmth');
        await vi.advanceTimersByTimeAsync(8000);
        expect(finals(events)).toEqual([{ type: 'final', text: 'I notice a warmth' }]);
        await finished;
    });

    it('retries a busy recognizer, then surfaces the error once the budget is spent', async () => {
        // Never come up: every launch is answered with RECOGNIZER_BUSY.
        H.start.mockImplementation(async () => undefined as unknown);
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        for (let i = 0; i < 3; i++) {
            nativeError('RecognitionService busy');
            await vi.advanceTimersByTimeAsync(100); // relaunch gap
        }
        expect(H.start).toHaveBeenCalledTimes(4); // 1 launch + 3 retries

        nativeError('RecognitionService busy'); // budget spent
        await vi.advanceTimersByTimeAsync(10);
        expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
        await finished;
    });
});

describe('stop() ends the turn immediately (meditation-pal-jvnu)', () => {
    it('a stopped engine on a quiet mic finishes without waiting for a native event', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(600); // past RESTART_GAP + ready
        let settled = false;
        void finished.then(() => {
            settled = true;
        });
        await engine.stop();
        await vi.advanceTimersByTimeAsync(50);
        expect(settled).toBe(true);
        expect(finals(events)).toHaveLength(0);
    });
});

describe('stale silence errors (meditation-pal-wlp9)', () => {
    // Real ordering from logcat: the stale error landed ~12ms after the new
    // launch, before the new recognizer reported coming up.
    it("ignores the previous segment's no-speech error, arriving before ready", async () => {
        H.start.mockImplementation(async () => undefined as unknown); // no 'ready' yet
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(20);

        nativeError('No speech detected');
        await vi.advanceTimersByTimeAsync(30);
        expect(finals(events)).toEqual([]); // turn survives
        expect(H.start).toHaveBeenCalledTimes(1); // no cancel-and-restart

        H.listeners.get('listeningState')?.({ status: 'ready' }); // now it's up
        partial('the first word survives');
        stopped();
        partial('the first word survives');
        await vi.advanceTimersByTimeAsync(8000);
        expect(finals(events)).toEqual([{ type: 'final', text: 'the first word survives' }]);
        await finished;
    });

    it('still ends a silent turn when the engine never reports coming up', async () => {
        H.start.mockImplementation(async () => undefined as unknown); // iOS/unpatched
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        let ended = false;
        void finished.then(() => {
            ended = true;
        });
        await vi.advanceTimersByTimeAsync(400); // past STALE_SILENCE_GUARD_MS

        nativeError('No speech detected');
        await vi.advanceTimersByTimeAsync(50);
        expect(ended).toBe(true); // an empty turn ends silently, emitting no final
        expect(finals(events)).toEqual([]);
        await finished;
    });
});

/**
 * Android session semantics (meditation-pal-lbl5, 2026-09-06). The patched
 * plugin keeps one SpeechRecognizer warm; a session outlives end-of-speech in
 * dictation mode and closes only with a `final`-flagged partialResults event
 * (usually with NO text - the last partial was the transcript) or an error.
 * The engine keys this on Capacitor.getPlatform() === 'android'.
 */
describe('Android native session events', () => {
    const P = vi.hoisted(() => ({ platform: 'web' }));
    vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => P.platform } }));
    const started = (): void => H.listeners.get('listeningState')?.({ status: 'started' });
    const finalClose = (text?: string): void =>
        H.listeners.get('partialResults')?.({ matches: text === undefined ? [] : [text], final: true });
    const codedError = (errorCode: number, message: string): void =>
        H.listeners.get('listeningState')?.({ status: 'error', message, errorCode });

    beforeEach(() => {
        P.platform = 'android';
        vi.spyOn(console, 'debug').mockImplementation(() => {});
    });
    afterEach(() => {
        P.platform = 'web';
    });

    it("end-of-speech alone does not relaunch; the session's textless close does", async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);
        expect(H.start).toHaveBeenCalledTimes(1);

        partial('I notice');
        stopped(); // Android end-of-speech: the session is still open
        await vi.advanceTimersByTimeAsync(1500); // well past the iOS settle timer
        expect(H.start).toHaveBeenCalledTimes(1);

        finalClose(); // the session closes with no transcript of its own
        await vi.advanceTimersByTimeAsync(100);
        expect(H.start).toHaveBeenCalledTimes(2); // relaunched to catch a continuation
        expect(finals(events)).toEqual([]);

        await vi.advanceTimersByTimeAsync(6000);
        expect(finals(events)).toEqual([{ type: 'final', text: 'I notice' }]);
    });

    it("a new utterance in the same session ('started' after 'stopped') banks the last one", async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('I notice a tightness');
        stopped();
        partial('I notice a tightness.'); // tail refinement of the ended utterance
        started(); // the session heard the next utterance
        partial(''); // its partials start from empty ...
        partial('in my chest'); // ... and replace, not extend
        finalClose();
        await vi.advanceTimersByTimeAsync(6000);

        expect(finals(events)).toEqual([{ type: 'final', text: 'I notice a tightness. in my chest' }]);
    });

    it('an empty partial (the recognizer hearing its own tone) does not arm the end-of-turn window', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('yeah');
        await vi.advanceTimersByTimeAsync(4000);
        partial(''); // 1s before the window would close: must not push it out
        await vi.advanceTimersByTimeAsync(1200);
        expect(finals(events)).toEqual([{ type: 'final', text: 'yeah' }]);
    });

    it('classifies errors by code: 7 is silence, 11 is a fault, whatever the text says', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        codedError(7, "Didn't understand, please try again.");
        await vi.advanceTimersByTimeAsync(100);
        expect(events.filter((e) => e.type === 'error')).toEqual([]); // silent turn, no fault

        const engine2 = new CapacitorSttEngine(OPTS);
        const { events: events2 } = collect(engine2);
        await vi.advanceTimersByTimeAsync(60);
        codedError(11, "Didn't understand, please try again.");
        await vi.advanceTimersByTimeAsync(100);
        expect(events2.filter((e) => e.type === 'error')).toHaveLength(1);
    });
});
