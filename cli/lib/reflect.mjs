// Background reflection: `amr reflect` (the Stop hook) detaches
// `amr reflect-run`, which asks a judge model to pull durable learnings
// out of the transcript and saves them itself. The session never sees a
// prompt or a response.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdAdd, episodicHits } from './commands.mjs';
import { KINDS, resolveHome } from './core.mjs';
import { resolveJudge, runJudge } from './judge.mjs';

const MAX_CHARS = 14000;
const MAX_ENTRIES = 5;

// Recent user/assistant prose, tool calls and results dropped.
export function transcriptText(file) {
  const parts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message?.content;
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : '';
    if (text.trim()) parts.push(`${o.type.toUpperCase()}: ${text.trim()}`);
  }
  return parts.join('\n\n').slice(-MAX_CHARS);
}

const PROMPT = (convo) => `You curate a long-term memory for a coding agent. Below is the tail of a session transcript. Extract at most ${MAX_ENTRIES} durable learnings that would help a FRESH session on this project: pitfalls, decisions, user preferences, conventions, root causes. Skip anything the user stated only as a one-off task, anything already obvious from the code, and all session state (PR numbers, commit SHAs, run IDs, "what I just did").

Write each as "When X, do Y, because Z" when it is a pitfall, else one plain sentence. Mark repo-specific ones project:true, machine/user-wide ones project:false.

Reply with ONLY a JSON array, e.g. [{"text":"...","project":true,"kind":"pitfall"}] (kind is one of pitfall|decision|preference|fact|howto). Reply [] if nothing qualifies.

TRANSCRIPT:
${convo}`;

export function parseEntries(reply) {
  const m = String(reply || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : [])
      .filter((e) => e && typeof e.text === 'string' && e.text.trim())
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function log(msg) {
  try {
    const f = path.join(resolveHome(), '.git', 'amr-reflect.log');
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// argv: path to a JSON file holding the hook payload.
export function cmdReflectRun(payloadFile) {
  let p = {};
  try {
    p = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    fs.unlinkSync(payloadFile);
  } catch {
    return;
  }
  const judge = resolveJudge(process.env.AMR_REFLECT_JUDGE || 'auto');
  if (!judge) return log('no judge available; skipped');
  let convo;
  try {
    convo = transcriptText(p.transcript_path);
  } catch {
    return log('transcript unreadable; skipped');
  }
  if (!convo.trim()) return;
  const entries = parseEntries(runJudge(judge, PROMPT(convo)));
  let saved = 0;
  for (const e of entries) {
    if (episodicHits(e.text).length) continue;
    const real = process.stdout.write;
    process.stdout.write = () => true; // cmdAdd chatter
    try {
      cmdAdd(e.text, {
        cwd: p.cwd || process.cwd(),
        ...(e.project ? { project: true } : {}),
        ...(KINDS.includes(e.kind) ? { kind: e.kind } : {}),
      });
      saved++;
    } catch (err) {
      log(`add failed: ${err.message}`);
    } finally {
      process.stdout.write = real;
    }
  }
  log(`judge ${judge}: ${saved}/${entries.length} saved`);
}
