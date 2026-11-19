import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseSemver, compareVersions, readReleaseInfo, parseSha256Sums, classifyInstallMode} from '../core/updateManager.js';

test('release versions are semantic, ordered, and reject unsafe tags', () => {
    assert.equal(parseSemver('v0.3.0')?.major, 0);
    assert.equal(compareVersions('0.3.1', 'v0.3.0'), 1);
    assert.equal(compareVersions('1.0.0', '0.9.99'), 1);
    assert.equal(compareVersions('0.3.0', 'v0.3.0'), 0);
    assert.equal(parseSemver('v1.2.3-rc1'), null);
    assert.equal(parseSemver('../../../evil'), null);
});

test('only exact GitHub release files of the trusted repository are accepted', () => {
    const tag='v0.4.0', zip='quick-chat@lbg2002.github.io.shell-extension.zip';
    const url=`https://github.com/lbg2002/gnome-quick-chat/releases/download/${tag}/${zip}`;
    const good={tag_name:tag, html_url:'https://github.com/lbg2002/gnome-quick-chat/releases/tag/'+tag, assets:[
        {name:zip, browser_download_url:url, size:90000},
        {name:'SHA256SUMS',browser_download_url:`https://github.com/lbg2002/gnome-quick-chat/releases/download/${tag}/SHA256SUMS`,size:250},
    ]};
    const parsed=readReleaseInfo(good);
    assert.equal(parsed.version,'0.4.0');
    assert.equal(parsed.zip.url,url);
    assert.equal(readReleaseInfo({...good,assets:[{...good.assets[0],browser_download_url:'https://evil.com/malware.zip'}]}).zip,null);
    assert.throws(()=>readReleaseInfo({...good,tag_name:'../../bad'}));
});

test('SHA256SUMS is matched by exact file name only', () => {
    const name='quick-chat@lbg2002.github.io.shell-extension.zip';
    const hash='a'.repeat(64);
    assert.equal(parseSha256Sums(`${hash}  ${name}\n`,name),hash);
    assert.equal(parseSha256Sums(`${hash}  bad-${name}\n`,name),null);
    assert.equal(parseSha256Sums('invalid',name),null);
});
test('user-installed extension and system package are never silently mixed', () => {
    assert.equal(classifyInstallMode(true,false),'user');
    assert.equal(classifyInstallMode(false,true),'system');
    assert.equal(classifyInstallMode(true,true),'mixed');
    assert.equal(classifyInstallMode(false,false),'unknown');
});
test('version metadata agrees with package release',()=>{
    const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
    const meta=JSON.parse(fs.readFileSync('metadata.json','utf8'));
    assert.equal(meta['version-name'],pkg.version);
});
