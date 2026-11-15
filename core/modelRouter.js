// Pure-JS Local Smart Model & Backend Router (Stage F6).
// 100% deterministic local rules — ZERO extra LLM/network calls per prompt!
// Hard Security Invariant:
//   - NEVER recommends or enables `mode === 'full'`!
//   - NEVER expands file, shell, or session approval permissions!
//   - Always user-overridable; prefers fast OpenAI Q&A for general chat and ZCode/Codex `readonly` for Agent tasks.

const AGENT_WORKSPACE_PATTERNS = [
    /(?:^|\s)(?:~\/|\/home\/|\/etc\/|\/var\/|\/opt\/|\/usr\/|\.\/|\.\.\/)\S+/,
    /(?:读取|查看|搜索|查找|修改|编辑|重构|检查|运行|执行).{0,12}(?:当前目录|工作区|仓库|项目|文件|日志|配置|脚本|测试)/,
    /\b(?:git\s+(?:status|diff|log)|npm\s+test|pytest|cargo\s+test|journalctl|systemctl|ls\s+-la)\b/i,
];

const COMPLEX_CODE_PATTERNS = [
    /```[\s\S]{120,}```/,
    /\b(?:refactor|architecture|deadlock|race\s+condition|memory\s+leak|segfault|TypeError|SyntaxError|ReferenceError)\b/i,
    /(?:多文件|架构重构|并发竞争|内存泄漏|全仓搜索|单元测试|代码审查|定位\s*Bug)/i,
];

const DEEP_REASONING_PATTERNS = [
    /(?:严谨证明|数学推导|时间复杂度证明|形式化验证|深度对比权衡|逐步推理|定理证明)/,
    /\b(?:prove\s+that|formal\s+proof|asymptotic\s+complexity|dynamic\s+programming\s+derivation)\b/i,
];

/**
 * Classifies prompt + attachments into one of:
 *   - `'simple_qa'` (日常简短问答 / 翻译 / 润色)
 *   - `'file_read'` (读取本地文件 / 目录查看)
 *   - `'complex_code'` (复杂代码排查 / 仓库任务)
 *   - `'deep_reasoning'` (深度数学 / 算法 / 架构推理)
 */
export function classifyPromptIntentLocally(promptText = '', attachments = []) {
    const text = String(promptText || '').trim();
    const attList = Array.isArray(attachments) ? attachments : [];

    const hasPathOnlyAttachment = attList.some(a => a?.kind === 'file_path');
    const hasTerminalLog = attList.some(a => a?.kind === 'terminal_log');

    if (hasPathOnlyAttachment) {
        return 'file_read';
    }
    if (AGENT_WORKSPACE_PATTERNS.some(re => re.test(text))) {
        return COMPLEX_CODE_PATTERNS.some(re => re.test(text)) ? 'complex_code' : 'file_read';
    }
    if (DEEP_REASONING_PATTERNS.some(re => re.test(text))) {
        return 'deep_reasoning';
    }
    if (hasTerminalLog || COMPLEX_CODE_PATTERNS.some(re => re.test(text))) {
        return 'complex_code';
    }
    return 'simple_qa';
}

/**
 * Clamps any candidate mode so routing can NEVER suggest or switch into `'full'` mode!
 */
export function clampSafeRecommendedMode(backend, candidateMode = 'readonly') {
    if (backend === 'openai') return 'chat';
    if (backend === 'codex') return 'readonly';
    if (candidateMode === 'chat') return 'chat';
    // Even if `candidateMode === 'full'`, strictly downgrade to `'readonly'`!
    return 'readonly';
}

/**
 * Recommends a user-configured backend, model, and reasoning effort using strictly local heuristics.
 * Returns `null` if the current configuration already matches or no better configured target exists.
 */
