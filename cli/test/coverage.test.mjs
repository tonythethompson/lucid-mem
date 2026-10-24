import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, read, run, tmpdir } from './helpers.mjs';

function setup() {
  const amrHome = tmpdir();
  const fakeHome = tmpdir();
  assert.equal(run(['ensure'], { amrHome, fakeHome }).status, 0);
  return { amrHome, fakeHome };
}

function claudeJsonl(fakeHome, lines) {
  const dir = path.join(fakeHome, '.claude', 'projects', 'projx');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(
    file,
    lines
      .map((text) =>
        JSON.stringify({ type: 'user', message: { content: text } })
      )
      .join('\n')
  );
}

test('coverage reports save rate and lists missed durable signals', () => {
  const { amrHome, fakeHome } = setup();
  run(['add', 'prefers tabs over spaces'], { amrHome, fakeHome });
  claudeJsonl(fakeHome, [
    // saved: near-verbatim in corpus
    'I prefer tabs over spaces everywhere, remember that',
    // durable but never saved
    'we decided the cache TTL should always be 300 seconds',
    // a code dump that merely contains a marker word — excluded
    'const x = () => { if (a) { return b; } }; // never skip this check',
    // ordinary chatter — not durable
    'looks good, ship it',
  ]);
  const r = run(['coverage', '--days', '7', '--no-log'], {
    amrHome,
    fakeHome,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\/2 durable signals covered — save rate 50%/);
  assert.match(r.stdout, /cache TTL should always be 300/);
  assert.ok(!r.stdout.includes('never skip this check'));

  // Misses land in the pending queue the next session reviews.
  const pending = path.join(amrHome, 'dreams', 'pending-saves.md');
  assert.match(read(pending), /cache TTL should always be 300/);

  // The queue must not self-cover: the same miss stays a miss.
  const r2 = run(['coverage', '--days', '7', '--no-log'], {
    amrHome,
    fakeHome,
  });
  assert.match(r2.stdout, /save rate 50%/);

  // And it surfaces in context for both modes (outside-mode here).
  const ctx = run(['context'], { amrHome, fakeHome, cwd: fakeHome });
  assert.match(ctx.stdout, /Pending memory candidates/);
  assert.match(ctx.stdout, /cache TTL/);
});

test('--judge env refines verdicts: prunes recall cues, catches paraphrase saves, proposes entries', () => {
  const { amrHome, fakeHome } = setup();
  run(['add', 'package manager is pnpm'], { amrHome, fakeHome });
  claudeJsonl(fakeHome, [
    // deterministic: durable (always), covered? terms don't overlap → miss
    'we always use pnpm for this repo, never npm',
    // deterministic: durable marker, but it is a recall cue not a save
    'going back to the sidebar rework, remember that?',
  ]);
  // Judge says: 0 is covered (paraphrase of the saved entry), 1 is not
  // durable (recall cue). Deterministic-only run would say 0/2.
  const judge = path.join(fakeHome, 'fake-judge.mjs');
  fs.writeFileSync(
    judge,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify({flagged:[
      {i:0,durable:true,covered:true},
      {i:1,durable:false,kind:'recall'}
    ],unflagged:[]})))`
  );
  const r = run(['coverage', '--days', '7', '--no-log', '--judge', 'env'], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `node "${judge}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judge:env/);
  assert.match(r.stdout, /1\/1 durable signals covered — save rate 100%/);
  // Nothing missed → the queue is empty.
  assert.ok(!fs.existsSync(path.join(amrHome, 'dreams', 'pending-saves.md')));
});

test('judge samples the unflagged pool and extrapolates the miss rate', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, [
    'we decided the cache TTL should always be 300 seconds', // flagged, unsaved
    'ok cool, that approach works for me', // chatter — judge calls index 1 durable
    'thanks, moving on to the next piece',
    'sounds right to me, go ahead with it',
  ]);
  const judge = path.join(fakeHome, 'fake-judge.mjs');
  fs.writeFileSync(
    judge,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const i=JSON.parse(JSON.stringify(s));
      console.log(JSON.stringify({flagged:[{i:0,durable:true,covered:false,proposal:'cache TTL is 300s'}],
        unflagged:[{i:1,durable:true,covered:false,proposal:'deploys happen fridays'}]}))})`
  );
  const r = run(['coverage', '--days', '7', '--judge', 'env'], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `node "${judge}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unflagged sample: 1\/3 durable/);
  assert.match(r.stdout, /adjusted save rate ≈ 0%/);
  assert.match(r.stdout, /\(unflagged\)/);
  const pending = read(path.join(amrHome, 'dreams', 'pending-saves.md'));
  assert.match(pending, /deploys happen fridays/);
});

