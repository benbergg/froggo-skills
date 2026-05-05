# Progress Calculation Reference (P4 Mixed Algorithm)

## Overview

Story progress is computed by a 4-priority fallback chain (P1→P2→P3),
implemented in `scripts/progress.sh`.

---

## P1: Hours-Based (highest priority)

**Condition:** at least one task for the story has `consumed + left > 0`.

**Formula:**

```
value = floor( ∑consumed / (∑consumed + ∑left) × 100 )
source = "hours"
```

**Example:** consumed=8, left=4 → 8 / (8+4) × 100 = 67%

See fixture: `tests/fixtures/progress-hours.json`

---

## P2: Count-Based (fallback when all hours are zero)

**Condition:** story has tasks but all `consumed` and `left` are 0.

**Formula:**

```
value = floor( done_count / total_count × 100 )
source = "count"
```

where `done_count` = tasks with `status == "done"` or `status == "closed"`.

**Example:** 1 done out of 2 tasks → 50%

See fixture: `tests/fixtures/progress-count.json`

---

## P3: Stage-Based (fallback when no tasks exist)

**Condition:** no tasks found for the story.

**Stage map:**

| Stage       | Value |
|-------------|-------|
| wait        | 0     |
| planned     | 10    |
| projected   | 20    |
| developing  | 40    |
| developed   | 60    |
| testing     | 75    |
| tested      | 90    |
| closed      | 100   |
| released    | 100   |
| (other)     | 0     |

```
source = "stage"
```

See fixture: `tests/fixtures/progress-stage.json`

---

## P4 Fallback Chain

```
P1 (hours sum > 0) → P2 (any tasks) → P3 (stage map)
```

---

## 10-Cell Progress Bar

`render_bar <pct>` renders a bracket-enclosed 10-cell bar:

```
0%   → [░░░░░░░░░░]
50%  → [█████░░░░░]
80%  → [████████░░]
100% → [██████████]
```

Each filled cell represents 10 percentage points (`filled = pct / 10`).
Values are clamped to [0, 10].
