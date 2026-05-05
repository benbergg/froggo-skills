# Role Mapping

## YAML Format

Place at `~/.zentao-roles.yaml`:

```yaml
roles:
  pm:   [lily, wang]
  dev:  [qingwa, zhang, liu]
  qa:   [zhao, sun]
names:    # optional, for display
  lily:   李丽
  qingwa: 青蛙
```

## Parsing Strategy

1. **`yq`** (preferred) — `yq -o=json '.' file`
2. **`python3 -c 'import yaml; ...'`** (fallback)
3. **abort** when neither available — pure bash + grep/awk parsing is **not allowed** (nesting/quoting/inline format unreliable)

## unknown Account Handling

- Account not in any `roles.*` list → role labeled `unknown`
- All occurrences in the report (story rows, task rows, bug table rows) get a trailing ` ⚠️`
- Banner at report top suggests updating `~/.zentao-roles.yaml`

## Optional Chinese Name Mapping

- If `names[account]` exists, render replaces `@account` with `@中文名`
- Otherwise the original account is preserved

## Exceptions

| Case | Behavior |
|------|----------|
| File absent | warn (non-fatal), return empty JSON, all accounts → unknown |
| Malformed YAML | abort, ask user to fix |
| Both yq and python3 missing | abort, ask user to install |

## API

```bash
source references/scripts/role-map-loader.sh
ROLE_JSON=$(load_role_map "$ROLE_MAP_FILE")
role=$(get_role_for "$ROLE_JSON" qingwa)   # → "dev"
name=$(get_name_for "$ROLE_JSON" qingwa)   # → "青蛙"
```
