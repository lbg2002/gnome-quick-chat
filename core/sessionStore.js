import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getLegacySessionFile, getSessionDir, getSessionsDir} from './paths.js';
import {
    isLegacyPiSessionMeta,
    parseLegacyPiSessionContent,
} from './configMigration.js';
import {
    buildBudgetedContextMessages,
    buildCrossBackendPromptWithContext,
    buildModelSignature,
} from '../protocol.js';

export {
    buildBudgetedContextMessages,
    buildCrossBackendPromptWithContext,
    buildModelSignature,
};

const Decoder = new TextDecoder('utf-8');
const Encoder = new TextEncoder();

const MAX_DISK_MESSAGES = 200;

function readFileAsync(filePath) {
    const file = Gio.File.new_for_path(filePath);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (src, res) => {
            try {
                const [ok, bytes] = src.load_contents_finish(res);
                if (!ok || !bytes) {
                    resolve('');
                    return;
                }
                resolve(Decoder.decode(bytes));
            } catch (err) {
                reject(err);
            }
        });
    });
}

function replaceFileAsync(filePath, contentStr) {
    const parent = GLib.path_get_dirname(filePath);
    GLib.mkdir_with_parents(parent, 0o700);
    const file = Gio.File.new_for_path(filePath);
    const bytes = new GLib.Bytes(Encoder.encode(contentStr));
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
            (src, res) => {
                try {
                    src.replace_contents_finish(res);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }
        );
    });
}

function appendLineAsync(filePath, lineStr) {
    const parent = GLib.path_get_dirname(filePath);
    GLib.mkdir_with_parents(parent, 0o700);
    const file = Gio.File.new_for_path(filePath);
    const bytes = Encoder.encode(lineStr.endsWith('\n') ? lineStr : `${lineStr}\n`);
    return new Promise((resolve, reject) => {
        file.append_to_async(
            Gio.FileCreateFlags.PRIVATE,
            GLib.PRIORITY_DEFAULT,
            null,
            (src, res) => {
                let outStream;
                try {
                    outStream = src.append_to_finish(res);
                } catch (err) {
                    reject(err);
                    return;
                }
                outStream.write_all_async(bytes, GLib.PRIORITY_DEFAULT, null, (stream, wRes) => {
                    try {
                        stream.write_all_finish(wRes);
                        stream.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                        resolve();
                    } catch (err) {
                        try { stream.close_async(GLib.PRIORITY_DEFAULT, null, () => {}); } catch (_) {}
                        reject(err);
                    }
                });
            }
        );
    });
}

export function listLegacyPiSessionFiles() {
    const sessionsDir = getSessionsDir();
    if (!GLib.file_test(sessionsDir, GLib.FileTest.IS_DIR)) return [];
    const found = [];
    try {
        const dir = GLib.Dir.open(sessionsDir, 0);
        let name;
        while ((name = dir.read_name()) !== null) {
            if (!name.endsWith('.jsonl')) continue;
            const fullPath = GLib.build_filenamev([sessionsDir, name]);
            if (!GLib.file_test(fullPath, GLib.FileTest.IS_DIR)) {
                found.push({name, path: fullPath});
            }
        }
        dir.close();
    } catch (_) {}
    found.sort((a, b) => b.name.localeCompare(a.name));
    return found;
}

export async function importLegacyPiSessionFileReadOnly(sourceFilePath, targetSessionId = '') {
    if (!sourceFilePath || !GLib.file_test(sourceFilePath, GLib.FileTest.EXISTS)) {
        return {ok: false, sessionId: '', importedCount: 0, error: '指定的旧会话文件不存在'};
    }
    let raw = '';
    try {
        raw = await readFileAsync(sourceFilePath);
    } catch (err) {
        return {ok: false, sessionId: '', importedCount: 0, error: `读取旧会话失败：${err.message}`};
    }
    const parsed = parseLegacyPiSessionContent(raw);
    if (!parsed.ok) {
        return {ok: false, sessionId: '', importedCount: 0, error: parsed.error};
    }
    const newSessionId = targetSessionId || GLib.uuid_string_random();
    const store = new SessionStore(newSessionId);
    store.messages = parsed.messages.slice(-MAX_DISK_MESSAGES);
    store.meta = {
        backend: '',
        modelSignature: '',
        remoteSessionId: '',
        updatedAt: Date.now(),
        importedFromLegacyPi: true,
    };
    await store._enqueueWrite(async () => {
        await store._writeMetaNow();
        await store._rewriteAllMessagesNow();
    });
    return {
        ok: true,
        sessionId: newSessionId,
        importedCount: store.messages.length,
        error: '',
    };
}

/**
 * Async JSONL + meta.json session store.
 * Layout:
 *   sessions/<sessionId>/meta.json
 *   sessions/<sessionId>/messages.jsonl
 */
export class SessionStore {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.dir = getSessionDir(sessionId);
        this.metaPath = GLib.build_filenamev([this.dir, 'meta.json']);
        this.jsonlPath = GLib.build_filenamev([this.dir, 'messages.jsonl']);
        this.legacyPath = getLegacySessionFile(sessionId);

