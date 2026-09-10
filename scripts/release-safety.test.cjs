const test = require('node:test');
const assert = require('node:assert/strict');
const { draftIds, run } = require('./release-safety.cjs');
const tag = 'v1.8.10';
const release = (id, extra = {}) => ({ id, tag_name: tag, draft: true, published_at: null, ...extra });
const assets = ['Sell.Con-1.8.10-arm64.dmg', 'Sell.Con-1.8.10.dmg', 'Sell.Con.Setup.1.8.10.exe']
  .map(name => ({ name, state: 'uploaded', size: 100 }));

test('finds all duplicate drafts and ignores other tags', () => {
  assert.deepEqual(draftIds([release(1), release(2), release(3, { tag_name: 'v1.8.9', draft: false })], tag), [1, 2]);
});
test('published or inconsistent published timestamp is rejected', () => {
  for (const extra of [{ draft: false }, { published_at: '2026-09-11' }]) {
    assert.throws(() => draftIds([release(1, extra)], tag), /must never/);
  }
});
test('preflight never writes and propagates list failures', () => {
  assert.deepEqual(run('preflight', tag, null, action => {
    assert.equal(action, 'list'); return [release(1)];
  }), [1]);
  assert.throws(() => run('preflight', tag, null, () => { throw Error('API unavailable'); }), /unavailable/);
});
test('keeps complete replacement and deletes only older drafts', () => {
  const deleted = [];
  const data = [release(1), release(2), release(3, { assets })];
  assert.deepEqual(run('cleanup', tag, '3', (action, id) => {
    if (action === 'list') return data;
    if (action === 'get') return data.find(row => row.id === id);
    deleted.push(id);
  }), [1, 2]);
  assert.deepEqual(deleted, [1, 2]);
});
test('incomplete or wrong replacement assets never delete old drafts', () => {
  for (const badAssets of [assets.slice(0, 2), [...assets, assets[0]], assets.map(a => ({ ...a, size: 0 }))]) {
    assert.throws(() => run('cleanup', tag, '2', (action, id) => {
      assert.notEqual(action, 'delete');
      return action === 'list' ? [release(1), release(2)] : release(id, { assets: badAssets });
    }), /three complete/);
  }
});
test('manual publication after listing prevents every deletion', () => {
  assert.throws(() => run('cleanup', tag, '3', (action, id) => {
    assert.notEqual(action, 'delete');
    if (action === 'list') return [release(1), release(2), release(3)];
    return release(id, { assets, draft: id !== 2 });
  }), /must never/);
});
test('invalid tag and missing replacement are rejected', () => {
  assert.throws(() => draftIds([], 'v1.8.10; echo unsafe'), /Invalid/);
  assert.throws(() => run('cleanup', tag, '2', () => [release(1)]), /not present/);
});
