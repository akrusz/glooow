/**
 * Session view - the meditation conversation.
 *
 * From a configured SessionSetup: builds the PromptBuilder, session manager,
 * and LLM provider, then runs the conversation loop until the user ends it.
 */

import {
    PromptBuilder,
    SessionManager,
    PacingController,
    TurnDecision,
    parseTurnSignals,
    looksLikeTtsEcho,
    getMode,
    StagedModeController,
    EXPLORATION_MODE,
    generateSessionSummary,
    buildResumeContext,
    classifyResumeIntent,
    classifyHoldRequest,
    routeUtterance,
    isMuteCommand,
    HOLD_REENTRY_GRACE_MS,
    classifyHoldConfirm,
    defaultPacingConfig,
    defaultWaitSeconds,
    runSmartCheckin,
    buildSmartCheckinEvent,
    buildTimerApproachEvent,
    buildTimerCompletionEvent,
    isSyntheticEventTurn,
    pickTimerFallback,
    timerApproachLeadSec,
    SESSION_TIMER_MAX_CHARS,
    TIMER_APPROACH_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
    sessionLanguageOf,
    localizePool,
    EMPTY_REPLY_FALLBACKS,
} from '../../../src/facilitation/index.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import {
    AnthropicProvider,
    OllamaProvider,
    contextLengthForRam,
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
    type LLMProvider,
} from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';
import { isNonSpeechOnly } from '../../../src/platform/index.js';
import { streamCompletionWithChunkedTts } from '../streaming-tts.js';
import { wrapTtsWithBargeIn } from '../barge-in.js';
import { ClaudeProxyHttpProvider } from '../adapters/claude-proxy-http.js';
import {
    sessionModelLabel,
    isSlowModel,
    nearestSubscriptionModel,
    probeClaudeProxyModel,
    prettyModelName,
    cloudUtilityModel,
    SLOW_MODEL_NOTE,
} from '../model-picker.js';
import { mountSessionInfoPanel, type SessionInfoRow } from '../session-info.js';
import { openAiContentReport, openBugReport } from '../bug-report.js';
import { CloudLlmProvider, type CloudProviderId } from '../adapters/cloud-llm.js';
import { ensureCloudToken } from '../cloud-auth.js';
import { getKnownBalance, subscribeBalance } from '../cloud-balance.js';
import { getRetreatCovered } from '../cloud-coverage.js';
import { creditAmount, withCloudOutline } from '../credit-rate.js';

import {
    createSttForChoice,
    sttBackendForChoice,
    resolveSttChoice,
    invalidateSttBackendCache,
    sttEngineOptions,
    type SttBackend,
} from '../adapters/stt-picker.js';
import { isWebMode } from '../app-mode.js';
import { describeCloudError, describeSttError } from '../stt-errors.js';
import { simulateLlmFault } from '../dev-sim.js';
import { isCheckinDebugOn } from '../dev-mode.js';
import { createTtsForVoice, createCloudAloudTts } from '../adapters/tts-picker.js';
import { WhisperPcmSttEngine } from '../adapters/whisper-pcm-stt.js';
import { startCloudSession, clearCloudSession } from '../cloud-session.js';
import {
    type SessionSetup,
    dirStepToBackend,
    ALL_PROVIDERS,
    GUIDANCE_LEVEL_LABELS,
    CHECKIN_PACE_LABELS,
    VERBOSITY_LABELS,
    FOCUS_LABELS,
    QUALITY_LABELS,
} from '../settings.js';
import {
    loadAppSettings,
    saveAppSettings,
    type AppSettings,
    type SttEngineChoice,
    LANGUAGES,
} from '../app-settings.js';
import { SessionClock } from '../session-clock.js';
import { sessionStore } from '../state.js';
import { markSessionActive, clearActiveSession } from '../active-session.js';
import { markSessionStarted } from '../tour/index-guide.js';
import { showEndConfirm as wireEndConfirm } from './end-confirm.js';
import { getApiKey } from '../api-keys.js';
import {
    mountEmberContainer,
    unmountEmberContainer,
    wireEmberControls,
} from '../embers.js';
import { initKasinaMode } from '../kasina.js';
import { initThemeToggle } from '../theme.js';
import { t } from '../i18n.js';
import { showErrorToast } from '../toast.js';
import { showBuyCreditsModal } from '../buy-credits-modal.js';
import { playCannedApology } from '../canned-apology.js';
import { reportCloudIncident, isCloudTtsError } from '../cloud-incidents.js';
import { OUT_OF_CREDITS_MESSAGE, BILLING_PAUSED_FINISH } from '../billing-messages.js';
import { startMicMeter, type MicMeter } from '../mic-meter.js';
import { isTauri, isCapacitor, isSingleOwnerMicPlatform, systemRamGb } from '../is-desktop.js';
import { acquireWakeLock, releaseWakeLock } from '../wakelock.js';
import {
    armSoakTap,
    tapCall,
    tapEvent,
    tapFlags,
    tapTurn,
    type TurnKind,
} from '../soak-tap.js';
import {
    buildScoredVoiceList,
    fetchServerVoices,
    fetchCloudVoices,
    prefixedVoiceId,
    previewVoice as runVoicePreview,
    previewErrorMessage,
    renderVoiceList,
    renderVoiceModalHTML,
    stopPreview as stopVoicePreview,
    updateVoiceSelection,
    syncSpeedControlForVoice,
    voiceRateLabel,
    ENGINE_LABELS,
    type ScoredVoice,
} from '../voice-picker.js';

// Anthropic blocks browser-origin requests; OpenAI/OpenRouter/Venice/Groq
// accept browser CORS. So Anthropic routes through the app-backend proxy, the
// rest go BYOK direct. Mobile (Capacitor) will need another path for Anthropic
// (@capacitor/http or a hosted proxy).
const OLLAMA_PROXY_URL = '/ollama';

export async function buildProvider(setup: SessionSetup): Promise<LLMProvider> {
    // Dev-build simulation hook (no-op everywhere else): draining a real
    // balance to see the out-of-credits apology is not a repeatable test.
    return simulateLlmFault(await buildRealProvider(setup));
}

async function buildRealProvider(setup: SessionSetup): Promise<LLMProvider> {
    const modelOpt = setup.model ? { model: setup.model } : {};
    switch (setup.provider) {
        case 'aloud': {
            // Hosted, metered proxy; sign in so the request carries a bearer
            // token. setup.model is "provider/model" and the model id itself may
            // contain a slash (openrouter), so split once.
            await ensureCloudToken();
            const slash = setup.model.indexOf('/');
            const sub = slash > 0 ? setup.model.slice(0, slash) : '';
            const model = slash > 0 ? setup.model.slice(slash + 1) : '';
            if (!sub || !model) {
                throw new Error(t('Pick a model for the aloud cloud in Settings.'));
            }
            return new CloudLlmProvider({ provider: sub as CloudProviderId, model });
        }
        case 'ollama':
            return new OllamaProvider({
                baseUrl: OLLAMA_PROXY_URL,
                // Down-clamp the context window on low-RAM machines; the
                // system-info probe has run by the time a session starts.
                contextLength: contextLengthForRam(systemRamGb()),
                ...modelOpt,
            });
        case 'anthropic': {
            // BYOK direct, like the other key providers: Anthropic allows
            // browser-origin requests that carry
            // anthropic-dangerous-direct-browser-access. This used to route
            // through an app-backend relay, which only ever existed in the
            // desktop shell - so on the hosted web app every turn 404'd
            // (meditation-pal-aq4e). The key now goes straight to Anthropic and
            // touches no server of ours at all.
            const anthropicKey = await getApiKey('anthropic');
            if (!anthropicKey) {
                throw new Error(
                    t('No API key set for {provider}. Add it in Settings, or pick a different provider.', {
                        provider: 'anthropic',
                    })
                );
            }
            return new AnthropicProvider({
                apiKey: anthropicKey,
                directBrowserAccess: true,
                ...modelOpt,
            });
        }
        case 'claude_proxy':
            // The `claude` CLI is a subprocess: the app backend runs it and
            // exposes the result over /app/v1/llm/claude_proxy.
            return new ClaudeProxyHttpProvider(modelOpt);
        case 'openai':
        case 'openrouter':
        case 'venice':
        case 'groq': {
            // BYOK direct from the browser; these accept CORS.
            const apiKey = await getApiKey(setup.provider);
            if (!apiKey) {
                throw new Error(
                    t('No API key set for {provider}. Add it in Settings, or pick a different provider.', {
                        provider: setup.provider,
                    })
                );
            }
            const opts = { apiKey, ...modelOpt };
            if (setup.provider === 'openai') return new OpenAIProvider(opts);
            if (setup.provider === 'openrouter') return new OpenRouterProvider(opts);
            if (setup.provider === 'venice') return new VeniceProvider(opts);
            return new GroqProvider(opts);
        }
    }
}

/**
 * Cheap, fast, NON-reasoning model (Haiku) for the auxiliary calls: the yes/no
 * resume/hold-confirm classifiers, one-word noting labels, and the session
 * recap. An always-thinking facilitation model (Fable 5 reasons every turn and
 * can't be told not to) makes the tiny-budget classifiers return nothing
 * (reasoning eats the budget), risks a truncated/thinking-block summary, and
 * keeps the user waiting on the end-of-session recap.
 *
 * Falls back to the facilitation provider where Haiku isn't reachable: local
 * Ollama and BYOK-direct providers (no Anthropic key). Safe because those users
 * aren't locked into reasoning - they can pick a non-reasoning model.
 */
export async function buildUtilityProvider(
    setup: SessionSetup,
    facilitation: LLMProvider
): Promise<LLMProvider> {
    switch (setup.provider) {
        case 'aloud': {
            // The server holds the key; the client only names provider + model.
            await ensureCloudToken();
            return new CloudLlmProvider({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });
        }
        case 'anthropic': {
            const anthropicKey = await getApiKey('anthropic');
            // No key: the facilitation leg has already thrown, so this is only
            // reachable if that changes. Reuse it rather than construct a
            // provider that can't authenticate.
            if (!anthropicKey) return facilitation;
            return new AnthropicProvider({
                apiKey: anthropicKey,
                directBrowserAccess: true,
                model: 'claude-haiku-4-5-20251001',
            });
        }
        case 'claude_proxy':
            return new ClaudeProxyHttpProvider({ model: 'haiku' });
        default:
            // Ollama (free/local) and BYOK-direct providers: reuse facilitation.
            return facilitation;
    }
}

/**
 * The utility model for the IN-SESSION recap refreshes only (nrj6). Those send
 * the whole transcript every SUMMARY_MIN_NEW_EXCHANGES and are most of the
 * utility leg's cost - several thousand input tokens a call, a few times an
 * hour, against the classifiers' handful of tokens. Flash Lite is ~10x cheaper
 * per input token and the recap is throwaway: it's background context for
 * summary-based resume, replaced by the next refresh, and superseded at the end
 * by the Haiku end-of-session summary that's actually shown in history. The
 * user-facing one stays on Haiku.
 *
 * Hosted only. Everywhere else the utility provider already is the facilitation
 * provider (or a local one), and there's nothing to save.
 *
 * WHICH cheap model is the server's call, not this view's: it's the entry
 * flagged `utility` in server/src/pricing/providers.ts, read off the same
 * /me/models payload the picker caches. Moving the job is a one-line flag move
 * there. If the catalog can't be reached we fall back to `utility` (Haiku) -
 * dearer, but a recap that costs more beats one that doesn't happen.
 */
export async function buildRecapProvider(
    setup: SessionSetup,
    utility: LLMProvider
): Promise<LLMProvider> {
    if (setup.provider !== 'aloud') return utility;
    const flagged = await cloudUtilityModel();
    if (!flagged) return utility;
    await ensureCloudToken();
    return new CloudLlmProvider({
        provider: flagged.provider as CloudProviderId,
        model: flagged.model,
    });
}


export interface SessionViewHandle {
    /** Tear down the running session and release resources. */
    teardown(): void;
    /**
     * Open the end-session confirmation for a nav request from outside the
     * session UI (browser/hardware Back). On confirm, tears down and routes to
     * `destination` via onEnd.
     */
    requestLeave(destination?: SessionEndDestination): void;
    /** Open the in-session info panel (model, mode, …). Wired to the mobile
     *  "More" sheet's Session-info entry; the nav ⓘ button opens it directly. */
    showInfo(): void;
    /** Enter/exit kasina gazing. Wired to the More sheet's Kasina entry; the
     *  nav orb toggles it directly (kasina.ts). */
    toggleKasina(): void;
}

export type SessionEndDestination = 'setup' | 'history' | 'settings' | 'account';

/** Re-generate the background recap only after this many new exchanges land.
 *  A refresh is an LLM call (cheap on a warm prompt cache, but non-zero for
 *  cloud users), so keep it to once or twice per long session. It can afford to
 *  lag: summary-based resume keeps the last RESUME_RECENT_KEEP exchanges
 *  verbatim, so the recap only has to cover the older portion. */
const SUMMARY_MIN_NEW_EXCHANGES = 12;

