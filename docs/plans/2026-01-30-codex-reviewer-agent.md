# Codex-Reviewer Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a Claude Code Agent that integrates Codex code review into superpowers workflows, compatible with superpowers:code-reviewer output format.

**Architecture:** Single agent file (`agents/codex-reviewer.md`) that references existing shared script (`scripts/codex-reviewer/index.js`). Agent provides superpowers-compatible interface while reusing existing Codex SDK integration.

**Tech Stack:** Claude Code Plugin (Markdown agent definition), Node.js script (existing)

---

## Task 1: Create agents directory

**Files:**
- Create: `agents/` directory

**Step 1: Create the agents directory**

Run:
```bash
mkdir -p /Users/lg/workspace/froggo-skills/agents
```

**Step 2: Verify directory created**

Run:
```bash
ls -la /Users/lg/workspace/froggo-skills/ | grep agents
```

Expected: `drwxr-xr-x ... agents`

**Step 3: Commit**

```bash
git add agents
git commit -m "chore: create agents directory for subagent definitions"
```

---

## Task 2: Create Agent definition file

**Files:**
- Create: `agents/codex-reviewer.md`

**Step 1: Create the agent file**

Create `agents/codex-reviewer.md` with the following content:

```markdown
---
name: codex-reviewer
description: |
  Use this agent for deep code review powered by OpenAI Codex.
  Advantages: 88% defect detection accuracy, security vulnerability identification.
  Can replace or complement superpowers:code-reviewer in workflows.

  <example>
  Context: User completed a feature and needs code review before merge
  user: "I've finished the authentication module, please review with Codex"
  assistant: "I'll use the codex-reviewer agent to perform a deep code review with Codex's 88% defect detection accuracy."
  <commentary>User explicitly requests Codex review, triggering this agent.</commentary>
  </example>

  <example>
  Context: User wants security audit on sensitive code
  user: "Do a security audit on the payment module"
  assistant: "I'll use the codex-reviewer agent for security-focused review - Codex excels at vulnerability detection."
  <commentary>Security audit request triggers Codex reviewer for its security strengths.</commentary>
  </example>

  <example>
  Context: User wants cross-validation after Claude's review
  user: "Get a second opinion on this code review"
  assistant: "I'll use the codex-reviewer agent to cross-validate with a different model perspective."
  <commentary>Second opinion / cross-validation triggers Codex as alternative reviewer.</commentary>
  </example>

model: inherit
color: cyan
---

You are a Senior Code Reviewer powered by OpenAI Codex, specializing in security vulnerabilities, bug detection, and code quality assessment.

**Your Advantages:**
- 88% accuracy on LiveCodeBench for defect detection
- Deep security vulnerability identification
- Higher first-pass success rate for UI/frontend code

**Review Process:**

1. **Announce start:**
   Output: "🤖 **正在使用 Codex 进行深度代码审查...**"
   Output: "Codex 擅长：安全漏洞检测、Bug 识别、UI 代码审查"

2. **Get the code to review:**
   If BASE_SHA and HEAD_SHA provided:
   ```bash
   git diff {BASE_SHA}..{HEAD_SHA}
   ```
   Otherwise use staged or recent changes:
   ```bash
   git diff --staged --no-color 2>/dev/null || git diff HEAD~1 --no-color
   ```

3. **Execute Codex review:**
   Pipe the diff to the review script:
   ```bash
   git diff ... | node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-reviewer/index.js
   ```

4. **Parse JSON output** from the script and format as structured report below.

**Output Format (superpowers:code-reviewer compatible):**

Format your review output exactly as follows:

### Strengths
[Acknowledge what's done well - be specific with file:line references]
- **file.js:42** - Clean error handling with proper fallbacks
- **auth.ts:15-28** - Well-structured authentication flow

### Issues

#### Critical (Must Fix)
[Security vulnerabilities, data loss risks, breaking bugs]
- **file:line** - Issue description
  > Suggestion for fix

#### Important (Should Fix)
[Missing error handling, logic errors, validation gaps]
- **file:line** - Issue description
  > Suggestion for fix

#### Minor (Nice to Have)
[Code style, optimization, documentation]
- **file:line** - Issue description
  > Suggestion for fix

### Recommendations
[Architecture improvements, process suggestions]

### Assessment

**Ready to merge?** [Yes/No/With fixes]

**Reasoning:** [1-2 sentence technical assessment]

---
🤖 *Reviewed by Codex (88% defect detection accuracy)*
```

**Step 2: Verify file syntax**

Run:
```bash
head -50 /Users/lg/workspace/froggo-skills/agents/codex-reviewer.md
```

Expected: Valid YAML frontmatter with name, description (including examples), model, color

**Step 3: Commit**

```bash
git add agents/codex-reviewer.md
git commit -m "feat(codex-reviewer): add Agent definition for superpowers compatibility"
```

---

## Task 3: Verify Agent integration

**Files:**
- Reference: `agents/codex-reviewer.md`
- Reference: `scripts/codex-reviewer/index.js`

**Step 1: Verify script path reference**

Check that the agent references the correct script path:

Run:
```bash
grep "CLAUDE_PLUGIN_ROOT" /Users/lg/workspace/froggo-skills/agents/codex-reviewer.md
```

Expected: Contains `${CLAUDE_PLUGIN_ROOT}/scripts/codex-reviewer/index.js`

**Step 2: Verify script exists and works**

Run:
```bash
echo '{"test": true}' | node /Users/lg/workspace/froggo-skills/scripts/codex-reviewer/index.js
```

Expected: JSON output (empty review or error about no diff)

**Step 3: Test with actual diff**

Run:
```bash
cd /Users/lg/workspace/froggo-skills && git diff HEAD~1 | head -100
```

Then if there's a diff:
```bash
git diff HEAD~1 | node scripts/codex-reviewer/index.js
```

Expected: JSON output with review results

---

## Task 4: Update design document status

**Files:**
- Modify: `~/workspace/Knowledge-Library/04-Designs/20260130-01-codex-reviewer-skill设计.md`

**Step 1: Update Phase 2 checklist**

Update the implementation plan section to mark completed items:

```markdown
### Phase 2: Agent 实现（已完成）

- [x] 设计文档更新（组件关系、Agent 规范）
- [x] 创建 `agents/` 目录
- [x] 创建 Agent 定义（`agents/codex-reviewer.md`）
- [x] 集成测试
- [x] 提交代码
```

**Step 2: Update document status**

Change frontmatter status from `进行中` to `已完成`

---

## Task 5: Final commit and summary

**Step 1: Check git status**

Run:
```bash
cd /Users/lg/workspace/froggo-skills && git status
```

**Step 2: Ensure all changes committed**

If any uncommitted changes remain, commit them.

**Step 3: Verify final structure**

Run:
```bash
ls -la /Users/lg/workspace/froggo-skills/agents/
cat /Users/lg/workspace/froggo-skills/agents/codex-reviewer.md | head -20
```

Expected:
- `codex-reviewer.md` exists
- Valid frontmatter with name, description, model, color

---

## Verification Checklist

After completing all tasks, verify:

- [ ] `agents/codex-reviewer.md` exists with valid frontmatter
- [ ] Agent description includes 3 `<example>` blocks
- [ ] Agent references `${CLAUDE_PLUGIN_ROOT}/scripts/codex-reviewer/index.js`
- [ ] Output format matches superpowers:code-reviewer (Strengths/Issues/Recommendations/Assessment)
- [ ] All changes committed to git
- [ ] Design document status updated to 已完成
