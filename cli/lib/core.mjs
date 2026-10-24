import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const resolveHome = () =>
  path.resolve(process.env.AMR_HOME || path.join(os.homedir(), 'agent-memory'));

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 15000,
    cwd: opts.cwd,
    shell: false,
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').trimEnd(),
    stderr: (r.stderr || '').trimEnd(),
    error: r.error,
  };
}

export const git = (repo, args, opts) => sh('git', ['-C', repo, ...args], opts);

// Canonicalize before comparing: git reports the long form of paths
// while env vars may carry 8.3 aliases (RUNNER~1) or symlinks.
const canon = (p) => {
  const r = path.resolve(p);
  // .native expands 8.3 aliases and symlinks; plain realpathSync keeps
  // 8.3 names as-is on Windows (verified).
  try {
    return fs.realpathSync.native(r);
  } catch {
    return r;
  }
};
const samePath = (a, b) => canon(a).toLowerCase() === canon(b).toLowerCase();

export function isMemoryRepo(dir) {
  if (!fs.existsSync(path.join(dir, 'MEMORY.md'))) return false;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top.code === 0 && samePath(top.stdout, dir);
}

export function ensureIdentity(repo) {
  const name = git(repo, ['config', 'user.name']);
  if (name.code !== 0 || !name.stdout.trim())
    git(repo, ['config', 'user.name', 'Agent Memory']);
  const email = git(repo, ['config', 'user.email']);
  if (email.code !== 0 || !email.stdout.trim())
    git(repo, ['config', 'user.email', 'agent-memory@localhost']);
}

export function ensureRepo() {
  const home = resolveHome();
  const empty =
    !fs.existsSync(home) || fs.readdirSync(home).length === 0;
  if (empty) {
    fs.mkdirSync(home, { recursive: true });
    sh('git', ['init'], { cwd: home });
    fs.writeFileSync(path.join(home, 'MEMORY.md'), '# Memory\n\n## Index\n');
    ensureIdentity(home);
    git(home, ['add', 'MEMORY.md']);
    git(home, ['commit', '-m', 'Create memory repo']);
    return home;
  }
  if (!isMemoryRepo(home))
    throw new Error(
      `${home} exists but is not an agent memory repo (needs its own git repo with MEMORY.md at top)`
    );
  return home;
}

export function projectFor(dir) {
  const top = sh('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0) return null;
  const toplevel = top.stdout.trim();
  const remote = sh('git', ['remote', 'get-url', 'origin'], { cwd: toplevel });
  const basis =
    remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : toplevel;
  const name =
    path
      .basename(toplevel)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
  const hash = crypto
    .createHash('sha1')
    .update(basis.toLowerCase())
    .digest('hex')
    .slice(0, 6);
  return { slug: `${name}-${hash}`, name: path.basename(toplevel), toplevel };
}

export function sanitizeFile(input) {
  let p = String(input).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  const norm = path.posix.normalize(p);
  if (norm.startsWith('..') || path.posix.isAbsolute(norm))
    throw new Error(`bad memory file path: ${input}`);
  return norm;
}

export const today = () => new Date().toISOString().slice(0, 10);

// Numeric flag with fallback — bad input gets the default, never NaN.
export const numFlag = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];
export const looksSecret = (text) =>
  SECRET_PATTERNS.some((re) => re.test(text));

const bulletText = (line) =>
  line
    .trim()
    .replace(/^-\s*/, '')
    .replace(/(\s*\[[^\]]*\])+\s*$/, '')
    .trim()
    .toLowerCase();

export function entryExists(filePath, text) {
  if (!fs.existsSync(filePath)) return false;
  const target = bulletText(text);
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('- '))
    .some((l) => bulletText(l) === target);
}

