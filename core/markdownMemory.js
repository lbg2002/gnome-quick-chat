import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {getDataDir, readFileBytesBoundedAsync} from './paths.js';

const INDEX = 'MEMORY.md';
const MAX_NOTE_BYTES = 8192;
const MAX_CHANGES = 6;
const MAX_JOURNAL_BYTES = 160 * 1024;
const TOPIC = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.md$/;
const SCOPES = ['computer', 'project'];
const encoder = new TextEncoder();
let queue = Promise.resolve();

export function getMemoryDirectory() {
    return GLib.build_filenamev([getDataDir(), 'memory']);
}

function checksum(text) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
}

function serial(operation) {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
}

function parse(text) {
    const raw = text.trim().replace(/^\x60{3}(?:json)?\s*\n([\s\S]*?)\n\x60{3}$/, '$1');
    if (raw.length > 65536) throw new Error('记忆响应过长');
    const result = JSON.parse(raw);
    if (!Array.isArray(result)) throw new Error('记忆响应须为数组');
    return result;
}

function topicLinks(markdown) {
    return new Set([...(markdown || '').matchAll(/\]\(([a-zA-Z0-9_-]+\.md)\)/g)]
        .map(match => match[1]).filter(name => name !== INDEX && TOPIC.test(name)));
}

const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('zh', {granularity: 'word'})
    : null;
const searchStopWords = new Set(['继续', '上次', '那个', '这个', '一下', '最近', '帮我', '记住', '忘记', '以后',
    '请问', 'the', 'and', 'that', 'this', 'with', 'please', 'test']);

function memorySearchTerms(query) {
    const text = String(query || '').normalize('NFKC').toLowerCase().replace(/_/g, ' ');
    const terms = new Set();
    let previousHan = '';
    // Older GJS has no Intl.Segmenter. Keep Latin words and treat adjacent Han characters as search terms.
    const segments = segmenter
        ? [...segmenter.segment(text)].map(({segment}) => segment)
        : text.match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}])+|[^\p{L}\p{N}]/gu) || [];
    for (const segment of segments) {
        if (/^\p{Script=Han}$/u.test(segment)) {
            const pair = previousHan + segment;
            if (previousHan && !searchStopWords.has(pair)) terms.add(pair);
            previousHan = segment;
            continue;
        }
        previousHan = '';
        if (/[\p{L}\p{N}]/u.test(segment) && segment.length >= 2 && !searchStopWords.has(segment)) {
            terms.add(segment);
        }
    }
    return [...terms].slice(0, 24);
}

function countMatches(text, terms) {
    const normalized = text.normalize('NFKC').toLowerCase();
    return terms.filter(term => normalized.includes(term)).length;
}

export function excerptMemoryNote(markdown, query) {
    const limit = 1000;
    if (markdown.length <= limit) return markdown;
    const terms = memorySearchTerms(query);
    const lines = markdown.split('\n');
    let start = 0;
    let offset = 0;
    let best = 0;
    for (const line of lines) {
        const score = countMatches(line, terms);
        if (score > best) {
            start = Math.max(0, offset - 150);
            best = score;
        }
        offset += line.length + 1;
    }
    return (start ? '…\n' : '') + markdown.slice(start, start + limit) +
        (start + limit < markdown.length ? '\n…' : '');
}

async function read(path, limit = MAX_NOTE_BYTES) {
    if (GLib.file_test(path, GLib.FileTest.IS_SYMLINK)) throw new Error('记忆文件不能是符号链接');
    const result = await readFileBytesBoundedAsync(path, limit);
    if (result.bytes) return new TextDecoder('utf-8', {fatal: true}).decode(result.bytes);
    if (!result.exists && !result.error) return null;
    if (!result.exists && !GLib.file_test(path, GLib.FileTest.EXISTS)) return null;
    throw new Error('无法读取记忆文件');
}

function replace(path, text) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(new GLib.Bytes(encoder.encode(text)), null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, (_, result) => {
                try { file.replace_contents_finish(result); resolve(); }
                catch (error) { reject(error); }
            });
    });
}

function ensureDirectory(path) {
    if (GLib.file_test(path, GLib.FileTest.IS_SYMLINK)) throw new Error('记忆目录不能是符号链接');
    if (GLib.mkdir_with_parents(path, 0o700) !== 0) throw new Error('无法创建记忆目录');
}

export class MemoryEditError extends Error {}

