/**
 * Pure-JS SessionStore persistence engine (Stage C1, zero GJS dependencies).
 *
 * Guarantees:
 * 1. Strict sessionId validation and root-directory containment (blocks relative/symlink escapes).
 * 2. Immutable record/compaction/meta snapshots captured synchronously at enqueue time —
 *    eliminating the 201+ message compaction race where queued compaction read live `this.messages`.
 * 3. Stable message fields (`id`, `turnId`, `revision`, `role`, `createdAt`, `ts`, `backend`,
 *    `modelId`, `replyTo`, `status`) and order-preserving ID deduplication on load.
 * 4. Single-flight `load()` and cross-instance per-`sessionId` write queue coordination.
 * 5. Recoverable commit order (`messages.jsonl` committed before `meta.json`), bounded write
 *    retries, observable `onSaveError` callbacks (`历史未保存`), corrupt JSONL line isolation
 *    (never overwriting sole history copy on parse error), and whole-turn compaction.
 */

import {
    isLegacyPiSessionMeta,
    parseLegacyPiSessionContent,
} from './configMigration.js';

export const DEFAULT_HOT_MESSAGE_LIMIT = 200;
export const DEFAULT_COMPACT_TARGET_RATIO = 0.8;
export const MAX_SINGLE_JSONL_RECORD_BYTES = 2 * 1024 * 1024; // 2 MiB safety cap per record
export const VALID_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const UTF8_ENCODER = new TextEncoder();

// Shared cross-instance write chain keyed by canonical `sessionsRootDir::sessionId`
// so old and new client instances never write to the same session files concurrently.
const sharedSessionWriteChains = new Map();

function cloneDeepJson(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
}

function normalizePosixDir(rawPath) {
    const raw = String(rawPath || '').trim();
    if (!raw.startsWith('/')) {
        throw new Error(`会话根目录必须为绝对路径：${raw}`);
    }
    const parts = [];
    for (const seg of raw.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            throw new Error(`会话路径禁止包含相对上级目录 (..)：${raw}`);
        }
        parts.push(seg);
    }
    return `/${parts.join('/')}`;
}

export function validateSessionId(sessionId) {
    const clean = String(sessionId ?? '').trim();
    if (!clean || clean.includes('\u0000') || clean.includes('/') || clean.includes('\\') || clean.includes('..')) {
        throw new Error(`非法的会话 ID 格式：${String(sessionId)}`);
    }
    if (!VALID_SESSION_ID_RE.test(clean)) {
        throw new Error(`非法的会话 ID 字符或长度：${clean}`);
    }
    return clean;
}

export function resolveSafeSessionPaths(sessionsRootDir, sessionId) {
    const validId = validateSessionId(sessionId);
    const rootDir = normalizePosixDir(sessionsRootDir);
    const prefix = rootDir === '/' ? '/' : `${rootDir}/`;

    const dir = `${prefix}${validId}`;
    const metaPath = `${dir}/meta.json`;
    const jsonlPath = `${dir}/messages.jsonl`;
    const archivePath = `${dir}/archive.jsonl`;
    const corruptPath = `${dir}/corrupt.jsonl`;
    const legacyPath = `${prefix}${validId}.qc.json`;

    for (const candidate of [dir, metaPath, jsonlPath, archivePath, corruptPath, legacyPath]) {
        if (!candidate.startsWith(prefix) || candidate === rootDir) {
            throw new Error(`会话路径越界保护已拦截：${candidate}`);
        }
    }

    return {
        sessionId: validId,
        rootDir,
        dir,
        metaPath,
        jsonlPath,
        archivePath,
        corruptPath,
        legacyPath,
    };
}

function coerceIsoTimestamp(rawCreatedAt, fallbackTs) {
    if (typeof rawCreatedAt === 'string' && rawCreatedAt.trim()) {
        const parsed = Date.parse(rawCreatedAt);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
    }
    if (typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt) && rawCreatedAt > 0) {
        return new Date(rawCreatedAt).toISOString();
    }
    const ts = typeof fallbackTs === 'number' && Number.isFinite(fallbackTs) && fallbackTs > 0
        ? fallbackTs
        : Date.now();
    return new Date(ts).toISOString();
}

