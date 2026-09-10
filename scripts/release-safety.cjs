const { execFileSync } = require('node:child_process');

function draftIds(releases, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Invalid release tag');
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.some(release => release.draft !== true || release.published_at)) {
    throw new Error(`Published release ${tag} must never be replaced`);
  }
  return matches.map(release => release.id);
}

function verifyReplacement(release, tag) {
  draftIds([release], tag);
  if (release.tag_name !== tag) throw new Error('Replacement tag differs');
  const version = tag.slice(1);
  const expected = [
    `Sell.Con-${version}-arm64.dmg`,
    `Sell.Con-${version}.dmg`,
    `Sell.Con.Setup.${version}.exe`,
  ];
  if (release.assets?.length !== 3 || expected.some(name =>
    !release.assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0)
  )) throw new Error('Replacement requires three complete platform assets');
}

function run(action, tag, replacementId, api) {
  // The tag endpoint may omit drafts. List all pages and fail on API errors.
  const releases = api('list');
  const ids = draftIds(releases, tag);
  if (action === 'preflight') return ids;
  if (action !== 'cleanup' || !/^\d+$/.test(String(replacementId))) throw new Error('Invalid cleanup request');
  const keep = Number(replacementId);
  if (!ids.includes(keep)) throw new Error('Replacement draft is not present');
  verifyReplacement(api('get', keep), tag);
  const old = ids.filter(id => id !== keep);
  // Recheck every old draft before deleting any, in case of a manual publish.
  for (const id of old) {
    const current = api('get', id);
    if (current.tag_name !== tag) throw new Error('Old draft tag changed');
    draftIds([current], tag);
  }
  for (const id of old) api('delete', id);
  return old;
}

if (require.main === module) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== 'sell-con/releases') throw new Error('Wrong release repository');
  const api = (action, id) => {
    const args = action === 'list'
      ? ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]
      : ['api', `repos/${repo}/releases/${id}`, ...(action === 'delete' ? ['-X', 'DELETE'] : [])];
    const output = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (action === 'delete') return;
    const data = JSON.parse(output);
    return action === 'list' ? data.flat() : data;
  };
  console.log(JSON.stringify(run(process.argv[2], process.argv[3], process.argv[4], api)));
}

module.exports = { draftIds, verifyReplacement, run };
