'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

test('content script is limited to X domains', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(
    manifest.content_scripts[0].matches,
    ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.twitter.com/*']
  );
  assert.ok(!manifest.content_scripts[0].matches.includes('<all_urls>'));
});

test('required host permissions do not include arbitrary sites', () => {
  for (const pattern of manifest.host_permissions) {
    assert.ok(!pattern.startsWith('http://'), pattern + ' should not be a required permission');
    assert.ok(pattern !== '<all_urls>');
  }
});

test('extension only asks for storage', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
});

test('all files referenced by the manifest exist', () => {
  const files = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts[0].js,
    ...manifest.content_scripts[0].css
  ]);
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file + ' is missing');
  }
});