        this.meta = {
            backend: '',
            modelSignature: '',
            remoteSessionId: '',
            updatedAt: 0,
        };
        this.messages = [];
        this._writeChain = Promise.resolve();
        this._loaded = false;
    }

    async load(currentBackend, currentConfig) {
        if (this._loaded) return;
        const currentSig = currentBackend && currentBackend !== 'unconfigured'
            ? buildModelSignature(currentBackend, currentConfig)
            : '';

        // 1. Try modern meta.json + messages.jsonl
        if (GLib.file_test(this.metaPath, GLib.FileTest.EXISTS) || GLib.file_test(this.jsonlPath, GLib.FileTest.EXISTS)) {
            try {
                if (GLib.file_test(this.metaPath, GLib.FileTest.EXISTS)) {
                    const metaRaw = await readFileAsync(this.metaPath);
                    if (metaRaw) {
                        const parsed = JSON.parse(metaRaw);
                        this.meta = {...this.meta, ...parsed};
                    }
                }
                if (GLib.file_test(this.jsonlPath, GLib.FileTest.EXISTS)) {
                    const linesRaw = await readFileAsync(this.jsonlPath);
                    const loaded = [];
                    for (const line of linesRaw.split('\n')) {
                        const t = line.trim();
                        if (!t) continue;
                        try {
                            loaded.push(JSON.parse(t));
                        } catch (_) {}
                    }
                    this.messages = loaded;
                }
            } catch (err) {
                console.warn(`[Quick Chat] Failed to load session ${this.sessionId}: ${err.message}`);
            }
        } else if (GLib.file_test(this.legacyPath, GLib.FileTest.EXISTS)) {
            // 2. Migrate legacy <sessionId>.qc.json transparently
            try {
                const raw = await readFileAsync(this.legacyPath);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    this.meta = {
                        backend: parsed.backend || '',
                        modelSignature: parsed.modelSignature || '',
                        remoteSessionId: parsed.remoteSessionId || '',
                        updatedAt: parsed.updatedAt || Date.now(),
                    };
                    if (Array.isArray(parsed.messages)) {
                        this.messages = parsed.messages.slice(-MAX_DISK_MESSAGES);
                    }
                    this._enqueueWrite(async () => {
                        await this._writeMetaNow();
                        await this._rewriteAllMessagesNow();
                        try { GLib.unlink(this.legacyPath); } catch (_) {}
                    });
                }
            } catch (err) {
                console.warn(`[Quick Chat] Legacy session migration warning: ${err.message}`);
            }
        }

        // Never treat a legacy Pi session ID as a ZCode or Codex remote session ID
        if (isLegacyPiSessionMeta(this.meta)) {
            this.meta.remoteSessionId = '';
        }

        // Verify signature match for remoteSessionId reuse
        if (!currentSig || (this.meta.modelSignature && this.meta.modelSignature !== currentSig)) {
            this.meta.remoteSessionId = '';
        }
        if (currentBackend && currentBackend !== 'unconfigured') {
            this.meta.backend = currentBackend;
            this.meta.modelSignature = currentSig;
        }
        this._loaded = true;
    }

    get remoteSessionId() {
        return this.meta.remoteSessionId || '';
    }

    setRemoteSessionId(remoteId, backend, config) {
        const clean = String(remoteId || '').trim();
        if (this.meta.remoteSessionId === clean) return;
        this.meta.remoteSessionId = clean;
        this.meta.backend = backend;
        this.meta.modelSignature = buildModelSignature(backend, config);
        this.meta.updatedAt = Date.now();
        this._enqueueWrite(() => this._writeMetaNow());
    }

    appendMessage(message, backend, config) {
        const record = {...message, ts: Date.now()};
        this.messages.push(record);
        this.meta.backend = backend;
        this.meta.modelSignature = buildModelSignature(backend, config);
        this.meta.updatedAt = record.ts;

        const needsCompaction = this.messages.length > MAX_DISK_MESSAGES;
        if (needsCompaction) {
            this.messages = this.messages.slice(-Math.floor(MAX_DISK_MESSAGES * 0.8));
        }

        this._enqueueWrite(async () => {
            await this._writeMetaNow();
            if (needsCompaction) {
                await this._rewriteAllMessagesNow();
            } else {
                await appendLineAsync(this.jsonlPath, JSON.stringify(record));
            }
        });
    }

    _enqueueWrite(taskFn) {
        this._writeChain = this._writeChain
            .then(() => taskFn())
            .catch(err => {
                console.warn(`[Quick Chat] Async session save error: ${err.message}`);
            });
        return this._writeChain;
    }

    async _writeMetaNow() {
        await replaceFileAsync(this.metaPath, JSON.stringify(this.meta, null, 2));
    }

    async _rewriteAllMessagesNow() {
        const content = this.messages.map(m => JSON.stringify(m)).join('\n') + (this.messages.length ? '\n' : '');
        await replaceFileAsync(this.jsonlPath, content);
    }
}
