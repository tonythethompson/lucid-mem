import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read } from './helpers.mjs';

function seed(home, repo, text) {
  const r = run(['add', text, '--project'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0, r.stderr);
}

test('context in a non-git dir shows global memory only', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'prefers tabs'], { amrHome: home });
  const r = run(['context'], { amrHome: home, cwd: tmpdir() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /prefers tabs/);
});

test('context in a repo shows its project memory', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'app'), 'https://github.com/acme/app.git');
  run(['ensure'], { amrHome: home });
  seed(home, repo, 'app uses redis cache');
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /app uses redis cache/);
});

test('link attaches siblings and private transitively (links are owner curation)', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'a'), 'https://github.com/acme/a.git');
  const repoB = initRepo(path.join(base, 'b'), 'https://github.com/acme/b.git');
  const repoC = initRepo(path.join(base, 'c'), 'https://github.com/acme/c.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'a uses sqlite');
  seed(home, repoB, 'b uses kafka');
  seed(home, repoC, 'c is a leaf');

  // b links to a
  const link = run(['link', 'a'], { amrHome: home, cwd: repoB });
  assert.equal(link.status, 0);
  const inB = run(['context'], { amrHome: home, cwd: repoB });
  assert.match(inB.stdout, /a uses sqlite/);

  // c links to b; a is private -> still attaches transitively, since
  // the link chain is the owner's own curation
  run(['link', 'b'], { amrHome: home, cwd: repoC });
  run(['policy', 'a', 'private', 'true'], { amrHome: home, cwd: repoA });
  const inC = run(['context'], { amrHome: home, cwd: repoC });
  assert.match(inC.stdout, /b uses kafka/);
  assert.match(inC.stdout, /a uses sqlite/);

  // explicit --also still attaches the private project
  const explicit = run(['context', '--also', 'a'], { amrHome: home, cwd: repoC });
  assert.match(explicit.stdout, /a uses sqlite/);
});

test('unresolved link names surface a marker', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'solo'), 'https://github.com/acme/solo.git');
  run(['ensure'], { amrHome: home });
  seed(home, repo, 'solo entry');
  run(['link', 'ghost-project'], { amrHome: home, cwd: repo });
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.match(r.stdout, /unresolved \(no memory file\): ghost-project/);
});

test('unlink removes the auto-attach', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'x1'), 'https://github.com/acme/x1.git');
  const repoB = initRepo(path.join(base, 'y1'), 'https://github.com/acme/y1.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'x1 fact');
  seed(home, repoB, 'y1 fact');
  run(['link', 'x1'], { amrHome: home, cwd: repoB });
  assert.match(run(['context'], { amrHome: home, cwd: repoB }).stdout, /x1 fact/);
  run(['unlink', 'x1'], { amrHome: home, cwd: repoB });
  assert.ok(!run(['context'], { amrHome: home, cwd: repoB }).stdout.includes('x1 fact'));
});

test('context in a known project is project-scoped (no global section)', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'iso'), 'https://github.com/acme/iso.git');
  run(['ensure'], { amrHome: home });
  run(['add', 'global pref'], { amrHome: home });
  seed(home, repo, 'iso fact');
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.match(r.stdout, /iso fact/);
  assert.ok(!r.stdout.includes('global pref'));
  assert.ok(!r.stdout.includes('## Global'));
  assert.ok(!r.stdout.includes('## Recent project memory'));
});

test('outside context pools latest project entries; private and noglobal excluded', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'pa'), 'https://github.com/acme/pa.git');
  const repoB = initRepo(path.join(base, 'pb'), 'https://github.com/acme/pb.git');
  const repoC = initRepo(path.join(base, 'pc'), 'https://github.com/acme/pc.git');
  const repoD = initRepo(path.join(base, 'pd'), 'https://github.com/acme/pd.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'pa pooled fact');
  seed(home, repoB, 'pb pooled fact');
  seed(home, repoC, 'pc secret fact');
  seed(home, repoD, 'pd quiet fact');
  run(['policy', 'pc', 'private', 'true'], { amrHome: home, cwd: repoC });
  run(['policy', 'pd', 'noglobal', 'true'], { amrHome: home, cwd: repoD });
  const r = run(['context'], { amrHome: home, cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Recent project memory/);
  assert.match(r.stdout, /pa pooled fact/);
  assert.match(r.stdout, /pb pooled fact/);
  assert.ok(!r.stdout.includes('pc secret fact'));
  assert.ok(!r.stdout.includes('pd quiet fact'));
});

test('context ranks by kind/recency within a budget; search usage boosts entries', () => {
  const home = tmpdir();
  const run0 = (args) => run(args, { amrHome: home });
  run0(['ensure']);
  const mem = path.join(home, 'MEMORY.md');
  const rows = [];
  for (let i = 0; i < 10; i++)
    rows.push(`- old filler fact number ${i} about nothing much at all [added: 2025-01-01; kind: fact; id: a00${i}]`);
  rows.push('- When CI flakes, re-run once, because runners are flaky [added: 2026-10-20; kind: pitfall; id: b001]');
  fs.writeFileSync(mem, `# Memory\n\n${rows.join('\n')}\n\n## Index\n`);
  const tight = run0(['context', '--budget', '10']).stdout;
  assert.match(tight, /When CI flakes/);
  assert.match(tight, /lower-ranked entries omitted/);
  assert.equal((tight.match(/old filler fact/g) || []).length, 2);
  // usage boost: searching for one old entry should lift it above its peers
  run0(['search', 'number 7']);
  const after = run0(['context', '--budget', '10']).stdout;
  assert.match(after, /number 7/);
  assert.match(run0(['context', '--full']).stdout, /number 0/);
});
