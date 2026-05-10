#!/usr/bin/env node
'use strict';

// dingtalk-log: generic DingTalk OpenAPI CLI wrapper
// Spec: Knowledge-Library/12-Projects/N0003-钉钉日志-skill/20260510-钉钉日志-skill-v1-设计文档.md

const COMMANDS = {
  'create-report':   { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'save-content':    { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'get-template':    { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'list-templates':  { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET'] },
  'get-user':        { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
};

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

  const missing = requireEnv(env, COMMANDS[sub].needsEnv);
  if (missing.length > 0) {
    errOut(`FATAL: missing required env for "${sub}": ${missing.join(', ')}`);
    errOut(`HINT: configure the missing variables, e.g.:`);
    for (const n of missing) errOut(`  export ${n}="<value>"`);
    return exit(1);
  }

  // Validate contents type early (B6)
  if (sub === 'create-report' || sub === 'save-content') {
    const raw = flags['contents'];
    if (!raw || raw === true) {
      errOut(`FATAL: --contents is required`);
      return exit(1);
    }
    let data;
    try { data = parseJsonFlag(raw, 'contents'); }
    catch (e) { errOut(`FATAL: ${e.message}`); return exit(1); }
    if (!Array.isArray(data)) {
      errOut(`FATAL: contents must be a JSON array, got ${typeof data}`);
      return exit(1);
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

module.exports = { main, parseArgs, requireEnv, parseJsonFlag };
