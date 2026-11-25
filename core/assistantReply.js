const MEMORY_ADDRESS = /^memory:\/\/(computer|project)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.md)$/;
const MAX_CHOICES = 4;

export function cleanReplyReferences(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.filter(value => typeof value === 'string' && MEMORY_ADDRESS.test(value)))].slice(0, 3);
}

export function cleanReplyChoices(values) {
    if (!Array.isArray(values)) return [];
    const labels = values.filter(value => typeof value === 'string' &&
        value.length <= 80 && value.trim() && !/[\n\r\p{C}]/u.test(value)).map(value => value.trim());
    return [...new Set(labels)].slice(0, MAX_CHOICES);
}

export function cleanMemoryReason(value) {
    return typeof value === 'string' ? value.replace(/[\p{C}]/gu, ' ').trim().slice(0, 120) : '';
}

export function splitAssistantReply(text, marker, allowedReferences, {partial = false} = {}) {
    if (!marker) return {text};
    const boundary = text.indexOf('\n' + marker);
    const startsWithMarker = text.startsWith(marker);
    if (boundary < 0 && !startsWithMarker) return {text: partial ? stripStreamingReplyMetadata(text, marker) : text};
    const visible = boundary < 0 ? '' : text.slice(0, boundary).trimEnd();
    if (partial) return {text: visible};
    const metadata = text.slice((startsWithMarker ? 0 : boundary + 1) + marker.length).trim();
    if (metadata.length > 1500) return {text: visible};
    try {
        const reply = JSON.parse(metadata);
        const memoryReferences = cleanReplyReferences(reply?.used).filter(address => allowedReferences?.has(address));
        const taskChoices = cleanReplyChoices(reply?.choices);
        return {text: visible, memoryReferences,
            memoryReason: memoryReferences.length ? cleanMemoryReason(reply?.reason) : '',
            taskChoices: taskChoices.length >= 2 ? taskChoices : []};
    } catch (_) {
        return {text: visible};
    }
}

export function stripStreamingReplyMetadata(text, marker) {
    if (!marker) return text;
    const boundary = text.indexOf('\n' + marker);
    if (text.startsWith(marker)) return '';
    if (boundary >= 0) return text.slice(0, boundary).trimEnd();
    const lastLine = text.lastIndexOf('\n');
    const suffix = text.slice(lastLine + 1);
    if (suffix.startsWith('[') && marker.startsWith(suffix)) return text.slice(0, lastLine < 0 ? 0 : lastLine).trimEnd();
    return text;
}

export function cleanTaskProgress(value) {
    if (!value || typeof value !== 'object') return null;
    const clean = names => Array.isArray(names)
        ? names.filter(name => typeof name === 'string' && name.trim() && !/[\p{C}]/u.test(name))
            .slice(0, 5).map(name => name.slice(0, 64)) : [];
    const completed = clean(value.completed);
    const blocked = clean(value.blocked);
    const unconfirmed = clean(value.unconfirmed);
    return completed.length || blocked.length || unconfirmed.length ? {completed, blocked, unconfirmed} : null;
}
