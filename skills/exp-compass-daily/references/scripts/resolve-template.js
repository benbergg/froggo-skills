#!/usr/bin/env node
'use strict';
// Resolve DingTalk report template by name. Returns template_id on stdout,
// caches lookup (template_id + default_received_convs + fields) to a JSON file,
// and cross-checks fields against the 4 expected H1 anchors used by exp-compass-daily.
//
// Two modes:
//   --from-stdin            Read dingtalk-log get-template JSON from stdin (test-friendly).
//   --bin <path>            Spawn the given binary as `node <path> get-template ...`. Default:
//                           $CLAUDE_PLUGIN_ROOT/skills/dingtalk-log/scripts/dingtalk-log.js
//
// Exit codes:
//   0 — ok (stdout = template_id)
//   1 — bad args
//   2 — lookup failed (spawn / parse / errcode != 0)
//   3 — template_id missing or empty

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const EXPECTED_FIELDS = [
  '一、研发概览',
  '二、 需求推进',
  '三、今日产出',
  '四、今日总结',
];

function usage() {
  return [
    'Usage: resolve-template.js --template-name <name> [options]',
    '',
    'Options:',
    '  --template-name <name>    DingTalk report template name (required)',
    '  --userid <id>             DingTalk userid (or env DINGTALK_USERID)',
    '  --from-stdin              Read dingtalk-log JSON from stdin (skip spawn)',
    '  --bin <path>              Path to dingtalk-log.js (default: inferred)',
    '  --cache <path>            Cache file path (default: $HOME/.cache/exp-compass-daily/template.json)',
    '  --no-cache                Skip writing cache file',
    '',
    'Exit codes: 0=ok, 1=bad args, 2=lookup failed, 3=template_id missing',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    templateName: null,
    userid: process.env.DINGTALK_USERID || null,
    fromStdin: false,
    bin: null,
    cache: null,
    noCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--template-name': out.templateName = argv[++i]; break;
      case '--userid': out.userid = argv[++i]; break;
      case '--from-stdin': out.fromStdin = true; break;
      case '--bin': out.bin = argv[++i]; break;
      case '--cache': out.cache = argv[++i]; break;
      case '--no-cache': out.noCache = true; break;
      case '-h':
      case '--help':
        process.stdout.write(usage() + '\n');
        process.exit(0);
      default:
        process.stderr.write(`Unknown flag: ${a}\n${usage()}\n`);
        process.exit(1);
    }
  }
  return out;
}

function defaultCachePath() {
  return path.join(os.homedir(), '.cache', 'exp-compass-daily', 'template.json');
}

function inferBin() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) return path.join(root, 'skills', 'dingtalk-log', 'scripts', 'dingtalk-log.js');
  // Fallback: walk up from this file's location: …/exp-compass-daily/references/scripts/
  return path.join(__dirname, '..', '..', '..', 'dingtalk-log', 'scripts', 'dingtalk-log.js');
}

function readStdinSync() {
  // Read all stdin to a Buffer, then return as utf-8 string.
  // node:fs readFileSync on fd 0 works on macOS/Linux.
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch (e) {
    return '';
  }
}

function fetchViaBin({ bin, templateName, userid }) {
  if (!fs.existsSync(bin)) {
    process.stderr.write(`spawn failed: dingtalk-log bin not found: ${bin}\n`);
    process.exit(2);
  }
  // .js → run with node; others (.sh, no-ext) → exec directly via shebang
  const isJs = bin.endsWith('.js');
  const cmd = isJs ? 'node' : bin;
  const args = isJs
    ? [bin, 'get-template', '--template-name', templateName, '--userid', userid || '']
    : ['get-template', '--template-name', templateName, '--userid', userid || ''];
  const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 60_000 });
  if (r.error) {
    process.stderr.write(`spawn failed: ${r.error.message}\n`);
    process.exit(2);
  }
  if (r.status !== 0) {
    process.stderr.write(`dingtalk-log get-template exited ${r.status}\n`);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
    process.exit(2);
  }
  return r.stdout || '';
}

function parseJsonStrict(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    process.stderr.write(`failed to parse dingtalk-log JSON: ${e.message}\n`);
    process.exit(2);
  }
}

function crossCheckFields(actualFields) {
  // actualFields: array of {field_name, sort, ...}
  const names = actualFields.map((f) => f.field_name);
  const ok = names.length === EXPECTED_FIELDS.length
    && names.every((n, i) => n === EXPECTED_FIELDS[i]);
  if (ok) {
    process.stderr.write(`fields ok: ${names.join(' | ')}\n`);
    return true;
  }
  process.stderr.write('WARN: template fields mismatch\n');
  process.stderr.write(`  expected: ${EXPECTED_FIELDS.join(' | ')}\n`);
  process.stderr.write(`  actual  : ${names.join(' | ')}\n`);
  return false;
}

function writeCache(cachePath, payload) {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = cachePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, cachePath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.templateName) {
    process.stderr.write('--template-name is required\n');
    process.stderr.write(usage() + '\n');
    process.exit(1);
  }

  let raw;
  if (args.fromStdin) {
    raw = readStdinSync();
  } else {
    const bin = args.bin || inferBin();
    raw = fetchViaBin({ bin, templateName: args.templateName, userid: args.userid });
  }

  const obj = parseJsonStrict(raw);

  if (obj.errcode !== undefined && obj.errcode !== 0) {
    const msg = obj.errmsg || '(no errmsg)';
    process.stderr.write(`lookup failed: errcode=${obj.errcode} errmsg=${msg}\n`);
    process.exit(2);
  }

  const result = obj.result || {};
  const templateId = (result.id || '').toString().trim();
  if (!templateId) {
    process.stderr.write('template_id missing or empty in dingtalk-log response\n');
    process.exit(3);
  }

  const fields = Array.isArray(result.fields) ? result.fields : [];
  crossCheckFields(fields);

  const defaultReceivedConvs = Array.isArray(result.default_received_convs)
    ? result.default_received_convs : [];
  if (defaultReceivedConvs.length === 0) {
    process.stderr.write('WARN: template has no default_received_convs (broadcast will silently no-op)\n');
  } else {
    const titles = defaultReceivedConvs.map((c) => c.title).filter(Boolean).join(', ');
    process.stderr.write(`default_received_convs: ${defaultReceivedConvs.length} (${titles})\n`);
  }

  if (!args.noCache) {
    const cachePath = args.cache || defaultCachePath();
    writeCache(cachePath, {
      template_id: templateId,
      template_name: args.templateName,
      default_received_convs: defaultReceivedConvs,
      fields: fields.map((f) => ({ field_name: f.field_name, sort: f.sort, type: f.type })),
      cached_at: new Date().toISOString(),
    });
    process.stderr.write(`cache written: ${cachePath}\n`);
  }

  process.stdout.write(templateId + '\n');
  process.exit(0);
}

main();
