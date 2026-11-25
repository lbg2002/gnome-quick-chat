import {cleanMemoryReason, cleanReplyChoices, cleanReplyReferences, cleanTaskProgress} from './assistantReply.js';
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
export const MAX_SESSION_META_BYTES = 256 * 1024; // 256 KiB cap for meta.json
export const MAX_SESSION_LINE_BYTES = 512 * 1024; // 512 KiB cap per line on load
export const MAX_SESSION_HOT_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB cap for hot messages.jsonl
export const MAX_SESSION_ARCHIVE_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB cap for archive.jsonl
export const MAX_SESSION_ARCHIVE_MESSAGES = 5000; // Max retained compacted messages in archive.jsonl
export const MAX_SESSION_REWOUND_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB cap for rewound.jsonl
export const MAX_SESSION_REWOUND_MESSAGES = 500; // Max retained rewound branch messages
export const MAX_SESSION_CORRUPT_BACKUP_BYTES = 512 * 1024; // 512 KiB cap for corrupt backup files
export const VALID_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const UTF8_ENCODER = new TextEncoder();

// Shared cross-instance write chain keyed by canonical `sessionsRootDir::sessionId`
// so old and new client instances never write to the same session files concurrently.
const sharedSessionWriteChains = new Map();
// R3: Shared cross-instance in-memory revision/state coordinator so two loaded SessionStoreEngine
// instances for the same sessionId cannot clobber each other's revisions or messages.
const sharedSessionCoordinatorState = new Map();

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
    const rewoundPath = `${dir}/rewound.jsonl`;
    const corruptPath = `${dir}/corrupt.jsonl`;
    const legacyPath = `${prefix}${validId}.qc.json`;

    for (const candidate of [dir, metaPath, jsonlPath, archivePath, rewoundPath, corruptPath, legacyPath]) {
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
        rewoundPath,
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
    defaultEndpoint = '',
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

    const endpoint = typeof raw.endpoint === 'string' && raw.endpoint.trim()
        ? raw.endpoint.trim().slice(0, 512)
        : String(defaultEndpoint || '').trim().slice(0, 512);

    const bounded = truncateContentToByteBudget(cloneDeepJson(raw.content ?? ''), Math.max(4096, maxRecordBytes - 1024));

    const finishReason = typeof raw.finishReason === 'string' && raw.finishReason.trim()
        ? raw.finishReason.trim().slice(0, 40)
        : '';

    const displayText = typeof raw.displayText === 'string' && raw.displayText.trim()
        ? raw.displayText.slice(0, 65536)
        : '';

    const archiveKind = raw.archiveKind === 'rewound_branch'
        ? 'rewound_branch'
        : (raw.archiveKind === 'compacted' ? 'compacted' : '');
    const archivedAt = typeof raw.archivedAt === 'string' && raw.archivedAt.trim()
        ? raw.archivedAt.trim().slice(0, 48)
        : '';
    const rewoundAt = typeof raw.rewoundAt === 'string' && raw.rewoundAt.trim()
        ? raw.rewoundAt.trim().slice(0, 48)
        : '';
    const rewindFromMessageId = typeof raw.rewindFromMessageId === 'string' && raw.rewindFromMessageId.trim()
        ? raw.rewindFromMessageId.trim().slice(0, 128)
        : '';
    const rewindRevision = Number.isInteger(raw.rewindRevision) && raw.rewindRevision > 0
        ? raw.rewindRevision
        : 0;

    const memoryReferences = cleanReplyReferences(raw.memoryReferences);
    const memoryReason = cleanMemoryReason(raw.memoryReason);
    const taskChoices = cleanReplyChoices(raw.taskChoices);
    const taskProgress = cleanTaskProgress(raw.taskProgress);
    const record = {
        id,
        ...(memoryReferences.length ? {memoryReferences, ...(memoryReason ? {memoryReason} : {})} : {}),
        ...(taskChoices.length >= 2 ? {taskChoices} : {}),
        ...(taskProgress ? {taskProgress} : {}),
        ...(turnId ? {turnId} : {}),
        revision,
        role,
        content: bounded.content,
        ...(displayText ? {displayText} : {}),
        createdAt,
        ts,
        backend,
        modelId,
        ...(typeof raw.selectedModelId === 'string' && raw.selectedModelId ? {selectedModelId: raw.selectedModelId.slice(0, 160)} : {}),
        ...(typeof raw.reportedModelId === 'string' && raw.reportedModelId ? {reportedModelId: raw.reportedModelId.slice(0, 160)} : {}),
        ...(endpoint ? {endpoint} : {}),
        replyTo,
        status,
        ...(raw.partial || bounded.truncated ? {partial: true} : {}),
        ...(bounded.truncated ? {truncated: true} : {}),
        ...(finishReason ? {finishReason} : {}),
        ...(typeof raw.errorMessage === 'string' && raw.errorMessage ? {errorMessage: raw.errorMessage} : {}),
        ...(archiveKind ? {archiveKind} : {}),
        ...(archivedAt ? {archivedAt} : {}),
        ...(rewoundAt ? {rewoundAt} : {}),
        ...(rewindFromMessageId ? {rewindFromMessageId} : {}),
        ...(rewindRevision > 0 ? {rewindRevision} : {}),
    };

    return record;
}

function isRewoundRecord(raw) {
    if (!raw || typeof raw !== 'object') return false;
    return raw.archiveKind === 'rewound_branch' || Boolean(raw.rewoundAt);
}

function buildArchiveIndexDescriptor(msg, archiveIndex = 0) {
    if (!msg || typeof msg !== 'object') return null;
    const textPreview = extractReadableMessageBody(msg).slice(0, 240);
    return {
        id: String(msg.id || ''),
        revision: Number(msg.revision || 0),
        role: msg.role || 'assistant',
        turnId: String(msg.turnId || ''),
        replyTo: String(msg.replyTo || ''),
        createdAt: String(msg.createdAt || ''),
        ts: Number(msg.ts || 0),
        backend: String(msg.backend || ''),
        modelId: String(msg.modelId || ''),
        status: String(msg.status || 'completed'),
        ...(msg.partial ? {partial: true} : {}),
        ...(msg.finishReason ? {finishReason: msg.finishReason} : {}),
        previewText: textPreview,
        archiveIndex,
    };
}

/**
 * Deduplicates loaded records by `id` (and explicit positive `revision` when the same revision
 * was replayed) while strictly preserving original conversation order.
 * If a later JSONL entry updates an existing `id` with an equal or higher `revision`,
 * it updates that slot in place without duplicating the message.
 */
export function deduplicateMessagesPreservingOrder(rawRecords, metaDefaults = {}) {
    const ordered = [];
    const indexById = new Map();
    const indexByExplicitRev = new Map();
    let maxRev = 0;
    let lastUserId = '';

    for (let i = 0; i < rawRecords.length; i++) {
        const candidate = rawRecords[i];
        if (!candidate || typeof candidate !== 'object') continue;
        const hasExplicitRev = Number.isInteger(candidate.revision) && candidate.revision > 0;
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
                if (hasExplicitRev) {
                    indexByExplicitRev.set(normalized.revision, existingIdx);
                }
            }
        } else if (
            hasExplicitRev &&
            indexByExplicitRev.has(normalized.revision) &&
            ordered[indexByExplicitRev.get(normalized.revision)]?.role === normalized.role &&
            extractReadableMessageBody(ordered[indexByExplicitRev.get(normalized.revision)]) === extractReadableMessageBody(normalized)
        ) {
            const existingIdx = indexByExplicitRev.get(normalized.revision);
            ordered[existingIdx] = normalized;
            indexById.set(normalized.id, existingIdx);
        } else {
            const newIdx = ordered.length;
            indexById.set(normalized.id, newIdx);
            if (hasExplicitRev) {
                indexByExplicitRev.set(normalized.revision, newIdx);
            }
            ordered.push(normalized);
        }
    }

    return {messages: ordered, maxRevision: maxRev};
}

