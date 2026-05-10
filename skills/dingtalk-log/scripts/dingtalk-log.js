#!/usr/bin/env node
'use strict';

// dingtalk-log: generic DingTalk OpenAPI CLI wrapper
// Spec: Knowledge-Library/12-Projects/N0003-钉钉日志-skill/20260510-钉钉日志-skill-v1-设计文档.md

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ============================================================================
// ---- env & arg parse -------------------------------------------------------
// ============================================================================

function requireEnv(env, names) {
  return names.filter((n) => !env[n] || env[n].trim() === '');
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

function parseJsonFlag(raw, flagName) {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error(`--${flagName} JSON parse failed: ${e.message}`); }
  return data;
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

// ============================================================================
// ---- token cache -----------------------------------------------------------
// ============================================================================

function tokenCachePath(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, '.cache', 'dingtalk', 'token.json');
}

function tokenCacheRead(env) {
  const file = tokenCachePath(env);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (_) { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { return null; }
  if (!parsed || typeof parsed.access_token !== 'string' || typeof parsed.expires_at !== 'number') return null;
  return parsed;
}

function tokenCacheWrite(env, tok) {
  const file = tokenCachePath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  const sanitized = JSON.stringify(tok).replace(/[\x00-\x1f]/g, '');
  fs.writeFileSync(tmp, sanitized, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function tokenCacheInvalidate(env) {
  try { fs.unlinkSync(tokenCachePath(env)); } catch (_) {}
}

function tokenIsFresh(tok, nowSec) {
  if (!tok) return false;
  return (tok.expires_at - 60) > nowSec;
}

// ============================================================================
// ---- http ------------------------------------------------------------------
// ============================================================================

const DT_HOST = 'https://oapi.dingtalk.com';

const HARD_TIMEOUT_MS_DEFAULT = 60_000;

function installHardTimeout(env) {
  const ms = Number(env.DINGTALK_TEST_HARD_TIMEOUT_MS) || HARD_TIMEOUT_MS_DEFAULT;
  const t = setTimeout(() => {
    process.stderr.write(`FATAL: hard timeout (${ms}ms) reached, aborting\n`);
    process.exit(7);
  }, ms);
  t.unref();
  return t;
}

function getFetch(env) {
  if (env.DINGTALK_TEST_FETCH) {
    delete require.cache[require.resolve(env.DINGTALK_TEST_FETCH)];
    return require(env.DINGTALK_TEST_FETCH);
  }
  return globalThis.fetch.bind(globalThis);
}

function sanitize(s) {
  let out = String(s);
  // Covers query (key=val), JSON ("key":"val"), and colon-form (key:val);
  // optional quote before separator handles JSON key quoting;
  // supports app_key / app_secret underscore variants alongside appkey / appsecret
  out = out.replace(
    /(access_token|app_?key|app_?secret)"?\s*([=:])\s*"?([^"\s&,}]+)"?/gi,
    (_m, key, sep) => `${key}${sep}***`
  );
  // Bearer header
  out = out.replace(/Bearer\s+\S+/gi, 'Bearer ***');
  return out;
}

class TokenError extends Error {
  constructor(msg) { super(msg); this.name = 'TokenError'; }
}

async function ensureToken(env, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCacheRead(env);
  if (tokenIsFresh(cached, now)) return cached.access_token;

  const url = `${DT_HOST}/gettoken?appkey=${encodeURIComponent(env.DINGTALK_APPKEY)}&appsecret=${encodeURIComponent(env.DINGTALK_APPSECRET)}`;
  let resp;
  try { resp = await fetchImpl(url); }
  catch (e) { throw new TokenError(`gettoken network error: ${e.message}`); }
  let body;
  try { body = await resp.json(); }
  catch (e) { throw new TokenError(`gettoken response not JSON (status=${resp.status})`); }
  if (body.errcode !== 0 || !body.access_token) {
    throw new TokenError(`gettoken errcode=${body.errcode} errmsg=${body.errmsg}`);
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 7200;
  const tok = { access_token: body.access_token, expires_at: now + expiresIn - 60 };
  tokenCacheWrite(env, tok);
  return tok.access_token;
}

const TOKEN_INVALID_ERRCODES = new Set([42001, 40014, 41001]);

async function callBusinessApi({ env, fetchImpl, urlBuilder, body }) {
  let token = await ensureToken(env, fetchImpl);
  let resp = await fetchImpl(urlBuilder(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed = await resp.json();
  if (parsed && TOKEN_INVALID_ERRCODES.has(parsed.errcode)) {
    tokenCacheInvalidate(env);
    token = await ensureToken(env, fetchImpl);
    resp = await fetchImpl(urlBuilder(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    parsed = await resp.json();
  }
  return parsed;
}

// ============================================================================
// ---- payload builders ------------------------------------------------------
// ============================================================================

const PAGINATION_CAP = 50;

function buildCreateReportPayload(flags, env) {
  const userid = flags['userid'] || env.DINGTALK_USERID;
  const ddFrom = flags['dd-from'] || 'openapi';
  return {
    create_report_param: {
      userid,
      template_id: flags['template-id'],
      dd_from: ddFrom,
      contents: flags._contents,
      to_chat: Boolean(flags['to-chat']),
      to_userids: flags['_to-userids'] || [],
      to_cids: flags['_to-cids'] || [],
    },
  };
}

function buildSaveContentPayload(flags, env) {
  const userid = flags['userid'] || env.DINGTALK_USERID;
  return {
    create_report_param: {
      userid,
      template_id: flags['template-id'],
      dd_from: flags['dd-from'] || 'report',
      contents: flags._contents,
    },
  };
}

function normalizeResult(result, key) {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && key in result) return result[key];
  return null;
}

// ============================================================================
// ---- endpoints -------------------------------------------------------------
// ============================================================================

async function runCreateReport({ env, flags, fetchImpl, log, errOut, exit }) {
  const payload = buildCreateReportPayload(flags, env);
  let body;
  try {
    body = await callBusinessApi({
      env, fetchImpl,
      urlBuilder: (t) => `${DT_HOST}/topapi/report/create?access_token=${encodeURIComponent(t)}`,
      body: payload,
    });
  } catch (e) {
    if (e instanceof TokenError) { errOut(`FATAL: ${sanitize(e.message)}`); return exit(2); }
    errOut(`FATAL: dingtalk_create_report ${sanitize(e.message)}`); return exit(3);
  }
  if (body.errcode !== 0) {
    errOut(`FATAL: dingtalk_create_report errcode=${body.errcode} errmsg=${body.errmsg}`);
    return exit(3);
  }
  const reportId = normalizeResult(body.result, 'report_id');
  log(JSON.stringify({ errcode: 0, report_id: reportId, raw: body }));
  return exit(0);
}

async function runSaveContent({ env, flags, fetchImpl, log, errOut, exit }) {
  const payload = buildSaveContentPayload(flags, env);
  let body;
  try {
    body = await callBusinessApi({
      env, fetchImpl,
      urlBuilder: (t) => `${DT_HOST}/topapi/report/savecontent?access_token=${encodeURIComponent(t)}`,
      body: payload,
    });
  } catch (e) {
    if (e instanceof TokenError) { errOut(`FATAL: ${sanitize(e.message)}`); return exit(2); }
    errOut(`FATAL: dingtalk_save_content ${sanitize(e.message)}`); return exit(3);
  }
  if (body.errcode !== 0) {
    errOut(`FATAL: dingtalk_save_content errcode=${body.errcode} errmsg=${body.errmsg}`);
    return exit(3);
  }
  const savedId = normalizeResult(body.result, 'report_id');
  log(JSON.stringify({ errcode: 0, saved_id: savedId, raw: body }));
  return exit(0);
}

async function runGetTemplate({ env, flags, fetchImpl, log, errOut, exit }) {
  if (!flags['template-name']) { errOut('FATAL: --template-name is required'); return exit(1); }
  const userid = flags['userid'] || env.DINGTALK_USERID;
  let body;
  try {
    body = await callBusinessApi({
      env, fetchImpl,
      urlBuilder: (t) => `${DT_HOST}/topapi/report/template/getbyname?access_token=${encodeURIComponent(t)}`,
      body: { userid, template_name: flags['template-name'] },
    });
  } catch (e) {
    if (e instanceof TokenError) { errOut(`FATAL: ${sanitize(e.message)}`); return exit(2); }
    errOut(`FATAL: dingtalk_get_template ${sanitize(e.message)}`); return exit(4);
  }
  if (body.errcode !== 0) {
    errOut(`FATAL: dingtalk_get_template errcode=${body.errcode} errmsg=${body.errmsg}`);
    return exit(4);
  }
  log(JSON.stringify({ errcode: 0, result: body.result, raw: body }));
  return exit(0);
}

async function runListTemplates({ env, flags, fetchImpl, log, errOut, exit }) {
  let size = parseInt(flags['size'] || '100', 10);
  if (size > 100) {
    errOut(`WARN: --size ${size} exceeds API limit (100), truncated`);
    size = 100;
  }
  const offset = parseInt(flags['offset'] || '0', 10);
  const userid = flags['userid'] || env.DINGTALK_USERID;
  const merged = [];
  let pages = 0;
  let cursor = offset;
  let lastBody = null;

  while (true) {
    const body = { offset: String(cursor), size };
    if (userid) body.userid = userid;
    let parsed;
    try {
      parsed = await callBusinessApi({
        env, fetchImpl,
        urlBuilder: (t) => `${DT_HOST}/topapi/report/template/listbyuserid?access_token=${encodeURIComponent(t)}`,
        body,
      });
    } catch (e) {
      if (e instanceof TokenError) { errOut(`FATAL: ${sanitize(e.message)}`); return exit(2); }
      errOut(`FATAL: dingtalk_list_templates ${sanitize(e.message)}`); return exit(5);
    }
    if (parsed.errcode !== 0) {
      errOut(`FATAL: dingtalk_list_templates errcode=${parsed.errcode} errmsg=${parsed.errmsg}`);
      return exit(5);
    }
    pages++;
    lastBody = parsed;
    const list = (parsed.result && parsed.result.template_list) || [];
    merged.push(...list);
    const nextCursor = parsed.result && parsed.result.next_cursor;
    if (!flags['all']) break;
    if (nextCursor == null || nextCursor === '' || nextCursor === false) break;
    if (pages >= PAGINATION_CAP) {
      errOut(`FATAL: pagination cap (${PAGINATION_CAP} pages) hit, possible buggy server cursor`);
      return exit(5);
    }
    cursor = nextCursor;
  }

  if (flags['all']) {
    log(JSON.stringify({ errcode: 0, result: { template_list: merged, pages_fetched: pages }, raw: null }));
  } else {
    log(JSON.stringify({ errcode: 0, result: lastBody.result, raw: lastBody }));
  }
  return exit(0);
}

async function runGetUser({ env, flags, fetchImpl, log, errOut, exit }) {
  const userid = flags['userid'] || env.DINGTALK_USERID;
  if (!userid) { errOut('FATAL: --userid is required'); return exit(1); }
  const body = { userid };
  if (flags['language']) body.language = flags['language'];
  let parsed;
  try {
    parsed = await callBusinessApi({
      env, fetchImpl,
      urlBuilder: (t) => `${DT_HOST}/topapi/v2/user/get?access_token=${encodeURIComponent(t)}`,
      body,
    });
  } catch (e) {
    if (e instanceof TokenError) { errOut(`FATAL: ${sanitize(e.message)}`); return exit(2); }
    errOut(`FATAL: dingtalk_get_user ${sanitize(e.message)}`); return exit(6);
  }
  if (parsed.errcode !== 0) {
    errOut(`FATAL: dingtalk_get_user errcode=${parsed.errcode} errmsg=${parsed.errmsg}`);
    return exit(6);
  }
  log(JSON.stringify({ errcode: 0, result: parsed.result, raw: parsed }));
  return exit(0);
}

// ============================================================================
// ---- cli -------------------------------------------------------------------
// ============================================================================

const COMMANDS = {
  'create-report':   { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'save-content':    { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'get-template':    { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
  'list-templates':  { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET'] },
  'get-user':        { needsEnv: ['DINGTALK_APPKEY', 'DINGTALK_APPSECRET', 'DINGTALK_USERID'] },
};

function printHelp(sub, log) {
  const lines = [
    `Usage: dingtalk-log ${sub || '<subcommand>'} [flags]`,
    `Subcommands: ${Object.keys(COMMANDS).join(', ')}`,
    `Common env: DINGTALK_APPKEY, DINGTALK_APPSECRET, DINGTALK_USERID`,
  ];
  log(lines.join('\n'));
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

  installHardTimeout(effectiveEnv);

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

  // Validate --template-id required for create-report / save-content
  if ((sub === 'create-report' || sub === 'save-content') && !flags['template-id']) {
    errOut(`FATAL: --template-id is required`);
    return exit(1);
  }

  if (flags['dry-run']) {
    let payload;
    if (sub === 'create-report') payload = buildCreateReportPayload(flags, effectiveEnv);
    else if (sub === 'save-content') payload = buildSaveContentPayload(flags, effectiveEnv);
    else { errOut(`FATAL: --dry-run only supports create-report / save-content`); return exit(1); }
    log(JSON.stringify(payload, null, 2));
    return exit(0);
  }

  if (sub === 'create-report') return runCreateReport({ env: effectiveEnv, flags, fetchImpl: getFetch(effectiveEnv), log, errOut, exit });
  if (sub === 'save-content')  return runSaveContent({ env: effectiveEnv, flags, fetchImpl: getFetch(effectiveEnv), log, errOut, exit });

  if (sub === 'get-template') {
    return runGetTemplate({ env: effectiveEnv, flags, fetchImpl: getFetch(effectiveEnv), log, errOut, exit });
  }

  if (sub === 'list-templates') {
    return runListTemplates({ env: effectiveEnv, flags, fetchImpl: getFetch(effectiveEnv), log, errOut, exit });
  }

  if (sub === 'get-user') {
    return runGetUser({ env: effectiveEnv, flags, fetchImpl: getFetch(effectiveEnv), log, errOut, exit });
  }

  errOut(`FATAL: subcommand "${sub}" not yet implemented`);
  return exit(1);
}

// ============================================================================
// ---- main entry ------------------------------------------------------------
// ============================================================================

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  main, parseArgs, requireEnv, parseJsonFlag,
  loadFlagContent, loadJsonFlag,
  buildCreateReportPayload, buildSaveContentPayload,
  tokenCachePath, tokenCacheRead, tokenCacheWrite, tokenCacheInvalidate, tokenIsFresh,
  ensureToken, sanitize, TokenError, getFetch,
  callBusinessApi, TOKEN_INVALID_ERRCODES,
  installHardTimeout,
  normalizeResult, runCreateReport, runSaveContent,
  runListTemplates, PAGINATION_CAP, runGetUser,
};
