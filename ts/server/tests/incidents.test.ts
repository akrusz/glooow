/**
 * Incident log (meditation-pal-xtgh): the routes record what went wrong on a
 * metered call, the app can report what it handled quietly, and the admin
 * endpoint reads it all back grouped by kind - without any meditation content.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps, type Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { Forwarder } from '../src/providers/forward.js';
import type { AuthResponse } from '../src/contract.js';
import { buildIncidentReport, clipDetail, recordIncident, type Incident } from '../src/credits/incidents.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { SqliteCreditsStore } from '../src/credits/sqlite-store.js';

const ADMIN = 'admin-token';

/** A stream whose done chunk carries usage but NO text: the reasoning-ate-
 *  the-budget shape (finish "length", output tokens billed, nothing said). */
function emptyForwarder(): Forwarder {
    return {
        async complete() {
            return { text: '', finishReason: 'length', inputTokens: 100, outputTokens: 300 } as never;
        },
        async *stream() {
            yield { text: '', done: true, finishReason: 'length', inputTokens: 100, outputTokens: 300 } as never;
        },
    } as unknown as Forwarder;
}

function failingForwarder(): Forwarder {
    return {
        async complete() {
            throw new Error('upstream 502 from provider\nstack line that must not be kept');
        },
        async *stream() {
            throw new Error('upstream 502 from provider');
        },
    } as unknown as Forwarder;
}

async function setup(forwarder: Forwarder) {
    const config = loadConfig({
        ANTHROPIC_API_KEY: 'sk-test',
        GOOGLE_API_KEY: 'g-test',
        ALOUD_ENABLE_DEV_AUTH: '1',
        ALOUD_ADMIN_TOKEN: ADMIN,
    });
    const deps: Deps = buildDeps(config);
    deps.forwarder = forwarder;
    const app = createApp(deps);
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await res.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;
    return { deps, app, token, accountId };
}

function complete(app: ReturnType<typeof createApp>, token: string, stream: boolean) {
    return app.request('/cloud/v1/llm/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            provider: 'google',
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'a private thing the meditator said' }],
            sessionId: 'sess-1',
            stream,
        }),
    });
}

describe('incident log - LLM route', () => {
    it.each([true, false])('records llm_empty with finish reason and tokens for a blank completion (stream=%s)', async (stream) => {
        const { deps, app, token, accountId } = await setup(emptyForwarder());
        const res = await complete(app, token, stream);
        expect(res.status).toBe(200);
        await res.text();
        const rows = await deps.store.incidentsSince(0);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.kind).toBe('llm_empty');
        expect(row.source).toBe('server');
        expect(row.accountId).toBe(accountId);
        expect(row.sessionId).toBe('sess-1');
        expect(row.model).toBe('gemini-2.5-flash-lite');
        expect(row.detail).toBe('finish=length tokens_out=300 tokens_in=100');
    });

    it('does not flag a streamed turn whose text arrived in deltas before the empty done chunk', async () => {
        const forwarder = {
            async *stream() {
                yield { text: 'Let the breath settle.', done: false } as never;
                yield { text: '', done: true, finishReason: 'stop', inputTokens: 3, outputTokens: 25 } as never;
            },
        } as unknown as Forwarder;
        const { deps, app, token } = await setup(forwarder);
        const res = await complete(app, token, true);
        expect(res.status).toBe(200);
        await res.text();
        expect(await deps.store.incidentsSince(0)).toHaveLength(0);
    });

    it.each([true, false])('records llm_error on an upstream failure, first line only (stream=%s)', async (stream) => {
        const { deps, app, token } = await setup(failingForwarder());
        const res = await complete(app, token, stream);
        await res.text();
        const rows = await deps.store.incidentsSince(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.kind).toBe('llm_error');
        expect(rows[0]!.detail).toContain('upstream 502');
        expect(rows[0]!.detail).not.toContain('stack line');
    });

    it('records insufficient_credits when the balance is gone', async () => {
        const { deps, app, token, accountId } = await setup(emptyForwarder());
        const balance = await deps.ledger.balance(accountId);
        await deps.ledger.debit(accountId, balance, 'drain');
        const res = await complete(app, token, false);
        expect(res.status).toBe(402);
        const rows = await deps.store.incidentsSince(0);
        expect(rows.map((r) => r.kind)).toEqual(['insufficient_credits']);
    });

    it('never stores the messages', async () => {
        const { deps, app, token } = await setup(emptyForwarder());
        await (await complete(app, token, false)).text();
        const rows = await deps.store.incidentsSince(0);
        expect(JSON.stringify(rows)).not.toContain('private thing');
    });
});

