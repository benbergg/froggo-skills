#!/usr/bin/env bash
# Multi-product intermediate JSON aggregation (design §6.4).

# Usage: aggregate file1.json file2.json ... role_map_json
# Last argument is the role-map JSON string; preceding args are per-product
# intermediate JSON file paths. Products are preserved in input file order.
aggregate() {
  local args=("$@")
  local count=$#
  local role_json="${args[$((count - 1))]}"
  local files=("${args[@]:0:$((count - 1))}")

  # Build products array preserving input file order
  local products="[]"
  for f in "${files[@]}"; do
    products=$(jq -s 'add' <(echo "$products") <(jq -c '[.]' "$f"))
  done

  # Compose final aggregated JSON
  jq -n --argjson products "$products" --argjson roles "$role_json" '
    def merge_workloads(acc; w):
      reduce (w | keys[]) as $acct (acc;
        .[$acct] = (
          (.[$acct] // {}) as $cur |
          (w[$acct]) as $add |
          reduce ($add | keys[]) as $key ($cur;
            if ($add[$key] | type) == "number" then
              .[$key] = (($cur[$key] // 0) + $add[$key])
            else
              .[$key] = $add[$key]
            end
          )
        )
      );
    {
      date: ($products[0].date),
      products: $products,
      overview: {
        in_progress:    ([$products[].stories.in_progress | length] | add),
        today_done:     ([$products[].stories.today_done  | length] | add),
        unassigned:     ([$products[].stories.unassigned  | length] | add),
        idle:           ([$products[].stories.idle        | length] | add),
        bugs_total:     ([$products[].bugs.snapshot | to_entries | map(.value | length) | add] | add),
        bugs_today_new: ([$products[].bugs.today."新建" | length] | add),
        bugs_today_res: ([$products[].bugs.today."解决" | length] | add),
        bugs_today_cls: ([$products[].bugs.today."关闭" | length] | add)
      },
      person_workload_global: (
        reduce ($products | map(.person_workload // {}))[] as $w ({};
          merge_workloads(.; $w)
        )
      ),
      roles: ($roles.roles // {}),
      names: ($roles.names // {})
    }
  '
}

export -f aggregate