export class MarkdownMemory {
    constructor(workspace, root = getMemoryDirectory()) {
        this.root = root;
        this.projectId = checksum(GLib.canonicalize_filename(workspace || '.', null));
        this.projects = GLib.build_filenamev([root, 'projects']);
        this.directories = {computer: root, project: GLib.build_filenamev([this.projects, this.projectId])};
        this.journal = GLib.build_filenamev([root, '.pending']);
    }

    path(scope, name, projectId = this.projectId) {
        if (!SCOPES.includes(scope) || !TOPIC.test(name) || !/^[a-f0-9]{64}$/.test(projectId)) {
            throw new Error('无效的记忆地址');
        }
        const directory = scope === 'computer' ? this.root : GLib.build_filenamev([this.projects, projectId]);
        for (const parent of scope === 'computer' ? [this.root] : [this.root, this.projects, directory]) {
            if (GLib.file_test(parent, GLib.FileTest.IS_SYMLINK)) throw new Error('记忆目录不能是符号链接');
        }
        return GLib.build_filenamev([directory, name]);
    }

    archiveJournal(kind) {
        const archive = GLib.build_filenamev([this.root, '.' + kind + '-' + GLib.uuid_string_random()]);
        Gio.File.new_for_path(this.journal).move(Gio.File.new_for_path(archive),
            Gio.FileCopyFlags.NOFOLLOW_SYMLINKS, null, null);
        return false;
    }

    async recover() {
        this.path('computer', INDEX);
        let entries;
        try {
            const pending = await read(this.journal, MAX_JOURNAL_BYTES);
            if (pending === null) return;
            const {projectId, edits} = JSON.parse(pending);
            if (typeof projectId !== 'string' || !/^[a-f0-9]{64}$/.test(projectId) ||
                !Array.isArray(edits) || !edits.length || edits.length > MAX_CHANGES ||
                edits.some(edit => !edit || !SCOPES.includes(edit.scope) ||
                    typeof edit.name !== 'string' || !TOPIC.test(edit.name) || edit.markdown === '' ||
                    [edit.before, edit.markdown].some(value => value !== null &&
                        (typeof value !== 'string' || value.includes('\0') || encoder.encode(value).length > MAX_NOTE_BYTES))) ||
                new Set(edits.map(({scope, name}) => scope + '/' + name)).size !== edits.length) {
                throw new Error('无效的记忆事务');
            }
            entries = edits.map(({scope, name, before, markdown}) => ({scope, name, before, markdown, projectId}));
        } catch (_) {
            return this.archiveJournal('invalid');
        }
        const pendingEdits = [];
        for (const {scope, name, before, markdown, projectId} of entries) {
            let path, current;
            try {
                path = this.path(scope, name, projectId);
                current = await read(path);
            } catch (_) {
                return this.archiveJournal('conflict');
            }
            if (current === markdown) continue;
            if (current !== before) return this.archiveJournal('conflict');
            pendingEdits.push({path, markdown});
        }
        for (const {path, markdown} of pendingEdits) {
            if (markdown === null) Gio.File.new_for_path(path).delete(null);
            else await replace(path, markdown);
        }
        Gio.File.new_for_path(this.journal).delete(null);
        return true;
    }

    snapshot() {
        return serial(async () => {
            await this.recover();
            const indexes = {};
            const notes = new Map();
            for (const scope of SCOPES) {
                const markdown = await read(this.path(scope, INDEX));
                indexes[scope] = markdown;
                for (const name of [...topicLinks(markdown)].slice(0, 48)) {
                    notes.set(`memory://${scope}/${name}`, {scope, name});
                }
            }
            return {indexes, notes};
        });
    }

    recall(snapshot, response) {
        return serial(async () => {
            await this.recover();
            const result = new Map();
            for (const address of [...new Set(parse(response))].slice(0, 3)) {
                const note = snapshot.notes.get(address);
                if (!note) continue;
                const markdown = await read(this.path(note.scope, note.name));
                if (markdown !== null) result.set(address, markdown);
            }
            return result;
        });
    }

    search(snapshot, query, {previousReferences = [], isCurrent = () => true} = {}) {
        const terms = memorySearchTerms(query);
        const followup = /这次|临时|以后|改用|纠正|忘掉|记错|上条|temporar|correct|instead|forget/i.test(query);
        const prior = new Set(followup ? previousReferences : []);
        if (!terms.length && !prior.size) return Promise.resolve(new Map());

        return serial(async () => {
            await this.recover();
            const matches = [];
            const indexLines = Object.fromEntries(SCOPES.map(scope =>
                [scope, (snapshot.indexes[scope] || '').split('\n')]));
            for (const [address, {scope, name}] of snapshot.notes) {
                if (!isCurrent()) return new Map();
                const subject = [name, ...indexLines[scope].filter(line => line.includes('](' + name + ')'))].join(' ');
                let markdown;
                try {
                    markdown = await read(this.path(scope, name));
                } catch (error) {
                    if (prior.has(address) || countMatches(subject, terms)) throw error;
                    continue;
                }
                if (markdown === null) continue;
                const score = (prior.has(address) ? 100 : 0) + countMatches(subject, terms) * 2 +
                    countMatches(markdown, terms);
                if (score) matches.push({address, markdown, score});
            }
            matches.sort((a, b) => b.score - a.score);
            return new Map(matches.slice(0, 3).map(({address, markdown}) => [address, markdown]));
        });
    }

