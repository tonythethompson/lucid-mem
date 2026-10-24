import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cmdAdd,
  cmdContext,
  cmdEnsure,
  cmdIndex,
  cmdLink,
  cmdPeer,
  cmdPolicy,
  cmdReflect,
  cmdRemote,
  cmdSearch,
  cmdSync,
  cmdUnlink,
  cmdUsed,
  cmdUpdate,
} from './commands.mjs';
import { cmdDiscover } from './discover.mjs';
import { cmdDream } from './dream.mjs';
import { cmdReflectRun } from './reflect.mjs';
import { cmdIds, cmdSupersede } from './ids.mjs';
import { cmdHarvest } from './harvest.mjs';
import { cmdCoverage } from './coverage.mjs';
import { cmdDoctor, cmdInstall, cmdUninstall } from './install.mjs';
import { cmdServe } from './serve.mjs';

const USAGE = `amr: agent memory CLI (lucid-mem)

usage: amr <command> [args] [flags]

  ensure                        create/verify the memory repo ($AMR_HOME, default ~/agent-memory)
  context [dir] [--budget N]    ranked session digest (default 6000 chars; --full ignores): project-scoped inside a known repo; global + pooled projects outside
  add "text"                    save a memory entry
  update <id|"match"> "text"   replace an entry in place; ids look like a3f9 (shown in entry meta)
  supersede <id> ["text"]       retire an entry to archive/superseded.md, optionally with a replacement
  used <id...>                  mark entries that helped (boosts them in context ranking)
  ids                           assign ids to entries that lack them
  search "term"                 grep all memory files
  index                         rebuild MEMORY.md index from files on disk
  link <name...> [--for <p>]    auto-attach other repos' memories to this repo's sessions
  unlink <name...> [--for <p>]  remove auto-attach links
  policy [name key bool]        per-repo policy: noglobal, private (no args = list)
  peer [add <url>|remove <n>]   attach another memory repo (multiplayer); clones into <AMR_HOME>-peers
  remote [set <url>]            show or set the git remote (private repos only)
  sync                          pull --rebase + push (no-op without a remote)
  doctor                        check repo, PATH, and per-host wiring
  dream [--days N] [--fix] [--compact] [--keep N] [--json]   memory health; --fix cleans up, --compact archives overflow; --spin plays the animation
  harvest [--days N] [--json] [--extract] [--max N] [--min C]   list transcripts; --extract streams normalized user messages
  discover [--days N] [--min N] [--json]   rank repos by transcript mentions; shows memory coverage + suggested links
  coverage [--days N] [--json] [--no-log] [--judge claude|codex|env]  save-rate metric: durable transcript signals vs memory repo
  reflect                       Stop hook: gated, saves learnings via a background judge (AMR_REFLECT=block prompts in-session)
  install [--host a,b|all]      wire hooks + rules + MCP into detected agent hosts
  uninstall [--host a,b|all]    remove amr hooks + rules + MCP entries
  serve                         stdio MCP server (memory_context/add/search/update)

flags:
  --project[=name]              scope the entry to the current repo, or a named project
  --also a,b                    attach extra projects to the context digest
  --file <topic>                write to a topic file instead of MEMORY.md
  --kind <k>                    add kind metadata (preference|fact|decision|howto)
  --cwd <dir>                   resolve project/host context against this dir
  --allow-secret                bypass secret-shape refusal
`;

// Flags that never take a value. Without this, `amr add --project "text"`
// swallowed the entry text as the flag's value. --project scopes by name
// only in the `--project=name` form.
const BOOL_FLAGS = new Set([
  'project', 'full', 'json', 'fix', 'compact', 'inline', 'spin',
  'extract', 'no-log', 'allow-secret', 'if-stale-off',
]);

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (
        !BOOL_FLAGS.has(a.slice(2)) &&
        i + 1 < argv.length &&
        !argv[i + 1].startsWith('--')
      )
        flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

// Subcommands invoked by host session hooks. AMR_HOOKS_OFF is set on
// processes amr spawns itself (the coverage judge) so a judge session's
// own hooks don't pay for context/sync/dream/coverage on the way in
// and out — that overhead dominated judge latency — and so a judge
// session's Stop event doesn't get hijacked by `reflect` mid-answer.
const HOOK_CMDS = new Set(['context', 'sync', 'dream', 'coverage', 'reflect']);

export function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, pos } = parseFlags(rest);
  if (process.env.AMR_HOOKS_OFF && HOOK_CMDS.has(cmd)) return 0;
  try {
    switch (cmd) {
      case 'ensure':
        return cmdEnsure();
      case 'context':
        return cmdContext({ ...flags, cwd: flags.cwd || pos[0] });
      case 'add': {
        const text = pos.join(' ');
        if (!text.trim()) {
          process.stderr.write('usage: amr add "text"\n');
          process.exitCode = 1;
          return;
        }
        return cmdAdd(text, flags);
      }
      case 'update': {
        const [match, ...t] = pos;
        const text = t.join(' ');
        if (!match || !text.trim()) {
          process.stderr.write('usage: amr update "match" "new text"\n');
          process.exitCode = 1;
          return;
        }
        return cmdUpdate(match, text, flags);
      }
      case 'search': {
        const term = pos.join(' ');
        if (!term.trim()) {
          process.stderr.write('usage: amr search "term"\n');
          process.exitCode = 1;
          return;
        }
        return cmdSearch(term);
      }
      case 'index':
        return cmdIndex();
      case 'serve':
        return cmdServe();
      case 'link':
        return cmdLink(pos, flags);
      case 'unlink':
        return cmdUnlink(pos, flags);
      case 'policy':
        return cmdPolicy(pos);
      case 'peer':
        return cmdPeer(pos, flags);
      case 'remote':
        return cmdRemote(pos);
      case 'sync':
        return cmdSync();
      case 'doctor':
        return cmdDoctor();
      case 'dream':
        return cmdDream(flags);
      case 'harvest':
        return cmdHarvest(flags);
      case 'discover':
        return cmdDiscover(flags);
      case 'coverage':
        return cmdCoverage(flags);
      case 'reflect':
        return cmdReflect();
      case 'used':
        return cmdUsed(pos);
      case 'ids':
        return cmdIds();
      case 'supersede':
        if (!pos[0]) {
          process.stderr.write('usage: amr supersede <id> ["replacement text"]\n');
          process.exitCode = 1;
          return;
        }
        return cmdSupersede(pos[0], pos.slice(1).join(' '));
      case 'reflect-run':
        return cmdReflectRun(pos[0]);
      case 'install':
        return cmdInstall(flags);
      case 'uninstall':
        return cmdUninstall(flags);
      case 'version':
      case '--version':
      case '-v': {
        const pkg = JSON.parse(
          fs.readFileSync(
            path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
            'utf8'
          )
        );
        return process.stdout.write(`amr ${pkg.version}\n`);
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        return process.stdout.write(USAGE);
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exitCode = 1;
    }
  } catch (e) {
    process.stderr.write(`amr: ${e.message}\n`);
    process.exitCode = 1;
  }
}