function truncateContentToByteBudget(content, maxBytes) {
    const encoded = UTF8_ENCODER.encode(JSON.stringify(content ?? ''));
    if (encoded.byteLength <= maxBytes) {
        return {content, truncated: false};
    }

    const marker = '\n… [单条记录超出本地存储上限，尾部已截断]';
    if (typeof content === 'string') {
        const ratio = Math.max(0.1, (maxBytes - 512) / encoded.byteLength);
        const keepChars = Math.max(256, Math.floor(content.length * ratio));
        return {content: `${content.slice(0, keepChars)}${marker}`, truncated: true};
    }
    if (Array.isArray(content)) {
        const cloned = [];
        let remainingChars = Math.max(512, Math.floor(maxBytes / 4));
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'text' && typeof part.text === 'string') {
                const slice = part.text.slice(0, remainingChars);
                remainingChars = Math.max(0, remainingChars - slice.length);
                cloned.push({...part, text: slice.length < part.text.length ? `${slice}${marker}` : slice});
            } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
                const slice = part.thinking.slice(0, Math.min(remainingChars, 16384));
                remainingChars = Math.max(0, remainingChars - slice.length);
                cloned.push({...part, thinking: slice.length < part.thinking.length ? `${slice}…` : slice});
            } else {
                cloned.push(part);
            }
        }
        return {content: cloned, truncated: true};
    }
    return {content: String(content ?? '').slice(0, 4096) + marker, truncated: true};
}

export function normalizeStoredMessage(raw, {
    fallbackIndex = 0,
    nextRevision = 1,
    defaultBackend = '',
    defaultModelId = '',
    previousUserMessageId = '',
    maxRecordBytes = MAX_SINGLE_JSONL_RECORD_BYTES,
} = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const role = ['user', 'assistant', 'system', 'toolResult'].includes(raw.role)
        ? raw.role
        : 'assistant';

    const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) && raw.ts > 0
        ? raw.ts
        : (typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
            ? Date.parse(raw.createdAt)
            : Date.now());

    const createdAt = coerceIsoTimestamp(raw.createdAt, ts);
    const revision = Number.isInteger(raw.revision) && raw.revision > 0
        ? raw.revision
        : nextRevision;

    const id = typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : `legacy_msg_${ts}_${fallbackIndex + 1}`;

    const turnId = typeof raw.turnId === 'string' && raw.turnId.trim()
        ? raw.turnId.trim()
        : '';

    const replyTo = typeof raw.replyTo === 'string' && raw.replyTo.trim()
        ? raw.replyTo.trim()
        : (role === 'assistant' && previousUserMessageId ? previousUserMessageId : '');

    const status = typeof raw.status === 'string' && raw.status.trim()
        ? raw.status.trim()
        : (raw.partial ? 'interrupted' : (raw.errorMessage ? 'failed' : 'completed'));

    const backend = typeof raw.backend === 'string' && raw.backend.trim()
        ? raw.backend.trim()
        : String(defaultBackend || '').trim();

    const modelId = typeof raw.modelId === 'string' && raw.modelId.trim()
        ? raw.modelId.trim()
        : String(defaultModelId || '').trim();

    const bounded = truncateContentToByteBudget(cloneDeepJson(raw.content ?? ''), Math.max(4096, maxRecordBytes - 1024));

    const record = {
        id,
        ...(turnId ? {turnId} : {}),
        revision,
        role,
        content: bounded.content,
        createdAt,
        ts,
        backend,
        modelId,
        replyTo,
        status,
        ...(raw.partial || bounded.truncated ? {partial: true} : {}),
        ...(bounded.truncated ? {truncated: true} : {}),
        ...(typeof raw.errorMessage === 'string' && raw.errorMessage ? {errorMessage: raw.errorMessage} : {}),
    };

    return record;
}