export function insertEntry(filePath, entry, { beforeIndex = false } = {}) {
  let lines = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    : [];
  if (!lines.length || !lines[0].startsWith('#'))
    lines.unshift(`# ${path.basename(filePath, '.md')}`, '');
  const idx = lines.findIndex((l) => /^##\s+Index/.test(l));
  if (beforeIndex && idx >= 0) {
    const head = lines.slice(0, idx);
    while (head.length && head[head.length - 1].trim() === '') head.pop();
    head.push(entry, '');
    lines = [...head, ...lines.slice(idx)];
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(entry, '');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

export function addIndexLink(repo, relNoExt) {
  const mem = path.join(repo, 'MEMORY.md');
  if (!fs.existsSync(mem)) return false;
  const link = `- [[${relNoExt}]]`;
  const lines = fs.readFileSync(mem, 'utf8').split(/\r?\n/);
  if (lines.some((l) => l.trim() === link)) return false;
  let idx = lines.findIndex((l) => /^##\s+Index/.test(l));
  if (idx < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', '## Index');
    idx = lines.length - 1;
  }
  let ins = idx + 1;
  while (ins < lines.length && lines[ins].trim() !== '') ins++;
  lines.splice(ins, 0, link);
  fs.writeFileSync(mem, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return true;
}

export function withLock(repo, fn) {
  const lock = path.join(repo, '.git', 'amr.lock');
  const wait = (ms) => {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  };
  let acquired = false;
  for (let i = 0; i < 15 && !acquired; i++) {
    try {
      if (fs.existsSync(lock)) {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 60000) fs.unlinkSync(lock);
      }
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch {
      wait(200);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lock);
      } catch {}
    }
  }
}

export function commit(repo, files, msg) {
  ensureIdentity(repo);
  for (const f of files) git(repo, ['add', '--', f]);
  const r = git(repo, ['commit', '-m', msg]);
  return r.code === 0;
}

export function hasRemote(repo) {
  const r = git(repo, ['remote']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export function pullFfOnly(repo, timeout = 2000) {
  return git(repo, ['pull', '--ff-only'], { timeout });
}

const CONFIG_REL = 'amr.json';

export function loadConfig(repo) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(repo, CONFIG_REL), 'utf8')
    );
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

export function saveConfig(repo, cfg) {
  fs.writeFileSync(
    path.join(repo, CONFIG_REL),
    JSON.stringify(cfg, null, 2) + '\n'
  );
}

// Project files are projects/<name>-<hash>.md. A config key may be the
// full slug or just the repo name (case-insensitive).
export function listProjects(repo) {
  const dir = path.join(repo, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const slug = f.slice(0, -3);
      const dash = slug.lastIndexOf('-');
      return { slug, name: dash > 0 ? slug.slice(0, dash) : slug };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Config keys may be full slugs, slug-names, or raw repo basenames like
// "api.trackdub" — normalize the same way projectFor names slugs so all
// forms resolve.
export const normName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function resolveProjectSlug(repo, key) {
  const k = String(key).toLowerCase().replace(/\.md$/, '');
  const kn = normName(k);
  const all = listProjects(repo);
  const exact = all.find((p) => p.slug === k || p.slug === kn);
  if (exact) return exact.slug;
  const named = all.filter((p) => p.name === kn || p.name === k);
  return named[0]?.slug ?? null;
}

// Config entries may be keyed by slug or name (lowercase). Look up a
// project's policy/link entry by either form.
export function projectEntry(cfg, { slug, name }) {
  const projects = cfg.projects || {};
  for (const k of [slug, name && name.toLowerCase(), name && normName(name)]) {
    if (k && projects[k]) return projects[k];
  }
  return null;
}

// Entry kinds. `state` is session-scoped (what is open, what was just
// committed) and expires; everything else is durable knowledge.
export const KINDS = ['pitfall', 'decision', 'preference', 'fact', 'howto', 'state'];
export const STATE_TTL_DAYS = 2;

export const addDays = (days, from = new Date()) =>
  new Date(from.getTime() + days * 864e5).toISOString().slice(0, 10);

export const entryKind = (line) =>
  (String(line).match(/kind:\s*([a-z-]+)/) || [])[1] || null;

// An entry is expired when its expires: date is before `now` (YYYY-MM-DD).
export const isExpired = (line, now = today()) => {
  const d = (String(line).match(/expires:\s*(\d{4}-\d{2}-\d{2})/) || [])[1];
  return !!d && d < now;
};