function capJsonlRecordsToBudget(records, {
    maxMessages = MAX_SESSION_ARCHIVE_MESSAGES,
    maxBytes = MAX_SESSION_ARCHIVE_FILE_BYTES,
} = {}) {
    const list = Array.isArray(records) ? records : [];
    const safeMaxCount = Math.max(1, Number(maxMessages) || MAX_SESSION_ARCHIVE_MESSAGES);
    const safeMaxBytes = Math.max(4096, Number(maxBytes) || MAX_SESSION_ARCHIVE_FILE_BYTES);

    const countSliced = list.length > safeMaxCount ? list.slice(list.length - safeMaxCount) : [...list];
    const keptReversed = [];
    let usedBytes = 0;
    let truncated = list.length > countSliced.length;

    for (let i = countSliced.length - 1; i >= 0; i--) {
        const line = JSON.stringify(countSliced[i]) + '\n';
        const lineBytes = UTF8_ENCODER.encode(line).byteLength;
        if (keptReversed.length > 0 && usedBytes + lineBytes > safeMaxBytes) {
            truncated = true;
            break;
        }
        keptReversed.push({record: countSliced[i], line});
        usedBytes += lineBytes;
    }

    keptReversed.reverse();
    return {
        records: keptReversed.map(item => item.record),
        body: keptReversed.map(item => item.line).join(''),
        usedBytes,
        truncated,
        droppedCount: Math.max(0, list.length - keptReversed.length),
    };
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
    constructor(sessionIdOrOptions, maybeOptions = {}) {
        const isFirstObj = sessionIdOrOptions && typeof sessionIdOrOptions === 'object';
        const sessionId = isFirstObj ? sessionIdOrOptions.sessionId : sessionIdOrOptions;
        const {
            sessionsRootDir,
            io,
            maxHotMessages = DEFAULT_HOT_MESSAGE_LIMIT,
            maxLineBytes = MAX_SESSION_LINE_BYTES,
            maxHotFileBytes = MAX_SESSION_HOT_FILE_BYTES,
            maxArchiveFileBytes = MAX_SESSION_ARCHIVE_FILE_BYTES,
            maxArchiveMessages = MAX_SESSION_ARCHIVE_MESSAGES,
            maxRewoundFileBytes = MAX_SESSION_REWOUND_FILE_BYTES,
            maxRewoundMessages = MAX_SESSION_REWOUND_MESSAGES,
            maxCorruptBackupBytes = MAX_SESSION_CORRUPT_BACKUP_BYTES,
            maxRetainedLines = 600,
            keepArchive = true,
            maxWriteRetries = 2,
            retryDelayMs = 20,
            onSaveError = null,
            buildContextSignature = null,
        } = isFirstObj ? sessionIdOrOptions : (maybeOptions || {});

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
        this.rewoundPath = paths.rewoundPath;
        this.corruptPath = paths.corruptPath;
        this.legacyPath = paths.legacyPath;

        this._io = io;
        this._maxHotMessages = Math.max(4, Number(maxHotMessages) || DEFAULT_HOT_MESSAGE_LIMIT);
        this._maxLineBytes = Math.max(512, Number(maxLineBytes) || MAX_SESSION_LINE_BYTES);
        this._maxHotFileBytes = Math.max(4096, Number(maxHotFileBytes) || MAX_SESSION_HOT_FILE_BYTES);
        this._maxArchiveFileBytes = Math.max(4096, Number(maxArchiveFileBytes) || MAX_SESSION_ARCHIVE_FILE_BYTES);
        this._maxArchiveMessages = Math.max(10, Number(maxArchiveMessages) || MAX_SESSION_ARCHIVE_MESSAGES);
        this._maxRewoundFileBytes = Math.max(4096, Number(maxRewoundFileBytes) || MAX_SESSION_REWOUND_FILE_BYTES);
        this._maxRewoundMessages = Math.max(4, Number(maxRewoundMessages) || MAX_SESSION_REWOUND_MESSAGES);
        this._maxCorruptBackupBytes = Math.max(2048, Number(maxCorruptBackupBytes) || MAX_SESSION_CORRUPT_BACKUP_BYTES);
        this._maxRetainedLines = Math.max(this._maxHotMessages, Number(maxRetainedLines) || 600);
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
            archivedMessageCount: 0,
            rewoundBranchCount: 0,
            updatedAt: 0,
        };
        this._messages = [];
        this._archiveIndex = [];
        this._syncingCoord = false;
        this._revision = 0;
        this._durableRevision = 0;
        this._loaded = false;
        this._loadPromise = null;
        this.lastWriteError = null;
        this._pendingWrites = new Map();
        this._failedWrites = new Map();
        this._nextWriteSeq = 0;
        this.corruptLineCount = 0;
        this.truncatedHotFileOnLoad = false;
        this._initialCorruptSnapshot = null;
        this._needsLeadingNewlineOnAppend = false;
    }

    get messages() {
        if (this._loaded && !this._syncingCoord) {
            this._syncFromCoordinator();
        }
        return this._messages;
    }

    set messages(next) {
        this._messages = Array.isArray(next) ? next : [];
    }

    get archiveIndex() {
        if (this._loaded && !this._syncingCoord) {
            this._syncFromCoordinator();
        }
        return this._archiveIndex.map(cloneDeepJson);
    }

    get archivedMessageCount() {
        if (this._loaded && !this._syncingCoord) {
            this._syncFromCoordinator();
        }
        return this._archiveIndex.length;
    }

    get totalLogicalMessageCount() {
        return this.archivedMessageCount + this.messages.length;
    }

    /**
     * Builds a fast revision lookup index across both archived and hot messages (Stage R8).
     */
    getRevisionIndex() {
        if (this._loaded && !this._syncingCoord) {
            this._syncFromCoordinator();
        }
        const map = new Map();
        for (let i = 0; i < this._archiveIndex.length; i++) {
            const entry = this._archiveIndex[i];
            const rev = Number(entry?.revision || 0);
            if (rev > 0) {
                map.set(rev, {
                    location: 'archive',
                    index: i,
                    id: entry.id,
                    revision: rev,
                    role: entry.role,
                    turnId: entry.turnId || '',
                });
            }
        }
        for (let i = 0; i < this._messages.length; i++) {
            const msg = this._messages[i];
            const rev = Number(msg?.revision || 0);
            if (rev > 0) {
                map.set(rev, {
                    location: 'hot',
                    index: i,
                    id: msg.id,
                    revision: rev,
                    role: msg.role,
                    turnId: msg.turnId || '',
                });
            }
        }
        return map;
    }

    lookupByRevision(revision) {
        const rev = Number(revision || 0);
        if (rev <= 0) return null;
        return this.getRevisionIndex().get(rev) || null;
    }

    get revision() {
        if (!this._syncingCoord) {
            this._syncFromCoordinator();
        }
        return this._revision;
    }

    get remoteSyncedRevision() {
        if (!this._syncingCoord) {
            this._syncFromCoordinator();
        }
        return Number(this.meta?.remoteSyncedRevision || 0);
    }

    get durableRevision() {
        return this._durableRevision;
    }

    get pendingWriteCount() {
        return this._pendingWrites.size;
    }

    get failedWrites() {
        return Array.from(this._failedWrites.values()).map(item => ({
            key: item.key,
            operation: item.operation,
            revision: item.revision,
            messageId: item.messageId,
            message: item.message,
            timestamp: item.timestamp,
        }));
    }

    get failedRevisions() {
        return Array.from(this._failedWrites.values())
            .map(item => Number(item.revision || 0))
            .filter(rev => rev > 0);
    }

    get hasUnsavedChanges() {
        return this._failedWrites.size > 0 || Boolean(this.lastWriteError);
    }

    setSaveErrorListener(fn) {
        this._onSaveError = fn;
    }

    _publishToCoordinator(operation = '', {forceOverwrite = false} = {}) {
        const existing = sharedSessionCoordinatorState.get(this._coordKey);
        if (!forceOverwrite && existing && existing.revision > this._revision) {
            return;
        }
        sharedSessionCoordinatorState.set(this._coordKey, {
            revision: this._revision,
            durableRevision: Math.max(this._durableRevision, existing?.durableRevision || 0),
            messages: this._messages.map(cloneDeepJson),
            archiveIndex: this._archiveIndex.map(cloneDeepJson),
            meta: cloneDeepJson(this.meta),
            needsLeadingNewlineOnAppend: this._needsLeadingNewlineOnAppend,
            lastOperation: operation,
            lastWriter: this,
        });
    }

    _syncFromCoordinator() {
        if (this._syncingCoord) return false;
        const coord = sharedSessionCoordinatorState.get(this._coordKey);
        if (!coord || coord.lastWriter === this) {
            return false;
        }
        if (coord.revision < this._revision) {
            return false;
        }
        if (
            coord.revision === this._revision &&
            coord.messages.length === this._messages.length &&
            (coord.archiveIndex?.length || 0) === this._archiveIndex.length
        ) {
            return false;
        }

        this._syncingCoord = true;
        try {
            if (Array.isArray(coord.archiveIndex)) {
                this._archiveIndex = coord.archiveIndex.map(cloneDeepJson);
            }
            if (coord.lastOperation === 'rewind_from_user_turn' || coord.lastOperation === 'rewind_rollback') {
                this._messages = coord.messages.map(cloneDeepJson);
                this._revision = coord.revision;
            } else {
                const {messages, maxRevision} = deduplicateMessagesPreservingOrder(
                    [...this._messages, ...coord.messages],
                    {
                        backend: coord.meta?.backend || this.meta.backend || '',
                        modelId: '',
                    }
                );
                const archiveIds = new Set(this._archiveIndex.map(a => a.id));
                this._messages = messages.filter(m => !archiveIds.has(m.id));
                this._revision = Math.max(this._revision, coord.revision, maxRevision);
            }

            this.meta = {
                ...this.meta,
                ...cloneDeepJson(coord.meta || {}),
                archivedMessageCount: this._archiveIndex.length,
                committedRevision: this._revision,
            };
            this._durableRevision = Math.max(this._durableRevision, Number(coord.durableRevision || 0));
            return true;
        } finally {
            this._syncingCoord = false;
        }
    }

    _computeSignature(backend, config) {
        if (!backend || backend === 'unconfigured') return '';
        if (typeof this._buildContextSignature === 'function') {
            return this._buildContextSignature(backend, config);
        }
        return `${backend}:${config?.provider || ''}:${config?.model || config?.openaiModel || ''}`;
    }

    async _readJsonlFileBoundedInternal(filePath, {
        maxLineBytes = this._maxLineBytes,
        maxTotalBytes = this._maxHotFileBytes,
        maxRetainedLines = this._maxRetainedLines,
    } = {}) {
        if (!filePath || !(await this._io.exists(filePath))) {
            return {
                exists: false,
                rawParsed: [],
                corruptLines: [],
                endsWithNewline: true,
                truncatedFile: false,
                linesRawSnapshot: '',
            };
        }

        const rawParsed = [];
        const corruptLines = [];
        let linesRawSnapshot = '';
        let endsWithNewline = true;
        let truncatedFile = false;

        if (typeof this._io.readJsonlBounded === 'function') {
            const bounded = await this._io.readJsonlBounded(filePath, {
                maxLineBytes,
                maxTotalBytes,
                maxRetainedLines,
            });
            if (bounded.truncatedFile || bounded.truncatedTotalBytes) {
                truncatedFile = true;
            }
            if (Array.isArray(bounded.corruptLines) && bounded.corruptLines.length > 0) {
                corruptLines.push(...bounded.corruptLines);
            }
            for (const entry of (bounded.lines || [])) {
                const trimmed = String(entry.raw || entry.text || '').trim();
                if (!trimmed) continue;
                try {
                    const obj = JSON.parse(trimmed);
                    if (obj && typeof obj === 'object') {
                        rawParsed.push(obj);
                    } else {
                        corruptLines.push({lineNumber: entry.lineNumber, raw: trimmed.slice(0, 65536)});
                    }
                } catch (_) {
                    corruptLines.push({lineNumber: entry.lineNumber, raw: trimmed.slice(0, 65536)});
                }
            }
            if (bounded.totalBytesRead > 0 && !bounded.endsWithNewline) {
                endsWithNewline = false;
            }
        } else {
            const linesRaw = String((await this._io.readText(filePath, maxTotalBytes)) || '');
            linesRawSnapshot = linesRaw;
            const encodedTotal = UTF8_ENCODER.encode(linesRaw);
            let boundedRaw = linesRaw;
            if (encodedTotal.byteLength > maxTotalBytes) {
                truncatedFile = true;
                boundedRaw = new TextDecoder('utf-8', {fatal: false}).decode(
                    encodedTotal.subarray(0, maxTotalBytes)
                );
            }
            const rawLines = boundedRaw.split(/\r?\n/);

            for (let idx = 0; idx < rawLines.length; idx++) {
                const trimmed = rawLines[idx].trim();
                if (!trimmed) continue;
                const lineByteLen = UTF8_ENCODER.encode(trimmed).byteLength;
                if (lineByteLen > maxLineBytes) {
                    corruptLines.push({
                        lineNumber: idx + 1,
                        raw: trimmed.slice(0, 4096),
                        reason: 'line_too_large',
                    });
                    continue;
                }
                try {
                    const obj = JSON.parse(trimmed);
                    if (obj && typeof obj === 'object') {
                        rawParsed.push(obj);
                        if (rawParsed.length > maxRetainedLines) {
                            rawParsed.shift();
                        }
                    } else {
                        corruptLines.push({lineNumber: idx + 1, raw: trimmed});
                    }
                } catch (_) {
                    corruptLines.push({lineNumber: idx + 1, raw: trimmed});
                }
            }
            if (linesRaw && !linesRaw.endsWith('\n')) {
                endsWithNewline = false;
            }
        }

        return {
            exists: true,
            rawParsed,
            corruptLines,
            endsWithNewline,
            truncatedFile,
            linesRawSnapshot,
        };
    }

    async _writeBoundedCorruptIsolation(corruptLines = [], sourceTag = 'messages.jsonl') {
        if (!Array.isArray(corruptLines) || corruptLines.length === 0) return;
        const newEntries = corruptLines.map(item => ({
            isolatedAt: new Date().toISOString(),
            source: sourceTag,
            lineNumber: item.lineNumber,
            ...(item.reason ? {reason: item.reason} : {}),
            raw: String(item.raw || '').slice(0, 16384),
        }));

        let existingEntries = [];
        try {
            if (await this._io.exists(this.corruptPath)) {
                const rawExisting = String((await this._io.readText(this.corruptPath, this._maxCorruptBackupBytes)) || '');
                for (const line of rawExisting.split(/\r?\n/)) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed && typeof parsed === 'object') {
                            existingEntries.push(parsed);
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}

        const combined = [...existingEntries, ...newEntries];
        const capped = capJsonlRecordsToBudget(combined, {
            maxMessages: 200,
            maxBytes: this._maxCorruptBackupBytes,
        });
        if (!capped.truncated && typeof this._io.appendLine === 'function') {
            const newLinesBody = newEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
            await this._io.appendLine(this.corruptPath, newLinesBody);
        } else {
            await this._io.replaceFile(this.corruptPath, capped.body);
        }
    }

    async _ensureBoundedCorruptBackup(corruptOriginalSnapshot = null) {
        const backupPath = `${this.jsonlPath}.corrupt-backup`;
        if (await this._io.exists(backupPath)) return;
        const rawOrig = corruptOriginalSnapshot !== null
            ? String(corruptOriginalSnapshot)
            : ((await this._io.exists(this.jsonlPath))
                ? String((await this._io.readText(this.jsonlPath, this._maxCorruptBackupBytes)) || '')
                : '');
        const encoded = UTF8_ENCODER.encode(rawOrig);
        const boundedStr = encoded.byteLength > this._maxCorruptBackupBytes
            ? new TextDecoder('utf-8', {fatal: false}).decode(encoded.subarray(0, this._maxCorruptBackupBytes))
            : rawOrig;
        await this._io.replaceFile(backupPath, boundedStr);
    }

    /**
     * Single-flight loader: concurrent `load()` calls share the exact same Promise,
     * and wait for any prior instance's pending writes on the same `sessionId` first!
     */
    load(currentBackend = '', currentConfig = {}) {
        if (this._loaded) {
            this._syncFromCoordinator();
            this._reconcileRuntimeContext(currentBackend, currentConfig);
            return Promise.resolve();
        }
        if (this._loadPromise) {
            return this._loadPromise.then(() => {
                this._syncFromCoordinator();
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
        const archiveExists = await this._io.exists(this.archivePath);

        if (metaExists || jsonlExists || archiveExists) {
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

            let hotMessages = [];
            let hotMaxRevision = 0;
            const allCorruptLines = [];

            if (jsonlExists) {
                const hotRead = await this._readJsonlFileBoundedInternal(this.jsonlPath, {
                    maxLineBytes: this._maxLineBytes,
                    maxTotalBytes: this._maxHotFileBytes,
                    maxRetainedLines: this._maxRetainedLines,
                });
                if (hotRead.truncatedFile) {
                    this.truncatedHotFileOnLoad = true;
                }
                if (hotRead.corruptLines.length > 0) {
                    allCorruptLines.push(...hotRead.corruptLines.map(c => ({...c, source: 'messages.jsonl'})));
                    if (this._initialCorruptSnapshot === null) {
                        this._initialCorruptSnapshot = hotRead.linesRawSnapshot;
                    }
                }
                if (!hotRead.endsWithNewline) {
                    this._needsLeadingNewlineOnAppend = true;
                }
                const dedupHot = deduplicateMessagesPreservingOrder(hotRead.rawParsed, {
                    backend: this.meta.backend || '',
                    modelId: '',
                });
                hotMessages = dedupHot.messages;
                hotMaxRevision = dedupHot.maxRevision;
            }

            let archiveMessages = [];
            let archiveMaxRevision = 0;
            let legacyRewoundFromArchive = [];
            let archiveHadDuplicatesOrRewound = false;

            if (archiveExists) {
                const archRead = await this._readJsonlFileBoundedInternal(this.archivePath, {
                    maxLineBytes: this._maxLineBytes,
                    maxTotalBytes: this._maxArchiveFileBytes,
                    maxRetainedLines: this._maxArchiveMessages,
                });
                if (archRead.corruptLines.length > 0) {
                    allCorruptLines.push(...archRead.corruptLines.map(c => ({...c, source: 'archive.jsonl'})));
                }
                const activeRawArchive = [];
                for (const rawObj of archRead.rawParsed) {
                    if (isRewoundRecord(rawObj)) {
                        legacyRewoundFromArchive.push(rawObj);
                        archiveHadDuplicatesOrRewound = true;
                    } else {
                        activeRawArchive.push(rawObj);
                    }
                }
                const dedupArch = deduplicateMessagesPreservingOrder(activeRawArchive, {
                    backend: this.meta.backend || '',
                    modelId: '',
                });
                if (dedupArch.messages.length < activeRawArchive.length) {
                    archiveHadDuplicatesOrRewound = true;
                }
                archiveMessages = dedupArch.messages.map(m => ({
                    ...m,
                    archiveKind: 'compacted',
                }));
                archiveMaxRevision = dedupArch.maxRevision;
            }

            // R8: Idempotent crash-window recovery (`archive append` + `hot replace`)!
            // If a crash occurred after appending to `archive.jsonl` and before replacing `messages.jsonl`,
            // overlapping messages exist in both `archiveMessages` and `hotMessages`.
            let needsCrashHealWrite = archiveHadDuplicatesOrRewound;
            if (archiveMessages.length > 0 && hotMessages.length > 0) {
                const archiveIdSet = new Set(archiveMessages.map(m => m.id));
                const archiveRevSet = new Set(
                    archiveMessages.map(m => Number(m.revision || 0)).filter(r => r > 0)
                );
                const hasOverlap = hotMessages.some(
                    m => archiveIdSet.has(m.id) || (m.revision > 0 && archiveRevSet.has(m.revision))
                );

                if (hasOverlap || hotMessages.length > this._maxHotMessages) {
                    needsCrashHealWrite = true;
                    const merged = deduplicateMessagesPreservingOrder(
                        [...archiveMessages, ...hotMessages],
                        {
                            backend: this.meta.backend || '',
                            modelId: '',
                        }
                    );
                    if (merged.messages.length > this._maxHotMessages) {
                        const reCompacted = compactMessagesByWholeTurn(merged.messages, {
                            maxMessages: this._maxHotMessages,
                            targetMessages: Math.max(2, Math.floor(this._maxHotMessages * DEFAULT_COMPACT_TARGET_RATIO)),
                        });
                        archiveMessages = reCompacted.evicted.map(m => ({
                            ...m,
                            archiveKind: 'compacted',
                        }));
                        hotMessages = reCompacted.retained.map(m => {
                            const copy = {...m};
                            delete copy.archiveKind;
                            delete copy.archivedAt;
                            return copy;
                        });
                    } else {
                        // Keep already-archived prefix in archiveMessages and strip duplicates from hotMessages
                        const filteredHot = hotMessages.filter(
                            m => !archiveIdSet.has(m.id) && !(m.revision > 0 && archiveRevSet.has(m.revision))
                        );
                        if (filteredHot.length > 0) {
                            hotMessages = filteredHot;
                        } else {
                            // All messages were in both files: keep latest turn in hotMessages, older in archiveMessages
                            const turns = groupMessagesIntoCompleteTurns(merged.messages);
                            hotMessages = turns.at(-1) || merged.messages;
                            const hotIdSet = new Set(hotMessages.map(m => m.id));
                            archiveMessages = merged.messages
                                .filter(m => !hotIdSet.has(m.id))
                                .map(m => ({...m, archiveKind: 'compacted'}));
                        }
                    }
                }
            }

            if (archiveMessages.length > this._maxArchiveMessages) {
                archiveMessages = archiveMessages.slice(archiveMessages.length - this._maxArchiveMessages);
                needsCrashHealWrite = true;
            }

            this._archiveIndex = archiveMessages.map((m, idx) => buildArchiveIndexDescriptor(m, idx)).filter(Boolean);
            this._messages = hotMessages;
            this._revision = Math.max(
                Number(this.meta.committedRevision || 0),
                hotMaxRevision,
                archiveMaxRevision,
                this._archiveIndex.length + this._messages.length
            );
            this._durableRevision = this._revision;
            this.meta.committedRevision = this._revision;
            this.meta.archivedMessageCount = this._archiveIndex.length;

            if (allCorruptLines.length > 0) {
                this.corruptLineCount += allCorruptLines.length;
                const corruptSnap = allCorruptLines.map(cloneDeepJson);
                this._enqueueWrite('isolate_corrupt_lines', async () => {
                    await this._writeBoundedCorruptIsolation(corruptSnap, 'load');
                }, {isAuxWrite: true});
            }

            if (needsCrashHealWrite) {
                const healArchiveSnap = archiveMessages.map(cloneDeepJson);
                const healHotSnap = this._messages.map(cloneDeepJson);
                const healRewoundSnap = legacyRewoundFromArchive.map(m => ({
                    ...cloneDeepJson(m),
                    archiveKind: 'rewound_branch',
                }));
                const healMetaSnap = cloneDeepJson(this.meta);
                const hadCorrupt = this.corruptLineCount > 0;
                const origCorruptSnap = this._initialCorruptSnapshot;
                this._needsLeadingNewlineOnAppend = false;

                this._enqueueWrite('heal_archive_hot_crash_window', async () => {
                    if (hadCorrupt) {
                        await this._ensureBoundedCorruptBackup(origCorruptSnap);
                    }
                    if (healRewoundSnap.length > 0) {
                        await this._appendBoundedRewoundRecords(healRewoundSnap);
                    }
                    const cappedArch = capJsonlRecordsToBudget(healArchiveSnap, {
                        maxMessages: this._maxArchiveMessages,
                        maxBytes: this._maxArchiveFileBytes,
                    });
                    await this._io.replaceFile(this.archivePath, cappedArch.body);
                    const hotBody = healHotSnap.map(m => JSON.stringify(m)).join('\n')
                        + (healHotSnap.length ? '\n' : '');
                    await this._io.replaceFile(this.jsonlPath, hotBody);
                    await this._io.replaceFile(this.metaPath, JSON.stringify(healMetaSnap, null, 2));
                }, {revision: this._revision, isFullSnapshot: true});
            }

            const coord = sharedSessionCoordinatorState.get(this._coordKey);
            if (coord && coord.revision > this._revision && sharedSessionWriteChains.has(this._coordKey)) {
                this._syncFromCoordinator();
            } else {
                this._publishToCoordinator('load', {forceOverwrite: true});
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
                    const evictedWithKind = compacted.evicted.map(m => ({
                        ...m,
                        archiveKind: 'compacted',
                        archivedAt: new Date().toISOString(),
                    }));
                    this._archiveIndex = evictedWithKind.map((m, idx) => buildArchiveIndexDescriptor(m, idx)).filter(Boolean);
                    this.messages = compacted.retained;
                    this._revision = Math.max(maxRevision, messages.length);
                    this.meta = {
                        ...this.meta,
                        schemaVersion: 2,
                        backend: parsed.backend || '',
                        modelSignature: parsed.modelSignature || '',
                        contextSignature: parsed.contextSignature || '',
                        remoteSessionId: parsed.remoteSessionId || '',
                        remoteSyncedRevision: 0,
                        committedRevision: this._revision,
                        archivedMessageCount: this._archiveIndex.length,
                        updatedAt: parsed.updatedAt || Date.now(),
                    };
                    this._publishToCoordinator('migrate_legacy_json', {forceOverwrite: true});
                    const snapshotMessages = this.messages.map(cloneDeepJson);
                    const snapshotMeta = cloneDeepJson(this.meta);
                    const snapshotEvicted = evictedWithKind;
                    this._enqueueWrite('migrate_legacy_json', async () => {
                        if (this._keepArchive && snapshotEvicted.length > 0) {
                            const cappedArch = capJsonlRecordsToBudget(snapshotEvicted, {
                                maxMessages: this._maxArchiveMessages,
                                maxBytes: this._maxArchiveFileBytes,
                            });
                            await this._io.replaceFile(this.archivePath, cappedArch.body);
                        }
                        const body = snapshotMessages.map(m => JSON.stringify(m)).join('\n') + (snapshotMessages.length ? '\n' : '');
                        await this._io.replaceFile(this.jsonlPath, body);
                        await this._io.replaceFile(this.metaPath, JSON.stringify(snapshotMeta, null, 2));
                        await this._io.unlink?.(this.legacyPath);
                    }, {revision: this._revision, isFullSnapshot: true});
                }
            }
            return;
        }

        this._publishToCoordinator('load_empty', {forceOverwrite: true});
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

        // R3: Invalidate remoteSessionId if backend/model/endpoint/workspace/mode changed,
        // if local conversation advanced past remoteSyncedRevision, if remoteSyncedRevision was never
        // confirmed (<= 0 while _revision > 0), or if there are unsaved disk write errors!
        const hasUnsyncedTurns = Boolean(
            this.meta.remoteSessionId &&
            (
                (this._revision > 0 && Number(this.meta.remoteSyncedRevision || 0) !== this._revision) ||
                this.hasUnsavedChanges
            )
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
        this._syncFromCoordinator();
        return this.meta.remoteSessionId || '';
    }

    /**
     * R3: Verifies whether `remoteSessionId` is safe to pass to `--resume` / `codex exec resume`
     * for a new turn. If any prior local turn was not confirmed by the backend (`remoteSyncedRevision !== _revision`)
     * or disk writes failed, invalidates `remoteSessionId` so the adapter falls back to local context.
     */
    resolveRemoteSessionForTurn(backend, config = {}) {
        this._syncFromCoordinator();
        this._reconcileRuntimeContext(backend, config);
        if (!this.meta.remoteSessionId) {
            return '';
        }
        return this.meta.remoteSessionId;
    }

    clearRemoteSessionId(reason = '') {
        this._syncFromCoordinator();
        if (!this.meta.remoteSessionId && !this.meta.remoteSyncedRevision) {
            return Promise.resolve({ok: true});
        }
        this.meta.remoteSessionId = '';
        this.meta.remoteSyncedRevision = 0;
        this.meta.updatedAt = Date.now();
        if (reason) {
            this.meta.lastRemoteResetReason = String(reason).slice(0, 240);
        }
        this._publishToCoordinator('clear_remote_session');
        const metaSnapshot = cloneDeepJson({...this.meta, committedRevision: this._revision});
        return this._enqueueWrite('clear_remote_session', async () => {
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        }, {revision: this._revision, isMetaOnly: true});
    }

    setRemoteSessionId(remoteId, backend, config, {markSynced = true} = {}) {
        this._syncFromCoordinator();
        const clean = String(remoteId || '').trim();
        const sig = this._computeSignature(backend, config);
        const targetSyncedRev = !clean
            ? 0
            : (markSynced ? this._revision : Number(this.meta.remoteSyncedRevision || 0));
        if (
            this.meta.remoteSessionId === clean &&
            this.meta.backend === backend &&
            this.meta.contextSignature === sig &&
            this.meta.remoteSyncedRevision === targetSyncedRev
        ) {
            return Promise.resolve({ok: true});
        }
        this.meta.remoteSessionId = clean;
        this.meta.backend = backend || this.meta.backend;
        this.meta.contextSignature = sig;
        this.meta.modelSignature = sig;
        this.meta.remoteSyncedRevision = targetSyncedRev;
        this.meta.updatedAt = Date.now();
        this._publishToCoordinator('set_remote_session');

        const metaSnapshot = cloneDeepJson({...this.meta, committedRevision: this._revision});
        return this._enqueueWrite('set_remote_session', async () => {
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        }, {revision: this._revision, isMetaOnly: true});
    }

    /**
     * R3: Advances `remoteSyncedRevision` ONLY after a backend turn has completed cleanly
     * and both user + assistant messages for that turn have been appended.
     */
    confirmRemoteTurnSynced(remoteId = '', backend = '', config = {}) {
        this._syncFromCoordinator();
        if (this.hasUnsavedChanges) {
            return this.clearRemoteSessionId('write_error_unsynced');
        }
        const clean = String(remoteId || this.meta.remoteSessionId || '').trim();
        if (!clean) {
            return Promise.resolve({ok: false});
        }
        return this.setRemoteSessionId(clean, backend || this.meta.backend, config, {markSynced: true});
    }

    async _appendBoundedRewoundRecords(rewoundRecords = []) {
        if (!Array.isArray(rewoundRecords) || rewoundRecords.length === 0) return;
        let existing = [];
        try {
            if (await this._io.exists(this.rewoundPath)) {
                const readRes = await this._readJsonlFileBoundedInternal(this.rewoundPath, {
                    maxLineBytes: this._maxLineBytes,
                    maxTotalBytes: this._maxRewoundFileBytes,
                    maxRetainedLines: this._maxRewoundMessages,
                });
                existing = readRes.rawParsed;
            }
        } catch (_) {}

        const combined = [...existing, ...rewoundRecords].map(m => ({
            ...m,
            archiveKind: 'rewound_branch',
        }));
        const capped = capJsonlRecordsToBudget(combined, {
            maxMessages: this._maxRewoundMessages,
            maxBytes: this._maxRewoundFileBytes,
        });
        await this._io.replaceFile(this.rewoundPath, capped.body);
    }

    async _appendOrRewriteBoundedArchiveRecords(evictedRecords = [], {forceRewrite = false} = {}) {
        if (!Array.isArray(evictedRecords) || evictedRecords.length === 0) return;
        const normalizedEvicted = evictedRecords.map(m => ({
            ...m,
            archiveKind: 'compacted',
            archivedAt: m.archivedAt || new Date().toISOString(),
        }));

        if (!forceRewrite && this._archiveIndex.length <= this._maxArchiveMessages) {
            const archiveLines = normalizedEvicted.map(m => JSON.stringify(m)).join('\n') + '\n';
            await this._io.appendLine(this.archivePath, archiveLines);
            return;
        }

        let existing = [];
        try {
            if (await this._io.exists(this.archivePath)) {
                const archRead = await this._readJsonlFileBoundedInternal(this.archivePath, {
                    maxLineBytes: this._maxLineBytes,
                    maxTotalBytes: this._maxArchiveFileBytes,
                    maxRetainedLines: this._maxArchiveMessages,
                });
                existing = archRead.rawParsed.filter(m => !isRewoundRecord(m));
            }
        } catch (_) {}

        const dedup = deduplicateMessagesPreservingOrder(
            [...existing, ...normalizedEvicted],
            {backend: this.meta.backend || '', modelId: ''}
        );
        const capped = capJsonlRecordsToBudget(
            dedup.messages.map(m => ({...m, archiveKind: 'compacted'})),
            {
                maxMessages: this._maxArchiveMessages,
                maxBytes: this._maxArchiveFileBytes,
            }
        );
        await this._io.replaceFile(this.archivePath, capped.body);
    }

    /**
     * Appends a message using strictly immutable snapshots captured at call time.
     * Even if message #201 triggers whole-turn compaction while #202 and #203 are appended
     * immediately afterwards, #201's compaction writes ONLY its frozen `<=201` snapshot,
     * and #202/#203 append ONLY their own lines — zero duplicates, zero dropped records!
     */
    appendMessage(message, backend = '', config = {}) {
        this._syncFromCoordinator();
        const rev = ++this._revision;
        let lastUserId = '';
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i]?.role === 'user' && this.messages[i]?.id) {
                lastUserId = this.messages[i].id;
                break;
            }
        }
        if (!lastUserId) {
            for (let i = this._archiveIndex.length - 1; i >= 0; i--) {
                if (this._archiveIndex[i]?.role === 'user' && this._archiveIndex[i]?.id) {
                    lastUserId = this._archiveIndex[i].id;
                    break;
                }
            }
        }

        const effectiveModelId = String(
            message?.modelId ||
            (backend === 'openai' ? (config?.openaiModel || config?.model || '') : (config?.model || ''))
        ).trim();
        const effectiveEndpoint = String(
            message?.endpoint ||
            (backend === 'openai' ? (config?.openaiBaseUrl || '') : '')
        ).trim();

        const record = normalizeStoredMessage(
            {...message, revision: rev},
            {
                fallbackIndex: this._archiveIndex.length + this.messages.length,
                nextRevision: rev,
                defaultBackend: backend || this.meta.backend || '',
                defaultModelId: effectiveModelId,
                defaultEndpoint: effectiveEndpoint,
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
        // R3: Do NOT advance `this.meta.remoteSyncedRevision` on local append!
        // `remoteSyncedRevision` is only advanced when the backend protocol confirms turn completion.
        this.meta.committedRevision = rev;
        this.meta.updatedAt = record.ts;

        // Capture immutable snapshots synchronously BEFORE yielding to async queue!
        const recordLineSnapshot = JSON.stringify(record);
        let compactionResult = {compacted: false, retained: null, evicted: []};
        let evictedForArchive = [];
        let forceArchiveRewrite = false;
        let fullSnapshotForInPlaceUpdate = null;

        if (this.messages.length > this._maxHotMessages) {
            compactionResult = compactMessagesByWholeTurn(this.messages, {
                maxMessages: this._maxHotMessages,
                targetMessages: Math.max(2, Math.floor(this._maxHotMessages * DEFAULT_COMPACT_TARGET_RATIO)),
            });
            if (compactionResult.compacted) {
                const archivedAtIso = new Date().toISOString();
                evictedForArchive = compactionResult.evicted.map(m => ({
                    ...cloneDeepJson(m),
                    archiveKind: 'compacted',
                    archivedAt: archivedAtIso,
                }));
                this.messages = compactionResult.retained.map(cloneDeepJson);

                if (this._keepArchive && evictedForArchive.length > 0) {
                    const existingArchIds = new Set(this._archiveIndex.map(a => a.id));
                    for (const ev of evictedForArchive) {
                        if (!existingArchIds.has(ev.id)) {
                            existingArchIds.add(ev.id);
                            const desc = buildArchiveIndexDescriptor(ev, this._archiveIndex.length);
                            if (desc) this._archiveIndex.push(desc);
                        } else {
                            forceArchiveRewrite = true;
                        }
                    }
                    if (this._archiveIndex.length > this._maxArchiveMessages) {
                        this._archiveIndex = this._archiveIndex
                            .slice(this._archiveIndex.length - this._maxArchiveMessages)
                            .map((entry, idx) => ({...entry, archiveIndex: idx}));
                        forceArchiveRewrite = true;
                    }
                }
            }
        } else if (replacedInPlace) {
            fullSnapshotForInPlaceUpdate = this.messages.map(cloneDeepJson);
        }

        this.meta.archivedMessageCount = this._archiveIndex.length;
        this._publishToCoordinator('append_message');

        const metaSnapshot = cloneDeepJson(this.meta);
        const hadPriorCorruptLines = this.corruptLineCount > 0;
        const corruptOriginalSnapshot = this._initialCorruptSnapshot;
        const prependLeadingNewline = this._needsLeadingNewlineOnAppend;
        if (prependLeadingNewline) {
            this._needsLeadingNewlineOnAppend = false;
        }
        const isFullSnapshotWrite = Boolean(compactionResult.compacted || fullSnapshotForInPlaceUpdate);
        if (isFullSnapshotWrite) {
            this._needsLeadingNewlineOnAppend = false;
        }

        let archiveWritten = false;
        let jsonlWritten = false;

        return this._enqueueWrite('append_message', async () => {
            if (isFullSnapshotWrite) {
                // Never overwrite the sole copy if corrupt lines were seen earlier without backing up first!
                if (hadPriorCorruptLines) {
                    await this._ensureBoundedCorruptBackup(corruptOriginalSnapshot);
                }
                if (!archiveWritten && this._keepArchive && evictedForArchive.length > 0) {
                    await this._appendOrRewriteBoundedArchiveRecords(evictedForArchive, {
                        forceRewrite: forceArchiveRewrite,
                    });
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
        }, {
            revision: rev,
            messageId: record.id,
            isFullSnapshot: isFullSnapshotWrite,
        });
    }

    /**
     * Rewinds session history cleanly to the point right BEFORE `targetMessageId`'s user turn
     * (used by in-place Regenerate `↻` and Edit Question `✎`).
     *
     * Architectural Invariant (Stage F3, R3 & R8):
     * 1. Because external CLI `resume` (`--resume` / `codex exec resume`) cannot roll back remote session turns,
     *    rewinding history ALWAYS invalidates `remoteSessionId` (`remoteSessionReset: true`) so the next turn
     *    starts a fresh CLI session and reconstructs exact local context via `buildCrossBackendPromptWithContext`.
     * 2. Transactional durability (R3): captures pre-rewind snapshot; if the disk write fails after retries,
     *    rolls back in-memory `messages`, `archiveIndex`, `meta`, and `_revision` so memory, disk, and UI never diverge!
     * 3. Branch separation (R8): rewound/replaced messages are written to `rewound.jsonl` (`archiveKind: 'rewound_branch'`),
     *    NEVER mixed into `archive.jsonl` (`compacted`), and NEVER re-injected into model context or default exports!
     */
    rewindFromUserMessage(targetMessageId, {archiveRemoved = true} = {}) {
        this._syncFromCoordinator();
        const cleanId = String(targetMessageId || '').trim();
        if (!cleanId) {
            return {
                ok: false,
                error: '缺少需要回退的消息标识',
                removedMessages: [],
                targetUserMessage: null,
                remoteSessionReset: false,
                writePromise: Promise.resolve({ok: false, error: new Error('缺少需要回退的消息标识')}),
            };
        }

        let splitIdx = this.messages.findIndex(m => m && m.id === cleanId);
        let splitInArchiveIdx = -1;

        if (splitIdx >= 0 && this.messages[splitIdx]?.role !== 'user') {
            const targetMsg = this.messages[splitIdx];
            const replyTo = String(targetMsg?.replyTo || '').trim();
            if (replyTo) {
                const replyUserIdx = this.messages.findIndex(m => m && m.id === replyTo && m.role === 'user');
                if (replyUserIdx >= 0) {
                    splitIdx = replyUserIdx;
                } else {
                    const archReplyIdx = this._archiveIndex.findIndex(a => a && a.id === replyTo && a.role === 'user');
                    if (archReplyIdx >= 0) {
                        splitInArchiveIdx = archReplyIdx;
                        splitIdx = -1;
                    }
                }
            }
            if (splitIdx >= 0 && this.messages[splitIdx]?.role !== 'user') {
                for (let i = splitIdx - 1; i >= 0; i--) {
                    if (this.messages[i]?.role === 'user') {
                        splitIdx = i;
                        break;
                    }
                }
            }
        }

        if (splitIdx < 0 && splitInArchiveIdx < 0) {
            let archIdx = this._archiveIndex.findIndex(a => a && a.id === cleanId);
            if (archIdx >= 0 && this._archiveIndex[archIdx]?.role !== 'user') {
                const replyTo = String(this._archiveIndex[archIdx]?.replyTo || '').trim();
                if (replyTo) {
                    const replyArchIdx = this._archiveIndex.findIndex(a => a && a.id === replyTo && a.role === 'user');
                    if (replyArchIdx >= 0) archIdx = replyArchIdx;
                }
                if (this._archiveIndex[archIdx]?.role !== 'user') {
                    for (let i = archIdx - 1; i >= 0; i--) {
                        if (this._archiveIndex[i]?.role === 'user') {
                            archIdx = i;
                            break;
                        }
                    }
                }
            }
            if (archIdx >= 0 && this._archiveIndex[archIdx]?.role === 'user') {
                splitInArchiveIdx = archIdx;
            }
        }

        if (
            (splitIdx < 0 || this.messages[splitIdx]?.role !== 'user') &&
            (splitInArchiveIdx < 0 || this._archiveIndex[splitInArchiveIdx]?.role !== 'user')
        ) {
            return {
                ok: false,
                error: '未在当前会话中找到对应的提问记录',
                removedMessages: [],
                targetUserMessage: null,
                remoteSessionReset: false,
                writePromise: Promise.resolve({ok: false, error: new Error('未在当前会话中找到对应的提问记录')}),
            };
        }

        // Capture full pre-rewind state for transactional rollback if disk commit fails
        const prevMessagesSnapshot = this.messages.map(cloneDeepJson);
        const prevArchiveIndexSnapshot = this._archiveIndex.map(cloneDeepJson);
        const prevMetaSnapshot = cloneDeepJson(this.meta);
        const prevRevision = this._revision;
        const prevNeedsNewline = this._needsLeadingNewlineOnAppend;

        let targetUserMessage = null;
        let removedMessages = [];
        let retainedSnapshot = [];
        let retainedArchiveIndexSnapshot = this._archiveIndex.map(cloneDeepJson);
        let removedArchiveDescriptors = [];

        if (splitInArchiveIdx >= 0) {
            const archTargetDesc = this._archiveIndex[splitInArchiveIdx];
            targetUserMessage = {
                id: archTargetDesc.id,
                revision: archTargetDesc.revision,
                role: 'user',
                content: archTargetDesc.previewText || '',
                createdAt: archTargetDesc.createdAt || '',
                ts: archTargetDesc.ts || 0,
                backend: archTargetDesc.backend || '',
                modelId: archTargetDesc.modelId || '',
            };
            removedArchiveDescriptors = this._archiveIndex.slice(splitInArchiveIdx).map(cloneDeepJson);
            retainedArchiveIndexSnapshot = this._archiveIndex.slice(0, splitInArchiveIdx).map(cloneDeepJson);
            removedMessages = [
                ...removedArchiveDescriptors.map(d => ({
                    id: d.id,
                    revision: d.revision,
                    role: d.role,
                    content: d.previewText || '',
                    createdAt: d.createdAt || '',
                    ts: d.ts || 0,
                })),
                ...this.messages.map(cloneDeepJson),
            ];
            retainedSnapshot = [];
            this._archiveIndex = retainedArchiveIndexSnapshot.map(cloneDeepJson);
            this.messages = [];
        } else {
            targetUserMessage = cloneDeepJson(this.messages[splitIdx]);
            removedMessages = this.messages.slice(splitIdx).map(cloneDeepJson);
            retainedSnapshot = this.messages.slice(0, splitIdx).map(cloneDeepJson);
            this.messages = retainedSnapshot.map(cloneDeepJson);
        }

        const hadRemoteSession = Boolean(this.meta.remoteSessionId);
        const rev = ++this._revision;
        const rewoundAtIso = new Date().toISOString();
        this.meta.remoteSessionId = '';
        this.meta.remoteSyncedRevision = 0;
        this.meta.lastRemoteResetReason = 'history_rewound';
        this.meta.committedRevision = rev;
        this.meta.archivedMessageCount = this._archiveIndex.length;
        this.meta.rewoundBranchCount = Number(this.meta.rewoundBranchCount || 0) + removedMessages.length;
        this.meta.updatedAt = Date.now();
        this._needsLeadingNewlineOnAppend = false;

        this._publishToCoordinator('rewind_from_user_turn');

        const metaSnapshot = cloneDeepJson(this.meta);
        const hadPriorCorruptLines = this.corruptLineCount > 0;
        const corruptOriginalSnapshot = this._initialCorruptSnapshot;
        let rewoundWritten = false;
        let archiveTruncatedWritten = splitInArchiveIdx < 0;
        let jsonlWritten = false;

        const rewindBackup = {
            prevMessagesSnapshot: prevMessagesSnapshot.map(cloneDeepJson),
            prevArchiveIndexSnapshot: prevArchiveIndexSnapshot.map(cloneDeepJson),
            removedMessages: removedMessages.map(cloneDeepJson),
            targetUserMessage: cloneDeepJson(targetUserMessage),
            splitInArchiveIdx,
            rewindRevision: rev,
            createdAtMs: Date.now(),
        };
        this._lastRewindBackup = rewindBackup;

        const writePromise = this._enqueueWrite('rewind_from_user_turn', async () => {
            if (hadPriorCorruptLines) {
                await this._ensureBoundedCorruptBackup(corruptOriginalSnapshot);
            }

            let fullRemovedFromArchive = [];
            let retainedArchiveRecords = [];
            if (!archiveTruncatedWritten && splitInArchiveIdx >= 0 && (await this._io.exists(this.archivePath))) {
                const archRead = await this._readJsonlFileBoundedInternal(this.archivePath, {
                    maxLineBytes: this._maxLineBytes,
                    maxTotalBytes: this._maxArchiveFileBytes,
                    maxRetainedLines: this._maxArchiveMessages,
                });
                const dedupArch = deduplicateMessagesPreservingOrder(
                    archRead.rawParsed.filter(m => !isRewoundRecord(m)),
                    {backend: metaSnapshot.backend || '', modelId: ''}
                );
                const exactCut = dedupArch.messages.findIndex(m => m.id === targetUserMessage.id);
                const cutAt = exactCut >= 0 ? exactCut : Math.min(splitInArchiveIdx, dedupArch.messages.length);
                retainedArchiveRecords = dedupArch.messages.slice(0, cutAt).map(m => ({
                    ...m,
                    archiveKind: 'compacted',
                }));
                fullRemovedFromArchive = dedupArch.messages.slice(cutAt);
            }

            if (!rewoundWritten && archiveRemoved && this._keepArchive) {
                const rawBranchToRewind = splitInArchiveIdx >= 0
                    ? [...fullRemovedFromArchive, ...prevMessagesSnapshot]
                    : removedMessages;
                if (rawBranchToRewind.length > 0) {
                    const taggedRewound = rawBranchToRewind.map(m => ({
                        ...cloneDeepJson(m),
                        archiveKind: 'rewound_branch',
                        rewoundAt: rewoundAtIso,
                        rewindFromMessageId: targetUserMessage.id,
                        rewindRevision: rev,
                    }));
                    await this._appendBoundedRewoundRecords(taggedRewound);
                }
                rewoundWritten = true;
            }

            if (!archiveTruncatedWritten && splitInArchiveIdx >= 0) {
                const cappedArch = capJsonlRecordsToBudget(retainedArchiveRecords, {
                    maxMessages: this._maxArchiveMessages,
                    maxBytes: this._maxArchiveFileBytes,
                });
                await this._io.replaceFile(this.archivePath, cappedArch.body);
                archiveTruncatedWritten = true;
            }

            if (!jsonlWritten) {
                const jsonlBody = retainedSnapshot.map(m => JSON.stringify(m)).join('\n')
                    + (retainedSnapshot.length ? '\n' : '');
                await this._io.replaceFile(this.jsonlPath, jsonlBody);
                jsonlWritten = true;
            }
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        }, {
            revision: rev,
            isFullSnapshot: true,
            dontRecordFailedWriteOnRollback: true,
            onRollback: () => {
                if (this._lastRewindBackup === rewindBackup) {
                    this._lastRewindBackup = null;
                }
                this.messages = prevMessagesSnapshot.map(cloneDeepJson);
                this._archiveIndex = prevArchiveIndexSnapshot.map(cloneDeepJson);
                this.meta = cloneDeepJson(prevMetaSnapshot);
                this._revision = prevRevision;
                this._needsLeadingNewlineOnAppend = prevNeedsNewline;
                this._publishToCoordinator('rewind_rollback', {forceOverwrite: true});
            },
        });

        return {
            ok: true,
            targetUserMessage,
            removedMessages,
            retainedCount: this._archiveIndex.length + this.messages.length,
            remoteSessionReset: hadRemoteSession,
            canUndo: true,
            writePromise,
        };
    }

    get canUndoLastRewind() {
        return Boolean(
            this._lastRewindBackup &&
            Array.isArray(this._lastRewindBackup.prevMessagesSnapshot) &&
            this._lastRewindBackup.prevMessagesSnapshot.length > 0
        );
    }

    /**
     * Restores the conversation branch discarded by the most recent `rewindFromUserMessage` (R11.3).
     * Never auto-reruns side-effecting operations; simply restores the logical history snapshot to disk & memory.
     */
    undoLastRewind() {
        this._syncFromCoordinator();
        const backup = this._lastRewindBackup;
        if (!backup || !Array.isArray(backup.prevMessagesSnapshot)) {
            return {
                ok: false,
                error: '暂无可撤销的历史回退记录',
                restoredCount: 0,
                writePromise: Promise.resolve({ok: false, error: new Error('暂无可撤销的历史回退记录')}),
            };
        }

        const prevMessagesOnUndoFail = this.messages.map(cloneDeepJson);
        const prevArchiveIndexOnUndoFail = this._archiveIndex.map(cloneDeepJson);
        const prevMetaOnUndoFail = cloneDeepJson(this.meta);
        const prevRevOnUndoFail = this._revision;

        const restoredMessages = backup.prevMessagesSnapshot.map(cloneDeepJson);
        const restoredArchiveIndex = backup.prevArchiveIndexSnapshot.map(cloneDeepJson);
        const restoredCount = backup.removedMessages?.length || 0;

        this.messages = restoredMessages.map(cloneDeepJson);
        this._archiveIndex = restoredArchiveIndex.map(cloneDeepJson);
        const rev = ++this._revision;
        this.meta.remoteSessionId = '';
        this.meta.remoteSyncedRevision = 0;
        this.meta.lastRemoteResetReason = 'undo_rewind';
        this.meta.committedRevision = rev;
        this.meta.archivedMessageCount = this._archiveIndex.length;
        this.meta.updatedAt = Date.now();
        this._lastRewindBackup = null;
        this._needsLeadingNewlineOnAppend = false;

        this._publishToCoordinator('undo_last_rewind', {forceOverwrite: true});
        const metaSnapshot = cloneDeepJson(this.meta);

        const writePromise = this._enqueueWrite('undo_last_rewind', async () => {
            const jsonlBody = restoredMessages.map(m => JSON.stringify(m)).join('\n')
                + (restoredMessages.length ? '\n' : '');
            await this._io.replaceFile(this.jsonlPath, jsonlBody);
            await this._io.replaceFile(this.metaPath, JSON.stringify(metaSnapshot, null, 2));
        }, {
            revision: rev,
            isFullSnapshot: true,
            dontRecordFailedWriteOnRollback: true,
            onRollback: () => {
                this._lastRewindBackup = backup;
                this.messages = prevMessagesOnUndoFail;
                this._archiveIndex = prevArchiveIndexOnUndoFail;
                this.meta = prevMetaOnUndoFail;
                this._revision = prevRevOnUndoFail;
                this._publishToCoordinator('undo_rewind_rollback', {forceOverwrite: true});
            },
        });

        return {
            ok: true,
            restoredCount,
            messages: this.messages.map(cloneDeepJson),
            writePromise,
        };
    }

    /**
     * Loads a paginated slice of older compacted messages from `archive.jsonl` (Stage R8).
     * Excludes rewound/replaced branches by default (`includeRewound = false`) and deduplicates
     * against hot `this.messages` so archived messages are never duplicated or mixed with rewound history.
     */
    async loadArchivedHistoryPage({
        beforeRevision = 0,
        beforeMessageId = '',
        beforeArchiveOffset = null,
        beforeIndex = null,
        limit = 30,
        includeRewound = false,
    } = {}) {
        const activeChain = sharedSessionWriteChains.get(this._coordKey);
        if (activeChain) {
            try { await activeChain; } catch (_) {}
        }
        this._syncFromCoordinator();

        if (!(await this._io.exists(this.archivePath))) {
            return {
                messages: [],
                hasMoreOlder: false,
                remainingOlderCount: 0,
                olderRemainingCount: 0,
                pageStartIndex: 0,
                pageEndIndex: 0,
                nextBeforeArchiveOffset: 0,
                nextBeforeRevision: 0,
                totalArchivedCount: 0,
            };
        }

        const archRead = await this._readJsonlFileBoundedInternal(this.archivePath, {
            maxLineBytes: this._maxLineBytes,
            maxTotalBytes: this._maxArchiveFileBytes,
            maxRetainedLines: this._maxArchiveMessages,
        });
        const filteredRaw = includeRewound
            ? archRead.rawParsed
            : archRead.rawParsed.filter(m => !isRewoundRecord(m));
        const dedupArch = deduplicateMessagesPreservingOrder(filteredRaw, {
            backend: this.meta.backend || '',
            modelId: '',
        });

        const hotIdSet = new Set(this.messages.map(m => m.id));
        const hotRevSet = new Set(this.messages.map(m => Number(m.revision || 0)).filter(r => r > 0));
        const activeArchived = dedupArch.messages.filter(
            m => !hotIdSet.has(m.id) && !(m.revision > 0 && hotRevSet.has(m.revision))
        );

        const effectiveOffset = Number.isInteger(beforeArchiveOffset) && beforeArchiveOffset >= 0
            ? beforeArchiveOffset
            : (Number.isInteger(beforeIndex) && beforeIndex >= 0 ? beforeIndex : null);

        let endIdx = activeArchived.length;
        if (effectiveOffset !== null) {
            endIdx = Math.min(activeArchived.length, effectiveOffset);
        } else if (beforeMessageId) {
            const foundIdx = activeArchived.findIndex(m => m.id === beforeMessageId);
            if (foundIdx >= 0) {
                endIdx = foundIdx;
            }
        } else if (Number(beforeRevision) > 0) {
            const cutoffRev = Number(beforeRevision);
            const firstAtOrAfter = activeArchived.findIndex(m => Number(m.revision || 0) >= cutoffRev);
            if (firstAtOrAfter >= 0) {
                endIdx = firstAtOrAfter;
            }
        }

        const pageSize = Math.max(1, Number(limit) || 30);
        const startIdx = Math.max(0, endIdx - pageSize);
        const pageMessages = activeArchived.slice(startIdx, endIdx);

        return {
            messages: pageMessages,
            hasMoreOlder: startIdx > 0,
            remainingOlderCount: startIdx,
            olderRemainingCount: startIdx,
            pageStartIndex: startIdx,
            pageEndIndex: endIdx,
            nextBeforeArchiveOffset: startIdx,
            nextBeforeRevision: pageMessages[0]?.revision || 0,
            totalArchivedCount: activeArchived.length,
        };
    }

    /**
     * Loads the complete logical conversation (`archive.jsonl` + `messages.jsonl`) deduplicated
     * by `id`/`revision` in chronological order (Stage R8).
     * By default (`includeRewound = false`), rewound/edited history branches are strictly excluded.
     */
    async loadFullLogicalHistory({includeRewound = false} = {}) {
        const activeChain = sharedSessionWriteChains.get(this._coordKey);
        if (activeChain) {
            try { await activeChain; } catch (_) {}
        }
        this._syncFromCoordinator();

        let archiveMessages = [];
        let legacyRewoundInArchive = [];
        if (await this._io.exists(this.archivePath)) {
            const archRead = await this._readJsonlFileBoundedInternal(this.archivePath, {
                maxLineBytes: this._maxLineBytes,
                maxTotalBytes: this._maxArchiveFileBytes,
                maxRetainedLines: this._maxArchiveMessages,
            });
            const activeRaw = [];
            for (const item of archRead.rawParsed) {
                if (isRewoundRecord(item)) {
                    legacyRewoundInArchive.push(item);
                } else {
                    activeRaw.push(item);
                }
            }
            const dedupArch = deduplicateMessagesPreservingOrder(activeRaw, {
                backend: this.meta.backend || '',
                modelId: '',
            });
            archiveMessages = dedupArch.messages;
        }

        const mergedActive = deduplicateMessagesPreservingOrder(
            [...archiveMessages, ...this.messages],
            {
                backend: this.meta.backend || '',
                modelId: '',
            }
        );

        let rewoundMessages = [];
        if (includeRewound) {
            let fromRewoundFile = [];
            if (await this._io.exists(this.rewoundPath)) {
                const rwRead = await this._readJsonlFileBoundedInternal(this.rewoundPath, {
                    maxLineBytes: this._maxLineBytes,
                    maxTotalBytes: this._maxRewoundFileBytes,
                    maxRetainedLines: this._maxRewoundMessages,
                });
                fromRewoundFile = rwRead.rawParsed;
            }
            const dedupRewound = deduplicateMessagesPreservingOrder(
                [...legacyRewoundInArchive, ...fromRewoundFile],
                {backend: this.meta.backend || '', modelId: ''}
            );
            rewoundMessages = dedupRewound.messages.map(m => ({
                ...m,
                archiveKind: 'rewound_branch',
            }));
        }

        const hotIdSet = new Set(this.messages.map(m => m.id));
        const effectiveArchivedCount = mergedActive.messages.filter(m => !hotIdSet.has(m.id)).length;

        return {
            messages: mergedActive.messages,
            archivedCount: effectiveArchivedCount,
            hotCount: this.messages.length,
            rewoundMessages,
            rewoundBranches: rewoundMessages,
        };
    }

    /**
     * R3: Idempotently re-persists the full in-memory deduplicated message history and metadata
     * to recover from earlier failed incremental writes without losing or duplicating records.
     */
    retryFailedWrites() {
        this._syncFromCoordinator();
        const {messages, maxRevision} = deduplicateMessagesPreservingOrder(this.messages, {
            backend: this.meta.backend || '',
            modelId: '',
        });
        this.messages = messages;
        this._revision = Math.max(this._revision, maxRevision, this._archiveIndex.length + messages.length);
        this.meta.committedRevision = this._revision;
        this.meta.archivedMessageCount = this._archiveIndex.length;
        this.meta.updatedAt = Date.now();
        this._needsLeadingNewlineOnAppend = false;

        this._publishToCoordinator('retry_failed_writes');

        const snapshotMessages = this.messages.map(cloneDeepJson);
        const snapshotMeta = cloneDeepJson(this.meta);
        const targetRev = this._revision;

        return this._enqueueWrite('retry_failed_writes', async () => {
            const jsonlBody = snapshotMessages.map(m => JSON.stringify(m)).join('\n')
                + (snapshotMessages.length ? '\n' : '');
            await this._io.replaceFile(this.jsonlPath, jsonlBody);
            await this._io.replaceFile(this.metaPath, JSON.stringify(snapshotMeta, null, 2));
        }, {
            revision: targetRev,
            isFullSnapshot: true,
        });
    }

    async flush() {
        const activeChain = sharedSessionWriteChains.get(this._coordKey);
        if (activeChain) {
            try {
                await activeChain;
            } catch (_) {}
        }
        this._syncFromCoordinator();
        const isClean = this._failedWrites.size === 0 && !this.lastWriteError;
        return {
            ok: isClean,
            flushed: isClean,
            durableRevision: this._durableRevision,
            committedRevision: this._revision,
            pendingWriteCount: this._pendingWrites.size,
            failedRevisions: this.failedRevisions,
            failedWrites: this.failedWrites,
            hasUnsavedChanges: this.hasUnsavedChanges,
            error: this.lastWriteError ? this.lastWriteError.message : '',
        };
    }

    _enqueueWrite(operation, taskFn, {
        revision = 0,
        messageId = '',
        isFullSnapshot = false,
        isMetaOnly = false,
        isAuxWrite = false,
        dontRecordFailedWriteOnRollback = false,
        onRollback = null,
    } = {}) {
        const writeId = ++this._nextWriteSeq;
        const effectiveRev = Number(revision || this._revision || 0);
        if (!isAuxWrite) {
            this._pendingWrites.set(writeId, {
                writeId,
                operation,
                revision: effectiveRev,
                messageId: String(messageId || ''),
            });
        }

        const prevChain = sharedSessionWriteChains.get(this._coordKey) || Promise.resolve();
        const nextChain = prevChain
            .catch(() => {})
            .then(async () => {
                let lastErr = null;
                const totalAttempts = this._maxWriteRetries + 1;
                for (let attempt = 1; attempt <= totalAttempts; attempt++) {
                    try {
                        await taskFn();
                        this._pendingWrites.delete(writeId);

                        if (isFullSnapshot) {
                            // Full snapshot write durably commits all messages up to effectiveRev
                            for (const [k, item] of this._failedWrites.entries()) {
                                if (!item.revision || item.revision <= effectiveRev) {
                                    this._failedWrites.delete(k);
                                }
                            }
                            if (this._failedWrites.size === 0) {
                                this.lastWriteError = null;
                                this._durableRevision = Math.max(this._durableRevision, effectiveRev);
                            }
                        } else if (!isAuxWrite && !isMetaOnly) {
                            // R3: Incremental write success MUST NOT clear earlier unresolved failedWrites!
                            if (this._failedWrites.size === 0) {
                                this.lastWriteError = null;
                                this._durableRevision = Math.max(this._durableRevision, effectiveRev);
                            }
                        } else if (isMetaOnly && this._failedWrites.size === 0) {
                            this.lastWriteError = null;
                        }

                        const coord = sharedSessionCoordinatorState.get(this._coordKey);
                        if (coord && this._durableRevision > (coord.durableRevision || 0)) {
                            coord.durableRevision = this._durableRevision;
                        }
                        return {
                            ok: true,
                            durableRevision: this._durableRevision,
                            hasUnsavedChanges: this.hasUnsavedChanges,
                        };
                    } catch (err) {
                        lastErr = err;
                        if (attempt < totalAttempts) {
                            await sleepMs(this._retryDelayMs * attempt);
                        }
                    }
                }

                this._pendingWrites.delete(writeId);
                let rolledBack = false;
                if (typeof onRollback === 'function') {
                    try {
                        onRollback();
                        rolledBack = true;
                    } catch (_) {}
                }

                const errMsg = lastErr?.message || String(lastErr || '未知磁盘写入错误');
                const failEntry = {
                    key: effectiveRev > 0 ? `rev:${effectiveRev}` : `op:${writeId}`,
                    operation,
                    revision: effectiveRev,
                    messageId: String(messageId || ''),
                    message: errMsg,
                    error: lastErr,
                    timestamp: Date.now(),
                };
                if (!dontRecordFailedWriteOnRollback || !rolledBack) {
                    this._failedWrites.set(failEntry.key, failEntry);
                    this.lastWriteError = {
                        operation,
                        revision: effectiveRev,
                        messageId: String(messageId || ''),
                        message: errMsg,
                        timestamp: failEntry.timestamp,
                    };
                }
                console.warn(`[Quick Chat] 会话保存失败 (${this.sessionId} / ${operation}): ${errMsg}`);
                try {
                    this._onSaveError?.({
                        sessionId: this.sessionId,
                        operation,
                        revision: effectiveRev,
                        messageId: String(messageId || ''),
                        message: `历史未保存：${errMsg}`,
                        error: lastErr,
                    });
                } catch (_) {}
                return {
                    ok: false,
                    error: lastErr,
                    rolledBack,
                    failedRevisions: this.failedRevisions,
                };
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

/**
 * Builds a clean continuation prompt anchored to the tail of a partial/truncated assistant message (Stage F3).
 */
export function buildContinuationPrompt(partialAssistantText = '') {
    const clean = String(partialAssistantText || '').trim();
    if (!clean) {
        return '请继续完成上一条未完成的回答。';
    }
    const tailSnippet = clean.slice(-140).replace(/\s+/g, ' ');
    return `请紧接上一条未完成的回答末尾继续输出剩余内容（无需重复上文，上一条末尾为：「${tailSnippet}」）。`;
}

function extractReadableMessageBody(msg) {
    if (!msg) return '';
    if (typeof msg.displayText === 'string' && msg.displayText.trim()) {
        return msg.displayText.trim();
    }
    if (typeof msg.text === 'string') {
        return msg.text.trim();
    }
    if (typeof msg.content === 'string') {
        return msg.content.trim();
    }
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter(p => p && p.type === 'text')
            .map(p => String(p.text || ''))
            .join('\n')
            .trim();
    }
    return '';
}

export function formatSessionByteSize(bytes = 0) {
    const n = Math.max(0, Number(bytes) || 0);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Exports a session's conversation messages as clean Markdown or JSON (Stage F3, F4 & R8).
 * By default (`includeRewound = false`), exports ONLY the current active logical conversation
 * (`archive.jsonl` + `messages.jsonl`) and excludes rewound/edited history branches.
 */
export function exportSessionFormatted(messagesOrOptions = [], meta = {}, options = {}) {
    const isSingleObjectCall =
        messagesOrOptions &&
        typeof messagesOrOptions === 'object' &&
        !Array.isArray(messagesOrOptions);
    const messages = isSingleObjectCall ? (messagesOrOptions.messages || []) : messagesOrOptions;
    const effectiveMeta = isSingleObjectCall ? (messagesOrOptions.meta || {}) : (meta || {});
    const {
        sessionId = '',
        format = 'markdown',
        exportedAtIso = new Date().toISOString(),
        includeRewound = false,
        rewoundMessages = [],
        archivedCount = 0,
    } = isSingleObjectCall ? messagesOrOptions : (options || {});

    const validMsgs = (Array.isArray(messages) ? messages : [])
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && (!isRewoundRecord(m) || includeRewound));
    const validRewound = includeRewound
        ? (Array.isArray(rewoundMessages) ? rewoundMessages : [])
            .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
        : [];
    const effectiveArchivedCount = Math.max(0, Number(archivedCount ?? effectiveMeta?.archivedMessageCount ?? 0));

    if (format === 'json') {
        return JSON.stringify({
            exportedAt: exportedAtIso,
            sessionId: String(sessionId || ''),
            backend: String(effectiveMeta?.backend || ''),
            exportScope: includeRewound ? 'full_with_rewound_branches' : 'active_logical_history_only',
            includesRewoundBranches: Boolean(includeRewound),
            archivedMessageCount: effectiveArchivedCount,
            messageCount: validMsgs.length,
            messages: validMsgs.map(m => ({
                id: m.id || '',
                revision: Number(m.revision || 0),
                role: m.role,
                text: extractReadableMessageBody(m),
                createdAt: m.createdAt || '',
                backend: m.backend || '',
                modelId: m.modelId || '',
                ...(m.selectedModelId ? {selectedModelId: m.selectedModelId} : {}),
                ...(m.reportedModelId ? {reportedModelId: m.reportedModelId} : {}),
                status: m.status || 'completed',
                ...(m.partial ? {partial: true} : {}),
                ...(m.finishReason ? {finishReason: m.finishReason} : {}),
            })),
            ...(includeRewound
                ? {
                    rewoundBranches: validRewound.map(m => ({
                        id: m.id || '',
                        revision: Number(m.revision || 0),
                        role: m.role,
                        text: extractReadableMessageBody(m),
                        createdAt: m.createdAt || '',
                        rewoundAt: m.rewoundAt || '',
                        rewindFromMessageId: m.rewindFromMessageId || '',
                    })),
                }
                : {}),
        }, null, 2);
    }

    const scopeDesc = includeRewound
        ? '包含当前逻辑会话及已撤销/替换的历史分支'
        : '当前逻辑会话完整有效历史（不含已撤销/编辑替换的旧分支）';
    const countDesc = effectiveArchivedCount > 0
        ? `${validMsgs.length}（含已归档 ${effectiveArchivedCount} 条）`
        : `${validMsgs.length}`;

    const lines = [
        '# Quick Chat（随问）对话导出',
        '',
        `- 会话 ID：\`${sessionId || 'current'}\``,
        `- 导出时间：${exportedAtIso}`,
        `- 导出范围：${scopeDesc}`,
        `- 消息数量：${countDesc}`,
        '',
        '---',
        '',
    ];

    for (const m of validMsgs) {
        const speaker = m.role === 'user'
            ? '🙋 我'
            : `✦ ${m.modelId || m.backend || '助手'}`;
        const timeTag = m.createdAt ? ` (${m.createdAt})` : '';
        const statusTag = m.partial
            ? ' [未完成/已截断]'
            : (m.finishReason === 'length' ? ' [达到长度上限]' : '');
        lines.push(`### ${speaker}${timeTag}${statusTag}`);
        lines.push('');
        lines.push(extractReadableMessageBody(m) || '（无正文）');
        lines.push('');
    }

    if (includeRewound && validRewound.length > 0) {
        lines.push('---');
        lines.push('');
        lines.push('## 附：已撤销/替换的历史分支（不参与当前对话上下文）');
        lines.push('');
        for (const m of validRewound) {
            const speaker = m.role === 'user'
                ? '🙋 我 [已撤销分支]'
                : `✦ ${m.modelId || m.backend || '助手'} [已撤销分支]`;
            const timeTag = m.createdAt ? ` (${m.createdAt})` : '';
            lines.push(`### ${speaker}${timeTag}`);
            lines.push('');
            lines.push(extractReadableMessageBody(m) || '（无正文）');
            lines.push('');
        }
    }
    return lines.join('\n');
}

/**
 * Lists valid stored session directories under `sessionsRootDir` sorted newest-first (Stage F4 & R8).
 * Computes both active logical message count (`hot + archived`) and total disk byte usage (`totalBytes`, `formattedSize`).
 */
export async function inspectSessionsWithIo(sessionsRootDir, io) {
    if (!sessionsRootDir || !io || typeof io.listDir !== 'function') return [];
    let entries = [];
    try {
        entries = await io.listDir(sessionsRootDir);
    } catch (_) {
        return [];
    }

    const sessions = [];
    for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : String(entry?.name || '');
        const isDir = typeof entry === 'object' ? Boolean(entry?.isDir) : true;
        const isSymlink = typeof entry === 'object' ? Boolean(entry?.isSymlink) : false;
        if (!name || !isDir || isSymlink) continue;

        let paths = null;
        try {
            paths = resolveSafeSessionPaths(sessionsRootDir, name);
        } catch (_) {
            continue;
        }

        let updatedAt = 0;
        let backend = '';
        let hotMessageCount = 0;
        let archivedMessageCount = 0;
        let previewTitle = '';
        let totalBytes = 0;

        try {
            if (await io.exists(paths.metaPath)) {
                const metaRaw = String((await io.readText(paths.metaPath, MAX_SESSION_META_BYTES)) || '');
                totalBytes += UTF8_ENCODER.encode(metaRaw).byteLength;
                const metaObj = JSON.parse(metaRaw);
                if (metaObj && typeof metaObj === 'object') {
                    updatedAt = Number(metaObj.updatedAt || 0);
                    backend = String(metaObj.backend || '');
                    archivedMessageCount = Math.max(0, Number(metaObj.archivedMessageCount || 0));
                }
            }
        } catch (_) {}

        try {
            if (await io.exists(paths.archivePath)) {
                const archRaw = String((await io.readText(paths.archivePath, MAX_SESSION_ARCHIVE_FILE_BYTES)) || '');
                totalBytes += UTF8_ENCODER.encode(archRaw).byteLength;
                const archLines = archRaw.split(/\r?\n/).filter(l => l.trim().length > 0);
                let activeArchCount = 0;
                for (const line of archLines) {
                    try {
                        const obj = JSON.parse(line);
                        if (obj && !isRewoundRecord(obj)) {
                            activeArchCount++;
                            if (!previewTitle && obj.role === 'user') {
                                const body = extractReadableMessageBody(obj).replace(/\s+/g, ' ');
                                if (body) {
                                    previewTitle = body.length > 28 ? `${body.slice(0, 28)}…` : body;
                                }
                            }
                        }
                    } catch (_) {}
                }
                archivedMessageCount = Math.max(archivedMessageCount, activeArchCount);
            }
        } catch (_) {}

        try {
            if (await io.exists(paths.jsonlPath)) {
                const hotRaw = String((await io.readText(paths.jsonlPath, MAX_SESSION_HOT_FILE_BYTES)) || '');
                totalBytes += UTF8_ENCODER.encode(hotRaw).byteLength;
                const rawLines = hotRaw
                    .split(/\r?\n/)
                    .filter(l => l.trim().length > 0);
                hotMessageCount = rawLines.length;
                for (const line of rawLines) {
                    if (previewTitle) break;
                    try {
                        const obj = JSON.parse(line);
                        if (obj?.role === 'user') {
                            const body = extractReadableMessageBody(obj).replace(/\s+/g, ' ');
                            if (body) {
                                previewTitle = body.length > 28 ? `${body.slice(0, 28)}…` : body;
                                break;
                            }
                        }
                    } catch (_) {}
                }
                if (!updatedAt && typeof io.statMtimeMs === 'function') {
                    updatedAt = await io.statMtimeMs(paths.jsonlPath);
                }
            }
        } catch (_) {}

        for (const auxPath of [paths.rewoundPath, paths.corruptPath, `${paths.jsonlPath}.corrupt-backup`]) {
            try {
                if (auxPath && (await io.exists(auxPath))) {
                    const auxRaw = String((await io.readText(auxPath, MAX_SESSION_REWOUND_FILE_BYTES)) || '');
                    totalBytes += UTF8_ENCODER.encode(auxRaw).byteLength;
                }
            } catch (_) {}
        }

        const messageCount = hotMessageCount + archivedMessageCount;
        if (messageCount > 0 || updatedAt > 0) {
            sessions.push({
                sessionId: paths.sessionId,
                updatedAt: updatedAt || 0,
                backend,
                hotMessageCount,
                archivedMessageCount,
                messageCount,
                totalBytes,
                formattedSize: formatSessionByteSize(totalBytes),
                preview: previewTitle || paths.sessionId.slice(0, 8),
                previewTitle: previewTitle || paths.sessionId.slice(0, 8),
            });
        }
    }

    sessions.sort((a, b) => (b.updatedAt - a.updatedAt) || b.sessionId.localeCompare(a.sessionId));
    return sessions;
}

/**
 * Resolves the single best previous session to restore (`恢复上一个会话`, Stage F4).
 * Supports both options object `(sessions, {currentSessionId, preferredPreviousId})`
 * and positional arguments `(sessions, currentSessionId, preferredPreviousId)`.
 */
export function resolvePreviousSessionId(sessions = [], optionsOrCurrentId = {}, maybePreferredId = '') {
    const list = Array.isArray(sessions) ? sessions : [];
    const currentSessionId = typeof optionsOrCurrentId === 'string'
        ? optionsOrCurrentId
        : String(optionsOrCurrentId?.currentSessionId || '');
    const preferredPreviousId = typeof optionsOrCurrentId === 'string'
        ? String(maybePreferredId || '')
        : String(optionsOrCurrentId?.preferredPreviousId || '');

    const cleanPreferred = String(preferredPreviousId || '').trim();
    if (cleanPreferred && cleanPreferred !== currentSessionId) {
        const hit = list.find(s => s.sessionId === cleanPreferred && s.messageCount > 0);
        if (hit) return hit.sessionId;
    }
    const latestOther = list.find(s => s.sessionId !== currentSessionId && s.messageCount > 0);
    return latestOther ? latestOther.sessionId : '';
}

/**
 * Plans bounded retention cleanup for old sessions WITHOUT deleting anything automatically!
 * Actual deletion requires explicit user confirmation after displaying size & retention policy (Stage F4 & R8).
 */
export function planSessionRetentionCleanup(sessions = [], {
    currentSessionId = '',
    previousSessionId = '',
    maxCount = undefined,
    maxSessions = undefined,
    maxAgeDays = 30,
    nowMs = Date.now(),
} = {}) {
    const effectiveMax = maxCount ?? maxSessions ?? 20;
    const safeMaxCount = Math.max(2, Number(effectiveMax) || 20);
    const safeMaxAgeDays = Math.max(1, Number(maxAgeDays) || 30);
    const cutoffMs = nowMs - safeMaxAgeDays * 24 * 60 * 60 * 1000;
    const protectedSet = new Set([currentSessionId, previousSessionId].filter(Boolean));

    const sorted = [...(Array.isArray(sessions) ? sessions : [])]
        .sort((a, b) => (b.updatedAt - a.updatedAt) || b.sessionId.localeCompare(a.sessionId));

    const keep = [];
    const candidatesToDelete = [];
    const unprotected = [];

    for (const s of sorted) {
        if (!s?.sessionId) continue;
        if (protectedSet.has(s.sessionId)) {
            keep.push(s);
        } else {
            unprotected.push(s);
        }
    }

    const remainingSlots = Math.max(0, safeMaxCount - keep.length);
    let unprotectedKept = 0;

    for (const s of unprotected) {
        const expiredByAge = s.updatedAt > 0 && s.updatedAt < cutoffMs;
        const expiredByCount = unprotectedKept >= remainingSlots;
        if (expiredByAge || expiredByCount) {
            const bytes = Math.max(0, Number(s.totalBytes || 0));
            candidatesToDelete.push({
                ...s,
                totalBytes: bytes,
                formattedSize: s.formattedSize || formatSessionByteSize(bytes),
                reason: expiredByAge ? `超过 ${safeMaxAgeDays} 天` : `超出保留上限 ${safeMaxCount} 个`,
            });
        } else {
            keep.push(s);
            unprotectedKept++;
        }
    }

    keep.sort((a, b) => (b.updatedAt - a.updatedAt) || b.sessionId.localeCompare(a.sessionId));

    const candidateTotalBytes = candidatesToDelete.reduce((sum, item) => sum + Math.max(0, Number(item.totalBytes || 0)), 0);
    const totalStoredBytes = sorted.reduce((sum, item) => sum + Math.max(0, Number(item?.totalBytes || 0)), 0);
    const candidateSizeSummary = formatSessionByteSize(candidateTotalBytes);
    const totalStoredSizeSummary = formatSessionByteSize(totalStoredBytes);

    return {
        keep,
        candidatesToDelete,
        candidateTotalBytes,
        candidateSizeSummary,
        totalStoredBytes,
        totalStoredSizeSummary,
        requiresExplicitUserConsent: true,
        policySummary: `最多保留最近 ${safeMaxCount} 个会话、${safeMaxAgeDays} 天内记录（待清理 ${candidatesToDelete.length} 个，共 ${candidateSizeSummary}）`,
    };
}

/**
 * Safely deletes a single validated session directory inside `sessionsRootDir` (Stage F4).
 */
export async function deleteSessionDirectoryWithIo(sessionsRootDir, sessionId, io, {
    protectedIds = [],
} = {}) {
    let paths;
    try {
        paths = resolveSafeSessionPaths(sessionsRootDir, sessionId);
    } catch (err) {
        return {ok: false, error: err.message};
    }
    if (Array.isArray(protectedIds) && protectedIds.includes(paths.sessionId)) {
        return {ok: false, error: '不能在保护模式下删除当前正在运行的会话'};
    }

    const coordKey = `${paths.rootDir}::${paths.sessionId}`;
    const pending = sharedSessionWriteChains.get(coordKey);
    if (pending) {
        try { await pending; } catch (_) {}
    }
    sharedSessionCoordinatorState.delete(coordKey);

    const knownFiles = [
        paths.jsonlPath,
        `${paths.jsonlPath}.corrupt-backup`,
        paths.metaPath,
        paths.archivePath,
        paths.rewoundPath,
        paths.corruptPath,
        paths.legacyPath,
    ];
    try {
        for (const fp of knownFiles) {
            await io.unlink?.(fp);
        }
        await io.rmdir?.(paths.dir);
    } catch (err) {
        return {
            ok: false,
            sessionId: paths.sessionId,
            error: `删除会话未完成，请核查剩余文件：${err?.message || err}`,
        };
    }
    return {ok: true, sessionId: paths.sessionId};
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
        importedCount: engine.totalLogicalMessageCount,
        error: '',
    };
}