/**
 * Deduplicates loaded records by `id` while strictly preserving original conversation order.
 * If a later JSONL entry updates an existing `id` with an equal or higher `revision`,
 * it updates that slot in place without duplicating the message.
 */
export function deduplicateMessagesPreservingOrder(rawRecords, metaDefaults = {}) {
    const ordered = [];
    const indexById = new Map();
    let maxRev = 0;
    let lastUserId = '';

    for (let i = 0; i < rawRecords.length; i++) {
        const candidate = rawRecords[i];
        const nextRev = maxRev + 1;
        const normalized = normalizeStoredMessage(candidate, {
            fallbackIndex: i,
            nextRevision: nextRev,
            defaultBackend: metaDefaults.backend || '',
            defaultModelId: metaDefaults.modelId || '',
            previousUserMessageId: lastUserId,
        });
        if (!normalized) continue;
        if (normalized.revision > maxRev) {
            maxRev = normalized.revision;
        }
        if (normalized.role === 'user') {
            lastUserId = normalized.id;
        }

        if (indexById.has(normalized.id)) {
            const existingIdx = indexById.get(normalized.id);
            const existing = ordered[existingIdx];
            if (normalized.revision >= existing.revision) {
                ordered[existingIdx] = normalized;
            }
        } else {
            indexById.set(normalized.id, ordered.length);
            ordered.push(normalized);
        }
    }

    return {messages: ordered, maxRevision: maxRev};
}

/**
 * Groups messages into atomic conversation turns (`user` + associated `assistant`/`toolResult` replies)
 * so compaction NEVER deletes one half of a turn, and NEVER drops the latest turn even if oversized.
 */
export function groupMessagesIntoCompleteTurns(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const turns = [];
    let currentGroup = [];

    for (const msg of messages) {
        if (!msg) continue;
        if (msg.role === 'user') {
            if (currentGroup.length > 0) {
                turns.push(currentGroup);
            }
            currentGroup = [msg];
        } else {
            currentGroup.push(msg);
        }
    }
    if (currentGroup.length > 0) {
        turns.push(currentGroup);
    }
    return turns;
}

/**
 * Compacts messages along whole-turn boundaries down to `targetMessages` (e.g. 160 when exceeding 200),
 * always retaining at least the latest complete turn regardless of message size.
 * Returns `{retained, evicted}` as deep-cloned immutable arrays.
 */
export function compactMessagesByWholeTurn(messages, {
    maxMessages = DEFAULT_HOT_MESSAGE_LIMIT,
    targetMessages = Math.max(2, Math.floor(DEFAULT_HOT_MESSAGE_LIMIT * DEFAULT_COMPACT_TARGET_RATIO)),
} = {}) {
    if (!Array.isArray(messages) || messages.length <= maxMessages) {
        return {
            compacted: false,
            retained: messages ? messages.map(cloneDeepJson) : [],
            evicted: [],
        };
    }

    const turnGroups = groupMessagesIntoCompleteTurns(messages);
    if (turnGroups.length <= 1) {
        // Single turn (even if > maxMessages or oversized): never split half a turn!
        return {
            compacted: false,
            retained: messages.map(cloneDeepJson),
            evicted: [],
        };
    }

    const keptGroupsReversed = [];
    let keptCount = 0;

    for (let i = turnGroups.length - 1; i >= 0; i--) {
        const grp = turnGroups[i];
        if (keptGroupsReversed.length === 0 || keptCount + grp.length <= targetMessages) {
            keptGroupsReversed.push(grp);
            keptCount += grp.length;
        } else {
            break;
        }
    }

    const keptGroupCount = keptGroupsReversed.length;
    const splitGroupIdx = turnGroups.length - keptGroupCount;
    const evicted = turnGroups.slice(0, splitGroupIdx).flat().map(cloneDeepJson);
    const retained = keptGroupsReversed.reverse().flat().map(cloneDeepJson);

    return {
        compacted: evicted.length > 0,
        retained,
        evicted,
    };
}

