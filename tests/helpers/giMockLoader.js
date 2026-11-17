import {registerHooks} from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';

let hooksRegistered = false;

const activeTimers = new Map();
let nextTimerId = 1;

export function createMockGLib() {
    return {
        PRIORITY_DEFAULT: 0,
        PRIORITY_DEFAULT_IDLE: 200,
        SOURCE_REMOVE: false,
        SOURCE_CONTINUE: true,
        FileTest: {
            IS_REGULAR: 1 << 0,
            IS_SYMLINK: 1 << 1,
            IS_DIR: 1 << 2,
            IS_EXECUTABLE: 1 << 3,
            EXISTS: 1 << 4,
        },
        UserDirectory: {
            DIRECTORY_DESKTOP: 0,
            DIRECTORY_DOCUMENTS: 1,
            DIRECTORY_DOWNLOAD: 2,
            DIRECTORY_PICTURES: 5,
        },
        Bytes: class Bytes {
            constructor(uint8) {
                this._buf = uint8 instanceof Uint8Array
                    ? Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength)
                    : Buffer.from(uint8 || []);
            }
            get_size() {
                return this._buf.length;
            }
            get_data() {
                return new Uint8Array(this._buf);
            }
            toArray() {
                return new Uint8Array(this._buf);
            }
        },
        get_home_dir: () => process.env.HOME || os.homedir(),
        get_user_data_dir: () => process.env.XDG_DATA_HOME || path.join(process.env.HOME || os.homedir(), '.local', 'share'),
        get_user_config_dir: () => process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || os.homedir(), '.config'),
        get_user_cache_dir: () => process.env.XDG_CACHE_HOME || path.join(process.env.HOME || os.homedir(), '.cache'),
        get_user_runtime_dir: () => process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `qc-runtime-${process.pid}`),
        get_tmp_dir: () => os.tmpdir(),
        get_user_special_dir: () => '',
        getenv: key => process.env[key] ?? null,
        get_environ: () => Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ''}`),
        environ_setenv: (envList, key, val) => {
            const prefix = `${key}=`;
            const filtered = Array.isArray(envList) ? envList.filter(item => !item.startsWith(prefix)) : [];
            filtered.push(`${key}=${val ?? ''}`);
            return filtered;
        },
        build_filenamev: parts => path.join(...parts.map(String)),
        path_get_dirname: p => path.dirname(String(p || '')),
        path_get_basename: p => path.basename(String(p || '')),
        uuid_string_random: () => crypto.randomUUID(),
        get_monotonic_time: () => Math.floor(performance.now() * 1000),
        find_program_in_path: prog => {
            if (!prog) return null;
            if (path.isAbsolute(prog)) {
                try {
                    fs.accessSync(prog, fs.constants.X_OK);
                    return prog;
                } catch (_) {
                    return null;
                }
            }
            const pathEnv = process.env.PATH || '';
            for (const dir of pathEnv.split(path.delimiter)) {
                if (!dir) continue;
                const full = path.join(dir, prog);
                try {
                    fs.accessSync(full, fs.constants.X_OK);
                    return full;
                } catch (_) {}
            }
            return null;
        },
        file_test: (filePath, flags) => {
            const p = String(filePath || '');
            if (!p) return false;
            try {
                const lstat = fs.lstatSync(p);
                if ((flags & (1 << 1)) && lstat.isSymbolicLink()) return true;
                const stat = fs.statSync(p);
                if (flags & (1 << 4)) return true;
                if ((flags & (1 << 2)) && stat.isDirectory()) return true;
                if ((flags & (1 << 0)) && stat.isFile()) return true;
                if (flags & (1 << 3)) {
                    fs.accessSync(p, fs.constants.X_OK);
                    return stat.isFile();
                }
                return false;
            } catch (_) {
                return false;
            }
        },
        file_get_contents: filePath => {
            const buf = fs.readFileSync(String(filePath));
            return [true, new Uint8Array(buf)];
        },
        mkdir_with_parents: (dirPath, mode = 0o700) => {
            try {
                fs.mkdirSync(String(dirPath), {recursive: true, mode});
                return 0;
            } catch (_) {
                return -1;
            }
        },
        unlink: filePath => {
            try {
                fs.unlinkSync(String(filePath));
                return 0;
            } catch (_) {
                return -1;
            }
        },
        rmdir: dirPath => {
            try {
                fs.rmdirSync(String(dirPath));
                return 0;
            } catch (_) {
                return -1;
            }
        },
        timeout_add: (_prio, ms, cb) => {
            const id = nextTimerId++;
            const handle = setTimeout(() => {
                activeTimers.delete(id);
                try {
                    const keep = cb();
                    if (keep) {
                        // One-shot in Quick Chat usage unless SOURCE_CONTINUE
                    }
                } catch (_) {}
            }, Math.max(0, Number(ms) || 0));
            activeTimers.set(id, handle);
            return id;
        },
        timeout_add_seconds: (_prio, sec, cb) => {
            const id = nextTimerId++;
            const handle = setTimeout(() => {
                activeTimers.delete(id);
                try {
                    cb();
                } catch (_) {}
            }, Math.max(0, Number(sec) || 0) * 1000);
            activeTimers.set(id, handle);
            return id;
        },
        idle_add: (_prio, cb) => {
            const id = nextTimerId++;
            const handle = setImmediate(() => {
                activeTimers.delete(id);
                try {
                    cb();
                } catch (_) {}
            });
            activeTimers.set(id, handle);
            return id;
        },
        source_remove: id => {
            const handle = activeTimers.get(id);
            if (!handle) return false;
            activeTimers.delete(id);
            clearTimeout(handle);
            clearImmediate(handle);
            return true;
        },
    };
}

export class MockOutputStream {
    constructor(writable) {
        this._writable = writable;
        this._closed = false;
        this.writeDelayMs = 0;
    }

    write_bytes_async(gbytes, _prio, cancellable, callback) {
        const buf = gbytes?._buf || Buffer.from(gbytes || []);
        const run = () => {
            if (cancellable?.is_cancelled?.()) {
                callback(this, {_err: new Error('Operation was cancelled')});
                return;
            }
            if (this._closed || !this._writable || this._writable.destroyed) {
                callback(this, {_err: new Error('Stream is closed')});
                return;
            }
            this._writable.write(buf, err => {
                if (err) {
                    callback(this, {_err: err});
                } else {
                    callback(this, {_written: buf.length});
                }
            });
        };
        if (this.writeDelayMs > 0) {
            setTimeout(run, this.writeDelayMs);
        } else {
            queueMicrotask(run);
        }
    }

    write_bytes_finish(res) {
        if (res?._err) throw res._err;
        return res?._written ?? 0;
    }

    flush_async(_prio, _cancellable, callback) {
        queueMicrotask(() => callback?.(this, {}));
    }

    flush_finish() {
        return true;
    }

    close_async(_prio, _cancellable, callback) {
        if (this._closed) {
            queueMicrotask(() => callback?.(this, {}));
            return;
        }
        this._closed = true;
        try {
            this._writable?.end?.(() => callback?.(this, {}));
        } catch (_) {
            queueMicrotask(() => callback?.(this, {}));
        }
    }

    close_finish(res) {
        if (res?._err) throw res._err;
        return true;
    }

    close() {
        this._closed = true;
        try {
            this._writable?.end?.();
        } catch (_) {}
        return true;
    }
}

class MockInputStream {
    constructor(readable) {
        this._readable = readable;
        this._chunks = [];
        this._ended = false;
        this._error = null;
        this._waiters = [];
        this._closed = false;

        if (readable) {
            readable.on('data', chunk => {
                this._chunks.push(Buffer.from(chunk));
                this._drainWaiters();
            });
            readable.on('end', () => {
                this._ended = true;
                this._drainWaiters();
            });
            readable.on('close', () => {
                this._ended = true;
                this._drainWaiters();
            });
            readable.on('error', err => {
                this._error = err;
                this._drainWaiters();
            });
        } else {
            this._ended = true;
        }
    }

    _drainWaiters() {
        while (this._waiters.length > 0) {
            const w = this._waiters[0];
            if (w.cancellable?.is_cancelled?.()) {
                this._waiters.shift();
                w.cb({err: new Error('Operation was cancelled')});
                continue;
            }
            if (this._error) {
                this._waiters.shift();
                w.cb({err: this._error});
                continue;
            }
            if (w.type === 'bytes') {
                if (this._chunks.length > 0) {
                    this._waiters.shift();
                    const first = this._chunks[0];
                    if (first.length <= w.count) {
                        this._chunks.shift();
                        w.cb({bytes: first});
                    } else {
                        const slice = first.subarray(0, w.count);
                        this._chunks[0] = first.subarray(w.count);
                        w.cb({bytes: slice});
                    }
                    continue;
                }
                if (this._ended || this._closed) {
                    this._waiters.shift();
                    w.cb({bytes: Buffer.alloc(0)});
                    continue;
                }
                break;
            }
            if (w.type === 'line') {
                const combined = this._chunks.length > 0 ? Buffer.concat(this._chunks) : Buffer.alloc(0);
                const nlIdx = combined.indexOf(0x0a);
                if (nlIdx !== -1) {
                    this._waiters.shift();
                    let lineBuf = combined.subarray(0, nlIdx);
                    if (lineBuf.length > 0 && lineBuf[lineBuf.length - 1] === 0x0d) {
                        lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
                    }
                    const rest = combined.subarray(nlIdx + 1);
                    this._chunks = rest.length > 0 ? [rest] : [];
                    w.cb({line: lineBuf.toString('utf8'), length: lineBuf.length});
                    continue;
                }
                if (this._ended || this._closed) {
                    this._waiters.shift();
                    if (combined.length > 0) {
                        this._chunks = [];
                        let lineBuf = combined;
                        if (lineBuf[lineBuf.length - 1] === 0x0d) {
                            lineBuf = lineBuf.subarray(0, lineBuf.length - 1);
                        }
                        w.cb({line: lineBuf.toString('utf8'), length: lineBuf.length});
                    } else {
                        w.cb({line: null, length: 0});
                    }
                    continue;
                }
                break;
            }
        }
    }

    read_bytes_async(count, _prio, cancellable, callback) {
        const GLib = createMockGLib();
        let cancelId = 0;
        if (cancellable?.connect) {
            cancelId = cancellable.connect(() => this._drainWaiters());
        }
        this._waiters.push({
            type: 'bytes',
            count,
            cancellable,
            cb: result => {
                if (cancelId && cancellable?.disconnect) {
                    try { cancellable.disconnect(cancelId); } catch (_) {}
                }
                queueMicrotask(() => {
                    if (result.err) {
                        callback(this, {_err: result.err});
                    } else {
                        callback(this, {_bytes: new GLib.Bytes(result.bytes)});
                    }
                });
            },
        });
        this._drainWaiters();
    }

    read_bytes_finish(res) {
        if (res?._err) throw res._err;
        return res?._bytes;
    }

    close_async(_prio, _cancellable, callback) {
        this._closed = true;
        try {
            this._readable?.destroy?.();
        } catch (_) {}
        this._drainWaiters();
        queueMicrotask(() => callback?.(this, {}));
    }

    close_finish(res) {
        if (res?._err) throw res._err;
        return true;
    }

    close() {
        this._closed = true;
        try {
            this._readable?.destroy?.();
        } catch (_) {}
        this._drainWaiters();
        return true;
    }
}

class MockDataInputStream extends MockInputStream {
    constructor(arg) {
        const baseStream = arg?.base_stream || arg;
        super(baseStream?._readable || null);
        this._base = baseStream;
        if (baseStream instanceof MockInputStream) {
            baseStream.read_line_async = function (_prio, cancellable, callback) {
                let cancelId = 0;
                if (cancellable?.connect) {
                    cancelId = cancellable.connect(() => this._drainWaiters());
                }
                this._waiters.push({
                    type: 'line',
                    cancellable,
                    cb: result => {
                        if (cancelId && cancellable?.disconnect) {
                            try { cancellable.disconnect(cancelId); } catch (_) {}
                        }
                        queueMicrotask(() => {
                            if (result.err) {
                                callback(this, {_err: result.err});
                            } else {
                                callback(this, {_line: result.line, _len: result.length});
                            }
                        });
                    },
                });
                this._drainWaiters();
            };
            baseStream.read_line_finish_utf8 = function (res) {
                if (res?._err) throw res._err;
                return [res?._line ?? null, res?._len ?? 0];
            };
            return baseStream;
        }
    }

    static new(baseStream) {
        if (baseStream instanceof MockDataInputStream) return baseStream;
        return new MockDataInputStream(baseStream);
    }
}

class MockSubprocess {
    constructor(child, flags = 0) {
        this._child = child;
        this._pid = child.pid ? String(child.pid) : '';
        this._exitCode = null;
        this._signal = null;
        this._exited = false;
        this._waitCallbacks = [];
        this._stdinStream = (flags & 1) && child.stdin ? new MockOutputStream(child.stdin) : null;
        this._stdoutStream = (flags & 2) && child.stdout ? new MockInputStream(child.stdout) : null;
        this._stderrStream = (flags & 4) && child.stderr ? new MockInputStream(child.stderr) : null;

        child.on('exit', (code, sig) => {
            this._exited = true;
            this._exitCode = code;
            this._signal = sig;
            const cbs = this._waitCallbacks.splice(0);
            for (const cb of cbs) {
                queueMicrotask(() => cb());
            }
        });
        child.on('error', err => {
            this._exited = true;
            this._error = err;
            const cbs = this._waitCallbacks.splice(0);
            for (const cb of cbs) {
                queueMicrotask(() => cb());
            }
        });
    }

    get_identifier() {
        return this._pid;
    }

    get_stdin_pipe() {
        return this._stdinStream;
    }

    get_stdout_pipe() {
        return this._stdoutStream;
    }

    get_stderr_pipe() {
        return this._stderrStream;
    }

    wait_async(cancellable, callback) {
        if (this._exited) {
            queueMicrotask(() => callback(this, {_ok: !this._error, _err: this._error}));
            return;
        }
        const done = () => {
            if (cancellable?.is_cancelled?.()) {
                callback(this, {_err: new Error('Operation was cancelled')});
            } else if (this._error) {
                callback(this, {_err: this._error});
            } else {
                callback(this, {_ok: true});
            }
        };
        this._waitCallbacks.push(done);
    }

    wait_finish(res) {
        if (res?._err) throw res._err;
        return true;
    }

    get_successful() {
        return this._exited && this._exitCode === 0 && !this._signal;
    }

    get_if_exited() {
        return this._exited && this._exitCode !== null;
    }

    get_exit_status() {
        return this._exitCode ?? -1;
    }

    get_if_signaled() {
        return this._exited && Boolean(this._signal);
    }

    get_term_sig() {
        if (!this._signal) return 0;
        const map = {SIGTERM: 15, SIGKILL: 9, SIGINT: 2};
        return map[this._signal] || 15;
    }

    send_signal(sigNum) {
        if (this._exited || !this._child?.pid) return;
        const sig = sigNum === 9 ? 'SIGKILL' : 'SIGTERM';
        try {
            process.kill(this._child.pid, sig);
        } catch (_) {}
    }

    force_exit() {
        if (this._exited || !this._child?.pid) return;
        try {
            process.kill(this._child.pid, 'SIGKILL');
        } catch (_) {}
    }

    communicate_utf8() {
        globalThis.__qcSyncCommunicateCount = (globalThis.__qcSyncCommunicateCount || 0) + 1;
        return [true, '', ''];
    }
}

export function createMockGio() {
    const GLib = createMockGLib();
    return {
        SubprocessFlags: {
            NONE: 0,
            STDIN_PIPE: 1,
            STDOUT_PIPE: 2,
            STDERR_PIPE: 4,
            STDERR_SILENCE: 8,
        },
        FileQueryInfoFlags: {
            NONE: 0,
            NOFOLLOW_SYMLINKS: 1,
        },
        FileCreateFlags: {
            NONE: 0,
            PRIVATE: 1,
            REPLACE_DESTINATION: 2,
        },
        FileType: {
            UNKNOWN: 0,
            REGULAR: 1,
            DIRECTORY: 2,
            SYMBOLIC_LINK: 3,
            SPECIAL: 4,
        },
        Cancellable: class Cancellable {
            constructor() {
                this._cancelled = false;
                this._listeners = new Map();
                this._nextId = 1;
            }
            is_cancelled() {
                return this._cancelled;
            }
            cancel() {
                if (this._cancelled) return;
                this._cancelled = true;
                for (const fn of Array.from(this._listeners.values())) {
                    try { fn(); } catch (_) {}
                }
            }
            connect(fn) {
                const id = this._nextId++;
                this._listeners.set(id, fn);
                if (this._cancelled) {
                    try { fn(); } catch (_) {}
                }
                return id;
            }
            disconnect(id) {
                this._listeners.delete(id);
            }
        },
        DataInputStream: MockDataInputStream,
        SubprocessLauncher: class SubprocessLauncher {
            constructor(optsOrFlags = 0) {
                this._flags = (typeof optsOrFlags === 'object' && optsOrFlags !== null)
                    ? Number(optsOrFlags.flags || 0)
                    : Number(optsOrFlags || 0);
                this._envMap = {...process.env};
                this._cwdPath = process.cwd();
            }
            static new(flags = 0) {
                return new SubprocessLauncher(flags);
            }
            set_cwd(cwd) {
                if (cwd) this._cwdPath = String(cwd);
            }
            set_environ(envList) {
                if (!Array.isArray(envList)) return;
                this._envMap = {};
                for (const entry of envList) {
                    const s = String(entry || '');
                    const eq = s.indexOf('=');
                    if (eq > 0) {
                        this._envMap[s.slice(0, eq)] = s.slice(eq + 1);
                    }
                }
            }
            setenv(key, val, overwrite = true) {
                if (overwrite || !(key in this._envMap)) {
                    this._envMap[String(key)] = String(val ?? '');
                }
            }
            spawnv(argv) {
                const cmd = String(argv[0]);
                if (cmd.startsWith('/') && !fs.existsSync(cmd)) {
                    throw new Error(`Failed to execute child process "${cmd}" (No such file or directory)`);
                }
                const args = argv.slice(1).map(String);
                const stdio = [
                    (this._flags & 1) ? 'pipe' : 'ignore',
                    (this._flags & 2) ? 'pipe' : 'ignore',
                    (this._flags & 4) ? 'pipe' : 'ignore',
                ];
                const child = spawn(cmd, args, {
                    cwd: this._cwdPath,
                    env: this._envMap,
                    stdio,
                });
                return new MockSubprocess(child, this._flags);
            }
        },
        Subprocess: class Subprocess {
            constructor(optsOrArgv, maybeFlags = 0) {
                const argv = Array.isArray(optsOrArgv) ? optsOrArgv : (optsOrArgv?.argv || []);
                const flags = Array.isArray(optsOrArgv) ? maybeFlags : Number(optsOrArgv?.flags || 0);
                this._cmd = String(argv[0]);
                this._args = argv.slice(1).map(String);
                this._flags = flags;
                this._mockProc = null;
            }
            static new(argv, flags = 0) {
                return new Subprocess(argv, flags);
            }
            _ensureSpawned() {
                if (this._mockProc) return this._mockProc;
                const stdio = [
                    (this._flags & 1) ? 'pipe' : 'ignore',
                    (this._flags & 2) ? 'pipe' : 'ignore',
                    (this._flags & 4) ? 'pipe' : 'ignore',
                ];
                const child = spawn(this._cmd, this._args, {stdio});
                this._mockProc = new MockSubprocess(child, this._flags);
                return this._mockProc;
            }
            get_identifier() {
                return this._ensureSpawned().get_identifier();
            }
            get_stdin_pipe() {
                return this._ensureSpawned().get_stdin_pipe();
            }
            get_stdout_pipe() {
                return this._ensureSpawned().get_stdout_pipe();
            }
            get_stderr_pipe() {
                return this._ensureSpawned().get_stderr_pipe();
            }
            wait_async(cancellable, cb) {
                return this._ensureSpawned().wait_async(cancellable, (_p, res) => cb(this, res));
            }
            wait_finish(res) {
                return this._ensureSpawned().wait_finish(res);
            }
            get_successful() {
                return this._mockProc ? this._mockProc.get_successful() : false;
            }
            get_if_exited() {
                return this._mockProc ? this._mockProc.get_if_exited() : false;
            }
            get_exit_status() {
                return this._mockProc ? this._mockProc.get_exit_status() : -1;
            }
            get_if_signaled() {
                return this._mockProc ? this._mockProc.get_if_signaled() : false;
            }
            get_term_sig() {
                return this._mockProc ? this._mockProc.get_term_sig() : 0;
            }
            send_signal(sigNum) {
                return this._mockProc?.send_signal(sigNum);
            }
            force_exit() {
                return this._mockProc?.force_exit();
            }
            communicate_utf8(_input, _cancellable) {
                globalThis.__qcSyncCommunicateCount = (globalThis.__qcSyncCommunicateCount || 0) + 1;
                const res = spawnSync(this._cmd, this._args, {encoding: 'utf8', timeout: 5000});
                this._mockProc = {
                    get_successful: () => res.status === 0 && !res.signal,
                    get_if_exited: () => res.status !== null,
                    get_exit_status: () => res.status ?? -1,
                    get_if_signaled: () => Boolean(res.signal),
                    get_term_sig: () => 0,
                };
                return [true, res.stdout || '', res.stderr || ''];
            }
            communicate_utf8_async(_input, _cancellable, cb) {
                const child = spawn(this._cmd, this._args, {
                    stdio: ['ignore', (this._flags & 2) ? 'pipe' : 'ignore', (this._flags & 4) ? 'pipe' : 'ignore'],
                });
                let out = '';
                let err = '';
                let exitStatus = null;
                let exitSignal = null;
                child.stdout?.on('data', d => { out += d.toString('utf8'); });
                child.stderr?.on('data', d => { err += d.toString('utf8'); });
                child.on('close', (code, sig) => {
                    exitStatus = code;
                    exitSignal = sig;
                    this._mockProc = {
                        get_successful: () => exitStatus === 0 && !exitSignal,
                        get_if_exited: () => exitStatus !== null,
                        get_exit_status: () => exitStatus ?? -1,
                        get_if_signaled: () => Boolean(exitSignal),
                        get_term_sig: () => 0,
                    };
                    cb(this, {_out: out, _err: err});
                });
            }
            communicate_utf8_finish(res) {
                return [true, res?._out || '', res?._err || ''];
            }
        },
        File: {
            new_for_uri(uri) {
                const clean = String(uri || '').replace(/^file:\/\//, '');
                return this.new_for_path(clean);
            },
            new_for_path(filePath) {
                const p = String(filePath || '');
                const fileApi = this;
                return {
                    get_path: () => p,
                    get_parent: () => fileApi.new_for_path(path.dirname(p)),
                    query_exists: () => fs.existsSync(p),
                    set_attribute_uint32: (attr, val) => {
                        if (attr === 'unix::mode') {
                            fs.chmodSync(p, val);
                        }
                        return true;
                    },
                    query_info: (_attrs, flags) => {
                        const st = (flags & 1) ? fs.lstatSync(p) : fs.statSync(p);
                        return {
                            get_size: () => st.size,
                            get_is_symlink: () => st.isSymbolicLink(),
                            get_symlink_target: () => fs.readlinkSync(p),
                            get_file_type: () => {
                                if (st.isSymbolicLink()) return 3;
                                if (st.isFile()) return 1;
                                if (st.isDirectory()) return 2;
                                return 4;
                            },
                            get_attribute_uint64: () => BigInt(Math.floor(st.mtimeMs * 1000)),
                            get_attribute_uint32: () => st.mode,
                        };
                    },
                    query_info_async(_attrs, flags, _prio, _cancellable, cb) {
                        queueMicrotask(() => {
                            try {
                                const info = this.query_info(_attrs, flags);
                                cb(this, {_info: info});
                            } catch (err) {
                                cb(this, {_err: err});
                            }
                        });
                    },
                    query_info_finish(res) {
                        if (res?._err) throw res._err;
                        return res._info;
                    },
                    enumerate_children_async(_attrs, _flags, _prio, _cancellable, cb) {
                        fs.readdir(p, {withFileTypes: true}, (err, dirents) => {
                            if (err) {
                                cb(this, {_err: err});
                                return;
                            }
                            let idx = 0;
                            const enumerator = {
                                next_files_async(count, _p, _c, nextCb) {
                                    const batch = dirents.slice(idx, idx + count).map(d => ({
                                        get_name: () => d.name,
                                        get_file_type: () => (d.isDirectory() ? 2 : 1),
                                    }));
                                    idx += count;
                                    queueMicrotask(() => nextCb(enumerator, {_infos: batch}));
                                },
                                next_files_finish(res) {
                                    if (res?._err) throw res._err;
                                    return res._infos || [];
                                },
                                close_async(_p, _c, closeCb) {
                                    queueMicrotask(() => closeCb?.(enumerator, {}));
                                },
                                close_finish() {
                                    return true;
                                },
                            };
                            cb(this, {_enum: enumerator});
                        });
                    },
                    enumerate_children_finish(res) {
                        if (res?._err) throw res._err;
                        return res._enum;
                    },
                    load_contents_async(_cancellable, cb) {
                        fs.readFile(p, (err, buf) => {
                            if (err) cb(this, {_err: err});
                            else cb(this, {_buf: new Uint8Array(buf)});
                        });
                    },
                    load_contents_finish(res) {
                        if (res?._err) throw res._err;
                        return [true, res._buf, null];
                    },
                    replace_contents_async(bytes, _etag, _backup, _flags, _cancellable, cb) {
                        const buf = bytes instanceof Uint8Array
                            ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                            : Buffer.from(bytes?._buf || bytes || []);
                        fs.writeFile(p, buf, {mode: 0o600}, err => {
                            if (err) cb(this, {_err: err});
                            else cb(this, {_ok: true});
                        });
                    },
                    replace_contents_bytes_async(bytes, etag, backup, flags, cancellable, cb) {
                        return this.replace_contents_async(bytes, etag, backup, flags, cancellable, cb);
                    },
                    replace_contents_finish(res) {
                        if (res?._err) throw res._err;
                        return [true, ''];
                    },
                    create_async(_flags, _prio, _cancellable, cb) {
                        queueMicrotask(() => {
                            try {
                                const fd = fs.openSync(p, 'wx', 0o600);
                                const stream = fs.createWriteStream(null, {fd});
                                cb(this, {_stream: new MockOutputStream(stream)});
                            } catch (err) {
                                cb(this, {_err: err});
                            }
                        });
                    },
                    create_finish(res) {
                        if (res?._err) throw res._err;
                        return res._stream;
                    },
                    replace_async(_etag, _backup, _flags, _prio, _cancellable, cb) {
                        queueMicrotask(() => {
                            try {
                                const fd = fs.openSync(p, 'w', 0o600);
                                const stream = fs.createWriteStream(null, {fd});
                                cb(this, {_stream: new MockOutputStream(stream)});
                            } catch (err) {
                                cb(this, {_err: err});
                            }
                        });
                    },
                    replace_finish(res) {
                        if (res?._err) throw res._err;
                        return res._stream;
                    },
                    append_to_async(_flags, _prio, _cancellable, cb) {
                        queueMicrotask(() => {
                            try {
                                const fd = fs.openSync(p, 'a', 0o600);
                                const stream = fs.createWriteStream(null, {fd});
                                cb(this, {_stream: new MockOutputStream(stream)});
                            } catch (err) {
                                cb(this, {_err: err});
                            }
                        });
                    },
                    append_to_finish(res) {
                        if (res?._err) throw res._err;
                        return res._stream;
                    },
                    read_async(_prio, _cancellable, cb) {
                        queueMicrotask(() => {
                            try {
                                const fd = fs.openSync(p, 'r');
                                const stream = fs.createReadStream(null, {fd});
                                cb(this, {_stream: new MockInputStream(stream)});
                            } catch (err) {
                                cb(this, {_err: err});
                            }
                        });
                    },
                    read_finish(res) {
                        if (res?._err) throw res._err;
                        return res._stream;
                    },
                    delete: () => {
                        fs.unlinkSync(p);
                        return true;
                    },
                    delete_async(_prio, _cancellable, cb) {
                        fs.unlink(p, err => {
                            if (err) cb(this, {_err: err});
                            else cb(this, {_ok: true});
                        });
                    },
                    delete_finish(res) {
                        if (res?._err) throw res._err;
                        return true;
                    },
                };
            },
        },
    };
}

export function registerGiMocks() {
    if (hooksRegistered) return;
    hooksRegistered = true;

    globalThis.__qcMockGLib = createMockGLib();
    globalThis.__qcMockGio = createMockGio();
    globalThis.__qcMockClutter = {
        EVENT_STOP: true,
        EVENT_PROPAGATE: false,
        ModifierType: {SHIFT_MASK: 1, CONTROL_MASK: 4},
        ActorAlign: {START: 1, CENTER: 2, END: 3, FILL: 0},
        Orientation: {HORIZONTAL: 0, VERTICAL: 1},
    };
    globalThis.__qcMockSt = {
        ClipboardType: {CLIPBOARD: 0},
        Clipboard: {
            get_default: () => ({
                get_text: (_type, cb) => cb?.(null, ''),
                set_text: () => {},
            }),
        },
        BoxLayout: class {},
        Button: class {},
        Label: class {},
        Entry: class {},
        ScrollView: class {},
        Widget: class {},
        Icon: class {},
    };
    globalThis.__qcMockSoup = {
        Session: class {
            constructor() {
                this._activeReqs = new Set();
            }
            abort() {
                for (const req of this._activeReqs) {
                    try { req.destroy(new Error('Soup session aborted')); } catch (_) {}
                }
                this._activeReqs.clear();
            }
            send_async(msg, _prio, cancellable, callback) {
                let cancelled = false;
                let cancelId = 0;
                const activeSession = this;

                const finishWithError = err => {
                    if (cancelId && cancellable?.disconnect) {
                        try { cancellable.disconnect(cancelId); } catch (_) {}
                        cancelId = 0;
                    }
                    queueMicrotask(() => callback?.(activeSession, {_err: err}));
                };

                if (cancellable?.is_cancelled?.()) {
                    finishWithError(new Error('Operation was cancelled'));
                    return;
                }

                let currentReq = null;
                if (cancellable?.connect) {
                    cancelId = cancellable.connect(() => {
                        cancelled = true;
                        try { currentReq?.destroy(new Error('Operation was cancelled')); } catch (_) {}
                    });
                }

                const performRequest = (hopCount = 0) => {
                    if (cancelled || msg._aborted) {
                        finishWithError(new Error(msg._abortReason || 'Operation was cancelled'));
                        return;
                    }
                    if (hopCount > 5) {
                        finishWithError(new Error('Too many redirects'));
                        return;
                    }
                    let parsedUrl;
                    try {
                        parsedUrl = new URL(msg._url);
                    } catch (err) {
                        finishWithError(err);
                        return;
                    }

                    const headersObj = {};
                    for (const [k, v] of msg._reqHeaders.entries()) {
                        headersObj[k] = v;
                    }
                    if (msg._bodyBuffer && msg._method !== 'GET' && msg._method !== 'HEAD') {
                        headersObj['Content-Length'] = String(msg._bodyBuffer.length);
                        if (msg._contentType && !headersObj['Content-Type'] && !headersObj['content-type']) {
                            headersObj['Content-Type'] = msg._contentType;
                        }
                    }

                    const req = http.request({
                        protocol: parsedUrl.protocol,
                        hostname: parsedUrl.hostname,
                        port: parsedUrl.port,
                        path: `${parsedUrl.pathname}${parsedUrl.search}`,
                        method: msg._method,
                        headers: headersObj,
                        agent: false,
                    }, res => {
                        activeSession._activeReqs.delete(req);
                        msg._status = res.statusCode || 200;
                        msg._reasonPhrase = res.statusMessage || 'OK';
                        msg._resHeaders = res.headers || {};

                        msg._emit('got-headers');
                        if (cancelled || msg._aborted || cancellable?.is_cancelled?.()) {
                            res.resume();
                            finishWithError(new Error(msg._abortReason || 'Operation was cancelled'));
                            return;
                        }

                        const status = msg._status;
                        const location = res.headers?.location;
                        if ([301, 302, 303, 307, 308].includes(status) && location) {
                            res.resume();
                            let nextUrl;
                            try {
                                nextUrl = new URL(location, msg._url).toString();
                            } catch (err) {
                                finishWithError(err);
                                return;
                            }
                            msg._url = nextUrl;
                            if (status === 303 || ((status === 301 || status === 302) && msg._method === 'POST')) {
                                msg._method = 'GET';
                                msg._bodyBuffer = null;
                            }
                            msg._emit('restarted');
                            if (cancelled || msg._aborted || cancellable?.is_cancelled?.()) {
                                finishWithError(new Error(msg._abortReason || 'Operation was cancelled'));
                                return;
                            }
                            performRequest(hopCount + 1);
                            return;
                        }

                        if (cancelId && cancellable?.disconnect) {
                            try { cancellable.disconnect(cancelId); } catch (_) {}
                            cancelId = 0;
                        }
                        const stream = new MockInputStream(res);
                        queueMicrotask(() => callback?.(activeSession, {_stream: stream}));
                    });

                    currentReq = req;
                    activeSession._activeReqs.add(req);
                    req.on('error', err => {
                        activeSession._activeReqs.delete(req);
                        finishWithError(err);
                    });

                    if (msg._bodyBuffer && msg._method !== 'GET' && msg._method !== 'HEAD') {
                        req.write(msg._bodyBuffer);
                    }
                    req.end();
                };

                performRequest(0);
            }
            send_finish(res) {
                if (res?._err) throw res._err;
                return res?._stream;
            }
        },
        Message: {
            new: (method, url) => {
                const listeners = new Map();
                let nextListenerId = 1;
                const reqHeaders = new Map();
                const msgObj = {
                    _method: String(method || 'GET').toUpperCase(),
                    _url: String(url || ''),
                    _reqHeaders: reqHeaders,
                    _resHeaders: {},
                    _status: 200,
                    _reasonPhrase: 'OK',
                    _bodyBuffer: null,
                    _contentType: '',
                    _aborted: false,
                    _abortReason: '',
                    connect(sig, fn) {
                        const id = nextListenerId++;
                        if (!listeners.has(sig)) listeners.set(sig, new Map());
                        listeners.get(sig).set(id, fn);
                        return id;
                    },
                    disconnect(id) {
                        for (const map of listeners.values()) {
                            map.delete(id);
                        }
                    },
                    _emit(sig) {
                        const map = listeners.get(sig);
                        if (!map) return;
                        for (const fn of map.values()) {
                            try { fn(msgObj); } catch (_) {}
                        }
                    },
                    get_method: () => msgObj._method,
                    get_uri: () => ({to_string: () => msgObj._url}),
                    get_request_headers: () => ({
                        append: (k, v) => {
                            reqHeaders.set(String(k), String(v));
                        },
                        replace: (k, v) => {
                            reqHeaders.set(String(k), String(v));
                        },
                        remove: k => {
                            for (const existingKey of Array.from(reqHeaders.keys())) {
                                if (existingKey.toLowerCase() === String(k).toLowerCase()) {
                                    reqHeaders.delete(existingKey);
                                }
                            }
                        },
                        get_one: k => {
                            for (const [existingKey, val] of reqHeaders.entries()) {
                                if (existingKey.toLowerCase() === String(k).toLowerCase()) {
                                    return val;
                                }
                            }
                            return null;
                        },
                    }),
                    get_response_headers: () => ({
                        get_content_length: () => {
                            const raw = msgObj._resHeaders['content-length'];
                            const n = Number(raw);
                            return Number.isFinite(n) && n > 0 ? n : 0;
                        },
                        get_one: name => {
                            const key = String(name || '').toLowerCase();
                            const val = msgObj._resHeaders[key];
                            if (Array.isArray(val)) return val[0] ?? null;
                            return val ?? null;
                        },
                    }),
                    get_status: () => msgObj._status,
                    get_reason_phrase: () => msgObj._reasonPhrase,
                    set_request_body_from_bytes: (contentType, gbytes) => {
                        msgObj._contentType = String(contentType || 'application/json');
                        if (!gbytes) {
                            msgObj._bodyBuffer = null;
                        } else if (gbytes._buf) {
                            msgObj._bodyBuffer = Buffer.from(gbytes._buf);
                        } else if (typeof gbytes.get_data === 'function') {
                            msgObj._bodyBuffer = Buffer.from(gbytes.get_data());
                        } else if (gbytes instanceof Uint8Array) {
                            msgObj._bodyBuffer = Buffer.from(gbytes);
                        } else {
                            msgObj._bodyBuffer = Buffer.from(String(gbytes));
                        }
                    },
                };
                return msgObj;
            },
        },
    };
    const MockConstructible = new Proxy(function MockGiClass() {}, {
        get(_t, p) {
            if (p === '__esModule') return false;
            if (p === Symbol.toPrimitive) return () => 0;
            return MockConstructible;
        },
        construct() {
            return {};
        },
        apply() {
            return {};
        },
    });
    globalThis.__qcMockGenericGi = MockConstructible;
    globalThis.__qcMockGnomeMain = {
        panel: {statusArea: {}},
        wm: {addKeybinding: () => {}, removeKeybinding: () => {}},
        sessionMode: {isLocked: false, isGreeter: false, hasNotifications: true, connect: () => 1, disconnect: () => {}},
        messageTray: {getSources: () => [], connect: () => 1, disconnect: () => {}},
        notify: () => {},
    };
    globalThis.__qcMockExtensionBase = class Extension {
        constructor(meta = {}) {
            this.metadata = meta;
        }
        getSettings() {
            return null;
        }
        openPreferences() {}
    };

    registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'gi://GLib') {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default globalThis.__qcMockGLib;')}`,
                    shortCircuit: true,
                };
            }
            if (specifier === 'gi://Gio') {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default globalThis.__qcMockGio;')}`,
                    shortCircuit: true,
                };
            }
            if (specifier.startsWith('gi://Clutter')) {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default globalThis.__qcMockClutter;')}`,
                    shortCircuit: true,
                };
            }
            if (specifier.startsWith('gi://St')) {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default globalThis.__qcMockSt;')}`,
                    shortCircuit: true,
                };
            }
            if (specifier.startsWith('gi://Soup')) {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default globalThis.__qcMockSoup;')}`,
                    shortCircuit: true,
                };
            }
            if (specifier.startsWith('gi://')) {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default globalThis.__qcMockGenericGi;')}`,
                    shortCircuit: true,
                };
            }
            if (specifier === 'resource:///org/gnome/shell/ui/main.js') {
                return {
                    url: `data:text/javascript,${encodeURIComponent(
                        'export const panel = globalThis.__qcMockGnomeMain.panel;' +
                        'export const wm = globalThis.__qcMockGnomeMain.wm;' +
                        'export const sessionMode = globalThis.__qcMockGnomeMain.sessionMode;' +
                        'export const messageTray = globalThis.__qcMockGnomeMain.messageTray;' +
                        'export const notify = globalThis.__qcMockGnomeMain.notify;' +
                        'export default globalThis.__qcMockGnomeMain;'
                    )}`,
                    shortCircuit: true,
                };
            }
            if (specifier === 'resource:///org/gnome/shell/extensions/extension.js') {
                return {
                    url: `data:text/javascript,${encodeURIComponent(
                        'export const Extension = globalThis.__qcMockExtensionBase;' +
                        'export default {Extension: globalThis.__qcMockExtensionBase};'
                    )}`,
                    shortCircuit: true,
                };
            }
            if (specifier.startsWith('resource://')) {
                return {
                    url: `data:text/javascript,${encodeURIComponent('export default {};')}`,
                    shortCircuit: true,
                };
            }
            return nextResolve(specifier, context);
        },
    });
}
