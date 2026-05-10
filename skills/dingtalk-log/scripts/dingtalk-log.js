#!/usr/bin/env node
'use strict';

// dingtalk-log: generic DingTalk OpenAPI CLI wrapper
// Spec: Knowledge-Library/12-Projects/N0003-钉钉日志-skill/20260510-钉钉日志-skill-v1-设计文档.md

const fs = require('node:fs');

const COMMANDS = {
  'create-report':   { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'save-content':    { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'get-template':    { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'list-templates':  { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET'] },
  'get-user':        { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
};

function isStdinTty(env) {
  // Test bridge via env; real runs use process.stdin.isTTY
  if (env.DINGTALK_TEST_STDIN_TTY === '1') return true;
  return Boolean(process.stdin.isTTY);
}

function readAllStdin() {
  // Synchronously read stdin until EOF
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let n;
  while ((n = fs.readSync(0, buf, 0, buf.length, null)) > 0) {
    chunks.push(Buffer.from(buf.slice(0, n)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Load flag content: supports @file / - / raw JSON
function loadFlagContent(raw, flagName, env, stdinTaken) {
  if (typeof raw !== 'string') {
    throw new Error(`--${flagName} requires a value`);
  }
  if (raw === '-') {
    if (stdinTaken.value) throw new Error(`only one flag may consume stdin (already taken by --${stdinTaken.name})`);
    if (isStdinTty(env)) throw new Error(`--${flagName} "-" requires piped stdin (got tty)`);
    stdinTaken.value = true;
    stdinTaken.name = flagName;
    return readAllStdin();
  }
  if (raw.startsWith('@')) {
    const p = raw.slice(1);
    if (!fs.existsSync(p)) throw new Error(`--${flagName} file not found: ${p}`);
    return fs.readFileSync(p, 'utf-8');
  }
  return raw;
}

function loadJsonFlag(raw, flagName, env, stdinTaken) {
  if (raw === undefined) return undefined;
  const text = loadFlagContent(raw, flagName, env, stdinTaken);
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error(`--${flagName} JSON parse failed: ${e.message}`); }
  return data;
}

function parseArgs(argv) {
  const out = { sub: null, flags: {}, hasHelp: false };
  out.sub = argv[2] || null;
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.hasHelp = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else { out.flags[key] = true; }
    }
  }
  return out;
}

function printHelp(sub, log) {
  const lines = [
    `Usage: dingtalk-log ${sub || '<subcommand>'} [flags]`,
    `Subcommands: ${Object.keys(COMMANDS).join(', ')}`,
    `Common env: DINGTALK_APPKEY, DINGTALK_APPSECRET, DINGTALK_USERID`,
  ];
  log(lines.join('\n'));
}

function requireEnv(env, names) {
  return names.filter((n) => !env[n] || env[n].trim() === '');
}

function parseJsonFlag(raw, flagName) {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`--${flagName} JSON parse failed: ${e.message}`); }
  return data;
}

async function main(deps = {}) {
  const argv = deps.argv ?? process.argv;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((s) => process.stdout.write(s + '\n'));
  const errOut = deps.err ?? ((s) => process.stderr.write(s + '\n'));
  const exit = deps.exit ?? process.exit;

  const { sub, flags, hasHelp } = parseArgs(argv);

  if (!sub) { printHelp(null, log); return exit(0); }
  if (!COMMANDS[sub]) {
    errOut(`FATAL: unknown subcommand "${sub}"`);
    errOut(`HINT: valid subcommands: ${Object.keys(COMMANDS).join(', ')}`);
    return exit(1);
  }

  if (hasHelp) { printHelp(sub, log); return exit(0); }

  // Merge --userid flag as fallback for DINGTALK_USERID (flag takes priority over env)
  const effectiveEnv = { ...env };
  if (flags['userid'] && typeof flags['userid'] === 'string') {
    effectiveEnv.DINGTALK_USERID = flags['userid'];
  }

  const missing = requireEnv(effectiveEnv, COMMANDS[sub].needsEnv);
  if (missing.length > 0) {
    errOut(`FATAL: missing required env for "${sub}": ${missing.join(', ')}`);
    errOut(`HINT: configure the missing variables, e.g.:`);
    for (const n of missing) errOut(`  export ${n}="<value>"`);
    return exit(1);
  }

  const stdinTaken = { value: false, name: null };

  if (sub === 'create-report' || sub === 'save-content') {
    let contents;
    try { contents = loadJsonFlag(flags['contents'], 'contents', effectiveEnv, stdinTaken); }
    catch (e) { errOut(`FATAL: ${e.message}`); return exit(1); }
    if (contents === undefined) { errOut(`FATAL: --contents is required`); return exit(1); }
    if (!Array.isArray(contents)) {
      errOut(`FATAL: contents must be a JSON array, got ${typeof contents}`);
      return exit(1);
    }
    flags._contents = contents;
  }
  if (sub === 'create-report') {
    for (const fname of ['to-userids', 'to-cids']) {
      if (flags[fname] !== undefined) {
        try {
          const arr = loadJsonFlag(flags[fname], fname, effectiveEnv, stdinTaken);
          if (!Array.isArray(arr)) throw new Error(`--${fname} must be a JSON array`);
          flags[`_${fname}`] = arr;
        } catch (e) { errOut(`FATAL: ${e.message}`); return exit(1); }
      }
    }
  }

  errOut(`FATAL: subcommand "${sub}" not yet implemented`);
  return exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, requireEnv, parseJsonFlag, loadFlagContent, loadJsonFlag };
