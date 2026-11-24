import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {MarkdownMemory} from '../core/markdownMemory.js';

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function rejects(operation, expected) {
    try {
        await operation();
    } catch (error) {
        assert(error.message.includes(expected), 'Unexpected failure: ' + error.message);
        return;
    }
    throw new Error('Expected rejection: ' + expected);
}

const root = GLib.dir_make_tmp('quickchat-memory-test-XXXXXX');
const computer = new MarkdownMemory('/tmp/workspace-a', root);
const switchedBackend = new MarkdownMemory('/tmp/workspace-a', root);
const otherWorkspace = new MarkdownMemory('/tmp/workspace-b', root);
const topic = 'memory://computer/desktop-apps.md';
const projectTopic = 'memory://project/preview.md';
const edits = [
    {scope: 'computer', name: 'MEMORY.md', markdown: '[浏览器](desktop-apps.md)'},
    {scope: 'computer', name: 'desktop-apps.md', markdown: '使用系统默认浏览器。'},
    {scope: 'project', name: 'MEMORY.md', markdown: '[预览](preview.md)'},
    {scope: 'project', name: 'preview.md', markdown: '先检查本项目配置。'},
];
try {
    const initial = await computer.snapshot();
    assert(initial.notes.size === 0, 'Empty memory');
    assert((await computer.edit(initial, new Map(), JSON.stringify(edits), () => true)).length === 4,
        'Model-authored Markdown files saved');
    const snapshot = await switchedBackend.snapshot();
    const recalled = await switchedBackend.recall(snapshot, JSON.stringify([topic, projectTopic, 'file:///etc/passwd']));
    assert(recalled.size === 2 && recalled.get(topic) === edits[1].markdown, 'Shared notes read back');
    assert(!(await otherWorkspace.snapshot()).notes.has(projectTopic), 'Project memory isolated');
    const info = Gio.File.new_for_path(computer.path('computer', 'desktop-apps.md'))
        .query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    assert((info.get_attribute_uint32('unix::mode') & 0o777) === 0o600, 'Private topic file');

    const replacement = {...edits[1], markdown: '每次重新查询系统的 HTTPS 关联。'};
    await switchedBackend.edit(snapshot, recalled, JSON.stringify([replacement]), () => true);
    const current = await computer.recall(await computer.snapshot(), JSON.stringify([topic]));
    assert(current.get(topic) === replacement.markdown, 'Second writer updates the shared topic');
    let rejected = false;
    try { await computer.edit(snapshot, recalled, JSON.stringify([edits[1]]), () => true); }
    catch (_) { rejected = true; }
    assert(rejected, 'Stale edits rejected');
    rejected = false;
    try {
        await computer.edit(snapshot, recalled, JSON.stringify([{...replacement, name: '../outside.md'}]), () => true);
    } catch (_) { rejected = true; }
    assert(rejected, 'Outside paths rejected');
    const beforeForget = await computer.snapshot();
    await rejects(() => computer.edit(beforeForget, current, JSON.stringify([
        {scope: 'computer', name: 'unlisted.md', markdown: 'missing index'},
    ]), () => true), '添加主题的相对链接');
    await rejects(() => computer.edit(beforeForget, current, JSON.stringify([
        {...edits[1], markdown: null},
    ]), () => true), '移除链接');
    await rejects(() => computer.edit(beforeForget, current, JSON.stringify([
        {...edits[0], markdown: '[失效](unlisted.md)'},
    ]), () => true), '没有对应文件');

    const projectPath = computer.path('project', 'preview.md');
    const journal = JSON.stringify({projectId: computer.projectId, edits: [
        {...edits[3], before: edits[3].markdown, markdown: 'Prepared next version'},
    ]});
    GLib.file_set_contents(computer.journal, journal);
    assert((await switchedBackend.recall(snapshot, JSON.stringify([projectTopic]))).get(projectTopic) ===
        'Prepared next version', 'A new instance replays a valid journal');
    GLib.file_set_contents(computer.journal, journal);
    GLib.file_set_contents(projectPath, 'Hand edited after interruption');
    assert((await otherWorkspace.snapshot()).notes.has(topic), 'Conflict does not block unrelated workspace');
    assert((await switchedBackend.recall(snapshot, JSON.stringify([projectTopic]))).get(projectTopic) ===
        'Hand edited after interruption', 'Recovery preserves hand-edited note');
    assert(!GLib.file_test(computer.journal, GLib.FileTest.EXISTS), 'Conflict is detached from active journal');
    const enumerator = Gio.File.new_for_path(root).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let archive;
    for (let item; (item = enumerator.next_file(null));) {
        if (item.get_name().startsWith('.conflict-')) archive = item.get_name();
    }
    enumerator.close(null);
    assert(archive && new TextDecoder().decode(GLib.file_get_contents(root + '/' + archive)[1]) === journal,
        'Prepared changes preserved for manual recovery');

    await computer.edit(await computer.snapshot(), current, JSON.stringify([
        {...edits[0], markdown: ''}, {...edits[1], markdown: null},
    ]), () => true);
    assert(!(await computer.snapshot()).notes.has(topic) &&
        !GLib.file_test(computer.path('computer', 'desktop-apps.md'), GLib.FileTest.EXISTS), 'Forgotten topic deleted');
} finally {
    const cleanup = Gio.Subprocess.new(['rm', '-rf', '--', root], Gio.SubprocessFlags.NONE);
    cleanup.wait_check(null);
}
print('GJS Markdown memory storage passed');