function sleepMs(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class SessionStoreEngine {
    constructor(sessionId, {
        sessionsRootDir,
        io,
        maxHotMessages = DEFAULT_HOT_MESSAGE_LIMIT,
        keepArchive = true,
        maxWriteRetries = 2,
        retryDelayMs = 20,
        onSaveError = null,
        buildContextSignature = null,
    } = {}) {
        if (!io || typeof io !== 'object') {
            throw new Error('SessionStoreEngine 需要有效的异步 I/O 适配器');
        }
        const paths = resolveSafeSessionPaths(sessionsRootDir, sessionId);
        this.sessionId = paths.sessionId;
        this.rootDir = paths.rootDir;
        this.dir = paths.dir;
        this.metaPath = paths.metaPath;
        this.jsonlPath = paths.jsonlPath;
        this.archivePath = paths.archivePath;
        this.corruptPath = paths.corruptPath;
        this.legacyPath = paths.legacyPath;

        this._io = io;
        this._maxHotMessages = Math.max(4, Number(maxHotMessages) || DEFAULT_HOT_MESSAGE_LIMIT);
        this._keepArchive = Boolean(keepArchive);
        this._maxWriteRetries = Math.max(0, Number(maxWriteRetries ?? 2));
        this._retryDelayMs = Math.max(0, Number(retryDelayMs ?? 20));
        this._onSaveError = onSaveError;
        this._buildContextSignature = buildContextSignature;
        this._coordKey = `${this.rootDir}::${this.sessionId}`;

        this.meta = {
            schemaVersion: 2,
            backend: '',
            modelSignature: '',
            contextSignature: '',
            remoteSessionId: '',
            remoteSyncedRevision: 0,
            committedRevision: 0,
            updatedAt: 0,
        };
        this.messages = [];
        this._revision = 0;
        this._loaded = false;
        this._loadPromise = null;
        this.lastWriteError = null;
        this.corruptLineCount = 0;
        this._initialCorruptSnapshot = null;
        this._needsLeadingNewlineOnAppend = false;
    }

    get revision() {
        return this._revision;
    }

    get hasUnsavedChanges() {
        return Boolean(this.lastWriteError);
    }

    setSaveErrorListener(fn) {
        this._onSaveError = fn;
    }

    _computeSignature(backend, config) {
        if (!backend || backend === 'unconfigured') return '';
        if (typeof this._buildContextSignature === 'function') {
            return this._buildContextSignature(backend, config);
        }
        return `${backend}:${config?.provider || ''}:${config?.model || config?.openaiModel || ''}`;
    }

    /**
     * Single-flight loader: concurrent `load()` calls share the exact same Promise,
     * and wait for any prior instance's pending writes on the same `sessionId` first!
     */
    load(currentBackend = '', currentConfig = {}) {
        if (this._loaded) {
            this._reconcileRuntimeContext(currentBackend, currentConfig);
            return Promise.resolve();
        }
        if (this._loadPromise) {
            return this._loadPromise.then(() => {
                this._reconcileRuntimeContext(currentBackend, currentConfig);
            });
        }

        const pendingPriorWrites = sharedSessionWriteChains.get(this._coordKey) || Promise.resolve();
        const task = (async () => {
            try {
                await pendingPriorWrites;
            } catch (_) {}

            await this._loadFromDiskInternal();
            this._loaded = true;
            this._reconcileRuntimeContext(currentBackend, currentConfig);
        })();

        this._loadPromise = task.finally(() => {
            if (!this._loaded) {
                this._loadPromise = null;
            }
        });
        return this._loadPromise;
    }

    async _loadFromDiskInternal() {
        const metaExists = await this._io.exists(this.metaPath);
        const jsonlExists = await this._io.exists(this.jsonlPath);

        if (metaExists || jsonlExists) {
            if (metaExists) {
                try {
                    const metaRaw = await this._io.readText(this.metaPath);
                    if (metaRaw && metaRaw.trim()) {
                        const parsed = JSON.parse(metaRaw);
                        if (parsed && typeof parsed === 'object') {
                            this.meta = {...this.meta, ...parsed};
                        }
                    }
                } catch (err) {
                    // Metadata corrupt or truncated during crash: isolate warning and recover from JSONL!
                    console.warn(`[Quick Chat] Metadata recovery on session ${this.sessionId}: ${err.message}`);
                }
            }

            if (jsonlExists) {
                const linesRaw = await this._io.readText(this.jsonlPath);
                const rawParsed = [];
                const corruptLines = [];
                const rawLines = String(linesRaw || '').split(/\r?\n/);

                for (let idx = 0; idx < rawLines.length; idx++) {
                    const trimmed = rawLines[idx].trim();
                    if (!trimmed) continue;
                    try {
                        const obj = JSON.parse(trimmed);
                        if (obj && typeof obj === 'object') {
                            rawParsed.push(obj);
                        } else {
                            corruptLines.push({lineNumber: idx + 1, raw: trimmed});
                        }
                    } catch (_) {
                        corruptLines.push({lineNumber: idx + 1, raw: trimmed});
                    }
                }

                const {messages, maxRevision} = deduplicateMessagesPreservingOrder(rawParsed, {
                    backend: this.meta.backend || '',
                    modelId: '',
                });
                this.messages = messages;
                this._revision = Math.max(Number(this.meta.committedRevision || 0), maxRevision, messages.length);
                this.meta.committedRevision = this._revision;

                if (linesRaw && !linesRaw.endsWith('\n')) {
                    this._needsLeadingNewlineOnAppend = true;
                }

                if (corruptLines.length > 0) {
                    this.corruptLineCount += corruptLines.length;
                    if (this._initialCorruptSnapshot === null) {
                        this._initialCorruptSnapshot = String(linesRaw || '');
                    }
                    // Isolate corrupt lines to corrupt.jsonl WITHOUT overwriting the sole messages.jsonl copy!
                    const isolationPayload = corruptLines
                        .map(item => JSON.stringify({
                            isolatedAt: new Date().toISOString(),
                            lineNumber: item.lineNumber,
                            raw: item.raw.slice(0, 65536),
                        }))
                        .join('\n') + '\n';
                    this._enqueueWrite('isolate_corrupt_lines', async () => {
                        await this._io.appendLine(this.corruptPath, isolationPayload);
                    });
                }
            }
            return;
        }

        // Migrate legacy `<sessionId>.qc.json` safely if present
        if (await this._io.exists(this.legacyPath)) {
            const raw = await this._io.readText(this.legacyPath);
            if (raw && raw.trim()) {
                let parsed = null;
                try {
                    parsed = JSON.parse(raw);
                } catch (err) {
                    this.corruptLineCount++;
                    console.warn(`[Quick Chat] Legacy session JSON corrupt (${this.sessionId}), keeping original file untouched: ${err.message}`);
                    return;
                }
                if (parsed && typeof parsed === 'object') {
                    const {messages, maxRevision} = deduplicateMessagesPreservingOrder(
                        Array.isArray(parsed.messages) ? parsed.messages : [],
                        {backend: parsed.backend || ''}
                    );
                    const compacted = compactMessagesByWholeTurn(messages, {maxMessages: this._maxHotMessages});
                    this.messages = compacted.retained;
                    this._revision = Math.max(maxRevision, this.messages.length);
                    this.meta = {
                        ...this.meta,
                        schemaVersion: 2,
                        backend: parsed.backend || '',
                        modelSignature: parsed.modelSignature || '',
                        contextSignature: parsed.contextSignature || '',
                        remoteSessionId: parsed.remoteSessionId || '',
                        remoteSyncedRevision: 0,
                        committedRevision: this._revision,
                        updatedAt: parsed.updatedAt || Date.now(),
                    };
                    const snapshotMessages = this.messages.map(cloneDeepJson);
                    const snapshotMeta = cloneDeepJson(this.meta);
                    const snapshotEvicted = compacted.evicted;
                    this._enqueueWrite('migrate_legacy_json', async () => {
                        if (this._keepArchive && snapshotEvicted.length > 0) {
                            const archiveBody = snapshotEvicted.map(m => JSON.stringify(m)).join('\n') + '\n';
                            await this._io.appendLine(this.archivePath, archiveBody);
                        }
                        const body = snapshotMessages.map(m => JSON.stringify(m)).join('\n') + (snapshotMessages.length ? '\n' : '');
                        await this._io.replaceFile(this.jsonlPath, body);
                        await this._io.replaceFile(this.metaPath, JSON.stringify(snapshotMeta, null, 2));
                        await this._io.unlink?.(this.legacyPath);
                    });
                }
            }
        }
    }

    _reconcileRuntimeContext(currentBackend, currentConfig) {
        // Never pass a legacy Pi session ID to ZCode or Codex
        if (isLegacyPiSessionMeta(this.meta)) {
            this.meta.remoteSessionId = '';
            this.meta.remoteSyncedRevision = 0;
        }

        if (!currentBackend || currentBackend === 'unconfigured') {
            return;
        }

        const nextSig = this._computeSignature(currentBackend, currentConfig);
        const prevSig = this.meta.contextSignature || this.meta.modelSignature || '';

        // Invalidate remoteSessionId if backend/model/endpoint/workspace/mode changed OR
        // if local conversation advanced (e.g. turns occurred on another backend) past remoteSyncedRevision!
        const hasUnsyncedTurns = Boolean(
            this.meta.remoteSessionId &&
            Number(this.meta.remoteSyncedRevision || 0) > 0 &&
            this._revision > Number(this.meta.remoteSyncedRevision)
        );
        const backendChanged = Boolean(this.meta.backend && this.meta.backend !== currentBackend);
        const signatureChanged = Boolean(prevSig && nextSig && prevSig !== nextSig);

        if (backendChanged || signatureChanged || hasUnsyncedTurns) {
            this.meta.remoteSessionId = '';
            this.meta.remoteSyncedRevision = 0;
        }

        this.meta.backend = currentBackend;
        this.meta.contextSignature = nextSig;
        this.meta.modelSignature = nextSig;
    }

    get remoteSessionId() {
        return this.meta.remoteSessionId || '';
    }

    clearRemoteSessionId(reason = '') {
        if (!this.meta.remoteSessionId) return Promise.resolve();
        this.meta.remoteSessionId = '';
        this.meta.remoteSyncedRevision = 0;
        this.meta.updatedAt = Date.now();
        if (reason) {
            this.meta.lastRemoteResetReason = String(reason).slice(0, 240);
        }
        const metaSnapshot = cloneDeepJson({...this.meta, committedRevision: this._revision});
        return this._enqueueWrite('clear_remote_session', async () => {
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        });
    }

    setRemoteSessionId(remoteId, backend, config) {
        const clean = String(remoteId || '').trim();
        const sig = this._computeSignature(backend, config);
        if (
            this.meta.remoteSessionId === clean &&
            this.meta.backend === backend &&
            this.meta.contextSignature === sig &&
            this.meta.remoteSyncedRevision === this._revision
        ) {
            return Promise.resolve();
        }
        this.meta.remoteSessionId = clean;
        this.meta.backend = backend || this.meta.backend;
        this.meta.contextSignature = sig;
        this.meta.modelSignature = sig;
        this.meta.remoteSyncedRevision = clean ? this._revision : 0;
        this.meta.updatedAt = Date.now();

        const metaSnapshot = cloneDeepJson({...this.meta, committedRevision: this._revision});
        return this._enqueueWrite('set_remote_session', async () => {
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        });
    }

    /**
     * Appends a message using strictly immutable snapshots captured at call time.
     * Even if message #201 triggers whole-turn compaction while #202 and #203 are appended
     * immediately afterwards, #201's compaction writes ONLY its frozen `<=201` snapshot,
     * and #202/#203 append ONLY their own lines — zero duplicates, zero dropped records!
     */
    appendMessage(message, backend = '', config = {}) {
        const rev = ++this._revision;
        let lastUserId = '';
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i]?.role === 'user' && this.messages[i]?.id) {
                lastUserId = this.messages[i].id;
                break;
            }
        }

        const effectiveModelId = String(
            message?.modelId ||
            (backend === 'openai' ? (config?.openaiModel || config?.model || '') : (config?.model || ''))
        ).trim();

        const record = normalizeStoredMessage(
            {...message, revision: rev},
            {
                fallbackIndex: this.messages.length,
                nextRevision: rev,
                defaultBackend: backend || this.meta.backend || '',
                defaultModelId: effectiveModelId,
                previousUserMessageId: lastUserId,
            }
        );

        // Deduplicate/replace in memory if caller re-persisted an existing message ID
        const existingIdx = this.messages.findIndex(m => m.id === record.id);
        let replacedInPlace = false;
        if (existingIdx >= 0) {
            this.messages[existingIdx] = record;
            replacedInPlace = true;
        } else {
            this.messages.push(record);
        }

        const sig = this._computeSignature(backend || this.meta.backend, config);
        if (backend && backend !== 'unconfigured') {
            this.meta.backend = backend;
            this.meta.contextSignature = sig;
            this.meta.modelSignature = sig;
        }
        if (this.meta.remoteSessionId && this.meta.backend === (backend || this.meta.backend)) {
            this.meta.remoteSyncedRevision = rev;
        }
        this.meta.committedRevision = rev;
        this.meta.updatedAt = record.ts;

        // Capture immutable snapshots synchronously BEFORE yielding to async queue!
        const recordLineSnapshot = JSON.stringify(record);
        let compactionResult = {compacted: false, retained: null, evicted: []};
        let fullSnapshotForInPlaceUpdate = null;

        if (this.messages.length > this._maxHotMessages) {
            compactionResult = compactMessagesByWholeTurn(this.messages, {
                maxMessages: this._maxHotMessages,
                targetMessages: Math.max(2, Math.floor(this._maxHotMessages * DEFAULT_COMPACT_TARGET_RATIO)),
            });
            if (compactionResult.compacted) {
                this.messages = compactionResult.retained.map(cloneDeepJson);
            }
        } else if (replacedInPlace) {
            fullSnapshotForInPlaceUpdate = this.messages.map(cloneDeepJson);
        }

        const metaSnapshot = cloneDeepJson(this.meta);
        const hadPriorCorruptLines = this.corruptLineCount > 0;
        const corruptOriginalSnapshot = this._initialCorruptSnapshot;
        const prependLeadingNewline = this._needsLeadingNewlineOnAppend;
        if (prependLeadingNewline) {
            this._needsLeadingNewlineOnAppend = false;
        }
        if (compactionResult.compacted || fullSnapshotForInPlaceUpdate) {
            this._needsLeadingNewlineOnAppend = false;
        }

        let archiveWritten = false;
        let jsonlWritten = false;

        return this._enqueueWrite('append_message', async () => {
            if (compactionResult.compacted || fullSnapshotForInPlaceUpdate) {
                // Never overwrite the sole copy if corrupt lines were seen earlier without backing up first!
                if (hadPriorCorruptLines) {
                    const backupPath = `${this.jsonlPath}.corrupt-backup`;
                    if (!(await this._io.exists(backupPath))) {
                        const rawOrig = corruptOriginalSnapshot !== null
                            ? corruptOriginalSnapshot
                            : ((await this._io.exists(this.jsonlPath)) ? await this._io.readText(this.jsonlPath) : '');
                        await this._io.replaceFile(backupPath, rawOrig);
                    }
                }
                if (!archiveWritten && this._keepArchive && compactionResult.evicted.length > 0) {
                    const archiveLines = compactionResult.evicted.map(m => JSON.stringify(m)).join('\n') + '\n';
                    await this._io.appendLine(this.archivePath, archiveLines);
                    archiveWritten = true;
                }
                if (!jsonlWritten) {
                    const targetList = compactionResult.compacted
                        ? compactionResult.retained
                        : fullSnapshotForInPlaceUpdate;
                    const jsonlBody = targetList.map(m => JSON.stringify(m)).join('\n') + (targetList.length ? '\n' : '');
                    // Commit order: messages.jsonl FIRST, meta.json SECOND!
                    await this._io.replaceFile(this.jsonlPath, jsonlBody);
                    jsonlWritten = true;
                }
            } else if (!jsonlWritten) {
                // Fast O(1) append of strictly this single frozen record!
                // If power loss left a truncated tail line without `\n`, start on a clean newline first.
                const lineToWrite = prependLeadingNewline ? `\n${recordLineSnapshot}` : recordLineSnapshot;
                await this._io.appendLine(this.jsonlPath, lineToWrite);
                jsonlWritten = true;
            }
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        });
    }

    flush() {
        return sharedSessionWriteChains.get(this._coordKey) || Promise.resolve();
    }

    _enqueueWrite(operation, taskFn) {
        const prevChain = sharedSessionWriteChains.get(this._coordKey) || Promise.resolve();
        const nextChain = prevChain
            .catch(() => {})
            .then(async () => {
                let lastErr = null;
                const totalAttempts = this._maxWriteRetries + 1;
                for (let attempt = 1; attempt <= totalAttempts; attempt++) {
                    try {
                        await taskFn();
                        this.lastWriteError = null;
                        return {ok: true};
                    } catch (err) {
                        lastErr = err;
                        if (attempt < totalAttempts) {
                            await sleepMs(this._retryDelayMs * attempt);
                        }
                    }
                }
                const errMsg = lastErr?.message || String(lastErr || '未知磁盘写入错误');
                this.lastWriteError = {
                    operation,
                    message: errMsg,
                    timestamp: Date.now(),
                };
                console.warn(`[Quick Chat] 会话保存失败 (${this.sessionId} / ${operation}): ${errMsg}`);
                try {
                    this._onSaveError?.({
                        sessionId: this.sessionId,
                        operation,
                        message: `历史未保存：${errMsg}`,
                        error: lastErr,
                    });
                } catch (_) {}
                return {ok: false, error: lastErr};
            });

        sharedSessionWriteChains.set(this._coordKey, nextChain);
        nextChain.finally(() => {
            if (sharedSessionWriteChains.get(this._coordKey) === nextChain) {
                sharedSessionWriteChains.delete(this._coordKey);
            }
        });
        return nextChain;
    }
}

