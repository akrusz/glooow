/**
 * Capacitor STT - wraps @capacitor-community/speech-recognition as an SttEngine.
 * SFSpeechRecognizer on iOS, SpeechRecognizer on Android: no bundled Whisper and
 * no network round-trip where on-device recognition is available (varies by OS
 * version and language). The mobile app's skip-Whisper path.
 *
 * Caveats:
 *   - The first permission prompt must come from a user gesture (mic-button
 *     click). requestPermissions() runs lazily inside start() so callers don't
 *     have to remember.
 *   - Native APIs auto-stop on end-of-speech. The plugin (v7) has no continuous
 *     mode, so to hold a turn open across a mid-thought pause we
 *     restart-stitch: fold each segment's transcript and relaunch the recognizer
 *     until submitDelayMs of real silence elapses (see start()). submitDelayMs=0
 *     keeps the old one-utterance-per-turn behavior. On Android the patched
 *     plugin (patches/) keeps one SpeechRecognizer warm and flags the closing
 *     transcript, so a relaunch costs ~50ms instead of a fresh service bind.
 *   - In a plain browser (no Capacitor runtime) this throws at start(), not at
 *     import.
 */

import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';

export interface CapacitorSttEngineOptions {
    /** BCP-47 language tag. Defaults to the page's lang attribute or 'en-US'. */
    language?: string;
    /** Keep recognizing across pauses until stop(). Default false (one turn). */
    continuous?: boolean;
    /** Emit partial-result events. Default true. */
    partialResults?: boolean;
    /** Candidates per result. We use only the top one, but the plugin requires
     *  the field. Default 1. */
    maxResults?: number;
    /**
     * Base pause (ms) tolerated before the turn is submitted. When > 0 we own
     * end-of-turn: Android's recognizer endpoints on ~1.5s of silence, so each
     * end-of-speech is treated as a segment boundary - the transcript is kept
     * and the recognizer relaunched - and the turn only ends after this much
     * real silence. 0 (default) submits on the first end-of-speech. Mirrors
     * WebSpeechSttEngine.submitDelayMs.
     */
    submitDelayMs?: number;
    /** Max pause (ms) tolerated - the cap on the ramp below. Defaults to
     *  submitDelayMs. */
    submitMaxDelayMs?: number;
    /** Adaptive ramp: each ms of speech buys this many ms of extra pause
     *  tolerance, capped at submitMaxDelayMs. 0 = flat delay. */
    submitRampRate?: number;
}

/**
 * How long a silence the native recognizer tolerates before it closes a
 * session on its own (meditation-pal-lbl5). Measured on the OnePlus 13: the
 * stock ~2.5s no-speech timeout became 4.0s with a 4000ms hint, so the hint
 * is honoured for that timeout (not for the in-utterance endpointer, which
 * keeps firing end-of-speech but, in dictation mode, leaves the session
 * open). Set long so a session spans a whole turn: the adapter's own
 * end-of-turn timer (submitDelayMs + ramp) decides when the turn is over and
 * closes the session, and the recognizer's timeout is only the backstop for
 * a turn with no speech at all. Must stay under IDLE_TIMEOUT_MS.
 */
const NATIVE_ENDPOINT_SILENCE_MS = 12000;

