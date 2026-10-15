// Optional AI integration. All AI output is untrusted:
//  - event analysis may only reference existing category ids; points always come from the rules;
//  - generated products pass validateProducts() and receive formula prices.
// On any failure callers fall back to keyword detection / the built-in catalog.
import { ctx } from './st.js';
import { extractJson, extractJsonObjects, validateProducts } from './validate.js';
import { truncate, plainText, clamp } from './util.js';
import { categoryXp } from './content.js';
import { TYPES, DURATIONS, RARITIES } from './pricing.js';

/** Connection Manager profiles usable for requests (empty when unavailable). */
export function listProfiles() {
    try {
        return ctx().ConnectionManagerRequestService.getSupportedProfiles().map(p => ({ id: p.id, name: p.name }));
    } catch {
        return [];
    }
}

/** Send a prompt via the configured source. Returns raw text. */
export async function generate(settings, systemPrompt, userPrompt, maxTokens) {
    const c = ctx();
    // The ceiling is deliberately high: a capable model can write a whole product array in one
    // reply. Models with a smaller real limit are handled by batching in generateProducts().
    const tokens = clamp(maxTokens || settings.ai?.maxTokens || 900, 100, 16000);
    if (settings.ai?.source === 'profile' && settings.ai.profileId) {
        const res = await c.ConnectionManagerRequestService.sendRequest(
            settings.ai.profileId,
            [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            tokens,
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
        );
        return typeof res === 'string' ? res : (res?.content ?? '');
    }
    return await c.generateRaw({ prompt: userPrompt, systemPrompt, responseLength: tokens, trimNames: false });
}

export function withTimeout(promise, ms, label = 'AI request') {
    let t;
    return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); })])
        .finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------- event analysis
export async function analyzeEvents(settings, message, previousText) {
    const cats = settings.categories.filter(c => c.enabled);
    if (!cats.length) return [];
    const catList = cats.map(c => `- ${c.id}: ${c.name} (e.g. ${truncate(c.keywords, 90)})`).join('\n');
    const sys = 'You are a strict event classifier for a fictional roleplay game. Output only JSON. Never invent categories.';
    const user = [
        'Which reward categories does the LATEST message clearly depict actually HAPPENING in the story (not planned, wished, failed, negated, hypothetical or merely mentioned)?',
        `Categories:\n${catList}`,
        `Intensity: none, ${settings.intensity.map(t => t.id).join(', ')}.`,
        previousText ? `Previous message (context only):\n"""${truncate(plainText(previousText), 600)}"""` : '',
        `LATEST message${message.isUser ? ' (by the user)' : ` (by ${message.name || 'the character'})`}:\n"""${truncate(plainText(message.text), 2500)}"""`,
        `Reply with ONLY a JSON array like [{"category":"kiss","intensity":"major","evidence":"short quote"}], or [] if nothing qualifies. Max ${settings.detection.maxEventsPerMessage || 5} entries.`,
    ].filter(Boolean).join('\n\n');
    const data = extractJson(await withTimeout(generate(settings, sys, user, 300), 90_000));
    if (!Array.isArray(data)) throw new Error('AI returned no JSON array');
    const out = [];
    for (const e of data.slice(0, settings.detection.maxEventsPerMessage || 3)) {
        const cat = cats.find(c => c.id === String(e?.category || '').trim());
        if (!cat || out.some(o => o.catId === cat.id)) continue;
        const tier = settings.intensity.find(t => t.id === String(e.intensity || '').toLowerCase());
        out.push({
            catId: cat.id, base: Number(cat.points) || 0, xp: categoryXp(cat), mult: tier ? Number(tier.mult) || 1 : 1, intensity: tier?.id || null,
            snippet: truncate(String(e.evidence || ''), 200), keyword: 'AI', source: 'ai',
        });
    }
    return out;
}

// ---------------------------------------------------------------- shop purpose interpretation
export async function interpretPurpose(settings, request) {
    const sys = 'You configure a fictional in-story shop. Output only JSON.';
    const user = `The user asked for: """${truncate(request, 300)}"""\nReturn {"label":"short shop name (max 40 chars)","summary":"one sentence: what the shop sells","tags":["5-10 lowercase single-word product tags"]}`;
    const data = extractJson(await withTimeout(generate(settings, sys, user, 250), 60_000));
    if (!data || typeof data !== 'object' || !data.label) throw new Error('AI could not interpret the shop purpose');
    return {
        label: truncate(String(data.label), 40),
        summary: truncate(String(data.summary || ''), 200),
        tags: (Array.isArray(data.tags) ? data.tags : []).map(t => String(t).toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean).slice(0, 10),
    };
}

/** How many products to ask for in one request. Small batches survive a capped output limit. */
export function productsPerCall(settings, count) {
    const n = Math.round(Number(settings?.ai?.productsPerCall));
    return Math.max(1, Math.min(Number(count) || 6, Number.isFinite(n) && n > 0 ? n : 3));
}

/** Tokens to request for one batch of `n` products (~15 JSON fields each, plus the prompt echo). */
function batchBudget(settings, n) {
    const floor = Math.max(900, n * 320 + 400);
    const user = Number(settings?.ai?.maxTokens);
    return clamp(Math.max(Number.isFinite(user) ? user : 0, floor), 100, 16000);
}

/**
 * Pull a product array out of a reply, however the model wrapped it. Falls back to every complete
 * `{...}` object in the text, so a truncated or malformed array still yields what it did write.
 */
export function parseProductList(text) {
    const data = extractJson(text);
    const arr = Array.isArray(data) ? data
        : Array.isArray(data?.products) ? data.products
            : (data && typeof data === 'object' ? Object.values(data).find(Array.isArray) : null);
    if (Array.isArray(arr) && arr.length) return arr;
    return extractJsonObjects(text);
}