export function recommendRouteLocally({
    promptText = '',
    attachments = [],
    currentBackend = 'unconfigured',
    currentModel = '',
    currentMode = 'readonly',
    currentEffort = 'default',
    availableBackends = [],
    profiles = {},
    dismissedKeys = null,
} = {}) {
    const cleanText = String(promptText || '').trim();
    if (!cleanText && (!Array.isArray(attachments) || attachments.length === 0)) {
        return null;
    }

    const available = new Set(Array.isArray(availableBackends) ? availableBackends : []);
    if (available.size === 0) return null;

    const category = classifyPromptIntentLocally(cleanText, attachments);

    let targetBackend = currentBackend;
    let targetEffort = currentEffort || 'default';
    let targetMode = clampSafeRecommendedMode(currentBackend, currentMode);
    let reasonLabel = '';

    if (category === 'simple_qa') {
        // Prefer fast OpenAI Q&A when configured so simple questions avoid spawning heavy CLI Agent processes
        if (available.has('openai') && currentBackend !== 'openai') {
            targetBackend = 'openai';
            targetMode = 'chat';
            targetEffort = 'fast';
            reasonLabel = '简单问答推荐使用轻量 OpenAI 接口快速响应（无需启动本地 Agent 进程）';
        } else {
            return null;
        }
    } else if (category === 'file_read' || category === 'complex_code') {
        const preferredAgent = available.has('zcode')
            ? 'zcode'
            : (available.has('codex') ? 'codex' : '');
        if (preferredAgent && currentBackend === 'openai') {
            targetBackend = preferredAgent;
            targetMode = clampSafeRecommendedMode(preferredAgent, 'readonly');
            targetEffort = category === 'complex_code' ? 'standard' : 'default';
            const agentTitle = preferredAgent === 'zcode' ? 'ZCode 需审批 Agent' : 'Codex 只读沙箱 Agent';
            reasonLabel = category === 'file_read'
                ? `检测到本地文件/目录任务，建议切换至 ${agentTitle}`
                : `检测到代码分析/排查任务，建议切换至 ${agentTitle}`;
        } else {
            return null;
        }
    } else if (category === 'deep_reasoning') {
        if (available.has('openai') && currentBackend === 'openai' && currentEffort !== 'deep') {
            targetBackend = 'openai';
            targetMode = 'chat';
            targetEffort = 'deep';
            reasonLabel = '检测到复杂推理问题，建议将思考强度切换为「深入」';
        } else if (currentEffort !== 'deep' && (currentBackend === 'zcode' || currentBackend === 'codex')) {
            targetBackend = currentBackend;
            // Preserve user's safe mode (`chat` or `readonly`), NEVER enabling `full`!
            targetMode = clampSafeRecommendedMode(currentBackend, currentMode);
            targetEffort = 'deep';
            reasonLabel = '检测到复杂推理问题，建议将思考强度切换为「深入」';
        } else {
            return null;
        }
    }

    // Final safety gate: NEVER output `mode: 'full'` under any circumstance!
    targetMode = clampSafeRecommendedMode(targetBackend, targetMode);
    const targetProfile = profiles?.[targetBackend] || {};
    const targetModel = String(targetProfile.model || (targetBackend === currentBackend ? currentModel : '') || '').trim();

    const signature = `${category}:${targetBackend}:${targetModel}:${targetMode}:${targetEffort}`;
    if (dismissedKeys && typeof dismissedKeys.has === 'function' && dismissedKeys.has(signature)) {
        return null;
    }

    if (
        targetBackend === currentBackend &&
        targetEffort === (currentEffort || 'default') &&
        (!targetModel || targetModel === currentModel)
    ) {
        return null;
    }

    const backendDisplay = targetBackend === 'openai'
        ? 'OpenAI API'
        : targetBackend === 'codex'
            ? 'Codex (只读)'
            : 'ZCode (需审批)';

    return {
        category,
        signature,
        targetBackend,
        targetModel,
        targetMode, // Guaranteed `'chat'` or `'readonly'` — NEVER `'full'`!
        targetEffort,
        summaryLabel: `${backendDisplay}${targetModel ? ` · ${targetModel}` : ''}`,
        reasonLabel,
    };
}