const RESTART_GAP_MS = 50;
// iOS only: how long after end-of-speech to wait for the closing transcript
// before folding the segment. Android's patched plugin flags that transcript
// (`final`) and reports the session's end, so it never runs this timer.
const SEGMENT_SETTLE_MS = 700;
// Android SpeechRecognizer error codes the patched plugin passes through.
const ERR_CLIENT = 5;
const ERR_SPEECH_TIMEOUT = 6;
const ERR_NO_MATCH = 7;
const ERR_BUSY = 8;
// A silence error this soon after a launch belongs to the previous segment:
// Android needs seconds of quiet to decide it heard nothing. (wlp9: ~12ms.)
const STALE_SILENCE_GUARD_MS = 300;
const IDLE_TIMEOUT_MS = 20000;
// The relaunched native recognizer isn't actually listening the instant
// start() is called - Android spends a few hundred ms warming up (and clips
// the first syllable). Treat that as deaf time too when crediting the pause
// budget across a restart, so a continuation spoken right after the pause
// isn't raced by the end-of-turn timer.
const RELAUNCH_WARMUP_MS = 400;
// The first native start() after a cold session start can silently hang -
// no 'ready', no partial, no error - for many seconds (observed ~15s, until
// the idle backstop). A short watchdog: if the recognizer hasn't reported it
// came up within this window, relaunch (a fresh bind usually comes up in ~1s)
// instead of waiting the idle timeout out.
//
// The liveness signal is the patched plugin's listeningState 'ready'
// (onReadyForSpeech; see patches/). The stock plugin's only launch-ish event,
// 'started', actually fires on onBeginningOfSpeech - USER SPEECH - so keying
// the watchdog on it meant every quiet stretch looked like a hung start and
// got its live recognizer torn down at 2.5s cadence, clipping whatever the
// user said into the deaf relaunch gaps.
const STARTUP_WATCHDOG_MS = 2500;
const MAX_START_RETRIES = 3;

export class CapacitorSttEngine implements SttEngine {
    private readonly options: Required<CapacitorSttEngineOptions>;
    private partialListener: PluginListenerHandle | null = null;
    private stateListener: PluginListenerHandle | null = null;
    private stopRequested = false;
    // Wakes the live start() generator so stop() ends the turn NOW. Without it
    // the generator sleeps until the recognizer's next event - on a quiet mic
    // that's its ~10s NO_MATCH timeout - and the listen loop, which re-enters
    // on the rebuilt engine only after this iteration ends, stays deaf for all
    // of it. Measured 11s after a lock/unlock on 2026-09-04: the first words
    // after coming back were never heard (meditation-pal-jvnu).
    private wakeForStop: (() => void) | null = null;

    constructor(options: CapacitorSttEngineOptions = {}) {
        const submitDelayMs = options.submitDelayMs ?? 0;
        this.options = {
            language: options.language ?? document.documentElement.lang ?? 'en-US',
            continuous: options.continuous ?? false,
            partialResults: options.partialResults ?? true,
            maxResults: options.maxResults ?? 1,
            submitDelayMs,
            submitMaxDelayMs: options.submitMaxDelayMs ?? submitDelayMs,
            submitRampRate: options.submitRampRate ?? 0,
        };
    }

