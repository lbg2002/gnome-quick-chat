import test from 'node:test';
import assert from 'node:assert/strict';

import {deleteSessionDirectoryWithIo} from '../core/sessionEngine.js';

test('QA-04: failed deletion is reported instead of showing success', async () => {
    let removedDirectory = false;
    const res = await deleteSessionDirectoryWithIo(
        '/tmp/quick-chat-qa-delete', 'qa_delete_fail',
        {
            async unlink() { throw new Error('EACCES: permission denied'); },
            async rmdir() { removedDirectory = true; },
        }
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /EACCES/);
    assert.equal(removedDirectory, false, 'Stop immediately when removing a file fails');
});

test('QA-04: successful removal remains idempotent for known session files', async () => {
    const unlinked = [];
    let directories = 0;
    const res = await deleteSessionDirectoryWithIo(
        '/tmp/quick-chat-qa-delete', 'qa_delete_success',
        {
            async unlink(p) { unlinked.push(p); },
            async rmdir() { directories++; },
        }
    );
    assert.equal(res.ok, true);
    assert.ok(unlinked.some(p => p.endsWith('messages.jsonl')));
    assert.equal(directories, 1);
});

test('QA-04: rmdir failing after file removal is not reported as success', async () => {
    const res = await deleteSessionDirectoryWithIo(
        '/tmp/quick-chat-qa-delete', 'qa_delete_not_empty',
        {
            async unlink() {},
            async rmdir() { throw new Error('ENOTEMPTY'); },
        }
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /ENOTEMPTY/);
});