    async validateIndex(scope, edits, snapshot) {
        const changes = new Map(edits.filter(edit => edit.scope === scope).map(edit => [edit.name, edit]));
        if (!changes.size) return;
        const currentIndex = await read(this.path(scope, INDEX));
        if (currentIndex !== snapshot.indexes[scope]) throw new MemoryEditError('记忆索引已被编辑，请读取最新索引后重试');
        const indexEdit = changes.get(INDEX);
        const links = topicLinks(indexEdit ? indexEdit.markdown : currentIndex);
        if (links.size > 48) throw new MemoryEditError('记忆索引最多链接 48 篇主题，请合并旧主题');
        for (const [name, edit] of changes) {
            if (name === INDEX) continue;
            if (edit.markdown === null && links.has(name)) {
                throw new MemoryEditError('删除主题时，请同时从 MEMORY.md 移除链接：' + name);
            }
            if (edit.markdown !== null && !links.has(name)) {
                throw new MemoryEditError('请在 MEMORY.md 添加主题的相对链接：' + name);
            }
        }
        if (indexEdit) {
            for (const name of links) {
                const target = changes.get(name);
                if ((target ? target.markdown : await read(this.path(scope, name))) === null) {
                    throw new MemoryEditError('MEMORY.md 的主题链接没有对应文件：' + name);
                }
            }
        }
    }

    edit(snapshot, recalled, response, isCurrent) {
        return serial(async () => {
            await this.recover();
            const changes = parse(response);
            if (changes.length > MAX_CHANGES) throw new Error('单次记忆修改过多');
            const edits = [];
            const seen = new Set();
            for (const {scope, name, markdown: requestedMarkdown} of changes) {
                const markdown = requestedMarkdown === '' ? '\n' : requestedMarkdown;
                const path = this.path(scope, name);
                const address = `memory://${scope}/${name}`;
                if (seen.has(path) || (markdown !== null &&
                    (typeof markdown !== 'string' || markdown.includes('\0') || encoder.encode(markdown).length > MAX_NOTE_BYTES))) {
                    throw new Error('无效的记忆修改');
                }
                seen.add(path);
                const before = name === INDEX ? snapshot.indexes[scope] : recalled.get(address) ?? null;
                if (await read(path) !== before) throw new Error('记忆已被编辑，请基于最新版本重试');
                if (before !== markdown) edits.push({scope, name, before, markdown});
            }
            if (!edits.length || !isCurrent()) return [];
            for (const scope of SCOPES) await this.validateIndex(scope, edits, snapshot);
            if (!isCurrent()) return [];
            ensureDirectory(this.root);
            if (edits.some(edit => edit.scope === 'project')) {
                ensureDirectory(this.projects);
                ensureDirectory(this.directories.project);
            }
            const journal = JSON.stringify({projectId: this.projectId, edits});
            if (encoder.encode(journal).length > MAX_JOURNAL_BYTES) throw new Error('记忆事务过长');
            await replace(this.journal, journal);
            if (await this.recover() === false) {
                throw new MemoryEditError('记忆提交遇到冲突或损坏，待恢复内容已归档');
            }
            const committed = edits.map(({scope, name, markdown}) => ({
                address: `memory://${scope}/${name}`,
                kind: markdown === null ? 'deleted' : 'updated',
            }));
            const deleted = new Set(committed.filter(change => change.kind === 'deleted').map(change => change.address));
            for (const {scope, name, before, markdown} of edits) {
                if (name !== INDEX) continue;
                const remaining = topicLinks(markdown);
                for (const topic of topicLinks(before)) {
                    const address = `memory://${scope}/${topic}`;
                    if (!remaining.has(topic) && !deleted.has(address) &&
                        GLib.file_test(this.path(scope, topic), GLib.FileTest.EXISTS)) {
                        committed.push({address, kind: 'unindexed'});
                    }
                }
            }
            return committed;
        });
    }
}
