import {normalizeEvent} from '../protocol.js';

export function supportsDshSdk(versionOutput) {
    const match = String(versionOutput).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/);
    if (!match) return false;
    const [, major, minor, patch, prerelease] = match;
    const version = Number(major) * 10000 + Number(minor) * 100 + Number(patch);
    if (version !== 202) return version > 202 && !prerelease;
    return !prerelease || (/^rc\.\d+$/.test(prerelease) && Number(prerelease.slice(3)) >= 5);
}

function safeText(value, max = 4000) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function decodeQuestions(raw) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 12) return null;
    const ids = new Set();
    const labels = new Set();
    const questions = [];
    for (const item of raw) {
        const id = safeText(item?.id, 256);
        const question = [safeText(item?.question), safeText(item?.detail, 16000)].filter(Boolean).join('\n\n');
        if (!id || id !== item.id || !question || ids.has(id) || labels.has(question)) return null;
        ids.add(id);
        labels.add(question);
        const rawOptions = item.options ?? [];
        if (!Array.isArray(rawOptions) || rawOptions.length > 30) return null;
        const options = rawOptions.map(option => ({
            label: safeText(option?.label, 256),
            description: safeText(option?.description),
        }));
        if (options.some((option, index) => !option.label || option.label !== rawOptions[index].label) ||
            new Set(options.map(option => option.label)).size !== options.length) return null;
        questions.push({id, question, header: safeText(item.header, 256), multiSelect: item.multiSelect === true, options});
    }
    return questions;
}

function answerQuestions(questions, drafts) {
    if (!drafts || typeof drafts !== 'object') return null;
    const answers = [];
    for (const question of questions) {
        const draft = Object.hasOwn(drafts, question.question) ? drafts[question.question] : {};
        const selected = draft?.selectedLabels ?? [];
        const custom = safeText(draft?.customText, 4096);
        if (!Array.isArray(selected) || new Set(selected).size !== selected.length ||
            (!question.multiSelect && (selected.length > 1 || (selected.length && custom))) ||
            selected.some(label => !question.options.some(option => option.label === label))) return null;
        answers.push({id: question.id, selected, ...(custom ? {custom} : {})});
    }
    return answers.some(item => item.selected.length || item.custom) ? answers : null;
}

/** Translates one DSH SDK process into the shared CLI turn and interaction contract. */
export class DshSdkTurn {
    constructor({sessionId, workspace, provider, model, prompt, approvalRequests, fullAccess = false, resume = false}) {
        this.sessionId = sessionId;
        this.initialize = {
            cwd: workspace, provider, model, approvalRequests,
            capabilities: {userQuestions: true},
        };
        this.prompt = prompt;
        this.resume = resume;
        this.expectedSandbox = fullAccess ? 'danger-full-access' : 'read-only';
        this.expectedApprovalPolicy = approvalRequests ? 'ask' : 'never';
        this.phase = 'initialize';
        this.pending = new Map();
        this.toolInputs = new Map();
        this.nativeApprovalIds = new Map();
        this.endReason = null;
    }

    start(send) {
        this.send = send;
        return send({jsonrpc: '2.0', id: 'qc-init', method: 'initialize', params: this.initialize});
    }

    _request(id, method, params) {
        // Bound JSONL writes are serialized by the process runner.
        this.send({jsonrpc: '2.0', id, method, params}).catch(() => {});
    }

    _reply(id, result) {
        return this.send({jsonrpc: '2.0', id, result});
    }