export async function mountSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: (destination?: SessionEndDestination) => void,
    continueFrom: SessionState | null = null
): Promise<SessionViewHandle> {
    root.innerHTML = renderSessionHTML();

    // The mode spec carries the base prompt, which user dimensions compose, and
    // (for staged modes) the phase arc the facilitator privately moves through.
    const mode = getMode(setup.meditationType) ?? EXPLORATION_MODE;
    // Loaded before the prompt builder because smart check-in timing rides on
    // the system prompt (the [WAIT:Nm] fragment). Also feeds the pacing config.
    const appSettings = await loadAppSettings();
    // In checkinPaceSlider modes (felt sense) the guidance slider is hidden and
    // directiveness doesn't compose; "Check-in pace" stands in for it, driving
    // only timing (the [WAIT] bias, the pacing seed, and whether check-ins may
    // be substantive).
    const directiveness = mode.checkinPaceSlider
        ? dirStepToBackend(setup.feltSensePaceStep)
        : dirStepToBackend(setup.dirStep);
    // Those modes also own their check-ins entirely: their setup panel has its
    // own toggle + pace slider, so the Settings-page Check-In radios (which the
    // panel can't show) don't apply. Content is always smart there - a line
    // generated under the mode's own prompt stays in-stance in a way the canned
    // pool can't, and it degrades to that pool on any failure anyway.
    const checkinTiming: AppSettings['checkinTiming'] = mode.checkinPaceSlider
        ? setup.feltSenseCheckins
            ? 'smart'
            : 'none'
        : appSettings.checkinTiming;
    const checkinContent: AppSettings['checkinContent'] = mode.checkinPaceSlider
        ? 'smart'
        : appSettings.checkinContent;
    // A continued session keeps the language it began in (its transcript and
    // its meditator are already in it); the setup pick applies to fresh sits.
    const sessionLanguage = continueFrom?.language ?? setup.language;
    const builder = new PromptBuilder({
        config: {
            focuses: setup.focuses,
            qualities: setup.qualities,
            directiveness,
            verbosity: setup.verbosity,
            customInstructions: setup.customInstructions,
            waitSignal: checkinTiming === 'smart',
            holdSignal: appSettings.silenceModeEnabled,
            // zh sessions: respond-in-Chinese fragment + zh canned pools
            // (openers, check-ins, hold re-entry). meditation-pal-c3a0.3.
            language: sessionLanguageOf(sessionLanguage),
        },
        mode,
    });
    // Staged modes: the active phase rides on the system prompt and the LLM
    // signals movement with [NEXT]/[BACK] (parsed each turn below). A continued
    // session resumes where it left off (SessionState.modePhase).
    const stager = mode.phases
        ? new StagedModeController(mode, continueFrom?.modePhase)
        : null;
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession(undefined, mode.id);
    // Stamped at start (not save) so autosave carries it and a resume keeps the
    // language the sit began in.
    if (session.state) session.state.language = sessionLanguage;
    if (stager) session.setModePhase(stager.phase.id);
    // Mark the user as no-longer-new so the setup-page tour stops auto-popping
    // on later boots (fire-and-forget).
    void markSessionStarted();
    // Tag every metered cloud call with one opaque grouping id so the server's
    // cost report attributes them to this session (cloud-session.ts). No
    // content/PII; cleared at endSession().
    startCloudSession();

    // On continue, hydrate with prior context. By default (resumeFromSummary) a
    // long session is seeded from its stored recap + the last few exchanges
    // rather than the whole transcript, for continuity without re-priming the
    // full history cold. The UI still renders the whole transcript below
    // (free); this only controls what the model sees.
    // Which model is facilitating: for the info panel, the saved record, and (on
    // resume) telling a *different* model who ran the earlier part. `let` so a
    // mid-session availability fallback can update it; `activeModel` tracks the
    // id/alias actually in use.
    let activeModel = setup.model;
    let modelLabel = sessionModelLabel(setup.provider, activeModel);
    if (continueFrom && continueFrom.exchanges.length > 0) {
        session.loadExchanges(
            buildResumeContext(continueFrom, appSettings.resumeFromSummary, {
                ...(continueFrom.model !== undefined
                    ? { priorModelLabel: continueFrom.model }
                    : {}),
                currentModelLabel: modelLabel,
            })
        );
    }
    let provider: LLMProvider;
    try {
        provider = await buildProvider(setup);
    } catch (err) {
        root.innerHTML = `
            <section class="session-stage">
                <div class="status">
                    <div id="status">${(err as Error).message}</div>
                </div>
            </section>
            <section class="controls">
                <button id="back" type="button" data-nav="setup">${t('Back to setup')}</button>
            </section>`;
        return {
            teardown() {
                /* nothing to tear down */
            },
            requestLeave() {
                /* no live session to guard */
            },
            showInfo() {
                /* no panel when the provider failed to build */
            },
            toggleKasina() {
                /* no orb on the error view */
            },
        };
    }

    // The pause-detection window (the STT VAD's trailing-silence submit window,
    // the real turn-taking gate) is provider-aware. A non-streaming provider
    // (the Claude subscription) can't start speaking until its whole reply is
    // generated, so it can't talk over a mid-thought pause; and those users pay
    // by subscription, not per request, so a too-early submit that a resumed
    // utterance supersedes (respondTo's turnGen/activeFullAbort) costs nothing.
    // Hence a shorter default window there, to cut latency.
    const providerStreams =
        typeof (provider as { completeStream?: unknown }).completeStream === 'function';
    const silenceBaseMs = providerStreams
        ? appSettings.silenceBaseMs
        : appSettings.nonStreamingSilenceBaseMs;
    const silenceMaxMs = providerStreams
        ? appSettings.silenceMaxMs
        : appSettings.nonStreamingSilenceMaxMs;
    const pacingConfig = {
        ...defaultPacingConfig,
        responseDelayMs: appSettings.responseDelayMs,
        silenceCheckinSec: appSettings.silenceCheckinSec,
        silenceCheckinsEnabled: checkinTiming !== 'none',
        silenceModeEnabled: appSettings.silenceModeEnabled,
        silenceBaseMs,
        silenceMaxMs,
    };
    const pacing = new PacingController({ config: pacingConfig });
    pacing.startSession();
    // Smart timing: until the model's first [WAIT], the slider sets the wait
    // (20m/8m/5m/90s/30s across the stops) - guidance level, or in
    // checkinPaceSlider modes the check-in pace (already folded into
    // `directiveness` above).
    if (checkinTiming === 'smart') {
        pacing.setCheckinInterval(defaultWaitSeconds(directiveness));
    }

    // Auxiliary calls run on a cheap, fast model (see buildUtilityProvider).
    // Falls back to the facilitation provider on any setup hiccup so a
    // helper-model problem can never block the session itself.
    let utilityProvider = provider;
    try {
        utilityProvider = await buildUtilityProvider(setup, provider);
    } catch {
        utilityProvider = provider;
    }
    // Background recaps run cheaper still (buildRecapProvider); same
    // never-block-the-session fallback.
    let recapProvider = utilityProvider;
    try {
        recapProvider = await buildRecapProvider(setup, utilityProvider);
    } catch {
        recapProvider = utilityProvider;
    }

    // Session facts live behind the nav "ⓘ" button rather than in the always-on
    // chrome. modelLabel is recomputed here so the saved record and the panel
    // agree, and stays current across an availability fallback.
    function recomputeModelLabel(): void {
        modelLabel = sessionModelLabel(setup.provider, activeModel);
    }
    recomputeModelLabel();
    function buildSessionInfoRows(): SessionInfoRow[] {
        const providerLabel =
            ALL_PROVIDERS.find((p) => p.value === setup.provider)?.label ?? setup.provider;
        // Streaming providers let the facilitator start speaking mid-reply; the
        // subscription (claude_proxy) returns the whole turn at once, so there's
        // a longer silent wait before it speaks.
        const streams = typeof (provider as { completeStream?: unknown }).completeStream === 'function';
        // Dimension rows only appear when the mode composes them into the
        // prompt (felt sense defines its own attention, tone, guidance, and
        // brevity, plus its own check-in timing default).
        const rows: SessionInfoRow[] = [
            {
                label: t('Model'),
                value: modelLabel,
                ...(isSlowModel(activeModel) ? { note: t(SLOW_MODEL_NOTE) } : {}),
            },
            { label: t('Mode'), value: t(mode.label) },
        ];
        if (mode.composes?.focuses !== false) {
            rows.push({
                label: t('Focus'),
                value:
                    setup.focuses.length > 0
                        ? setup.focuses.map((f) => t(FOCUS_LABELS[f])).join(', ')
                        : t(FOCUS_LABELS.open_awareness),
            });
        }
        if (mode.composes?.qualities !== false && setup.qualities.length > 0) {
            rows.push({
                label: t('Vibe'),
                value: setup.qualities.map((q) => t(QUALITY_LABELS[q])).join(', '),
            });
        }
        if (mode.composes?.directiveness !== false) {
            rows.push({ label: t('Guidance'), value: t(GUIDANCE_LEVEL_LABELS[setup.dirStep] ?? 'Balanced') });
        } else if (mode.checkinPaceSlider) {
            rows.push({
                label: t('Check-in pace'),
                value: setup.feltSenseCheckins
                    ? t(CHECKIN_PACE_LABELS[setup.feltSensePaceStep] ?? 'Patient')
                    : t('Off'),
            });
        }
        if (mode.composes?.verbosity !== false) {
            rows.push({ label: t('Response length'), value: t(VERBOSITY_LABELS[setup.verbosity]) });
        }
        // What the sit speaks with and hears: the live voice (tap to change -
        // same modal as the input-row button), the recognizer, and the
        // language the whole session runs in (fixed at setup; a resume keeps
        // the original, whatever the app setting says now).
        const voiceName = stripVoicePrefix(setup.voice);
        const voiceEntry = voiceName ? scoredVoices.find((v) => v.name === voiceName) : undefined;
        const engineId = voiceEntry?.displayEngine ?? voiceEntry?.engine;
        const engineLabel = engineId ? (ENGINE_LABELS[engineId] ?? engineId) : null;
        rows.push(
            {
                label: t('Voice'),
                value: voiceName ?? t('Default'),
                note: engineLabel
                    ? `${t(engineLabel)} · ${voiceRateLabel(voiceName, scoredVoices, setup.ttsRate)}`
                    : voiceRateLabel(voiceName, scoredVoices, setup.ttsRate),
                onClick: () => openSessionVoiceModal(),
            },
            {
                label: t('Speech recognition'),
                value: t(
                    sttEngineOptions(isWebMode()).find((o) => o.value === sttChoice)?.label ??
                        sttChoice
                ),
            },
            {
                label: t('Language'),
                value: LANGUAGES.find(([c]) => c === sessionLanguage)?.[1] ?? sessionLanguage,
            },
            { label: t('Source'), value: t(providerLabel) },
            {
                label: t('Delivery'),
                value: streams ? t('Speaks as it generates') : t('Waits for full reply, then speaks'),
            },
            // Actionable: the clock can be hidden from the input row, and this
            // is then the only way back to its settings mid-session.
            {
                label: t('Clock'),
                value: sessionClock.faceLabel(),
                onClick: () => void sessionClock.openPicker(),
            }
        );
        return rows;
    }
    const infoPanel = mountSessionInfoPanel(root, buildSessionInfoRows, t('Session'), [
        { label: t('Report a bug'), onClick: () => void openBugReport() },
        // Flag an inappropriate facilitator response. Play's AI-Generated
        // Content policy requires this to be reachable in-session, whatever
        // the LLM source; own-provider (BYOK/local) reports self-identify in
        // the mail template.
        {
            label: t('Report AI content'),
            onClick: () =>
                void openAiContentReport({
                    sourceLabel:
                        ALL_PROVIDERS.find((p) => p.value === setup.provider)?.label ??
                        setup.provider,
                    ownProvider: setup.provider !== 'aloud',
                }),
        },
    ]);
    // The nav ⓘ button that opens it is created further down (navLinks), and
    // wired there once it exists in the DOM.

    /**
     * On a failed Claude-subscription turn, tell a *removed* model (Anthropic
     * pulling Fable, etc.) apart from a cold-start stall: re-probe, and only on
     * a confirmed "unavailable" swap the live provider to the nearest peer,
     * refresh the panel, and tell the user. Returns true if it swapped (caller
     * skips the generic stall apology). Best-effort; never throws.
     */
    async function tryFallbackSubscriptionModel(): Promise<boolean> {
        if (setup.provider !== 'claude_proxy') return false;
        const fallback = nearestSubscriptionModel(activeModel);
        if (!fallback) return false; // already on a dependable default
        // Only reclassify a stall as a removal when the probe confirms it, or a
        // plain cold-start hiccup would silently change the model.
        if ((await probeClaudeProxyModel(activeModel)) !== 'unavailable') return false;
        const prevLabel = sessionModelLabel('claude_proxy', activeModel);
        try {
            setup.model = fallback;
            provider = await buildProvider(setup);
        } catch {
            return false;
        }
        activeModel = fallback;
        recomputeModelLabel();
        infoPanel.refresh();
        // Toast carries the specifics; the spoken line stays in the
        // facilitator's voice (no "subscription"/model jargon mid-session).
        showErrorToast(
            t("{prev} isn't available on your subscription right now. Switched to {next}.", {
                prev: prevLabel,
                next: prettyModelName(fallback),
            })
        );
        void tts.speak('I need to switch models for a moment, then we can continue.', {
            rate: setup.ttsRate,
        });
        return true;
    }

    // Barge-in (wrapTtsWithBargeIn opens its own mic stream during speak() and
    // cancels on sustained energy): drop the holding-orb. The listen loop picks
    // up the user's next utterance naturally.
    const onBargeIn = () => {
        tapEvent('audio', 'barge-in');
        setHolding(false);
    };

    // Tier-2 soak harness: no-op unless DEV and ?soak=1 (ui/src/soak-tap.ts).
    armSoakTap();

    // Re-probe each session start: the Whisper backend (desktop Rust shell /
    // Hono in the browser) may have come up or gone down since last detection.
    invalidateSttBackendCache();
    const vadOpts = {
        silenceBaseMs: pacingConfig.silenceBaseMs,
        silenceMaxMs: pacingConfig.silenceMaxMs,
        silenceRampRate: pacingConfig.silenceRampRate,
        minSpeechDurationMs: pacingConfig.minSpeechDurationMs,
        micDeviceId: appSettings.micDeviceId,
        whisperModelSize: appSettings.sttWhisperModel,
        speculation: appSettings.sttSpeculation,
        // Per-session pick (setup; original language on a resume), not the app
        // default: the recognizer must hear the language this sit runs in
        // (meditation-pal-c3a0.2).
        language: sessionLanguage,
    };
    // The STT source is an explicit, mode-resolved choice (Settings / setup):
    // local Whisper, browser speech, or the aloud cloud (credits). No hidden
    // automatic; resolveSttChoice falls back to the mode's flow default when
    // nothing's been chosen. The hosted adapter is the server-Whisper engine
    // pointed at the cloud, so it reports as 'server-whisper' downstream.
    // `let`, not const: a blocked browser recognizer can be swapped to aloud
    // cloud mid-session via switchSttEngine, which re-derives all of these.
    let sttChoice = resolveSttChoice(appSettings.sttEngine, isWebMode());
    let stt: SttEngine | null = await createSttForChoice(sttChoice, vadOpts);
    let sttBackend: SttBackend = sttBackendForChoice(sttChoice);

    // server-Whisper detects barge-in on its own continuous capture stream, so
    // don't ALSO wrap TTS with the separate-stream detector there: a second mic
    // stream doesn't get the OS echo-cancellation and trips on the facilitator's
    // own voice (the self-barge-in bug). web-speech / capacitor have no such
    // stream, so they keep the wrapper.
    let engineDrivenBargeIn = sttBackend === 'server-whisper';
    // Continuous capture (meditation-pal-57gl): on the engine-driven path the
    // mic stays live through the LLM+TTS window instead of pausing while `busy`,
    // so the user is never "deaf" mid-response. Safe because that VAD rejects
    // TTS echo (measured echo gate + energy floor vs ~0.005 echo); web-speech /
    // capacitor recognizers can't, so they keep pause-while-busy + the wrapper.
    let continuousCapture = engineDrivenBargeIn;
    // Turn supersession + barge-in plumbing. turnGen bumps each turn so a stale
    // turn bails; activeFullAbort stops a superseded turn generating;
    // activeTtsAbort hushes the in-flight reply without discarding it.
    let turnGen = 0;
    let activeFullAbort: AbortController | null = null;
    let activeTtsAbort: AbortController | null = null;
    // The continuous-capture engine when that's the live backend; used for
    // barge-in wiring and per-device echo calibration (setTtsActive below).
    let whisperEngine: WhisperPcmSttEngine | null =
        continuousCapture && stt instanceof WhisperPcmSttEngine ? stt : null;
    async function buildTts(voiceId: string | null) {
        // Server-side synthesis is billable compute; fold chars into usage.
        const ttsOpts = { onServerSynthesize: (chars: number) => session.recordTts(chars) };
        let engine;
        if (setup.provider === 'aloud' && !voiceId) {
            // Hosted pipeline with no voice picked: the server default. Any
            // explicit pick goes through the normal picker instead - `aloud:`
            // routes to this same hosted engine there, and a `browser:`/`server:`
            // voice must not be overridden with the hosted default (the Ava→Leda
            // bug, and its desktop twin with `server:`-prefixed macOS voices).
            engine = createCloudAloudTts('', ttsOpts);
        } else {
            ({ engine } = await createTtsForVoice(voiceId, ttsOpts));
        }
        // The barge-in wrapper opens a PARALLEL getUserMedia stream during every
        // speak(). On a phone that misfires two ways: echoCancellation can't
        // cope with the device's own loudspeaker, so the facilitator's voice
        // trips the energy detector and cancels its own TTS (only the first
        // sentence of a reply plays - each sentence is a separate speak() with
        // its own listener); and the extra mic stream contends with the single
        // recognizer the platform allows, so the next start() hangs (the ~2.5s
        // startup-watchdog relaunches in the logs). First seen in Android's
        // WebView (meditation-pal-x4h4), then in mobile Chrome on the web build
        // (meditation-pal-oxmt) - it's the speaker, not the wrapper. Capture
        // already pauses while busy on both, so skip the wrapper on any phone;
        // desktop browsers honor EC, and server-whisper drives its own.
        const wrapBargeIn =
            !engineDrivenBargeIn && sttBackend !== 'capacitor' && !isSingleOwnerMicPlatform();
        return wrapBargeIn
            ? wrapTtsWithBargeIn(engine, { onBargeIn, micDeviceId: appSettings.micDeviceId })
            : engine;
    }
    // A voice that can't speak the session's language (a leftover English pick
    // starting a zh sit) gets swapped, for this session only, to the best voice
    // that can: Leda glitching through a Chinese sit is worse than not honoring
    // the pick (meditation-pal-c3a0.6). Never persisted - the next English
    // session gets the original voice back.
    if (sessionLanguage !== 'en') {
        try {
            const [server, hosted] = await Promise.all([fetchServerVoices(), fetchCloudVoices()]);
            const list = buildScoredVoiceList(server, true, hosted, sessionLanguage);
            const currentName = stripVoicePrefix(setup.voice);
            const current = currentName ? list.find((v) => v.name === currentName) : undefined;
            const needsSwap = current
                ? current.langMismatch === true
                : setup.provider !== 'aloud';
            if (needsSwap) {
                // The list sorts zh-native voices first in a zh session, so
                // this lands on one when the catalog has it.
                const capable = list.find((v) => !v.langMismatch && !v.needsDownload);
                if (capable) setup.voice = prefixedVoiceId(capable.engine, capable.name);
            } else if (!current && setup.provider === 'aloud' && sessionLanguage === 'zh') {
                // No voice + hosted provider: the server default (Harper) does
                // speak zh, but with an audible accent - steer to a voice a
                // native speaker signed off on (CloudVoice.zhNative), when the
                // catalog names one. Session-only, like the swap above.
                const native = list.find((v) => v.zhNative && !v.langMismatch && !v.needsDownload);
                if (native) setup.voice = prefixedVoiceId(native.engine, native.name);
            }
        } catch {
            // Catalog unreachable: keep the picked voice.
        }
    }
    // `let` so an in-session voice change can swap the engine (see the voice
    // modal). Reassigning here is picked up by the outer `tts` wrapper.
    let activeTts = await buildTts(setup.voice);

    /** Rebuild the live engine when the user picks a new voice mid-session. */
    async function rebuildTts(voiceId: string | null): Promise<void> {
        const next = await buildTts(voiceId);
        try {
            await activeTts.cancel();
        } catch {
            /* ignore */
        }
        activeTts = next;
    }

    // Outer wrapper honoring the TTS toggle: when muted, speak() is a no-op and
    // in-flight playback is cancelled. Cheaper than tearing down the barge-in
    // wrapper.
    // Depth of in-flight speak() calls: while > 0 the facilitator's audio is
    // actually playing, which the capture engine uses to calibrate this device's
    // echo floor and gate it out. Bracketing real speak() calls keeps the signal
    // tight to playback, NOT the silent "thinking" phase.
    let ttsSpeakingDepth = 0;
    // Hold the engine's echo gate through the gaps BETWEEN a reply's sentence
    // chunks and briefly past playback: room reverb, AEC tails, and VAD debounce
    // all outlive the audio element, and per-speak() on/off flips left ungated
    // windows where trailing-fragment echo snuck through (meditation-pal-p8lx).
    const TTS_ACTIVE_HANGOVER_MS = 1000;
    let ttsActiveOffTimer: ReturnType<typeof setTimeout> | null = null;
    // When playback last ended; with the depth counter this defines the
    // "echo possible" window the transcript-level guard checks.
    let lastTtsEndedAt = 0;
    // Rolling tail of text handed to the synthesizer (everything voiced goes
    // through here). The transcript echo guard matches phantom turns against it.
    let spokenTail = '';
    const SPOKEN_TAIL_MAX_CHARS = 600;
    function ttsPlaybackStarted(text: string): void {
        tapFlags({ speaking: true });
        tapEvent('tts', 'start', { text });
        spokenTail = `${spokenTail} ${text}`.slice(-SPOKEN_TAIL_MAX_CHARS);
        if (ttsActiveOffTimer) {
            clearTimeout(ttsActiveOffTimer);
            ttsActiveOffTimer = null;
        }
        whisperEngine?.setTtsActive(true);
    }
    function ttsPlaybackEnded(): void {
        tapFlags({ speaking: false });
        tapEvent('tts', 'end');
        lastTtsEndedAt = Date.now();
        // whisperEngine is reassignable (in-session STT switch), so pin the one
        // this playback belongs to.
        const engine = whisperEngine;
        if (!engine) return;
        ttsActiveOffTimer = setTimeout(() => {
            ttsActiveOffTimer = null;
            if (ttsSpeakingDepth === 0) engine.setTtsActive(false);
        }, TTS_ACTIVE_HANGOVER_MS);
    }
    /** Echo can only arrive while audio plays or shortly after (capture +
     *  transcription latency stretch "shortly" to a few seconds). */
    const ECHO_TEXT_WINDOW_MS = 4000;
    /** How long a paused recognizer waits after playback before reopening the
     *  mic, so a phone speaker's reverb isn't heard as the user. */
    const MIC_RESUME_COOLDOWN_MS = 700;
    const micCooldown = isSingleOwnerMicPlatform();
    function inEchoWindow(): boolean {
        return ttsSpeakingDepth > 0 || Date.now() - lastTtsEndedAt < ECHO_TEXT_WINDOW_MS;
    }
    const tts = {
        async speak(text: string, options?: import('../../../src/platform/index.js').TtsOptions): Promise<void> {
            // A torn-down session must never voice anything. A slow LLM turn
            // (the Claude Subscription CLI can resolve minutes after the user
            // quit) would otherwise play into whatever session is now on screen:
            // the cross-session ghost-voice leak. `torn` is the one chokepoint
            // covering every caller (opener, response, check-in line).
            if (!ttsEnabled || torn) return;
            ++ttsSpeakingDepth;
            ttsPlaybackStarted(text);
            try {
                return await activeTts.speak(text, options);
            } finally {
                if (--ttsSpeakingDepth === 0) ttsPlaybackEnded();
            }
        },
        prefetch(text: string, options?: import('../../../src/platform/index.js').TtsOptions): void {
            // Without this passthrough the streaming bridge sees no prefetch()
            // on the wrapper and inter-sentence synthesis stays serial.
            if (!ttsEnabled || torn) return;
            activeTts.prefetch?.(text, options);
        },
        cancel(): Promise<void> {
            return activeTts.cancel();
        },
        listVoices() {
            return activeTts.listVoices();
        },
    } satisfies TtsEngine;
    // On the server-Whisper path, barge-in comes from its continuous
    // (echo-cancelled) capture stream. Wired after the tts wrapper exists, and
    // extracted so switchSttEngine can re-wire a newly built engine.
    function wireWhisperBargeIn(): void {
        if (!whisperEngine) return;
        whisperEngine.setBargeInHandler(() => {
            // Only meaningful while the facilitator is responding: hush it so
            // the user isn't talked over. The utterance keeps being captured and
            // gets its own turn, which supersedes this one. Muting TTS only, so
            // a false trigger doesn't lose the in-flight reply - it just
            // finishes silently into the transcript. In a silence hold there's
            // nothing to interrupt (busy is false) and the resume classifier
            // owns leaving the hold, so don't clear it here.
            if (!busy) return;
            void tts.cancel();
            activeTtsAbort?.abort();
            onBargeIn();
        });
    }
    wireWhisperBargeIn();

    // Inject an orb into the global nav's .nav-center slot and override the nav
    // links to End / History. Both are restored on teardown so swapping back to
    // setup doesn't leave stale chrome.
    const navCenter = document.getElementById('navCenter');
    const navLinks = document.getElementById('navLinks');
    const savedNavLinks = navLinks ? navLinks.innerHTML : null;
    if (navCenter) {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-breathing orb-nav" id="orb"></div>
                <button type="button" class="session-hamburger" id="sessionHamburger" aria-label="${t('Session menu')}" aria-haspopup="true" aria-controls="mobileMoreSheet" data-mobile-more-open>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
                </button>
            </div>`;
    }
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">${t('End')}<span class="nav-word-session"> ${t('Session')}</span></a>
            <a href="#" data-nav="history">${t('History')}</a>
            <button type="button" class="nav-info-btn" id="session-info-btn" aria-label="${t('Session info')}" title="${t('Session info')}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button type="button" class="theme-toggle"
                data-theme-toggle aria-label="${t('Toggle theme')}"></button>`;
        // Re-init the theme toggle since we just replaced its DOM node.
        const themeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
        if (themeBtn) initThemeToggle(themeBtn);
        navLinks
            .querySelector<HTMLElement>('#session-info-btn')
            ?.addEventListener('click', () => infoPanel.toggle());
    }

    const conversation = root.querySelector<HTMLElement>('#conversation')!;
    const typingIndicator = root.querySelector<HTMLElement>('#typing-indicator')!;
    const statusEl = root.querySelector<HTMLElement>('#voice-status')!;
    const timerEl = root.querySelector<HTMLElement>('#timer')!;
    const ttsToggle = root.querySelector<HTMLButtonElement>('#tts-toggle')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#voice-btn')!;
    const listenBtn = root.querySelector<HTMLButtonElement>('#listen-btn')!;
    const voicePickerBtn = root.querySelector<HTMLButtonElement>('#voice-picker-btn')!;
    const kasinaToggle = root.querySelector<HTMLInputElement>('#kasina-toggle')!;
    const orbEl = document.getElementById('orb');
    const endBtn = document.getElementById('end-btn') as HTMLAnchorElement | null;

    // The orb is always breathing, with `orb-holding` layered on during silence
    // mode. Richer states (listening / thinking / speaking) are meditation-pal-1au.
    // Silence-hold state drives both the orb glow and the "Just Listen"
    // highlight from one place, so every entry/exit path (manual button, an LLM
    // [HOLD], resuming by speaking) keeps them in sync.
    function setHolding(holding: boolean): void {
        if (orbEl) orbEl.classList.toggle('orb-holding', holding);
        listenBtn.classList.toggle('active', holding);
    }

    // Begin a silence hold. Every entry path (confirmed auto-[HOLD], manual
    // button) routes through here so the view flag, pacing controller, buffer,
    // and orb glow flip together, and a pending [HOLD] bid is always cleared.
    function enterHold(): void {
        tapEvent('hold', 'enter');
        tapFlags({ silenceMode: true, awaitingHoldConfirm: false });
        awaitingHoldConfirm = false;
        silenceMode = true;
        silenceBuffer = [];
        pacing.enterSilenceMode();
        setHolding(true);
        setStatus(t("Holding space, say when you're ready to continue"));
    }

    function setStatus(text: string): void {
        statusEl.textContent = text;
    }

    // Slow-response indicator: if nothing has been spoken this long after a
    // turn (or opener) started generating, say so - during a provider
    // slowdown or outage the quiet typing dots read as a dead app. One shared
    // timer: arming replaces any previous one, and the first spoken sentence
    // or the turn's end clears it.
    const SLOW_RESPONSE_STATUS_MS = 15_000;
    let slowStatusTimer: ReturnType<typeof setTimeout> | null = null;
    function armSlowResponseStatus(): void {
        clearSlowResponseStatus();
        slowStatusTimer = setTimeout(
            () => setStatus(t('Still working - the response is taking longer than usual')),
            SLOW_RESPONSE_STATUS_MS
        );
    }
    function clearSlowResponseStatus(): void {
        if (slowStatusTimer) {
            clearTimeout(slowStatusTimer);
            slowStatusTimer = null;
        }
    }

    // Persistent STT outage banner. The status line and a one-shot toast are
    // easy to miss, so a run of failed transcriptions raises a banner that stays
    // until a transcription lands: nobody should talk into a dead mic for a
    // whole session unaware. Streak-tracked so a network blip doesn't flash it.
    const sttTroubleEl = root.querySelector<HTMLElement>('#stt-trouble');
    let sttFailureStreak = 0;
    /** Show the banner once failures pass the threshold; called on each STT error. */
    function noteSttFailure(): void {
        sttFailureStreak++;
        if (sttFailureStreak >= 2 && sttTroubleEl) renderSttTrouble();
    }
    /**
     * Fill the trouble banner. When aloud cloud is an available STT option and
     * we're not on it, offer a one-click switch, so a user whose browser blocks
     * its speech recognizer (common on Edge/Windows) gets a working mic without
     * leaving the session or hunting through Settings.
     */
    function renderSttTrouble(): void {
        if (!sttTroubleEl) return;
        const canSwitchToCloud =
            sttChoice !== 'aloud-gpt-transcribe' &&
            sttEngineOptions(isWebMode()).some((o) => o.value === 'aloud-gpt-transcribe');
        sttTroubleEl.replaceChildren();
        const msg = document.createElement('span');
        msg.textContent = canSwitchToCloud
            ? t('Trouble hearing you - your browser may be blocking its speech recognition.')
            : t(
                  "Trouble with speech to text. We're not catching your voice right now - check your connection, or change speech recognition in Settings."
              );
        sttTroubleEl.appendChild(msg);
        if (canSwitchToCloud) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'stt-trouble-btn';
            btn.textContent = t('Use aloud cloud speech');
            btn.addEventListener('click', () => void switchSttEngine('aloud-gpt-transcribe'));
            sttTroubleEl.appendChild(btn);
        }
        sttTroubleEl.classList.remove('hidden');
    }
    /** Clear the streak + banner; called whenever a transcription succeeds. */
    function clearSttTrouble(): void {
        sttFailureStreak = 0;
        sttTroubleEl?.classList.add('hidden');
    }

    // Guards a switch in progress so a double-click (or a fresh STT error
    // re-rendering the banner) can't build two engines at once.
    let switchingStt = false;
    /**
     * Swap the live STT engine mid-session (the trouble banner's button).
     * Re-derives every backend-shaped bit the listen loop, meter, and barge-in
     * read (all `let` above), rebuilds TTS so its barge-in wrapping matches the
     * new backend, and persists the choice. Stopping the old recognizer ends the
     * loop's current iteration; it re-enters on the new `stt`.
     */
    async function switchSttEngine(choice: SttEngineChoice): Promise<void> {
        if (switchingStt || torn || choice === sttChoice) return;
        switchingStt = true;
        try {
            setStatus(t('Switching to aloud cloud speech…'));
            const next = await createSttForChoice(choice, vadOpts);
            if (!next) {
                showErrorToast(
                    t("Couldn't start aloud cloud speech - check your connection and that you're signed in.")
                );
                setStatus(muted ? t('Muted') : t('Listening…'));
                return;
            }
            const prev = stt;
            stt = next;
            sttChoice = choice;
            sttBackend = sttBackendForChoice(choice);
            engineDrivenBargeIn = sttBackend === 'server-whisper';
            continuousCapture = engineDrivenBargeIn;
            whisperEngine =
                continuousCapture && next instanceof WhisperPcmSttEngine ? next : null;
            wireWhisperBargeIn();
            await rebuildTts(setup.voice);
            // Persist so the next session opens on the engine that worked here.
            try {
                const s = await loadAppSettings();
                await saveAppSettings({ ...s, sttEngine: choice });
            } catch {
                /* best-effort; the live switch still stands for this session */
            }
            stopMeter();
            clearSttTrouble();
            // Ends the loop's in-flight `for await` on the old engine; it re-enters
            // on the new `stt`. Restart it if it had already fallen out.
            void prev?.stop();
            if (!muted) {
                setStatus(t('Listening…'));
                startMeter();
                if (!listenLoopRunning) void listenLoop();
            } else {
                setStatus(t('Muted'));
            }
        } finally {
            switchingStt = false;
        }
    }

    /**
     * Phones stop the speech recognizer and mute the getUserMedia tracks when
     * the page goes to the background, and nothing brings them back: the listen
     * loop's `for await` just ends and the mic is dead for the rest of the
     * page's life, with no error shown (meditation-pal-wudm). Locking the screen
     * or taking a notification mid-sit is ordinary meditation behaviour, so this
     * has to self-heal. Rebuild the SAME engine on foreground and re-enter the
     * loop.
     *
     * Phones only (isSingleOwnerMicPlatform), for the reason the mic cooldown is
     * phone-only too: a desktop tab switch doesn't kill capture, and rebuilding
     * there would cut a live turn for nothing.
     */
    async function restartSttAfterForeground(): Promise<void> {
        if (torn || muted || switchingStt || !stt) return;
        switchingStt = true;
        try {
            const next = await createSttForChoice(sttChoice, vadOpts);
            if (!next) {
                // Leave the old engine in place: a failed rebuild shouldn't also
                // take away whatever capture may still work.
                renderSttTrouble();
                return;
            }
            const prev = stt;
            stt = next;
            whisperEngine = continuousCapture && next instanceof WhisperPcmSttEngine ? next : null;
            wireWhisperBargeIn();
            stopMeter();
            // Ends the loop's in-flight iteration on the old engine; it re-enters
            // on the new `stt`, or is restarted below if it had already fallen out.
            void prev?.stop();
            if (torn || muted) return;
            startMeter();
            if (!listenLoopRunning) void listenLoop();
            debugLog('stt restarted after foreground');
        } catch (err) {
            console.warn('STT restart after foreground failed', err);
            renderSttTrouble();
        } finally {
            switchingStt = false;
        }
    }

    const onVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible') return;
        if (!isSingleOwnerMicPlatform()) return;
        void restartSttAfterForeground();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Staged-mode phase hint: a quiet word in the input row ("sensing",
    // "finding words") so the user can feel where they are in the arc without
    // it being announced aloud. Hidden for single-phase modes.
    const phaseEl = root.querySelector<HTMLElement>('#session-phase');
    function setPhaseHint(): void {
        if (!phaseEl || !stager) return;
        phaseEl.textContent = t(stager.phase.label);
        phaseEl.title = t('{mode}: step {n} of {total}', {
            mode: t(mode.label),
            n: stager.phaseIndex + 1,
            total: stager.phases.length,
        });
        phaseEl.classList.remove('hidden');
    }
    setPhaseHint();

    function appendMessage(
        role: 'user' | 'assistant',
        text: string,
        partial = false
    ): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role === 'assistant' ? 'facilitator' : 'user'}${partial ? ' partial' : ''}`;
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        el.appendChild(content);
        // Insert before the typing indicator so it stays at the bottom.
        conversation.insertBefore(el, typingIndicator);
        conversation.scrollTop = conversation.scrollHeight;
        return el;
    }

    /**
     * Progressive facilitator bubble revealed in step with the voice: each
     * sentence appears when its audio starts (streaming-tts onSpeakStart), not
     * when generation finishes - text running ahead of the voice was the
     * immersion-breaker beta users flagged. finalize() swaps in the exact clean
     * text (original whitespace, plus anything never spoken because TTS was
     * hushed or failed), so the transcript always ends complete. The typing dots
     * stay up until the first reveal so the wait doesn't look dead.
     */
    function createAssistantReveal(): {
        anchor: () => void;
        reveal: (sentence: string) => void;
        finalize: (cleanText: string) => void;
        discard: () => void;
    } {
        let el: HTMLElement | null = null;
        let content: HTMLElement | null = null;
        let revealed = '';
        // Created hidden so anchor() can claim its transcript position (ahead of
        // any later turn's bubbles) without showing an empty balloon while the
        // first audio chunk is in flight.
        const ensure = (): HTMLElement => {
            if (!el) {
                el = appendMessage('assistant', '');
                el.style.display = 'none';
                content = el.querySelector<HTMLElement>('.message-content');
            }
            return content ?? el;
        };
        const show = (text: string): void => {
            const target = ensure();
            el!.style.display = '';
            target.textContent = text;
            hideTyping();
            conversation.scrollTop = conversation.scrollHeight;
        };
        return {
            anchor: () => {
                ensure();
            },
            reveal: (sentence: string) => {
                revealed = revealed ? `${revealed} ${sentence}` : sentence;
                show(revealed);
            },
            finalize: (cleanText: string) => {
                show(cleanText);
            },
            discard: () => {
                el?.remove();
                el = null;
                content = null;
            },
        };
    }

    /** Render a billing apology (paused / out-of-credits) as a transient
     *  facilitator bubble. NOT added to session history, so the saved transcript
     *  and the next LLM call's context resume from the last real turn once the
     *  user tops up or switches to a local/BYOK provider. showBuy adds an inline
     *  top-up button (useful only out-of-credits; a top-up can't lift a
     *  soft-launch pause). */
    function appendBillingApology(text: string, showBuy: boolean): void {
        const el = appendMessage('assistant', text);
        if (!showBuy) return;
        // A retreat attendee (meditation-pal-414) shouldn't be nudged to buy:
        // their cap reset restores access, not a top-up.
        if (getRetreatCovered()) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'buy-clouds-inline';
        btn.innerHTML = withCloudOutline(t('Buy ☁️ to continue'));
        btn.addEventListener('click', () => {
            void showBuyCreditsModal({
                title: t("You're out of clouds"),
                subtitle: t('Top up to keep going, or switch to a local/BYOK provider in Settings.'),
            });
        });
        el.appendChild(btn);
    }

    /** The voice name to voice a canned apology in. Strips the `aloud:` prefix
     *  for the hosted endpoint; returns null (server default, then browser
     *  fallback) for a browser-side voice or non-hosted provider. */
    function cannedVoice(): string | null {
        const v = setup.voice;
        if (setup.provider === 'aloud' && v?.startsWith('aloud:')) return v.slice('aloud:'.length);
        return null;
    }

    /** First TTS failure of a turn (streaming-tts onTtsError). TTS stays
     *  non-fatal (the reply still lands in the transcript and the loop keeps
     *  listening), but hosted billing/auth failures must be SEEN: out of credits
     *  gets the same apology + buy prompt as the LLM leg, other recognized cloud
     *  conditions toast. Unrecognized errors stay quiet - a browser speech
     *  hiccup isn't worth interrupting a meditation for. */
    function handleTtsError(err: unknown): void {
        if (torn) return;
        // The browser refused to play the audio we did synthesize (Safari's
        // per-element autoplay gate, or a per-site "never auto-play" setting).
        // Worth saying: the alternative is a whole sit in silence with no clue.
        if ((err as { name?: string })?.name === 'NotAllowedError') {
            showErrorToast(t('Your browser blocked audio playback - allow auto-play for this site.'));
            if (cannedVoice()) reportCloudIncident('client_playback_blocked', { model: cannedVoice() ?? '' });
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/insufficient_credits|out of credits|endpoint 402/i.test(msg)) {
            appendBillingApology(OUT_OF_CREDITS_MESSAGE, true);
            void playCannedApology('insufficient_credits', cannedVoice(), OUT_OF_CREDITS_MESSAGE);
            return;
        }
        // A hosted voice that failed for any other reason (5xx, timeout,
        // network): the sit continues text-first, the operator gets the row.
        if (isCloudTtsError(msg)) reportCloudIncident('client_tts_error', { detail: msg, model: cannedVoice() ?? '' });
        const described = describeCloudError(msg);
        if (described) showErrorToast(described);
    }

    // CSS hides the bubble with `.typing-bubble { display: none }` and reveals
    // it via `.typing-bubble.visible`, so toggle the class, not the `hidden`
    // attribute (which that display rule overrides).
    function showTyping(): void {
        typingIndicator.classList.add('visible');
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideTyping(): void {
        typingIndicator.classList.remove('visible');
        setFacilitatorHint(null);
    }

    // Transient hint next to the typing dots (e.g. Ollama "Loading model into
    // memory…" on first hit), inserted right after the typing indicator.
    function setFacilitatorHint(message: string | null): void {
        let el = document.getElementById('facilitator-status-hint');
        if (!message) {
            el?.classList.remove('visible');
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = 'facilitator-status-hint';
            el.className = 'facilitator-status-hint';
            typingIndicator.insertAdjacentElement('afterend', el);
        }
        el.textContent = message;
        el.classList.add('visible');
        conversation.scrollTop = conversation.scrollHeight;
    }

    const sessionStartMs = Date.now();

    // Keep the screen on for the session. The wake lock module also re-acquires
    // on visibility change while body[data-session-active] is set.
    document.body.dataset['sessionActive'] = 'true';
    void acquireWakeLock();

    // The clock in the input row: elapsed / time of day / countdown, switched by
    // tapping it. The mode and any timer length persist to app settings, so a
    // daily twenty-minute sit re-arms itself next session.
    const sessionClock = new SessionClock(
        timerEl,
        sessionStartMs,
        appSettings,
        (choice) => {
            appSettings.sessionClockMode = choice.mode;
            appSettings.sessionTimerMin = choice.timerMin;
            appSettings.showSessionClock = choice.showClock;
            appSettings.endSessionOnTimer = choice.endOnComplete;
            // Re-read before writing: the in-memory copy was loaded at mount
            // and must not clobber anything saved since.
            void loadAppSettings().then((s) =>
                saveAppSettings({
                    ...s,
                    sessionClockMode: choice.mode,
                    sessionTimerMin: choice.timerMin,
                    showSessionClock: choice.showClock,
                    endSessionOnTimer: choice.endOnComplete,
                })
            );
        }
    );

    // Rolling mean gap between completed turns, used to size the timer's
    // approach notice: with 90-second turns a one-minute lead can fall entirely
    // inside a silence and never be spoken before the end lands on top of it.
    const turnGaps: number[] = [];
    let lastTurnEndMs = sessionStartMs;
    const TURN_GAP_WINDOW = 4;
    function recordTurnGap(): void {
        const now = Date.now();
        turnGaps.push((now - lastTurnEndMs) / 1000);
        if (turnGaps.length > TURN_GAP_WINDOW) turnGaps.shift();
        lastTurnEndMs = now;
    }
    function avgTurnSec(): number | null {
        if (turnGaps.length === 0) return null;
        return turnGaps.reduce((a, b) => a + b, 0) / turnGaps.length;
    }

    // Initial mic / status hint.
    if (stt === null) {
        micBtn.disabled = true;
        micBtn.classList.add('disabled');
        const hint = t(
            'No microphone available. Try Chrome or Edge for built-in transcription, or check your microphone permissions.'
        );
        micBtn.title = hint;
        setStatus(t('Mic unavailable'));
    } else {
        setStatus(t('Listening…'));
    }

    function insertDivider(text: string): void {
        const divider = document.createElement('div');
        divider.className = 'message divider';
        divider.textContent = text;
        conversation.insertBefore(divider, typingIndicator);
    }

    // On continue, render the old exchanges under a "continuing from" divider.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        const oldDate = new Date(continueFrom.startTime * 1000).toLocaleString();
        insertDivider(t('continuing from {date}', { date: oldDate }));
        for (const ex of continueFrom.exchanges) {
            // Synthetic check-in / timer event turns are model context, not speech.
            if (ex.role === 'user' && isSyntheticEventTurn(ex.content)) continue;
            if (ex.role === 'user' || ex.role === 'assistant') {
                appendMessage(ex.role, ex.content);
            }
        }
        insertDivider(t('resumed'));
    }

    // Show the intention as a faint first line of context, if set.
    if (setup.intention.trim()) {
        insertDivider(t('intention: {intention}', { intention: setup.intention }));
    }

    let busy = false;
    let muted = false;
    let listenLoopRunning = false;
    let torn = false;
    // Capacitor App 'appStateChange' handle (mobile background-save); removed in
    // endSession. Held as the addListener promise so teardown can await + remove.
    let appStateListener: Promise<{ remove(): Promise<void> }> | null = null;
    // Smart check-ins: single-flight guard + how many have fired in the current
    // silence stretch (reset on any real user turn). Past the cap we stop paying
    // for LLM calls; auto-quit handles true walk-aways.
    let checkinInFlight = false;
    let smartCheckinStreak = 0;
    /** Consecutive [PASS] replies in this silence stretch. A user who asked for
     *  check-ins shouldn't get silence because the model keeps declining, so
     *  past the budget the next one speaks a canned line instead of asking. */
    let smartCheckinPasses = 0;
    /** Single-flight guard for the timer's approach/completion notices. */
    let timerNoticeInFlight = false;
    const SMART_CHECKIN_MAX_STREAK = 4;
    const SMART_CHECKIN_MAX_PASSES = 2;

    // ---- Check-in debug HUD --------------------------------------------
    // Dev tool: fixed monospace readout of [WAIT]/check-in traffic - active
    // modes, effective interval + countdown, rolling log of signals and
    // outcomes. Mounted via ?debug=checkin or the Developer setting (dev-mode.ts).
    const checkinDebug = isCheckinDebugOn();
    let debugPanel: HTMLElement | null = null;
    const debugLogLines: string[] = [];
    const debugT0 = Date.now();
    function debugLog(line: string): void {
        if (!checkinDebug) return;
        const t = Math.round((Date.now() - debugT0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        debugLogLines.push(`${mm}:${ss} ${line}`);
        if (debugLogLines.length > 8) debugLogLines.shift();
        renderCheckinDebug();
    }
    function renderCheckinDebug(): void {
        if (!debugPanel) return;
        const over = pacing.hasCheckinOverride() ? ' (wait)' : '';
        // Hold state is otherwise invisible: the re-entry window is a timestamp
        // with no UI, so testing it meant guessing at the clock.
        const sinceHold = Date.now() - leftHoldAt;
        const hold = silenceMode
            ? 'held'
            : awaitingHoldConfirm
              ? 'awaiting confirm'
              : sinceHold < HOLD_REENTRY_GRACE_MS
                ? `re-entry ${Math.ceil((HOLD_REENTRY_GRACE_MS - sinceHold) / 1000)}s`
                : 'off';
        debugPanel.textContent = [
            `timing ${checkinTiming} · content ${checkinContent} · hold ${hold}`,
            `interval ${pacing.getCheckinInterval()}s${over} · next ${Math.round(
                pacing.getCheckinEtaSec()
            )}s · streak ${smartCheckinStreak}/${SMART_CHECKIN_MAX_STREAK} · pass ${smartCheckinPasses}/${SMART_CHECKIN_MAX_PASSES}`,
            ...debugLogLines,
        ].join('\n');
    }
    let debugTimer: ReturnType<typeof setInterval> | null = null;
    if (checkinDebug) {
        debugPanel = document.createElement('div');
        debugPanel.className = 'checkin-debug';
        root.appendChild(debugPanel);
        debugTimer = setInterval(renderCheckinDebug, 1000);
        renderCheckinDebug();
    }
    let silenceMode = false;
    // When the last hold ended, for the re-entry grace window below. 0 = never
    // held this session, which reads as "long ago" and needs no special case.
    let leftHoldAt = 0;
    // Require-confirm handshake for a model-initiated [HOLD] (rlgm). Small
    // models especially emit [HOLD] far too eagerly, often off a truncated
    // fragment, and going silent on that one token can strand the session. So a
    // [HOLD] is only a *bid*: the facilitator asks "shall I be quiet?" (per the
    // prompt) and we set this flag instead of going silent. The meditator's NEXT
    // utterance is judged by classifyHoldConfirm, not by a second [HOLD] from
    // the unreliable model, and only a clear yes enters the hold. The manual
    // listen button bypasses all of this: clicking it IS the confirmation.
    let awaitingHoldConfirm = false;
    // Wall-clock of the last USER activity (a completed turn), for the
    // auto-quit-after-silence timer. Facilitator check-ins must NOT reset it, or
    // they'd keep a forgotten session alive forever. Seeded at mount so a
    // session opened and abandoned still quits.
    let lastActivityAt = Date.now();
    // The current session recap, refreshed in the background on a throttle
    // (refreshSummaryThrottled). Persisted into autosaves so an interrupted
    // session still has a history label AND a cheap-resume seed. Seeded from a
    // resumed session's prior recap; autosave falls back to the intention.
    let currentSummary = continueFrom?.notes ?? '';
    let summaryAtExchangeCount = 0;
    let summaryRefreshing = false;
    // Utterances spoken during a silence hold, accumulated until the
    // resume-intent classifier says the meditator wants to continue; the whole
    // buffer then becomes the resume turn's context. Cleared on entry to hold.
    let silenceBuffer: string[] = [];
    // True while the voice-picker modal is open: pause listening so the
    // mic doesn't transcribe a voice preview's own audio and "respond" to it.
    let voiceModalOpen = false;
    let currentPartial: HTMLElement | null = null;
    let scoredVoices: ScoredVoice[] = [];

    // Live in-session balance (opt-in; meditation-pal-14s). Off by default - a
    // ticking credit count is distracting mid-meditation. When on it reads the
    // shared balance store the LLM proxy feeds every turn, so it updates live
    // without extra round-trips.
    let unsubscribeBalance: (() => void) | null = null;
    const balanceEl = root.querySelector<HTMLElement>('#session-balance');
    // Reveal only once this session actually spends credits. Every metered call
    // (LLM, hosted TTS/STT, including a mid-session switch to a credit-spending
    // voice) publishes a lower balance, so keying visibility off a balance *drop*
    // beats predicting from the provider set: it stays hidden on local / BYOK /
    // subscription sessions instead of showing a frozen number, and needs no
    // voice/provider-change wiring. (Subsumes the retreat-covered case,
    // meditation-pal-414, kept below as a cheap guard.) subscribeBalance doesn't
    // fire on subscribe, so nothing paints until a real spend arrives.
    if (balanceEl && appSettings.showSessionBalance && !getRetreatCovered()) {
        let prev = getKnownBalance();
        let revealed = false;
        unsubscribeBalance = subscribeBalance((b) => {
            if (b == null) {
                balanceEl.classList.add('hidden');
                revealed = false;
                prev = b;
                return;
            }
            if (!revealed && prev != null && b < prev) revealed = true;
            if (revealed) {
                // creditAmount already carries the ☁️; outline it for light bg.
                balanceEl.innerHTML = withCloudOutline(creditAmount(b));
                balanceEl.classList.remove('hidden');
            }
            prev = b;
        });
    }

    // An utterance spoken while the facilitator holds silence. The meditator can
    // think out loud without the facilitator jumping in on every word: each
    // utterance is shown and buffered, and a lightweight classification (no
    // history) judges whether it means "I'm ready to continue." Only a yes exits
    // the hold and submits the whole buffer as the resume turn
    // (meditation-pal-k1yc). Check-ins are suppressed during a hold (pacing
    // returns Hold) and the listen loop awaits this, so there's no race with
    // respondTo / the check-in timer.
    async function handleSilenceUtterance(userText: string): Promise<void> {
        if (isNonSpeechOnly(userText)) return;
        appendMessage('user', userText);
        tapTurn('user', 'user', userText);
        silenceBuffer.push(userText);
        setStatus(t('Holding space, one moment…'));
        const classifyStart = Date.now();
        const verdict = await classifyResumeIntent(utilityProvider, userText, {
            onUsage: (u) => session.recordLlmUsage(u),
        });
        tapCall('classify-resume', Date.now() - classifyStart);
        tapEvent('classifier', 'resume', { verdict, utterance: userText });
        // The user may have toggled out of the hold (or the view torn down)
        // during the classifier round-trip; bail so we don't resurrect it.
        if (torn || !silenceMode) return;
        if (verdict === 'stay') {
            setStatus(t("Holding space, say when you're ready to continue"));
            return;
        }
        // 'resume' (they asked to continue) or 'error' (the classifier call
        // itself failed, e.g. a provider 429). On 'error' we fail OPEN and leave
        // the hold: a silence with no voice escape is the worst outcome (a
        // quota-stalled session could otherwise never be resumed by speech,
        // ff1y), and the resumed turn surfaces any real provider failure through
        // the normal error banner instead of trapping the user in limbo.
        const joined = silenceBuffer.join(' ');
        silenceBuffer = [];
        // Bubbles for the buffered utterances are already on screen; respondTo
        // records the joined text in history and runs the resume turn.
        await respondTo(joined, { skipUserBubble: true });
    }

    // The meditator's reply to the facilitator's "shall I be quiet?" bid
    // (awaitingHoldConfirm). A yes/no classifier, not a second [HOLD] from the
    // model, decides (rlgm): a clear yes enters the hold; a no (or a classifier
    // error, or the user carrying on after an eager mis-bid) runs as a normal
    // turn. Awaited by the listen loop, so no race with the check-in timer.
    async function handleHoldConfirm(userText: string): Promise<void> {
        if (isNonSpeechOnly(userText)) return;
        awaitingHoldConfirm = false;
        tapFlags({ awaitingHoldConfirm: false });
        const confirmStart = Date.now();
        const confirmed = await classifyHoldConfirm(utilityProvider, userText, {
            onUsage: (u) => session.recordLlmUsage(u),
        });
        tapCall('classify-confirm', Date.now() - confirmStart);
        tapEvent('classifier', 'hold-confirm', { confirmed, utterance: userText });
        if (torn) return;
        if (confirmed) {
            // Show their "yes" and begin the silence. The reply isn't recorded
            // as a meditation turn: enterHold resets the buffer, and the next
            // thing they say is what gets buffered for the resume.
            appendMessage('user', userText);
            tapTurn('user', 'user', userText);
            enterHold();
        } else {
            // Not a yes: an ordinary turn. Also the graceful exit for an eager
            // mis-bid - they kept talking, so we keep going.
            await respondTo(userText);
        }
    }

    // An utterance in the window just after a hold ended. The app already knows
    // a silence just broke - the model doesn't - so it decides here rather than
    // asking for a reply and then talking over it (tv9u). A yes speaks one
    // canned line and drops straight back under, skipping both the facilitation
    // turn and the "shall I be quiet?" handshake: the meditator confirmed that
    // once already, and they're usually only back here because the resume
    // classifier misread them. Anything else runs as an ordinary turn.
    async function handleReHoldRequest(userText: string): Promise<void> {
        if (isNonSpeechOnly(userText)) return;
        const reholdStart = Date.now();
        const asking = await classifyHoldRequest(utilityProvider, userText, {
            onUsage: (u) => session.recordLlmUsage(u),
        });
        tapCall('classify-rehold', Date.now() - reholdStart);
        tapEvent('classifier', 'rehold', { asking, utterance: userText });
        if (torn) return;
        if (!asking) {
            await respondTo(userText);
            return;
        }
        // Recorded, unlike the hold-confirm yes: the canned line goes into
        // history, so without the request the model later reads itself saying
        // "going quiet" with nothing that asked for it.
        appendMessage('user', userText);
        tapTurn('user', 'user', userText);
        session.addUserMessage(userText);
        await respondWithFacilitatorLine(builder.getHoldReentryLine(), 'reentry');
        if (torn) return;
        enterHold();
    }

    async function respondTo(
        userText: string,
        opts: { skipUserBubble?: boolean } = {}
    ): Promise<void> {
        // Drop transcriptions that are only non-speech markers ("[cough]",
        // "[BLANK_AUDIO]", "(wind blowing)", "*sighs*") or carry no words: a
        // cough or background noise shouldn't take the user's turn or wake us
        // from a silence hold. (The listen loop already cleared the partial.)
        if (isNonSpeechOnly(userText)) return;
        // Supersede any in-flight turn: bump the generation, stop the previous
        // turn generating (it bails without recording), and cut its audio. With
        // continuous capture this is how an interrupting utterance takes over.
        const myGen = ++turnGen;
        // Diagnostic (native STT resume: only the first sentence of a reply is
        // vocalized). If a reply/opener is still playing (busy) when this
        // utterance arrives, superseding it hushes the audio after the current
        // sentence. Log the interrupting text so a logcat reader can tell a real
        // barge-in from an un-caught echo of the facilitator's own voice.
        if (busy) console.info(`[turn] interrupting in-flight reply with: "${userText}"`);
        activeFullAbort?.abort();
        void tts.cancel();
        const myFullAbort = new AbortController();
        const myTtsAbort = new AbortController();
        activeFullAbort = myFullAbort;
        activeTtsAbort = myTtsAbort;
        // True once a newer turn (or teardown) has taken over; we bail silently
        // at each such point so the live turn owns the transcript + dots.
        const superseded = (): boolean => torn || myGen !== turnGen;
        // If the user just spoke to break a silence hold, a [HOLD] in the reply
        // shouldn't snap straight back into silence on the same turn - it reads
        // as "I can't get out of silence mode."
        const wasSilent = silenceMode;
        // aloud cloud is the convenience path: its glitches are smoothed over
        // in the chair and logged for the operator (cloud-incidents.ts).
        const cloudSmooth = setup.provider === 'aloud';
        busy = true;
        tapFlags({ busy: true });
        // Hoisted so the catch can discard a partially revealed bubble when the
        // stream dies mid-reply (the reply never reaches history).
        let reveal: ReturnType<typeof createAssistantReveal> | null = null;
        try {
            pacing.onSpeechEnd();
            pacing.onTranscription(userText);
            smartCheckinStreak = 0;
            smartCheckinPasses = 0;
            if (silenceMode) {
                silenceMode = false;
                leftHoldAt = Date.now();
                tapEvent('hold', 'exit');
                tapFlags({ silenceMode: false });
                setHolding(false);
            }
            // On a resume from silence the buffered utterances are already on
            // screen as user bubbles; don't double-render, just record the
            // joined text in history for the LLM turn.
            if (!opts.skipUserBubble) appendMessage('user', userText);
            // The buffered utterances were tapped as they arrived; tap the
            // joined resume text only when it wasn't already recorded.
            if (!opts.skipUserBubble) tapTurn('user', 'user', userText);
            session.addUserMessage(userText);
            // Dots the instant we submit, before any network round-trip, so the
            // user sees their turn was received.
            showTyping();
            setStatus(t('Thinking…'));

            // Ollama: surface a not-yet-loaded model next to the dots so the
            // user knows why the first response is slow. One cheap HTTP call.
            if (provider instanceof OllamaProvider) {
                setFacilitatorHint(await provider.coldLoadMessage());
            }
            if (superseded()) return;

            const systemPrompt = builder.buildSystemPrompt(stager?.promptSection());
            // Streaming + sentence-chunked TTS, falling back to non-streaming
            // when the provider has no completeStream: the first sentence starts
            // speaking before the rest finishes generating. Two signals, so a
            // barge-in can hush the audio (ttsSignal) without losing the
            // transcript, while a newer turn aborts outright (signal).
            // onSpeakStart fires with control tokens already stripped; status
            // stays "Thinking…" until a sentence actually speaks.
            armSlowResponseStatus();
            let bubble = createAssistantReveal();
            reveal = bubble;
            const turnStart = Date.now();
            const attemptCompletion = (target: typeof bubble) =>
                streamCompletionWithChunkedTts(provider, tts, session.getContextMessages(), {
                    system: systemPrompt,
                    ttsOptions: { rate: setup.ttsRate },
                    onTtsError: handleTtsError,
                    signal: myFullAbort.signal,
                    ttsSignal: myTtsAbort.signal,
                    onSpeakStart: (sentence) => {
                        if (!superseded()) {
                            clearSlowResponseStatus();
                            setStatus(t('Speaking…'));
                            target.reveal(sentence);
                        }
                    },
                });
            let { text: rawText, ttsDone, usage, finishReason } = await attemptCompletion(bubble);
            // A newer utterance took over mid-generation: drop this reply; the
            // live turn owns the typing dots + history.
            if (superseded()) {
                bubble.discard();
                return;
            }
            // A completion with NO text at all is a glitch, not a reply: some
            // endpoints intermittently burn the whole budget on a hidden
            // thinking preamble (Kimi K2, finish "length", meditation-pal-yi02).
            // One quiet retry before anything is said or shown about it; the
            // dots stay up, so from the chair it is just a slower turn.
            // Cloud only: on a local/BYOK provider nothing is hidden - the user
            // owns that setup and should see its failures as they happen.
            if (cloudSmooth && !rawText.trim() && finishReason !== BILLING_PAUSED_FINISH) {
                console.warn(
                    `[turn] empty completion finish=${finishReason ?? 'null'} raw=0 chars - retrying once`
                );
                tapEvent('error', 'empty-completion-retry', { finish: finishReason ?? 'null' });
                reportCloudIncident('client_llm_empty_retry', {
                    detail: `finish=${finishReason ?? 'null'}`,
                    model: setup.model,
                });
                bubble.discard();
                bubble = createAssistantReveal();
                reveal = bubble;
                ({ text: rawText, ttsDone, usage, finishReason } = await attemptCompletion(bubble));
                if (superseded()) {
                    bubble.discard();
                    return;
                }
            }
            clearSlowResponseStatus();
            const turnLatencyMs = Date.now() - turnStart;
            tapCall('turn', turnLatencyMs);
            const { hold, stage, waitSec, cleanText } = parseTurnSignals(rawText);
            // A soft-launch-pause canned turn (proxy spoke a graceful apology,
            // charged nothing): show it transiently but keep it OUT of session
            // history/logs so we resume from the last real turn. No buy prompt
            // and no silence mode - a top-up can't lift the pause.
            const ephemeral = finishReason === BILLING_PAUSED_FINISH;
            // Staged modes: apply the LLM's movement signal (clamped at the ends
            // of the arc) and persist the new phase for resume.
            if (stager && !ephemeral && stage !== 'none') {
                if (stager.apply(stage)) {
                    session.setModePhase(stager.phase.id);
                    tapEvent('stage', stage, { phase: stager.phase.id });
                    tapFlags({ phase: stager.phase.id });
                    setPhaseHint();
                } else {
                    tapEvent('stage', 'clamped', { signal: stage, phase: stager.phase.id });
                }
            }
            // Smart timing: [WAIT:Nm] sets when the next check-in may fire
            // (sticky across turns, clamped by the controller).
            if (!ephemeral && waitSec !== null) {
                if (checkinTiming === 'smart') {
                    pacing.setCheckinInterval(waitSec);
                    tapEvent('signal', 'wait', {
                        requestedSec: waitSec,
                        effectiveSec: pacing.getCheckinInterval(),
                    });
                    debugLog(`turn [WAIT] ${waitSec}s → interval ${pacing.getCheckinInterval()}s`);
                } else {
                    tapEvent('signal', 'wait-ignored', { requestedSec: waitSec });
                    debugLog(`turn [WAIT] ${waitSec}s ignored (timing ${checkinTiming})`);
                }
            }
            // Nothing to say is not a valid turn, whether the completion was
            // blank or carried only control tokens. A signal-only reply
            // ("[WAIT:8m]", a bare "[HOLD]") keeps rawText non-empty but leaves
            // cleanText empty once parseTurnSignals strips it - recording that
            // blank turn and speaking it gives the meditator total silence in
            // answer to what they said. The signals above are already applied,
            // so the model's intent still lands; only the empty turn is dropped.
            // A bare [HOLD] must NOT arm awaitingHoldConfirm (set further down,
            // past this bail): no question was asked, so the meditator's next
            // words are a normal turn, not an answer. (meditation-pal-9era)
            if (!ephemeral && !cleanText.trim()) {
                if (rawText.trim()) {
                    // The model chose to say nothing beyond its signals. That
                    // is a legitimate turn shape (a bare "[WAIT:8m]" after
                    // someone says they want to sit quietly), so go back to
                    // listening with no reply and no complaint.
                    tapEvent('signal', 'signal-only-reply', { raw: rawText });
                    bubble.discard();
                    hideTyping();
                    pacing.onResponseEnd();
                    setStatus(idleStatus());
                    return;
                }
                // finishReason is the one clue to WHY a completion came back
                // blank ("length" = budget eaten, "error" = upstream failed,
                // null = the stream ended without a done chunk); keep it in
                // the device log (meditation-pal-yi02).
                console.warn(`[turn] empty completion finish=${finishReason ?? 'null'} raw=0 chars`);
                if (!cloudSmooth) {
                    throw new Error(
                        t('The model returned an empty response. Try again, or check your provider in Settings.')
                    );
                }
                // aloud cloud, blank twice running: the meditator gets a short
                // canned acknowledgement in the facilitator's voice rather than
                // an error toast - their words shouldn't land in dead air, and
                // the next turn is a fresh request anyway. The operator sees
                // it in the admin incident log instead.
                tapEvent('error', 'empty-completion-fallback', { finish: finishReason ?? 'null' });
                reportCloudIncident('client_llm_empty_fallback', {
                    detail: `finish=${finishReason ?? 'null'}`,
                    model: setup.model,
                });
                const pool = localizePool(EMPTY_REPLY_FALLBACKS, sessionLanguageOf(sessionLanguage));
                const line = pool[Math.floor(Math.random() * pool.length)]!;
                session.addAssistantMessage(line, undefined, usage);
                bubble.anchor();
                setStatus(t('Speaking…'));
                bubble.reveal(line);
                try {
                    await tts.speak(line, { rate: setup.ttsRate });
                } catch (err) {
                    handleTtsError(err as Error);
                }
                bubble.finalize(line);
                tapTurn('assistant', 'reply', line, { raw: '', latencyMs: Date.now() - turnStart });
                if (superseded()) return;
                pacing.onResponseEnd();
                setStatus(idleStatus());
                return;
            }
            if (!ephemeral) session.addAssistantMessage(cleanText, undefined, usage);
            // Claim the bubble's transcript spot now (still hidden if nothing
            // has been spoken), so a turn that supersedes us mid-playback can't
            // end up ordered above this reply.
            bubble.anchor();

            // Let in-flight TTS chunks finish so the next turn doesn't pile on.
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            // Complete the bubble whatever happened to the audio (hushed
            // barge-in, TTS failure, normal finish): the reply is in history, so
            // the transcript must show it in full.
            bubble.finalize(cleanText);
            tapTurn('assistant', 'reply', cleanText, { raw: rawText, latencyMs: turnLatencyMs });
            if (superseded()) return;
            // A [HOLD] is only a bid: the facilitator just asked whether to go
            // quiet. Don't go silent here - the meditator's next utterance is
            // classified for a yes (rlgm). When silenceModeEnabled is false,
            // [HOLD] is ignored entirely.
            // (Re-entry right after a hold never reaches here: handleReHoldRequest
            // takes that turn before the model is asked for a reply.)
            awaitingHoldConfirm =
                !ephemeral && !wasSilent && hold && pacingConfig.silenceModeEnabled;
            tapFlags({ awaitingHoldConfirm });
            if (hold) tapEvent('signal', awaitingHoldConfirm ? 'hold-bid' : 'hold-bid-ignored');
            setStatus(idleStatus());
            pacing.onResponseEnd();
        } catch (err) {
            // The reply never made it into history: drop any partially revealed
            // bubble so the transcript matches what's recorded.
            reveal?.discard();
            if (superseded()) return;
            clearSlowResponseStatus();
            hideTyping();
            const msg = (err as Error).message;
            tapEvent('error', 'turn-failed', { message: msg });
            // 402s are already logged server-side; everything else that fails a
            // cloud turn in the app (timeouts, network, upstream) goes to the
            // operator's incident log.
            if (cloudSmooth && !/insufficient_credits|out of credits|endpoint 402/i.test(msg)) {
                reportCloudIncident('client_llm_error', { detail: msg, model: setup.model });
            }
            // Running out of credits is a graceful stop, not an error. Ephemeral
            // apology (NOT saved to history - we resume from the last real turn
            // once topped up or switched to local/BYOK), voiced via the free
            // canned endpoint, with a one-tap top-up in the transcript.
            // (meditation-pal-44o, meditation-pal-4l5)
            if (/insufficient_credits|out of credits|endpoint 402/i.test(msg)) {
                appendBillingApology(OUT_OF_CREDITS_MESSAGE, true);
                void playCannedApology('insufficient_credits', cannedVoice(), OUT_OF_CREDITS_MESSAGE);
            } else if (/claude_proxy_stalled/.test(msg)) {
                // The local Claude CLI failed across all retries (see
                // ClaudeProxyHttpProvider). First rule out a *removed* model:
                // swap to the nearest peer rather than apologize for a model
                // that will never answer.
                const swapped = await tryFallbackSubscriptionModel();
                if (!swapped) {
                    // Spoken apology stays non-technical (facilitator's voice,
                    // local TTS so it works offline); the toast names the cause
                    // when the CLI gave an actionable one - retrying can't fix
                    // a spent usage limit or an expired login.
                    const limit = /usage limit|rate limit/i.test(msg);
                    const auth = /oauth|authentication|api key|log ?in/i.test(msg);
                    const apology = limit
                        ? "Sorry, looks like I've hit a usage limit. Let's pick this up later."
                        : "Sorry, I'm having trouble responding right now. Let's try again in a moment.";
                    showErrorToast(
                        limit
                            ? t('Claude subscription usage limit reached. It resets after a few hours, or pick another model in Settings.')
                            : auth
                              ? t('Claude sign-in expired. Run `claude` in a terminal to log in again.')
                              : apology
                    );
                    void tts.speak(apology, { rate: setup.ttsRate });
                }
            } else {
                // Other failures: a toast is more visible than the small status
                // line, and the loop resumes listening so nothing is wedged.
                showErrorToast(describeCloudError(msg) ?? t('Something went wrong: {msg}', { msg }));
            }
            setStatus(idleStatus());
            // Reset the check-in clock like the success path does, or a long
            // failed turn leaves a stale timestamp and the next poll fires a
            // check-in right on top of the error apology.
            pacing.onResponseEnd();
        } finally {
            // Only the latest turn owns the shared flags: a superseded turn
            // unwinding later must not clear the busy/abort state the live one
            // set, or it would re-open the gate mid-response.
            if (myGen === turnGen) {
                busy = false;
                tapFlags({ busy: false });
                activeFullAbort = null;
                activeTtsAbort = null;
            }
            // A completed user turn is the activity signal for auto-quit, and
            // the sample the timer's approach notice sizes itself against.
            lastActivityAt = Date.now();
            recordTurnGap();
            // Persist every round (user message + whatever response or error) so
            // an offline LLM call or a crash still leaves the transcript
            // recoverable. No-op unless logging is on.
            void autosaveSession();
        }
    }

    /**
     * Always-on listening loop: one STT utterance per iteration, dispatched
     * when speech ends.
     *
     * On the engine-driven (server-Whisper) path the loop runs CONTINUOUSLY,
     * never pausing while the facilitator thinks or speaks, so the user is never
     * "deaf" mid-response (meditation-pal-57gl). That path's VAD rejects TTS
     * echo, a barge-in hushes the facilitator, and an utterance landing during a
     * response supersedes it in respondTo, so the response isn't awaited here.
     * Other backends (web-speech, capacitor) would transcribe the facilitator's
     * own TTS, so they pause while `busy` and use the barge-in wrapper.
     */
    async function listenLoop(): Promise<void> {
        if (!stt || listenLoopRunning) return;
        listenLoopRunning = true;
        // Toast a mic error only when it first appears (the loop re-checks every
        // 2s) so a persistent fault doesn't spam; reset on a successful capture
        // so a later recurrence surfaces again.
        let lastMicErrorToast: string | null = null;
        try {
            while (!torn && !muted) {
                // Always pause for the voice-picker modal; pause for `busy` only
                // on backends that can't capture during playback.
                while (
                    (voiceModalOpen || (!continuousCapture && busy)) &&
                    !torn &&
                    !muted
                ) {
                    await new Promise<void>((r) => setTimeout(r, 100));
                }
                // Then let the last of the facilitator's audio die away before
                // reopening the mic - the acoustic half of the echo guard, and
                // the only half that works when the recognizer mangles what it
                // leaked (meditation-pal-oxmt). Phones only: it's their speaker
                // that reverberates, and the wait costs the start of a barge-in,
                // which on desktop reopens the mic mid-sentence.
                while (micCooldown && !continuousCapture && !torn && !muted) {
                    const since = Date.now() - lastTtsEndedAt;
                    if (ttsSpeakingDepth === 0 && since >= MIC_RESUME_COOLDOWN_MS) break;
                    await new Promise<void>((r) =>
                        setTimeout(r, Math.max(50, MIC_RESUME_COOLDOWN_MS - since))
                    );
                }
                if (torn || muted) break;

                const cycleStart = Date.now();
                let finalText = '';
                // Engine-reported "speech began while TTS was playing", the
                // authoritative echo signal. undefined on engines that don't
                // report it; the guard then falls back to the arrival window.
                let finalStartedDuringTts: boolean | undefined;
                let micError: string | null = null;
                // Echo test: did the utterance start during playback (or, absent
                // that signal, land near it), AND does it read as a verbatim run
                // of the recently synthesized text?
                const isEcho = (text: string, startedDuringTts: boolean | undefined): boolean =>
                    (startedDuringTts ?? inEchoWindow()) && looksLikeTtsEcho(text, spokenTail);
                try {
                    for await (const event of stt.start()) {
                        if (event.type === 'partial') {
                            // Don't preview our own echo as the user's words: a
                            // partial bubble showing the facilitator's sentence
                            // breaks immersion even when the final is dropped.
                            // Same for non-speech markers ("[NOISES]"): the
                            // final would be dropped, so don't flash the bubble.
                            if (
                                isEcho(event.text, event.startedDuringTts) ||
                                isNonSpeechOnly(event.text)
                            ) {
                                currentPartial?.remove();
                                currentPartial = null;
                                continue;
                            }
                            if (!currentPartial) {
                                currentPartial = appendMessage('user', event.text, true);
                            } else {
                                // Update the inner .message-content: setting
                                // textContent on the bubble wipes that wrapper.
                                const content =
                                    currentPartial.querySelector('.message-content');
                                if (content) content.textContent = event.text;
                                // Keep the growing partial in view: a multi-line
                                // in-progress bubble otherwise runs off the bottom
                                // of the transcript until the final replaces it.
                                conversation.scrollTop = conversation.scrollHeight;
                            }
                        } else if (event.type === 'final') {
                            finalText = event.text;
                            finalStartedDuringTts = event.startedDuringTts;
                            // Billable server-side STT compute (Whisper) reports
                            // audio seconds; on-device engines omit it.
                            if (event.seconds) session.recordStt(event.seconds);
                        } else if (event.type === 'error') {
                            micError = describeSttError(event.error);
                            // Hosted STT failures reach the operator's incident
                            // log; device recognizers are the user's own.
                            const sttMsg = event.error instanceof Error ? event.error.message : String(event.error);
                            if (/Whisper endpoint (?!402)/.test(sttMsg)) {
                                reportCloudIncident('client_stt_error', { detail: sttMsg });
                            }
                        }
                    }
                } catch (err) {
                    micError = describeSttError(err);
                }
                // Transcript-level echo guard (meditation-pal-p8lx): our own TTS
                // leaking back through the mic must not take a turn, wake a
                // silence hold, answer a hold-confirm question, or read as a
                // request to go back under. One choke point covering every
                // dispatch path below.
                if (finalText.trim() && isEcho(finalText.trim(), finalStartedDuringTts)) {
                    console.info(`[echo-guard] dropped TTS echo: "${finalText.trim()}"`);
                    tapEvent('audio', 'echo-dropped', { text: finalText.trim() });
                    finalText = '';
                }
                if (currentPartial) {
                    currentPartial.remove();
                    currentPartial = null;
                }
                if (torn || muted) break;
                // The voice modal opened mid-capture: discard what was heard
                // (likely a preview) and wait it out.
                if (voiceModalOpen) continue;

                if (finalText.trim()) {
                    lastMicErrorToast = null;
                    clearSttTrouble();
                    const text = finalText.trim();
                    tapEvent('stt', 'final', { text });
                    // "mute" outranks every route below, silence mode included:
                    // it's the one thing you say when you want the app to stop
                    // hearing you, so it must not become a turn or wake a hold.
                    if (isMuteCommand(text)) {
                        tapEvent('audio', 'mute-command', { text });
                        tapFlags({ muted: true });
                        setMuted(true);
                        break;
                    }
                    // Precedence between the silence handlers lives in
                    // routeUtterance, where it can be tested without a mic.
                    const route = routeUtterance({
                        silenceMode,
                        awaitingHoldConfirm,
                        silenceModeEnabled: pacingConfig.silenceModeEnabled,
                        msSinceHoldEnded: Date.now() - leftHoldAt,
                    });
                    tapEvent('note', `route:${route}`);
                    switch (route) {
                        case 'silence':
                            await handleSilenceUtterance(text);
                            break;
                        case 'hold-confirm':
                            await handleHoldConfirm(text);
                            break;
                        case 'rehold':
                            await handleReHoldRequest(text);
                            break;
                        case 'normal':
                            if (continuousCapture) {
                                // Don't block the mic on the response; keep
                                // capturing so an interrupting utterance is
                                // caught. respondTo supersedes any in-flight
                                // turn itself.
                                void respondTo(text);
                            } else {
                                await respondTo(text);
                            }
                            break;
                    }
                } else if (micError) {
                    tapEvent('stt', 'error', { message: micError });
                    setStatus(micError);
                    if (micError !== lastMicErrorToast) {
                        showErrorToast(micError);
                        lastMicErrorToast = micError;
                    }
                    // Raise the persistent banner once failures stop looking
                    // like a one-off, so a sustained outage stays visible after
                    // the toast fades and the status reverts.
                    noteSttFailure();
                    // Brief backoff so a broken mic doesn't tight-loop us.
                    await new Promise<void>((r) => setTimeout(r, 2000));
                } else if (Date.now() - cycleStart < 1000) {
                    // Empty capture that also ended in under a second: the
                    // engine is bouncing (e.g. Android's recognizer erroring
                    // straight into 'stopped'). Pace the restart so a bounce
                    // can't become a bridge-speed storm.
                    await new Promise<void>((r) => setTimeout(r, 600));
                }
                // Empty utterance with no error: just loop and listen again.
            }
        } finally {
            listenLoopRunning = false;
        }
    }

    function setMicButtonState(): void {
        if (!stt) return;
        // CSS drives the mute-line off `.btn-voice.active` (active = mic on,
        // line hidden), so muting means removing .active. The orb desaturates
        // via .orb-muted.
        micBtn.classList.toggle('active', !muted);
        orbEl?.classList.toggle('orb-muted', muted);
        micBtn.setAttribute(
            'aria-label',
            muted ? t('Unmute microphone') : t('Mute microphone')
        );
    }

    // Mic input-level ring (the .btn-voice.active --mic-level box-shadow).
    // server-Whisper feeds it from the engine's own per-frame RMS, NEVER a
    // second mic stream: the old analyser stream made macOS re-arbitrate its
    // single voice-processing input between two captures, which could glitch or
    // hard-zero the engine's stream mid-utterance (lost words no VAD can
    // recover). Web Speech hides its audio, so on desktop it keeps the small
    // dedicated meter stream (cosmetic; failures swallowed).
    //
    // On mobile the mic has a single owner: that getUserMedia meter stream
    // starves the system speech recognizer, so onresult never fires and the ring
    // pulses while nothing is transcribed (the android-chrome-speech-display
    // bug). Skip the meter there - recognition beats a cosmetic ring, and Web
    // Speech gives us no stream to share. Android Chrome is confirmed; iOS/iPadOS
    // stays in the gate defensively, though it no longer reaches this path (the
    // picker keeps Web Speech off iOS entirely - meditation-pal-j8k1).
    let micMeter: MicMeter | null = null;
    let engineMeterOn = false;
    function startMeter(): void {
        if (whisperEngine) {
            if (engineMeterOn) return;
            engineMeterOn = true;
            // Same level mapping as mic-meter.ts (GAIN 4); smoothing retuned
            // for the ~85ms frame cadence vs its 60fps rAF.
            let smoothed = 0;
            whisperEngine.setLevelListener((rms) => {
                const level = Math.min(1, rms * 4);
                smoothed = smoothed * 0.6 + level * 0.4;
                micBtn.style.setProperty('--mic-level', smoothed.toFixed(3));
            });
            return;
        }
        if (micMeter || sttBackend !== 'web-speech') return;
        // Single-owner mic platforms (Android, iOS/iPadOS): see above.
        if (isSingleOwnerMicPlatform()) return;
        void startMicMeter(micBtn, appSettings.micDeviceId)
            .then((m) => {
                if (torn || muted) m.stop(); // raced with teardown/mute
                else micMeter = m;
            })
            .catch(() => {});
    }
    function stopMeter(): void {
        if (engineMeterOn) {
            whisperEngine?.setLevelListener(null);
            micBtn.style.removeProperty('--mic-level');
            engineMeterOn = false;
        }
        micMeter?.stop();
        micMeter = null;
    }

    /** Mic on/off. Unmuting is button-only - a muted mic hears no way back. */
    // The resting status line between turns. Every reply path resets the
    // line when it ends, and a mute set mid-reply must survive that.
    function idleStatus(): string {
        if (muted) return t('Muted');
        return stt ? t('Listening…') : t('Mic unavailable');
    }

    function setMuted(next: boolean): void {
        if (!stt || next === muted) return;
        if (next) {
            muted = true;
            void stt.stop();
            stopMeter();
            setMicButtonState();
            setStatus(t('Muted'));
        } else {
            muted = false;
            setMicButtonState();
            // The listen loop resumes without re-announcing, so clear the
            // 'Muted' status here or it sticks.
            setStatus(
                silenceMode
                    ? t("Holding space, say when you're ready to continue")
                    : stt
                      ? t('Listening…')
                      : t('Ready')
            );
            startMeter();
            void listenLoop();
        }
    }

    micBtn.addEventListener('click', () => setMuted(!muted));

    // TTS toggle: when off, cancel in-flight speech and skip later speak()
    // calls. The .active class shows the wave icons; without it, the mute-line.
    let ttsEnabled = true;
    ttsToggle.addEventListener('click', () => {
        ttsEnabled = !ttsEnabled;
        ttsToggle.classList.toggle('active', ttsEnabled);
        if (!ttsEnabled) void tts.cancel();
    });

    // Manual silence-mode toggle. Exiting is immediate here; while held, the
    // resume-intent classifier decides when speech ends the hold.
    listenBtn.addEventListener('click', () => {
        if (silenceMode) {
            silenceMode = false;
            leftHoldAt = Date.now();
            pacing.exitSilenceMode();
            setHolding(false);
            setStatus(stt ? t('Listening…') : t('Ready'));
        } else {
            // Clicking the button IS the confirmation: bypass the auto-[HOLD]
            // bid/classify handshake (rlgm) and go straight into the hold.
            enterHold();
        }
    });

    // Window/document-level listeners (kasina drag, beforeunload) outlive the
    // view's elements, so they must be removed on teardown or they leak across
    // sessions. One AbortController covers them all; endSession() aborts it, and
    // it's handed to initKasinaMode() so its document listeners detach too.
    const viewCleanup = new AbortController();
    // Tear the info panel's overlay + document listener down with the view.
    viewCleanup.signal.addEventListener('abort', () => infoPanel.dispose());

    // Guard against accidentally closing/reloading the tab mid-session (the
    // browser's native "Leave site?" prompt). In-app nav away is already guarded
    // by showEndConfirm on the End/History links below.
    window.addEventListener(
        'beforeunload',
        (e) => {
            e.preventDefault();
            e.returnValue = '';
        },
        { signal: viewCleanup.signal }
    );

    // Mobile: Android can kill a backgrounded activity, cold-booting to setup
    // (meditation-pal-v73p). Force a save the moment we go inactive so the
    // resume pointer + latest transcript are on disk before any kill. Per-round
    // autosave already covers the common case; this catches mid-round progress.
    //
    // Coming BACK is where the mic gets rebuilt: the Capacitor Android WebView
    // does not fire 'visibilitychange' across a background round trip, so the
    // visibilitychange handler below - the only trigger wudm shipped with -
    // never ran on a phone, and the mic stayed deaf until the adapter's 15s
    // idle backstop happened to relaunch it. appStateChange is the event that
    // actually arrives there.
    // Removed in endSession (App.addListener isn't AbortController-aware).
    if (isCapacitor()) {
        appStateListener = (async () => {
            const { App } = await import('@capacitor/app');
            return App.addListener('appStateChange', ({ isActive }) => {
                if (torn) return;
                if (!isActive) {
                    void autosaveSession();
                    return;
                }
                if (isSingleOwnerMicPlatform()) void restartSttAfterForeground();
            });
        })();
    }

    // Kasina gazing mode, shared with the noting session view. Document-level
    // listeners are tied to viewCleanup so they don't leak across sessions.
    if (orbEl) {
        initKasinaMode({
            orb: orbEl,
            root,
            toggle: kasinaToggle,
            signal: viewCleanup.signal,
        });
    }

    // Voice picker: the setup view's modal layout, but selecting a voice here
    // also rebuilds the live tts engine so the next utterance uses it.
    void initVoicePicker();

    async function initVoicePicker(): Promise<void> {
        const [server, hosted] = await Promise.all([fetchServerVoices(), fetchCloudVoices()]);
        scoredVoices = buildScoredVoiceList(server, true, hosted, sessionLanguage);
        updateVoicePickerLabel();
    }

    function updateVoicePickerLabel(): void {
        const name = stripVoicePrefix(setup.voice);
        if (name) voicePickerBtn.textContent = `${name} · ${voiceRateLabel(name, scoredVoices, setup.ttsRate)}`;
        else voicePickerBtn.textContent = t('Voice');
    }

    voicePickerBtn.addEventListener('click', () => openSessionVoiceModal());

    function openSessionVoiceModal(): void {
        const modal = root.querySelector<HTMLElement>('#voice-modal');
        const listEl = root.querySelector<HTMLElement>('#voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#modal-speed-slider');
        const speedLabel = root.querySelector<HTMLElement>('#modal-speed-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(setup.voice);
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true, hideIncompatible: true });
        speedSlider.value = String(setup.ttsRate);
        syncSpeedControlForVoice(speedSlider, speedLabel, currentName, scoredVoices, setup.ttsRate);
        modal.classList.remove('hidden');
        // Pause listening and stop in-flight capture while the modal is open, so
        // voice previews aren't transcribed as user turns.
        voiceModalOpen = true;
        void stt?.stop();

        const onListClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const row = target.closest<HTMLElement>('.voice-row');
            if (!row) return;
            const name = row.dataset['voiceName'];
            if (!name) return;
            const entry = scoredVoices.find((v) => v.name === name);
            if (target.closest('.voice-row-preview')) {
                if (row.classList.contains('voice-row-locked')) return;
                runVoicePreview(name, setup.ttsRate, entry?.engine).catch((err) => {
                    showErrorToast(previewErrorMessage(err));
                });
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            setup.voice = prefixedVoiceId(entry?.engine, name);
            updateVoiceSelection(listEl, name);
            syncSpeedControlForVoice(speedSlider, speedLabel, name, scoredVoices, setup.ttsRate);
            updateVoicePickerLabel();
            // Rebuild the live engine, or a browser/server voice change would
            // update only the label and silently keep the old engine.
            void rebuildTts(setup.voice);
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            setup.ttsRate = rate;
            speedLabel.textContent = t('{rate} wpm', { rate });
            updateVoicePickerLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            stopVoicePreview();
            // The loop is parked in its busy/modal wait and picks back up on its
            // own; restart it if it had exited.
            voiceModalOpen = false;
            if (stt && !muted && !torn && !listenLoopRunning) void listenLoop();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            modal.removeEventListener('click', onBackdrop);
        };
        const onBackdrop = (e: MouseEvent) => {
            if (e.target === modal) closeModal();
        };
        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', onBackdrop);
    }

    // Greet before the listen loop starts. busy so the mic loop doesn't hear
    // input until the opener finishes. Resuming gets a welcome-back.
    {
        busy = true;
        void (async () => {
            try {
                // Prime the STT capture graph BEFORE the greeting so its onset
                // pre-buffer fills while the facilitator talks. Otherwise the
                // graph is built lazily on first start(), and a barge-in during
                // the greeting has an empty buffer and clips the first word (d35).
                await stt?.prime?.();
                if (continueFrom && continueFrom.exchanges.length > 0) {
                    await generateContinuationOpener();
                } else {
                    await generateOpener();
                }
            } finally {
                busy = false;
            }
        })();
    }

    /**
     * Fresh-session opener: a brief LLM welcome via buildOpenerPrompt (a
     * one-shot instruction, NOT kept in history), falling back to the static
     * opener pool on any error.
     */
    async function generateOpener(): Promise<void> {
        const openerPrompt = builder.buildOpenerPrompt(setup.intention.trim());
        const reveal = createAssistantReveal();
        try {
            setStatus(t('Thinking…'));
            showTyping();
            armSlowResponseStatus();
            // First LLM call, so this is where Ollama pays the cold-load cost;
            // surface that wait at session start.
            if (provider instanceof OllamaProvider) {
                setFacilitatorHint(await provider.coldLoadMessage());
            }
            const messages = [
                ...session.getContextMessages(),
                { role: 'user' as const, content: openerPrompt },
            ];
            const { text: rawText, ttsDone, usage, finishReason } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                {
                    system: builder.buildSystemPrompt(stager?.promptSection()),
                    ttsOptions: { rate: setup.ttsRate },
                    // Reveal in step with the voice (createAssistantReveal).
                    onTtsError: handleTtsError,
                    onSpeakStart: (sentence) => {
                        clearSlowResponseStatus();
                        setStatus(t('Speaking…'));
                        reveal.reveal(sentence);
                    },
                }
            );
            clearSlowResponseStatus();
            // Strip control tokens an eager model put on the greeting: an opener
            // can neither hold nor move the arc.
            const { cleanText } = parseTurnSignals(rawText);
            // An empty greeting is a failed opener: throw so the catch uses the
            // static fallback rather than a blank first turn. Tested on
            // cleanText, so a signal-only greeting falls back too (9era).
            if (!cleanText.trim()) {
                throw new Error(
                    `empty opener completion (finish=${finishReason ?? 'null'} raw=${rawText.length} chars)`
                );
            }
            tapTurn('assistant', 'opener', cleanText, { raw: rawText });
            // The opener prompt was one-shot; record only the greeting.
            session.addAssistantMessage(cleanText, undefined, usage);
            reveal.anchor();
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            reveal.finalize(cleanText);
            pacing.onResponseEnd();
            setStatus(idleStatus());
        } catch (err) {
            console.warn('LLM opener failed, using static fallback', err);
            clearSlowResponseStatus();
            reveal.discard();
            hideTyping();
            const fallback = builder.getSessionOpener();
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            tapEvent('note', 'opener-fallback');
            tapTurn('assistant', 'opener', fallback);
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(idleStatus());
        }
    }

    async function generateContinuationOpener(): Promise<void> {
        const continuationNote =
            'The meditator is returning to continue from a previous session. ' +
            "Offer a brief, warm welcome back and gently acknowledge they're " +
            'picking up where they left off.';
        const reveal = createAssistantReveal();
        try {
            setStatus(t('Welcoming you back…'));
            // Previous exchanges + the synthetic continuation note. The note
            // stays out of history: it's a one-shot instruction, not a turn.
            const messages = [
                ...session.getContextMessages(),
                { role: 'user' as const, content: continuationNote },
            ];
            showTyping();
            armSlowResponseStatus();
            const { text: rawText, ttsDone, usage, finishReason } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                {
                    system: builder.buildSystemPrompt(stager?.promptSection()),
                    ttsOptions: { rate: setup.ttsRate },
                    onTtsError: handleTtsError,
                    onSpeakStart: (sentence) => {
                        clearSlowResponseStatus();
                        setStatus(t('Speaking…'));
                        reveal.reveal(sentence);
                    },
                }
            );
            clearSlowResponseStatus();
            const { cleanText } = parseTurnSignals(rawText);
            // Empty welcome-back: fall through to the static fallback below.
            // cleanText, so a signal-only one falls back too (9era).
            if (!cleanText.trim()) throw new Error('empty continuation completion');
            session.addAssistantMessage(cleanText, undefined, usage);
            reveal.anchor();
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            reveal.finalize(cleanText);
            pacing.onResponseEnd();
            setStatus(idleStatus());
        } catch (err) {
            console.warn('Continuation opener failed', err);
            clearSlowResponseStatus();
            reveal.discard();
            hideTyping();
            const fallback = 'Welcome back. Let’s continue.';
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(idleStatus());
        }
    }

    // Kick off always-on listening when the view mounts.
    if (stt) {
        setMicButtonState();
        startMeter();
        void listenLoop();
    }

    // Background check-in loop, polling the PacingController. When it decides
    // it's been long enough since anything happened, a gentle check-in reminds
    // the user the facilitator is still there. Off in silence mode or when
    // check-ins are disabled.
    const CHECK_IN_POLL_MS = 10_000;
    const checkInTimer: ReturnType<typeof setInterval> | null = pacingConfig.silenceCheckinsEnabled
        ? setInterval(() => {
              if (torn || busy || muted) return;
              // The pacing controller only sees COMPLETED turns, so on the
              // continuous-capture path it can't tell the user is mid-ramble.
              // Without this guard a long utterance gets a check-in spoken over
              // it, which the user's voice then barge-in cancels: noise for all.
              if (whisperEngine?.userSpeechActive) return;
              const decision = pacing.shouldRespond();
              if (decision !== TurnDecision.CheckIn) return;
              if (checkinContent === 'smart') {
                  void respondWithSmartCheckIn();
              } else {
                  debugLog('canned check-in');
                  tapEvent('checkin', 'canned');
                  void respondWithFacilitatorLine(builder.getCheckInPrompt());
              }
          }, CHECK_IN_POLL_MS)
        : null;

    // Session-timer poll. Separate from the check-in loop and deliberately not
    // gated on silenceCheckinsEnabled or silence mode: a timer the user set is
    // the one thing that must land. It still waits for a turn boundary (busy),
    // so it never speaks over the user or a response in flight - a few seconds
    // late beats barging in.
    const TIMER_POLL_MS = 2000;
    const timerPoll = setInterval(() => {
        if (torn || busy || timerNoticeInFlight) return;
        if (whisperEngine?.userSpeechActive) return;
        const due = sessionClock.timerDue(
            timerApproachLeadSec(sessionClock.timerTotalSec(), avgTurnSec())
        );
        if (due) void respondWithTimerNotice(due);
    }, TIMER_POLL_MS);

    /**
     * Speak the timer's approach notice or closing word. Same shape as a smart
     * check-in (event turn → model → canned fallback), with two differences:
     * completion may not [PASS], and neither notice is subject to the check-in
     * streak cap, since the user explicitly asked to be told.
     */
    async function respondWithTimerNotice(kind: 'approach' | 'completion'): Promise<void> {
        if (timerNoticeInFlight || busy) return;
        timerNoticeInFlight = true;
        const myGen = turnGen;
        const myAbort = new AbortController();
        activeFullAbort = myAbort;
        const total = sessionClock.timerMinutes();
        const staged = stager !== null;
        // Opted in: this closing word is the last thing they hear, and the sit
        // ends once it has been spoken. Never the other way round - the notice
        // always lands before the session goes away.
        const endsSession = kind === 'completion' && sessionClock.endsSessionOnComplete();
        const fallbackPool =
            kind === 'approach'
                ? TIMER_APPROACH_FALLBACKS
                : endsSession
                  ? TIMER_CLOSE_FALLBACKS
                  : TIMER_COMPLETION_FALLBACKS;
        const canned = pickTimerFallback(
            localizePool(fallbackPool, sessionLanguageOf(sessionLanguage)),
            total
        );
        try {
            const eventText =
                kind === 'approach'
                    ? buildTimerApproachEvent(sessionClock.remainingSec() ?? 0, total, { staged })
                    : buildTimerCompletionEvent(total, { staged, endsSession });
            debugLog(`timer ${kind} event sent (${total}m)`);
            const timerStart = Date.now();
            const { reply, usage } = await runSmartCheckin(
                provider,
                [...session.getContextMessages(), { role: 'user', content: eventText }],
                {
                    system: builder.buildSystemPrompt(stager?.promptSection()),
                    signal: myAbort.signal,
                    maxChars: SESSION_TIMER_MAX_CHARS,
                }
            );
            tapCall(`timer-${kind}`, Date.now() - timerStart);
            if (torn || myGen !== turnGen || busy) return;
            session.recordLlmUsage(usage);
            if (reply.kind === 'pass' && kind === 'approach') {
                debugLog('timer approach → pass');
                tapEvent('timer', 'approach-pass');
                pacing.onResponseEnd();
                return;
            }
            if (reply.kind === 'pass') tapEvent('timer', 'pass-on-completion');
            const line = reply.kind === 'speak' ? reply.text : canned;
            debugLog(`timer ${kind} → ${reply.kind === 'speak' ? 'speak' : 'canned'}`);
            tapEvent('timer', `${kind}-${reply.kind === 'speak' ? 'speak' : 'canned'}`);
            // The event turn enters history with the line, so later turns know
            // why the facilitator spoke about time unprompted.
            session.addUserMessage(eventText);
            tapTurn('user', 'event', eventText);
            await respondWithFacilitatorLine(
                line,
                kind === 'approach' ? 'timer-approach' : 'timer-completion'
            );
            if (endsSession) void closeAfterTimer();
            else restoreHoldAfterNotice();
        } catch {
            if (!torn && myGen === turnGen && !busy) {
                debugLog(`timer ${kind} → error (canned)`);
                tapEvent('timer', `${kind}-error-canned`);
                tapTurn('user', 'event', `[Timer: ${kind}]`);
                await respondWithFacilitatorLine(
                    canned,
                    kind === 'approach' ? 'timer-approach' : 'timer-completion'
                );
                if (endsSession) void closeAfterTimer();
                else restoreHoldAfterNotice();
            }
        } finally {
            timerNoticeInFlight = false;
        }
    }

    /** End the sit after the timer's closing word has finished speaking. Saves
     *  on the same terms as the idle auto-quit; no confirm dialog, since the
     *  user asked for this when they set the timer. */
    async function closeAfterTimer(): Promise<void> {
        if (torn) return;
        debugLog('timer completion → ending session');
        await endSession(undefined, !appSettings.saveSessionLogs);
    }

    /**
     * A timer notice is the one thing allowed to speak into a silence hold, but
     * it must not END the hold: respondWithFacilitatorLine calls
     * pacing.onResponseEnd, which drops the controller back to Listening. Put
     * the hold back unless the meditator themselves came out of it while we
     * were speaking.
     */
    function restoreHoldAfterNotice(): void {
        if (torn || !silenceMode) return;
        tapEvent('hold', 'restored-after-timer');
        pacing.enterSilenceMode();
        setStatus(t("Holding space, say when you're ready to continue"));
    }

    // Auto-quit-after-silence: once a session goes untouched past the configured
    // window, save (if logging is on) and end it. An open session keeps
    // listening and checking in, which slowly spends cloud credit. Settings are
    // read at fire time, so toggling them mid-session takes effect immediately.
    const AUTO_QUIT_POLL_MS = 30_000;
    const idleQuitTimer = setInterval(() => {
        if (torn || busy) return;
        if (!appSettings.autoQuitAfterSilence) return;
        if (Date.now() - lastActivityAt < appSettings.autoQuitSilenceMin * 60_000) return;
        void endSession(undefined, !appSettings.saveSessionLogs);
    }, AUTO_QUIT_POLL_MS);

    /**
     * Speak a facilitator-initiated line (a check-in, not a response to user
     * input): transcript + session history + TTS. No LLM call; the caller
     * decides the text.
     */
    async function respondWithFacilitatorLine(
        text: string,
        kind: TurnKind = 'checkin-canned'
    ): Promise<void> {
        if (busy) return;
        busy = true;
        tapFlags({ busy: true });
        try {
            session.addAssistantMessage(text);
            tapTurn('assistant', kind, text);
            // Reveal with the voice, like LLM replies.
            const reveal = createAssistantReveal();
            reveal.anchor();
            setStatus(t('Speaking…'));
            try {
                await tts.speak(text, {
                    rate: setup.ttsRate,
                    onStart: () => reveal.reveal(text),
                });
            } catch {
                /* non-fatal */
            }
            reveal.finalize(text);
            pacing.onResponseEnd();
            setStatus(idleStatus());
        } finally {
            busy = false;
            tapFlags({ busy: false });
            // Capture check-ins too, so a crash between turns doesn't lose them.
            void autosaveSession();
        }
    }

    /**
     * Smart check-in: ask the model for a line that fits the session, or for
     * permission to keep quiet (contract in facilitation/smart-checkin.ts). Any
     * failure degrades to a canned line, so this is never worse than the simple
     * check-in.
     */
    async function respondWithSmartCheckIn(): Promise<void> {
        if (checkinInFlight || busy) return;
        if (smartCheckinStreak >= SMART_CHECKIN_MAX_STREAK) {
            // Out of chances: silent no-op that resets the interval so the
            // poll doesn't refire every tick. Auto-quit takes it from here.
            debugLog('check-in skipped (streak cap)');
            tapEvent('checkin', 'skipped-streak-cap');
            pacing.onResponseEnd();
            return;
        }
        // Spent the pass budget: speak a canned line rather than give the model
        // another chance to stay quiet. Still counts as a check-in (streak), so
        // the cap above remains the walk-away backstop.
        if (smartCheckinPasses >= SMART_CHECKIN_MAX_PASSES) {
            smartCheckinStreak++;
            smartCheckinPasses = 0;
            debugLog('canned check-in (pass budget)');
            tapEvent('checkin', 'canned-pass-budget');
            await respondWithFacilitatorLine(builder.getCheckInPrompt());
            return;
        }
        checkinInFlight = true;
        // Don't own the turn (no turnGen bump): a real utterance arriving
        // mid-call must win. Registering our abort as the active one lets
        // respondTo cancel the in-flight completion; the gen check catches the
        // takeover either way.
        const myGen = turnGen;
        const myAbort = new AbortController();
        activeFullAbort = myAbort;
        try {
            smartCheckinStreak++;
            const smartTiming = checkinTiming === 'smart';
            const eventText = buildSmartCheckinEvent(
                pacing.getSilenceDuration(),
                smartCheckinStreak,
                {
                    withWaitHint: smartTiming,
                    // Substantive check-ins at the attentive end of either
                    // slider. In pace modes the line is generated under the
                    // mode's own system prompt, so it stays in-stance.
                    directive: directiveness >= 7,
                }
            );
            debugLog(
                `event #${smartCheckinStreak} sent (silence ${Math.round(pacing.getSilenceDuration())}s)`
            );
            const checkinStart = Date.now();
            const { reply, usage } = await runSmartCheckin(
                provider,
                [...session.getContextMessages(), { role: 'user', content: eventText }],
                {
                    system: builder.buildSystemPrompt(stager?.promptSection()),
                    signal: myAbort.signal,
                }
            );
            tapCall('checkin', Date.now() - checkinStart);
            if (torn || myGen !== turnGen || busy) return;
            // The call happened whether or not anything gets spoken; tally it.
            session.recordLlmUsage(usage);
            // A check-in reply can also carry [WAIT:Nm] ("not now, ask again in
            // 15 minutes"), honored under smart timing.
            if (smartTiming && reply.kind !== 'fallback' && reply.waitSec !== null) {
                pacing.setCheckinInterval(reply.waitSec);
                tapEvent('signal', 'wait', {
                    requestedSec: reply.waitSec,
                    effectiveSec: pacing.getCheckinInterval(),
                });
            }
            const waitNote =
                reply.kind !== 'fallback' && reply.waitSec !== null
                    ? ` [WAIT] ${reply.waitSec}s`
                    : '';
            if (reply.kind === 'pass') {
                smartCheckinPasses++;
                debugLog(`→ pass${waitNote}`);
                tapEvent('checkin', 'pass', { streak: smartCheckinStreak });
                pacing.onResponseEnd();
                return;
            }
            smartCheckinPasses = 0;
            if (reply.kind === 'speak') {
                debugLog(`→ speak "${reply.text.slice(0, 40)}"${waitNote}`);
                tapEvent('checkin', 'speak', { streak: smartCheckinStreak });
                // Event turn enters history only when the model speaks, so
                // the next turn's model sees why the facilitator piped up.
                session.addUserMessage(eventText);
                tapTurn('user', 'event', eventText);
                await respondWithFacilitatorLine(reply.text, 'checkin');
            } else {
                debugLog('→ fallback (canned)');
                tapEvent('checkin', 'fallback', { streak: smartCheckinStreak });
                await respondWithFacilitatorLine(builder.getCheckInPrompt());
            }
        } catch {
            // Provider hiccup, or aborted by a real turn: canned fallback unless
            // a real turn took over.
            if (!torn && myGen === turnGen && !busy) {
                debugLog('→ error (canned)');
                tapEvent('checkin', 'error-fallback', { streak: smartCheckinStreak });
                await respondWithFacilitatorLine(builder.getCheckInPrompt());
            }
        } finally {
            checkinInFlight = false;
        }
    }

    // End button + History link live in the global nav (injected on mount).
    // Clicks during an active session go through showEndConfirm() so a stray tap
    // can't drop a meditation.
    if (endBtn) {
        endBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showEndConfirm(t('End this session?'), undefined);
        });
    }
    const historyLink = navLinks?.querySelector<HTMLAnchorElement>('[data-nav="history"]');
    if (historyLink) {
        historyLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Stop the global data-nav handler so this confirm is the only way
            // out of a live session.
            e.stopImmediatePropagation();
            showEndConfirm(
                t('Leave session to view history? This will end your current session.'),
                'history'
            );
        });
    }

    /**
     * Show the End-Session confirmation overlay. On confirm/skip-save the
     * session ends and onEnd fires with `destination` so the router knows where
     * to land the user. Wires fresh handlers each call so a re-open doesn't
     * carry the previous click's destination.
     */
    function showEndConfirm(
        message: string,
        destination: SessionEndDestination | undefined
    ): void {
        wireEndConfirm(root, message, {
            saveByDefault: appSettings.saveSessionLogs,
            onBeforeSave: () => showSavingOverlay(),
            end: (skipSave) => void endSession(destination, skipSave),
        });
    }

    function showSavingOverlay(): void {
        const overlay = root.querySelector<HTMLElement>('#session-saving');
        overlay?.classList.remove('hidden');
    }

    mountEmberContainer();
    wireEmberControls(root);

    async function endSession(
        destination?: SessionEndDestination,
        skipSave = false
    ): Promise<void> {
        if (torn) return;
        torn = true;
        tapFlags({ ended: true });
        tapEvent('note', `session-ended${skipSave ? ' (unsaved)' : ''}`);
        // Stop any in-flight turn from generating/speaking into a torn-down view.
        activeFullAbort?.abort();
        unsubscribeBalance?.();
        if (checkInTimer) clearInterval(checkInTimer);
        clearInterval(idleQuitTimer);
        if (debugTimer) clearInterval(debugTimer);
        clearInterval(timerPoll);
        sessionClock.destroy();
        pacing.endSession();
        const finalState = session.endSession();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        void stt?.stop();
        stopMeter();
        void tts.cancel();
        // Relax Ollama's keep_alive to the short default: the model idles out
        // soon (not the full 30m) but stays warm for an immediate restart.
        if (provider instanceof OllamaProvider) void provider.relaxKeepAlive();
        // Clearing the session-active flag also stops the visibility-change
        // handler re-acquiring the wake lock.
        releaseWakeLock();
        delete document.body.dataset['sessionActive'];
        // Cleanly ended: drop the resume pointer so relaunch doesn't offer it.
        void appStateListener?.then((h) => h.remove());
        void clearActiveSession();
        // Embers are session-only.
        unmountEmberContainer();
        // Exit kasina if active: the toggle's exit branch restores the
        // pre-kasina theme and moves the orb back into the nav (about to be
        // cleared) rather than orphaning it in <body>.
        if (kasinaToggle.checked) {
            kasinaToggle.checked = false;
            kasinaToggle.dispatchEvent(new Event('change'));
        }
        // Remove the window/document-level listeners (kasina drag, beforeunload).
        viewCleanup.abort();
        // Restore the global nav slots we replaced on mount.
        if (navCenter) navCenter.innerHTML = '';
        if (navLinks && savedNavLinks !== null) {
            navLinks.innerHTML = savedNavLinks;
            // Re-init the theme toggle; the restore just replaced its node.
            const restoredThemeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
            if (restoredThemeBtn) initThemeToggle(restoredThemeBtn);
        }

        if (!skipSave && finalState && hasUserContent(finalState.exchanges)) {
            // LLM summary for the history row; falls back to the intention.
            setStatus(t('Saving session…'));
            let summary = '';
            try {
                // Off-transcript completion, so fold its token usage into the
                // session tally before persisting finalState (same object
                // reference as session.state, so recording still mutates it
                // after endSession()).
                summary = await generateSessionSummary(utilityProvider, finalState.exchanges, {
                    systemPrompt: builder.buildSystemPrompt(stager?.promptSection()),
                    onUsage: (u) => session.recordLlmUsage(u),
                });
            } catch {
                /* fall through to fallback */
            }
            // Diagnostic: distinguishes a guard-skip (low userTurns) from an
            // empty/failed recap (userTurns ok but chars=0) behind the same
            // "Exploration" fallback. Remove once the summary path is confirmed.
            console.info(
                `[summary] provider=${provider.constructor?.name ?? '?'} ` +
                    `userTurns=${finalState.exchanges.filter((e) => e.role === 'user').length} ` +
                    `chars=${summary.length}`
            );
            finalState.notes = summary || setup.intention.trim();
            // Record who facilitated: history shows it, and a later resume can
            // tell a different model who came before (buildResumeContext).
            finalState.model = modelLabel;
            finalState.provider = setup.provider;
            try {
                await sessionStore.save(finalState);
            } catch (err) {
                console.warn('Failed to save session', err);
            }
        }

        // After the summary completion, which is an off-transcript LLM turn that
        // still belongs to this session's cost group.
        clearCloudSession();
        onEnd(destination);
    }

    function hasUserContent(exchanges: ReadonlyArray<{ role: string }>): boolean {
        // Skips empty sessions started and immediately ended by a stray click.
        return exchanges.some((e) => e.role === 'user');
    }

    /**
     * Persist the in-progress session to local storage without an LLM summary,
     * so a crash or going offline still leaves a recoverable transcript. No-op
     * when "Save session logs" is off, or before any user turn exists. The
     * detailed summary is generated only on a clean end (endSession); until then
     * the "Exploration" type label stands in for it in the history list.
     */
    async function autosaveSession(): Promise<void> {
        if (!appSettings.saveSessionLogs) return;
        const state = session.state;
        if (!state || !hasUserContent(state.exchanges)) return;
        // Provisional endTime so an interrupted session still shows a sensible
        // duration in history; the live state stays active (endTime null) so the
        // running loop is unaffected. A clean end overwrites this row.
        //
        // notes carries the latest background recap (or the intention) so an
        // interrupted session is never blank in history and can be resumed
        // cheaply from the recap - see refreshSummaryThrottled.
        const snapshot: SessionState = {
            ...state,
            endTime: Math.floor(Date.now() / 1000),
            notes: currentSummary || setup.intention.trim(),
            model: modelLabel,
            provider: setup.provider,
        };
        try {
            await sessionStore.save(snapshot);
            // Mark this session as the one to resume if the app is killed while
            // backgrounded (meditation-pal-v73p). Only after a successful save,
            // so the pointer never outlives a recoverable transcript.
            void markSessionActive(state.sessionId);
        } catch (err) {
            console.warn('Session autosave failed', err);
        }
        // Kick a throttled recap refresh for next time (fire-and-forget).
        void refreshSummaryThrottled();
    }

    /**
     * Refresh `currentSummary` in the background, throttled. Generating a recap
     * is an LLM call, so it only runs once SUMMARY_MIN_NEW_EXCHANGES have landed
     * since the last one, on the cheapest utility model we have
     * (buildRecapProvider). It reuses the warm prompt cache (the facilitation
     * system prompt) so the transcript reads at ~0.1x, making an in-session
     * refresh cheap. Never runs mid-turn (busy) or into a torn-down view; its
     * token cost folds into the session tally.
     */
    async function refreshSummaryThrottled(): Promise<void> {
        if (!appSettings.saveSessionLogs) return;
        if (summaryRefreshing || busy || torn) return;
        const state = session.state;
        if (!state || !hasUserContent(state.exchanges)) return;
        const exCount = state.exchanges.length;
        // Only re-summarize once a few new exchanges have landed.
        if (exCount - summaryAtExchangeCount < SUMMARY_MIN_NEW_EXCHANGES) return;
        summaryRefreshing = true;
        try {
            const recap = await generateSessionSummary(recapProvider, state.exchanges, {
                systemPrompt: builder.buildSystemPrompt(stager?.promptSection()),
                onUsage: (u) => session.recordLlmUsage(u),
            });
            if (!torn && recap) {
                currentSummary = recap;
                summaryAtExchangeCount = exCount;
            }
        } catch {
            /* non-fatal; a missing recap falls back to the intention */
        } finally {
            summaryRefreshing = false;
        }
    }

    return {
        teardown(): void { void endSession(); },
        requestLeave(destination?: SessionEndDestination): void {
            showEndConfirm(leaveMessage(destination), destination);
        },
        showInfo(): void { infoPanel.open(); },
        toggleKasina(): void {
            kasinaToggle.checked = !kasinaToggle.checked;
            kasinaToggle.dispatchEvent(new Event('change'));
        },
    };
}

