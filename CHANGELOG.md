# Changelog

All notable changes to `froggo-skills` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.27.0] - 2026-05-05

### Added

- **New skill: `daily-report`** — 产研日报自动生成
  - Four-state story classification: 进行中 / 今日完成 / 未分配 / 未执行
    (historical closed/released and draft excluded)
  - Per-story task expansion with type emoji map
    (📐 设计 / 💻 开发 / 🧪 测试 / 🔍 研究 / 💬 讨论 / 🎨 UI / 📞 沟通 /
    📌 需求 / 📝 事务 / 📋 普通 / 🔧 其他)
  - P4 mixed progress algorithm (hours → count → stage fallback)
  - Bug table with scope filter: today-events + historical active/confirmed
    (historical resolved and closed bugs excluded as noise)
  - Per-product summary blocks: progress distribution, task type breakdown,
    person workload top-5, today blockers, bug severity distribution,
    bug top-3 handlers
  - Real product name fetched from `/products/{pid}` (fallback `Product-{pid}`)
  - Person fields normalized from Zentao object format `{id,account,realname,avatar}`
    to display string (realname > account)
  - Knowledge library auto-detection: `~/workspace/Knowledge-Library` preferred
  - API call budget hard cap (`DAILY_API_BUDGET=600` default)
  - Rate-limit backoff (1/2/4/8s exponential)
  - Range-based task degrade (`DAILY_TASK_LIMIT=500` default)
  - YAML role-map parser via `yq` or `python3` (bash regex parsing rejected)
  - Feishu summary push with cron-mode alert escalation
  - 70-point evaluation gate with source-weighted progress check
  - Rollback procedure documented (4 operations + checklist)
- **12 test files, 129 assertions, all passing**
  - Unit tests: retry / role-map / progress / collect-stories / today-filter /
    collect-bugs / collect-tasks / task-limit / aggregate / template-render /
    evaluation
  - End-to-end test with mock zt-functions (no credentials needed):
    full pipeline + draft exclusion + normal task type + summary blocks
- Plugin manifest description updated to include 产研日报 trigger keywords

### Changed

- `plugin.json` version bump: `1.26.0 → 1.27.0`

### Notes

- The skill depends on the existing `zentao-api` skill's 6 helper functions
  (`zt_init` / `zt_acquire_token` / `zt_get` / `zt_paginate` / `zt_write` /
  `zt_week_range`). `run.sh` sources them from a sibling skill path.
- For local dry-run see `skills/daily-report/references/local-verify.md`.
- For rollback see `skills/daily-report/references/rollback.md`.

## [1.26.0] - prior

Earlier versions are not catalogued here; see `git log` for history.