describe('incident log - client reports', () => {
    it('accepts an allowlisted client kind and tags it as client-sourced', async () => {
        const { deps, app, token, accountId } = await setup(emptyForwarder());
        const res = await app.request('/cloud/v1/incidents', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                kind: 'client_llm_empty_fallback',
                detail: 'finish=length',
                provider: 'openrouter',
                model: 'moonshotai/kimi-k2',
                sessionId: 'sess-9',
            }),
        });
        expect(res.status).toBe(204);
        const rows = await deps.store.incidentsSince(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: 'client_llm_empty_fallback',
            source: 'client',
            accountId,
            sessionId: 'sess-9',
            provider: 'openrouter',
            model: 'moonshotai/kimi-k2',
            detail: 'finish=length',
        });
    });

    it('rejects a server-side kind (no spoofing) and an unknown one', async () => {
        const { deps, app, token } = await setup(emptyForwarder());
        for (const kind of ['llm_empty', 'nonsense']) {
            const res = await app.request('/cloud/v1/incidents', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ kind }),
            });
            expect(res.status).toBe(400);
        }
        expect(await deps.store.incidentsSince(0)).toHaveLength(0);
    });

    it('requires a session', async () => {
        const { app } = await setup(emptyForwarder());
        const res = await app.request('/cloud/v1/incidents', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind: 'client_tts_error' }),
        });
        expect(res.status).toBe(401);
    });
});

describe('incident log - admin endpoint', () => {
    it('groups the window by kind and lists recent rows with a short account label', async () => {
        const { deps, app, token } = await setup(emptyForwarder());
        await (await complete(app, token, false)).text();
        await (await complete(app, token, true)).text();
        await recordIncident(deps.store, {
            accountId: (await deps.store.allAccounts())[0]!.id,
            kind: 'client_tts_error',
            source: 'client',
            ts: Date.now() / 1000 - 30 * 24 * 3600, // outside a 7d window
        });
        const res = await app.request('/cloud/v1/admin/incidents?sinceHours=168', {
            headers: { authorization: `Bearer ${ADMIN}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            total: number;
            byKind: Array<{ kind: string; count: number; accounts: number; sessions: number }>;
            recent: Array<{ account: string; accountId: string; kind: string }>;
        };
        expect(body.total).toBe(2);
        expect(body.byKind).toEqual([{ kind: 'llm_empty', source: 'server', count: 2, accounts: 1, sessions: 1 }]);
        expect(body.recent).toHaveLength(2);
        expect(body.recent[0]!.account).not.toContain('@');
    });

    it('is gated like the other admin routes', async () => {
        const { app, token } = await setup(emptyForwarder());
        const res = await app.request('/cloud/v1/admin/incidents', { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(401);
    });
});

describe('incident log - stores + helpers', () => {
    const sample = (over: Partial<Incident> = {}): Incident => ({
        id: over.id ?? 'i1',
        ts: over.ts ?? 1000,
        accountId: 'acct',
        sessionId: null,
        kind: 'tts_error',
        source: 'server',
        provider: 'azure',
        model: 'en-US-Ethan',
        detail: 'boom',
        ...over,
    });

    it.each([
        ['MemoryCreditsStore', () => new MemoryCreditsStore()],
        ['SqliteCreditsStore(:memory:)', () => new SqliteCreditsStore(':memory:')],
    ])('%s round-trips rows newest first and filters by ts', async (_name, make) => {
        const store = make();
        await store.createAccount({ id: 'acct', email: 'a@b.c', emailVerified: true, createdAt: 1 });
        await store.appendIncident(sample({ id: 'old', ts: 10 }));
        await store.appendIncident(sample({ id: 'new', ts: 20, sessionId: 's' }));
        const all = await store.incidentsSince(0);
        expect(all.map((r) => r.id)).toEqual(['new', 'old']);
        expect(all[0]).toEqual(sample({ id: 'new', ts: 20, sessionId: 's' }));
        expect((await store.incidentsSince(15)).map((r) => r.id)).toEqual(['new']);
    });

    it('clips detail to one line and a fixed length', () => {
        expect(clipDetail('first line\nsecond')).toBe('first line');
        expect(clipDetail('x'.repeat(500))).toHaveLength(240);
    });

    it('buildIncidentReport counts distinct accounts and sessions per kind', () => {
        const rows: Incident[] = [
            sample({ id: '1', accountId: 'a', sessionId: 's1' }),
            sample({ id: '2', accountId: 'a', sessionId: 's1' }),
            sample({ id: '3', accountId: 'b', sessionId: null }),
            sample({ id: '4', kind: 'llm_empty' }),
        ];
        const report = buildIncidentReport(rows, 0);
        expect(report.total).toBe(4);
        expect(report.byKind[0]).toEqual({ kind: 'tts_error', source: 'server', count: 3, accounts: 2, sessions: 1 });
    });
});