function workTranscript(dir, n) {
  const file = path.join(dir, 'work.jsonl');
  const row = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
  };
  fs.writeFileSync(file, Array(n).fill(JSON.stringify(row)).join('\n'));
  return file;
}

test('reflect stays quiet without real work, blocks once after it, then rate-limits', () => {
  const { amrHome, fakeHome } = setup();
  const hook = (payload) =>
    run(['reflect'], {
      amrHome,
      fakeHome,
      env: { AMR_REFLECT: 'block' },
      input: JSON.stringify(payload),
    });
  const sid = `s-${path.basename(fakeHome)}`;
  const quiet = hook({ session_id: sid, transcript_path: workTranscript(fakeHome, 2) });
  assert.equal(quiet.stdout, '');
  const t = workTranscript(fakeHome, 7);
  const j = JSON.parse(hook({ session_id: sid, transcript_path: t }).stdout);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /amr add/);
  assert.equal(hook({ session_id: sid, transcript_path: t }).stdout, '');
  assert.equal(
    hook({ session_id: sid, stop_hook_active: true, transcript_path: t }).stdout,
    ''
  );
});

test('add --project "text" keeps the text; episodic entries get a warning', () => {
  const { amrHome, fakeHome } = setup();
  const repo = initRepo(tmpdir());
  const r = run(['add', '--project', 'PR #788 open, commit 1f06cc1b not pushed'], {
    amrHome, fakeHome, cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved to projects\//);
  assert.match(r.stderr, /session state/);
  assert.match(r.stderr, /commit SHA/);
});

test('a failing judge falls back to deterministic results', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  const judge = path.join(fakeHome, 'bad-judge.mjs');
  fs.writeFileSync(judge, 'process.exit(3)');
  const r = run(['coverage', '--days', '7', '--no-log', '--judge', 'env'], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `node "${judge}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judge env failed — deterministic results/);
  assert.match(r.stdout, /save rate 0%/);
});

test('pending queue drains once a missed signal is saved', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  run(['coverage', '--no-log'], { amrHome, fakeHome });
  const pending = path.join(amrHome, 'dreams', 'pending-saves.md');
  assert.ok(fs.existsSync(pending));

  run(['add', 'db migration runs weekly'], { amrHome, fakeHome });
  const r = run(['coverage', '--no-log'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\/1 .*100%/);
  assert.ok(!fs.existsSync(pending));
});

test('coverage logs a trend line by default; --no-log skips it', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  const log = path.join(amrHome, 'dreams', 'coverage.jsonl');
  run(['coverage', '--no-log'], { amrHome, fakeHome });
  assert.ok(!fs.existsSync(log));
  const r = run(['coverage'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const entry = JSON.parse(readLines(log).at(-1));
  assert.equal(entry.durable, 1);
  assert.equal(entry.covered, 0);
  assert.equal(entry.rate, 0);
});

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

test('reflect-run saves judge entries, skipping episodic ones', () => {
  const { amrHome, fakeHome } = setup();
  const repo = initRepo(tmpdir());
  const transcript = path.join(fakeHome, 'convo.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'user', message: { content: 'ci flaked again' } })
  );
  const judge = path.join(fakeHome, 'good-judge.mjs');
  fs.writeFileSync(
    judge,
    'console.log(JSON.stringify([' +
      '{text:"When CI flakes, re-run once before debugging, because runners are flaky",project:true},' +
      '{text:"PR #788 open, commit 1f06cc1b not pushed",project:true}]))'
  );
  const payload = path.join(fakeHome, 'payload.json');
  fs.writeFileSync(
    payload,
    JSON.stringify({ transcript_path: transcript, cwd: repo })
  );
  const r = run(['reflect-run', payload], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `"${process.execPath}" "${judge}"`, AMR_REFLECT_JUDGE: 'env' },
  });
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(path.join(amrHome, 'projects'));
  assert.equal(files.length, 1);
  const body = read(path.join(amrHome, 'projects', files[0]));
  assert.match(body, /re-run once before debugging/);
  assert.doesNotMatch(body, /PR #788/);
  assert.equal(r.stdout, '');
});