/** Message shown in the end-session confirm for an external nav request
 *  (browser Back). Matches the wording the in-session links use. */
function leaveMessage(destination?: SessionEndDestination): string {
    if (destination === 'history') {
        return t('Leave session to view history? This will end your current session.');
    }
    if (destination === 'settings') {
        return t('Leave session to view settings? This will end your current session.');
    }
    if (destination === 'account') {
        return t('Leave session to view your account? This will end your current session.');
    }
    return t('Leave your session?');
}

/** SessionSetup.voice carries a 'server:' or 'browser:' prefix; the voice
 *  picker works with raw names. Strip the prefix on the way in. */
function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser|aloud):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

// describeSttError / describeCloudError live in ui/src/stt-errors.ts
// (standalone so node-env tests can cover the matching order); re-exported
// here for existing importers.
export { describeCloudError, describeSttError } from '../stt-errors.js';

function renderSessionHTML(): string {
    return `
    <div class="session-container">
        <div class="conversation" id="conversation">
            <div class="message facilitator typing-bubble" id="typing-indicator">
                <div class="message-content">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>

        <div class="input-area">
            <!-- Persistent STT-outage banner. Hidden until a run of failed
                 transcriptions (renderSttTrouble); cleared on the next success.
                 Unlike the status line, it stays put so a user can't talk into
                 a dead mic for a whole session without noticing. -->
            <div class="stt-trouble hidden" id="stt-trouble" role="status"></div>
            <div class="input-row">
                <div id="voice-status" class="voice-status">${t('Connecting…')}</div>
                <span class="session-phase hidden" id="session-phase"></span>
                <!-- Live cloud balance: hidden unless the user opts in
                     (Settings, "Show credit balance during sessions"). -->
                <span class="session-balance hidden" id="session-balance" title="${t('Cloud credits remaining')}"></span>
                <button type="button" class="session-timer" id="timer" title="${t('Session Clock')}">0:00</button>
                <button id="tts-toggle" class="btn btn-tts active" title="${t('Read responses aloud')}" aria-label="${t('Toggle text-to-speech')}">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path class="tts-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        <path class="tts-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="voice-btn" class="btn btn-voice" title="${t('Toggle microphone')}" aria-label="${t('Toggle microphone')}">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="listen-btn" class="btn btn-listen"
                    title="${t('The facilitator stays quiet until you ask to resume.')}">
                    ${t('Just Listen')}
                </button>
            </div>
            <div class="input-controls">
                <div class="ember-level" title="${t('Floating ember particles')}">
                    <span class="toggle-text">${t('Embers')}</span>
                    <button class="ember-btn" id="ember-minus" type="button">−</button>
                    <div class="ember-blocks" id="ember-blocks">
                        <span class="ember-block filled" data-level="1"></span>
                        <span class="ember-block" data-level="2"></span>
                        <span class="ember-block" data-level="3"></span>
                        <span class="ember-block" data-level="4"></span>
                    </div>
                    <button class="ember-btn" id="ember-plus" type="button">+</button>
                </div>
                <!-- Hidden state holder for kasina gazing (initKasinaMode).
                     Entry points: tapping the nav orb, or the More sheet's
                     Kasina entry on mobile; click-outside exits. -->
                <input type="checkbox" id="kasina-toggle" class="hidden">
                <div class="voice-control">
                    <button type="button" id="voice-picker-btn" class="voice-picker-btn">${t('Voice')}</button>
                </div>
            </div>
        </div>
    </div>

    <div class="ember-container" id="ember-container"></div>

    ${renderVoiceModalHTML({
        modalId: 'voice-modal',
        closeId: 'voice-modal-close',
        listId: 'voice-modal-list',
        speedSliderId: 'modal-speed-slider',
        speedLabelId: 'modal-speed-label',
        speedValue: 110,
    })}

    <div class="session-ended-overlay hidden" id="session-confirm">
        <div class="session-ended-content">
            <p id="confirm-text"></p>
            <div class="session-ended-actions">
                <button id="confirm-yes" type="button" class="btn btn-primary">${t('End Session')}</button>
                <button id="confirm-no" type="button" class="btn btn-secondary">${t('Cancel')}</button>
            </div>
            <button id="confirm-skip-save" type="button" class="btn-link hidden">${t('End Without Saving')}</button>
        </div>
    </div>

    <div class="session-ended-overlay hidden" id="session-saving">
        <div class="session-ended-content">
            <p>${t('Saving session…')}</p>
        </div>
    </div>`;
}