    /** Does this platform actually have speech recognition? Lets app boot pick
     *  an adapter without paying the import cost on the wrong platform. */
    static async isAvailable(): Promise<boolean> {
        try {
            const result = await SpeechRecognition.available();
            return result.available;
        } catch {
            return false;
        }
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;

        try {
            const perm = await SpeechRecognition.checkPermissions();
            if (perm.speechRecognition !== 'granted') {
                const requested = await SpeechRecognition.requestPermissions();
                if (requested.speechRecognition !== 'granted') {
                    yield { type: 'error', error: new Error('Speech recognition permission denied') };
                    return;
                }
            }
        } catch (err) {
            yield { type: 'error', error: err };
            return;
        }

        const queue: SttEvent[] = [];
        let done = false;
        let wake: (() => void) | null = null;

        const push = (event: SttEvent): void => {
            queue.push(event);
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };
        this.wakeForStop = () => {
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };
        const finish = (): void => {
            done = true;
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };

        // Clear any half-torn-down native session (the next start() fails
        // "RecognitionService busy" otherwise). The plugin's stop() NEVER
        // resolves its call on the success path - fire and forget, never
        // await it - and it runs before the listeners attach so its
        // 'stopped' event can't read as this turn ending.
        void SpeechRecognition.stop().catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, RESTART_GAP_MS));

        // The plugin's REAL contract with partialResults: true (our default;
        // read from the Android source, not the docs; 'ready'/'error' exist
        // only because we patch them in - see patches/):
        //   - start() resolves IMMEDIATELY and empty - it is not a result.
        //   - listeningState 'ready' (patched in, onReadyForSpeech) fires when
        //     the recognizer is actually live and hearing the mic.
        //   - listeningState 'started' is onBeginningOfSpeech - the user began
        //     SPEAKING. It is not a launch signal; on a quiet mic it never fires.
        //   - Interim AND final transcripts all arrive as 'partialResults'
        //     events (native onResults is forwarded to the same event).
        //   - listeningState 'stopped' fires at END OF SPEECH, before the
        //     final transcript lands.
        //   - listeningState 'error' (patched in, onError) carries the native
        //     error message; without the patch NO_MATCH / SPEECH_TIMEOUT /
        //     BUSY reject the already-resolved start() call and JS never sees
        //     them - a silent turn and a wedged recognizer look identical.
        //
        // stitching (submitDelayMs > 0): each end-of-speech is a segment
        // boundary. After a short settle to catch the post-'stopped' final,
        // fold the segment into `accumulated`, relaunch the recognizer, and let
        // an end-of-turn timer - reset on every real utterance, NOT on empty
        // restarts - decide when the pause is long enough to submit. Legacy
        // (submitDelayMs === 0): finalize a short debounce after 'stopped'.
        const { submitDelayMs, submitMaxDelayMs, submitRampRate } = this.options;
        const stitching = submitDelayMs > 0;
        // Android (patched plugin): a recognition session ends only at its
        // final transcript or an error, and the plugin serialises a start()
        // that lands during a live session. In dictation mode the session
        // outlives end-of-speech - a second 'started' can follow 'stopped' -
        // so tearing it down at 'stopped' (the pre-2026-09 design) both lost
        // the words that followed and drew ERROR_CLIENT from the restart
        // (meditation-pal-lbl5). Here 'stopped' is informational; the segment
        // folds on `final`. iOS keeps the settle-timer fold.
        const nativeSessionEvents = Capacitor.getPlatform() === 'android';

        let accumulated = ''; // folded transcript from prior segments this turn
        let segmentText = ''; // current segment's latest partial
        let speechStartMs = 0;
        let lastSpeechAt = 0;
        let sawSpeech = false;
        let submitted = false;
        // How many segments contributed speech this turn. Logged at submit so a
        // logcat reader can see stitching held across a pause (> 1 = stitched).
        let segments = 0;
        let segmentHasSpeech = false;
        // True between a segment's end-of-speech and its relaunch: the plugin
        // delivers the segment's FINAL transcript as a 'partialResults' event
        // AFTER 'stopped', and that late delivery must not read as new speech
        // (which would cancel the pending restart and reset the end-of-turn
        // window - the mic would then wait dead and still cut the user off).
        let segmentStopped = false;
        // Absolute time (ms) the turn should submit if no more speech arrives.
        // The end timer is scheduled to this, not to a raw delay, so we can push
        // it out to credit deaf teardown time (see restartSegment).
        let endsAt = 0;
        // When the current segment's Android end-of-speech fired - the moment the
        // mic went deaf. Used to credit the deaf gap back into endsAt at relaunch.
        let stoppedAt = 0;
        // Startup watchdog: whether the active segment has reported it started
        // (via listeningState 'started' or a first partial), and how many times
        // we've relaunched a hung start this turn (reset on a real start).
        let started = false;
        let startRetries = 0;
        // True while a relaunch is tearing down/rebinding; error events in that
        // window belong to the dying segment and must not trigger another one.
        let relaunching = false;
        // `relaunching` covers only the teardown window; a stale error can also
        // land just after the new segment is up.
        let segmentLaunchedAt = 0;
        let endTimer: ReturnType<typeof setTimeout> | null = null;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let startTimer: ReturnType<typeof setTimeout> | null = null;

        const clearTimers = (): void => {
            if (endTimer !== null) clearTimeout(endTimer);
            if (settleTimer !== null) clearTimeout(settleTimer);
            if (idleTimer !== null) clearTimeout(idleTimer);
            if (startTimer !== null) clearTimeout(startTimer);
            startTimer = null;
            endTimer = settleTimer = idleTimer = null;
        };
        const combined = (): string =>
            [accumulated, segmentText].map((s) => s.trim()).filter(Boolean).join(' ');

        // End the turn: emit the stitched transcript (or note silence) and stop.
        const submit = (): void => {
            if (submitted || done) return;
            submitted = true;
            clearTimers();
            const text = combined();
            if (text) {
                console.info(`[stt-native] final: ${text.length} chars, ${segments} segment(s)`);
                push({ type: 'final', text });
            } else {
                console.info('[stt-native] turn ended with no speech');
            }
            finish();
            // Fire-and-forget: the plugin's stop() never resolves (see stop()).
            void SpeechRecognition.stop().catch(() => {});
        };

        // Pause tolerated right now: base + speech-so-far × ramp, capped. Ramps
        // with speech duration so longer turns get more patience mid-sentence.
        const neededMs = (): number => {
            const speechDur = lastSpeechAt && speechStartMs ? lastSpeechAt - speechStartMs : 0;
            return Math.min(submitDelayMs + speechDur * submitRampRate, submitMaxDelayMs);
        };
        // Schedule the end timer to fire at the absolute `endsAt` deadline.
        const scheduleEnd = (): void => {
            if (endTimer !== null) clearTimeout(endTimer);
            endTimer = setTimeout(submit, Math.max(0, endsAt - Date.now()));
        };
        // (Re)arm the end-of-turn timer from live speech: a fresh full pause
        // window starting now. Clears any pending deaf-gap credit - we're live
        // again, the mic just heard the user.
        const armEnd = (): void => {
            endsAt = Date.now() + neededMs();
            stoppedAt = 0;
            scheduleEnd();
        };
        // Nothing heard for a long time (recognizer wedged, or a silent turn
        // that never errored): submit what we have (or note silence) as a
        // backstop so the listen loop isn't left hanging.
        const bumpIdle = (): void => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            idleTimer = setTimeout(submit, IDLE_TIMEOUT_MS);
        };

        // (Re)arm the startup watchdog for the segment we're about to launch.
        const armStart = (): void => {
            started = false;
            if (startTimer !== null) clearTimeout(startTimer);
            startTimer = setTimeout(onStartTimeout, STARTUP_WATCHDOG_MS);
        };
        // The recognizer reported it started (or spoke): cancel the watchdog and
        // refresh the relaunch budget so a later hang gets a fresh set of tries.
        const markStarted = (): void => {
            if (started) return;
            started = true;
            startRetries = 0;
            if (startTimer !== null) {
                clearTimeout(startTimer);
                startTimer = null;
            }
        };
        // The launch produced no 'started'/partial in time: the start() call hung.
        // Relaunch (a fresh bind usually comes up fast); give up after a few tries
        // so a truly-dead recognizer ends the turn rather than spinning.
        const onStartTimeout = (): void => {
            startTimer = null;
            if (submitted || done || this.stopRequested || started) return;
            if (startRetries < MAX_START_RETRIES) {
                startRetries++;
                console.info(
                    `[stt-native] no start in ${STARTUP_WATCHDOG_MS}ms - relaunch ${startRetries}/${MAX_START_RETRIES}`
                );
                void restartSegment();
            } else {
                console.warn('[stt-native] recognizer never started - ending turn');
                submit();
            }
        };

        // Relaunch the native recognizer for the next segment, keeping the
        // stitched transcript. Bounded by the end-of-turn timer, which fires
        // submit() and flips `submitted`, so this can't loop forever.
        const restartSegment = async (): Promise<void> => {
            if (submitted || done || this.stopRequested || relaunching) return;
            // Latched until the relaunch lands: the native stop() below can
            // itself fire onError (now a visible 'error' event, see the state
            // listener), which must not trigger a second, racing restart.
            relaunching = true;
            void SpeechRecognition.stop().catch(() => {});
            await new Promise<void>((resolve) => setTimeout(resolve, RESTART_GAP_MS));
            if (submitted || done || this.stopRequested) {
                relaunching = false;
                return;
            }
            // Credit the deaf teardown gap back into the pause budget. The mic
            // was down from Android's end-of-speech (stoppedAt) through this
            // relaunch, plus the recognizer's warmup - the user couldn't be heard
            // for any of it, so none of it should count as end-of-turn silence.
            // Without this, a short word before a think-pause ("yeah, ..." then a
            // beat) submits the fragment before the continuation reaches a live
            // mic. Only extends a live deadline; converges because real listening
            // silence accrues faster than the deaf credit, and idleTimer caps it.
            if (endsAt && stoppedAt) {
                endsAt += Date.now() - stoppedAt + RELAUNCH_WARMUP_MS;
                stoppedAt = 0;
                scheduleEnd();
            }
            segmentStopped = false; // the relaunched segment's partials are live
            segmentHasSpeech = false; // count this new segment only if it hears speech
            relaunching = false;
            launchSegment();
        };

        // Live speech in the currently-active segment: advances the transcript
        // and resets the end-of-turn window.
        const onLiveSpeech = (text: string): void => {
            if (submitted || done) return;
            markStarted(); // a partial proves the recognizer came up
            // An empty partial is the recognizer hearing sound it can't
            // transcribe (its own start tone, the room). Not speech: it must
            // not arm the end-of-turn window or count as a segment.
            if (!text.trim()) return;
            if (!sawSpeech) {
                sawSpeech = true;
                console.info('[stt-native] first partial received');
            }
            if (!segmentHasSpeech) {
                segmentHasSpeech = true;
                segments++;
            }
            if (speechStartMs === 0) speechStartMs = Date.now();
            segmentText = text;
            lastSpeechAt = Date.now();
            bumpIdle();
            if (stitching) armEnd();
            push({ type: 'partial', text: combined() });
        };

        this.partialListener = await SpeechRecognition.addListener('partialResults', (data) => {
            const text = ((data as { matches?: string[] }).matches ?? [])[0];
            const isFinal = (data as { final?: boolean }).final === true;
            if (submitted || done || (text === undefined && !isFinal)) return;
            console.debug(`[stt-native] ${isFinal ? 'final' : 'partial'} ${text?.length ?? 'no'} chars`);
            if (isFinal) {
                // The session closed (patched Android plugin). It usually
                // brings no transcript of its own - the last partial stands -
                // but when it does, adopt it. Then fold and relaunch, or with
                // no stitching, submit.
                markStarted();
                if (text?.trim()) {
                    if (segmentHasSpeech) {
                        segmentText = text;
                        push({ type: 'partial', text: combined() });
                    } else {
                        onLiveSpeech(text); // a short utterance with no interim partial
                    }
                }
                segmentStopped = true;
                stoppedAt = Date.now(); // the mic is deaf from here to the next 'ready'
                if (stitching) foldSegment();
                else submit();
                return;
            }
            if (text === undefined) return;
            if (segmentStopped) {
                // Post-'stopped' delivery of the utterance that just ended:
                // adopt the (usually cleaner) text for the preview, but the
                // utterance is over - don't touch the end-of-turn window. On
                // Android the session may go on to a NEW utterance, whose
                // partials start from empty; 'started' folds this one first.
                segmentText = text;
                push({ type: 'partial', text: combined() });
                if (!stitching) {
                    if (settleTimer !== null) clearTimeout(settleTimer);
                    settleTimer = setTimeout(submit, 700);
                }
                return;
            }
            onLiveSpeech(text);
        });

        this.stateListener = await SpeechRecognition.addListener('listeningState', (data) => {
            const status = (data as { status?: string }).status;
            console.info(`[stt-native] state: ${status}`);
            if (status === 'ready' || status === 'started') {
                // 'ready' = the recognizer came up (patched plugin). 'started' =
                // speech began - also proof of life, and the only signal on
                // builds without the patch (or iOS).
                markStarted();
                if (status === 'started' && segmentStopped && stitching) {
                    // Android dictation: a new utterance in the same session.
                    // Its partials replace, not extend, the last one's text,
                    // so bank the finished utterance now.
                    if (segmentText) {
                        accumulated = combined();
                        segmentText = '';
                    }
                    segmentStopped = false;
                    segmentHasSpeech = false;
                }
                return;
            }
            if (status === 'error') {
                const msg = (data as { message?: string }).message ?? 'recognizer error';
                const code = (data as { errorCode?: number }).errorCode;
                if (submitted || done || this.stopRequested || relaunching) return;
                // NO_MATCH / SPEECH_TIMEOUT: ordinary silence, not a fault. The
                // code is authoritative when the plugin sends one; the text
                // match covers iOS and unpatched builds.
                const silence =
                    code !== undefined
                        ? code === ERR_NO_MATCH || code === ERR_SPEECH_TIMEOUT
                        : /didn't understand|no match|no speech/i.test(msg);
                const busy = code !== undefined ? code === ERR_BUSY || code === ERR_CLIENT : /busy|client side/i.test(msg);
                if (silence) {
                    // Not ours if this segment hasn't come up yet - it's the
                    // previous one's, and acting on it cost every turn its first
                    // ~650ms (meditation-pal-wlp9). Time-bounded so an engine
                    // that never reports ready (iOS) still ends a silent turn.
                    if (!started && Date.now() - segmentLaunchedAt < STALE_SILENCE_GUARD_MS) {
                        console.info(`[stt-native] ignoring stale silence error: ${msg}`);
                        return;
                    }
                    // If end-of-speech already scheduled this segment's wrap-up,
                    // let the settle path own it (fold + restart/submit).
                    if (settleTimer !== null) return;
                    if (stitching && sawSpeech && accumulated) {
                        // Silence during a turn in progress: keep the mic live
                        // for a continuation; the end-of-turn timer submits.
                        // Mark the deaf point so restartSegment credits the gap.
                        if (stoppedAt === 0) stoppedAt = Date.now();
                        void restartSegment();
                    } else {
                        submit(); // nothing heard: end the (empty) turn
                    }
                    return;
                }
                // BUSY / flaky client errors: the service didn't take the
                // launch. Relaunch on the watchdog's retry budget.
                if (busy && startRetries < MAX_START_RETRIES) {
                    startRetries++;
                    console.info(
                        `[stt-native] recognizer error "${msg}" - relaunch ${startRetries}/${MAX_START_RETRIES}`
                    );
                    void restartSegment();
                    return;
                }
                // Real fault (audio, permissions, network, retries exhausted):
                // surface it so the listen loop can toast and back off.
                console.warn(`[stt-native] recognizer error: ${msg}`);
                push({ type: 'error', error: new Error(msg) });
                finish();
                void SpeechRecognition.stop().catch(() => {});
                return;
            }
            if (status !== 'stopped' || submitted || done) return;
            segmentStopped = true;
            // Mark when the mic went deaf so restartSegment can credit the gap.
            // Not on Android: the session (and the mic) outlives end-of-speech
            // there, and the deaf moment is the session's close (`final` /
            // silence error), which sets it.
            if (!nativeSessionEvents && stoppedAt === 0) stoppedAt = Date.now();
            if (!stitching) {
                // Legacy: submit a short debounce after end-of-speech; a
                // post-stop final re-arms it (above) so the cleaner text wins.
                // Android submits on `final` instead; the timer is a backstop.
                if (settleTimer !== null) clearTimeout(settleTimer);
                settleTimer = setTimeout(submit, 2500);
                return;
            }
            // Android: the session is still open; its `final` (or a silence
            // error) closes the segment. iOS: settle briefly to catch the
            // post-'stopped' transcript, then fold and relaunch.
            if (nativeSessionEvents) return;
            if (settleTimer !== null) clearTimeout(settleTimer);
            settleTimer = setTimeout(foldSegment, SEGMENT_SETTLE_MS);
        });

        // The segment that just ended is complete: fold its text into the
        // turn and relaunch for a continuation, or end a silent turn. The
        // end-of-turn timer, armed from the last LIVE utterance, is what
        // actually ends a turn with speech in it.
        const foldSegment = (): void => {
            if (settleTimer !== null) clearTimeout(settleTimer);
            settleTimer = null;
            if (submitted || done) return;
            if (segmentText) {
                accumulated = combined();
                segmentText = '';
            }
            if (sawSpeech && accumulated) {
                void restartSegment();
            } else {
                submit(); // silent turn: let the listen loop start fresh
            }
        };

        // Launch (or relaunch) one native recognition segment.
        const launchSegment = (): void => {
            segmentLaunchedAt = Date.now();
            armStart(); // watchdog: relaunch if this start() hangs
            const startPromise = SpeechRecognition.start({
                language: this.options.language,
                maxResults: this.options.maxResults,
                partialResults: this.options.partialResults,
                popup: false,
                silenceLengthMs: NATIVE_ENDPOINT_SILENCE_MS,
            });
            startPromise
                .then((result) => {
                    // Meaningful only with partialResults: false; in partial mode
                    // this resolves instantly and empty - ignore it.
                    const text = ((result as { matches?: string[] } | undefined)?.matches ?? [])[0];
                    if (text !== undefined) {
                        onLiveSpeech(text);
                        if (!stitching) submit();
                    }
                })
                .catch((err: unknown) => {
                    // In partial mode start() resolves up front, so this catch
                    // only sees pre-resolve rejects (permission, unavailable) -
                    // recognition-time errors arrive as listeningState 'error'
                    // above. The benign-silence branch is kept for iOS and for
                    // builds without the plugin patch.
                    const msg = err instanceof Error ? err.message : String(err);
                    const benign = /didn't understand|no match/i.test(msg);
                    if (!benign) {
                        console.warn(`[stt-native] start error: ${msg}`);
                        push({ type: 'error', error: err });
                        finish();
                        return;
                    }
                    if (submitted || done) return;
                    if (stitching && sawSpeech && accumulated) {
                        // Silence during a turn in progress: the end-of-turn timer
                        // will submit; keep the mic live for a continuation. Mark
                        // the deaf point if 'stopped' didn't already (NO_MATCH can
                        // arrive without it) so restartSegment credits the gap.
                        if (stoppedAt === 0) stoppedAt = Date.now();
                        void restartSegment();
                    } else {
                        submit(); // nothing heard: end the (empty) turn
                    }
                });
        };

        console.info('[stt-native] start requested');
        bumpIdle();
        launchSegment();

        try {
            while (true) {
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
                if (done || this.stopRequested) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        } finally {
            this.wakeForStop = null;
            clearTimers();
            await this.partialListener?.remove().catch(() => {});
            await this.stateListener?.remove().catch(() => {});
            this.partialListener = null;
            this.stateListener = null;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.wakeForStop?.();
        // Never await: the plugin's stop() call never resolves on success
        // (Android impl calls stopListening() without call.resolve()), so an
        // await here hangs the caller forever.
        void SpeechRecognition.stop().catch(() => {
            // Already stopped - fine.
        });
    }
}