    async respond({requestId, decision, questionDrafts, alwaysAllow}) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.sending || alwaysAllow) return {sent: false};
        let result;
        if (pending.questions) {
            if (!['modify', 'allow', 'deny'].includes(decision)) return {sent: false};
            const answers = decision === 'modify' ? answerQuestions(pending.questions, questionDrafts) : null;
            if (decision === 'modify' && !answers) return {sent: false};
            result = answers ? {answers} : {cancelled: true};
        } else {
            if (!['allow', 'deny'].includes(decision)) return {sent: false};
            result = {outcome: decision === 'allow' ? 'allowed-once' : 'rejected'};
        }
        pending.sending = true;
        try {
            await this._reply(pending.id, result);
        } catch (_) {
            pending.sending = false;
            return {sent: false};
        }
        if (this.pending.get(requestId) !== pending || !pending.questions) return {sent: true};
        this.pending.delete(requestId);
        return {
            sent: true,
            event: {
                type: 'permission_resolved', requestId, toolName: pending.toolName,
                toolCallId: pending.callId,
                decision: result.cancelled ? 'deny' : decision,
            },
        };
    }

    read(frame) {
        if (frame.jsonrpc !== '2.0') return null;
        if (frame.method && frame.id !== undefined) return this._readRequest(frame);
        if (!frame.method) return this._readResult(frame);
        if (frame.params?.sessionId !== this.sessionId) return null;
        if (frame.method === 'user-question.cancelled') {
            for (const [requestId, request] of this.pending) {
                if (request.questions && request.nativeId === frame.params.requestId) {
                    this.pending.delete(requestId);
                    return {type: 'permission_resolved', requestId, toolName: request.toolName, decision: 'deny'};
                }
            }
        }
        if (frame.method !== 'session.event' || !['running', 'resuming'].includes(this.phase)) return null;
        const event = frame.params.event;
        const data = event?.data;
        if (!data) return null;
        switch (event.type) {
            case 'sandbox/mode':
                if (data.mode !== this.expectedSandbox) throw new Error('DSH SDK 沙箱与随问所选权限不符');
                return null;
            case 'approval/policy':
                if (data.policy !== this.expectedApprovalPolicy) throw new Error('DSH SDK 审批策略与随问所选权限不符');
                return null;
            default:
                break;
        }
        if (this.phase !== 'running') return null;
        switch (event.type) {
            case 'assistant/message': {
                const blocks = data.message?.content;
                if (!Array.isArray(blocks)) return null;
                const text = blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? '').slice(0, 65536)).join('\n');
                return text ? {type: 'text_snapshot', text, segmentId: String(event.seq ?? '')} : null;
            }
            case 'tool/call': {
                let input = data.arguments;
                if (typeof input === 'string') {
                    try { input = JSON.parse(input); } catch (_) { input = null; }
                }
                const callId = safeText(data.callId, 256);
                if (callId && input && typeof input === 'object' && !Array.isArray(input) && this.toolInputs.size < 128) {
                    this.toolInputs.set(callId, {name: data.name, input});
                }
                return normalizeEvent('dsh', {type: 'tool_call', tool: data.name, callId, input});
            }
            case 'approval/asked':
                if (data.callId && data.id && this.nativeApprovalIds.size < 128) {
                    this.nativeApprovalIds.set(data.callId, data.id);
                }
                return null;
            case 'approval/decided':
                for (const [requestId, request] of this.pending) {
                    if (!request.questions && request.nativeId === data.id) {
                        this.pending.delete(requestId);
                        this.nativeApprovalIds.delete(request.callId);
                        return {
                            type: 'permission_resolved', requestId, toolName: request.toolName,
                            toolCallId: request.callId, decision: data.outcome === 'allowed-once' ? 'allow' : 'deny',
                        };
                    }
                }
                return null;
            case 'tool/result':
                this.toolInputs.delete(data.message?.toolCallId);
                this.nativeApprovalIds.delete(data.message?.toolCallId);
                return data.message && normalizeEvent('dsh', {
                    type: 'tool_result', callId: data.message.toolCallId,
                    status: data.message.isError ? 'error' : 'completed', error: data.error,
                });
            case 'turn/end':
                this.endReason = data.reason;
                return null;
            default:
                return null;
        }
    }

    _readResult(frame) {
        if (frame.id === 'qc-init' && this.phase === 'initialize') {
            if (frame.result?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') {
                return this._finish({kind: 'error', error: {message: safeText(frame.error?.message) || 'DSH SDK 握手失败'}});
            }
            if (this.resume) {
                this.phase = 'resuming';
                this._request('qc-resume', 'session/resume', {sessionId: this.sessionId});
            } else {
                this._sendPrompt();
            }
        } else if (frame.id === 'qc-resume' && this.phase === 'resuming') {
            if (frame.error || !frame.result) {
                return this._finish({kind: 'error', error: {message: safeText(frame.error?.message) || 'DSH 未恢复既有会话'}});
            }
            this._sendPrompt();
        } else if (frame.id === 'qc-prompt' && this.phase === 'running') {
            if (frame.error || !frame.result?.messageId) {
                return this._finish({kind: 'error', error: {message: safeText(frame.error?.message) || 'DSH 未接收提问'}});
            }
            this._request('qc-wait', 'session/wait', {sessionId: this.sessionId});
        } else if (frame.id === 'qc-wait' && this.phase === 'running') {
            return this._finish(frame.error
                ? {kind: 'error', error: {message: safeText(frame.error.message)}}
                : this.endReason);
        }
        return null;
    }

    _sendPrompt() {
        this.phase = 'running';
        this._request('qc-prompt', 'session/prompt', {
            sessionId: this.sessionId, contentBlocks: [{type: 'text', text: this.prompt}],
        });
    }

    _finish(reason) {
        this.phase = 'shutdown';
        this._request('qc-shutdown', 'shutdown', undefined);
        const sessionId = reason?.kind === 'completed' ? this.sessionId : '';
        const result = normalizeEvent('dsh', {type: 'final', reason, sessionId});
        return {...result, authoritative: false};
    }

    _readRequest(frame) {
        if (!['approval/request', 'user-question/ask'].includes(frame.method)) return null;
        if (typeof frame.id !== 'string' && !Number.isSafeInteger(frame.id)) return null;
        const params = frame.params || {};
        const isQuestion = frame.method === 'user-question/ask';
        const questions = isQuestion ? decodeQuestions(params.questions) : null;
        const callId = safeText(params.callId, 256);
        const tool = this.toolInputs.get(callId);
        const nativeId = isQuestion ? safeText(params.requestId, 256) : this.nativeApprovalIds.get(callId);
        const allowed = nativeId && (isQuestion ? Boolean(questions)
            : this.initialize.approvalRequests && tool?.name === params.toolName && Boolean(tool?.input));
        const requestId = 'dsh:' + typeof frame.id + ':' + frame.id;
        if (this.pending.has(requestId)) return null;
        if (this.phase !== 'running' || params.sessionId !== this.sessionId || !allowed || this.pending.size >= 12) {
            this._reply(frame.id, isQuestion ? {cancelled: true} : {outcome: 'rejected'}).catch(() => {});
            return null;
        }
        const toolName = isQuestion ? 'AskUserQuestion' : safeText(params.toolName, 256);
        this.pending.set(requestId, {id: frame.id, nativeId, questions, toolName, callId});
        const event = normalizeEvent('zcode', {type: 'quickchat.permission_requested', payload: {
            requestId, toolName, toolCallId: callId,
            input: questions ? {questions} : tool.input,
            reason: safeText(params.reason), allowSessionRule: false,
        }});
        return event ? {...event, allowSkip: false} : null;
    }
}