/**
 * Generate `count` products for the Shop. The work is split into batches (Settings → AI → products
 * per call) because many backends cap output tokens below what a single six-product array needs,
 * and a truncated array used to lose every product. A batch that comes back empty or short is
 * retried at half the size, so this converges even on a very small output limit.
 * @returns {Promise<{accepted:object[], rejected:object[]}>}
 */
export async function generateProducts(settings, opts) {
    const count = clamp(Math.round(Number(opts?.count) || 6), 1, 20);
    const accepted = [], rejected = [];
    const seen = new Set();
    let size = productsPerCall(settings, count);
    let lastRaw = '';
    for (let attempt = 0; attempt < 12 && accepted.length < count; attempt++) {
        const want = Math.min(size, count - accepted.length);
        const res = await generateProductBatch(settings, opts, want);
        lastRaw = res.raw;
        rejected.push(...res.rejected);
        if (!res.accepted.length) {
            if (size <= 1) break;                      // a single product already failed: give up cleanly
            size = Math.max(1, Math.floor(size / 2));  // smaller batch, try again
            continue;
        }
        for (const p of res.accepted) {
            const nk = p.name.toLowerCase();
            if (seen.has(nk)) continue;
            seen.add(nk);
            accepted.push(p);
        }
        // A short batch means the model stopped early: ask for fewer next time rather than hammer it.
        if (res.accepted.length < want && size > 1) size = Math.max(1, Math.floor(size / 2));
    }
    if (!accepted.length) {
        const preview = truncate(plainText(lastRaw).replace(/\s+/g, ' ').trim(), 90) || '(empty reply)';
        throw new Error(`the model returned no usable products - it replied "${preview}". Lower "Products per AI call" in Settings > AI, or raise the model's output limit`);
    }
    return { accepted, rejected };
}


// ---------------------------------------------------------------- product generation
/** One AI request for `count` products. Returns the validated split plus the raw reply text. */
async function generateProductBatch(settings, { purpose, setting, owned = [], prefs = [], restrictions = [], recentNames = [], storyContext = '' }, count) {
    const sys = 'You design products for a private, supernatural "System Shop" in an adult fictional roleplay. Adults only. Every product must be a means of getting, compelling, exposing or enduring a sexual act — leverage, surveillance, compulsion, restraint, physical capability, or a setup that creates the opportunity. Never offer romance, dating, courtship, gifts or affection. Reply with a single JSON array and nothing else.';
    const user = [
        `Shop purpose: ${purpose.label}${purpose.custom ? ` – ${purpose.custom}` : ''}`,
        setting ? `Setting:\n${truncate(setting, 900)}` : '',
        storyContext ? `Recent story:\n${truncate(storyContext, 900)}` : '',
        owned.length ? `The user already owns: ${owned.join(', ')}. Do not offer these again; complementary items or stronger versions are welcome.` : '',
        prefs.length ? `The user tends to like: ${prefs.join(', ')}.` : '',
        restrictions.length ? `NEVER offer anything related to: ${restrictions.join(', ')}.` : '',
        recentNames.length ? `Avoid repeating these recent products: ${recentNames.join(', ')}.` : '',
        'Read the recent story and invent products that would be immediately useful against the specific people, places and secrets in it. Prefer a concrete tool over a vague mood.',
        `Create exactly ${count} product${count === 1 ? '' : 's'}${count > 1 ? ': cheap consumables plus at most one powerful aspirational product' : ''}.`,
        `Each product: {"name","icon"(one emoji),"description"(1-2 sentences fitting the setting),"effect"(precise: what it does in the story),"type"(${TYPES.join('|')}),"duration"(${DURATIONS.join('|')}; "permanent" only for permanent/equipment),"power"(1-10, honest strength),"utility"(1-10),"rarity"(${RARITIES.join('|')}),"uses"(1-5 for consumables/services),"realityAltering"(true only for reality-bending effects),"tags"(3-6 lowercase words),"family"(base ability name shared by weaker/stronger versions)}.`,
        'No prices - the System calculates them. Keep each description and effect under 15 words. No commentary before or after the array.',
    ].filter(Boolean).join('\n\n');
    // Each product is ~15 fields of JSON, so budget per product and never go below the user's floor.
    const budget = batchBudget(settings, count);
    const raw = await withTimeout(generate(settings, sys, user, budget), 120_000);
    const list = parseProductList(raw).slice(0, count);
    if (!list.length) return { accepted: [], rejected: [], raw };
    return { ...validateProducts(list, settings.economy, {
        source: 'ai',
        theme: purpose.theme === 'custom' ? `custom:${purpose.label}` : purpose.theme,
        defaultCategory: purpose.label,
    }), raw };
}

// ---------------------------------------------------------------- private assistant
export const PERSONALITIES = {
    neutral: 'neutral and concise',
    professional: 'polite, professional and helpful, like a concierge',
    mysterious: 'cryptic, mysterious and quietly knowing',
    playful: 'cheerful, playful and enthusiastic',
    mischievous: 'teasing, mischievous and a little smug (never cruel)',
};

export async function assistantComment(settings, situation) {
    const a = settings.assistant;
    const sys = `You are ${a.name}, a private System Shop assistant that only the user can perceive. Personality: ${PERSONALITIES[a.personality] || PERSONALITIES.neutral}. Story characters cannot see or hear you. You never make purchases. Reply with at most 2 short sentences, no quotation marks.`;
    const text = await withTimeout(generate(settings, sys, situation, 120), 45_000, 'Assistant');
    return truncate(plainText(text).replace(/^["']|["']$/g, ''), 280);
}