export async function importLegacyPiSessionWithIo({
    sourceFilePath,
    targetSessionId,
    sessionsRootDir,
    io,
    maxHotMessages = DEFAULT_HOT_MESSAGE_LIMIT,
} = {}) {
    if (!sourceFilePath || !(await io.exists(sourceFilePath))) {
        return {ok: false, sessionId: '', importedCount: 0, error: '指定的旧会话文件不存在'};
    }
    let raw = '';
    try {
        raw = await io.readText(sourceFilePath);
    } catch (err) {
        return {ok: false, sessionId: '', importedCount: 0, error: `读取旧会话失败：${err.message}`};
    }
    const parsed = parseLegacyPiSessionContent(raw);
    if (!parsed.ok) {
        return {ok: false, sessionId: '', importedCount: 0, error: parsed.error};
    }

    const engine = new SessionStoreEngine(targetSessionId, {
        sessionsRootDir,
        io,
        maxHotMessages,
    });
    engine.meta.importedFromLegacyPi = true;
    for (const msg of parsed.messages) {
        engine.appendMessage(msg, '', {});
    }
    await engine.flush();
    if (engine.lastWriteError) {
        return {ok: false, sessionId: '', importedCount: 0, error: `保存导入历史失败：${engine.lastWriteError.message}`};
    }
    return {
        ok: true,
        sessionId: engine.sessionId,
        importedCount: engine.messages.length,
        error: '',
    };
}
