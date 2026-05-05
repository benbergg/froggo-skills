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

  # Build products array preserving input file order via temp file
  # (avoids ARG_MAX limit when products contain many stories/tasks).
  local products_file
  products_file=$(mktemp -t daily-products.XXXXXX) || return 1
  jq -n '[]' > "$products_file"
  for f in "${files[@]}"; do
    jq -s 'add' "$products_file" <(jq -c '[.]' "$f") > "$products_file.new" \
      && mv "$products_file.new" "$products_file"
  done

  # Write role JSON to temp file too (defensive against very large maps).
  local roles_file
  roles_file=$(mktemp -t daily-roles.XXXXXX) || { rm -f "$products_file"; return 1; }
  echo "$role_json" > "$roles_file"

  # Compose final aggregated JSON
  jq -n --slurpfile products_arr "$products_file" --slurpfile roles_arr "$roles_file" '
    ($products_arr[0]) as $products
    | ($roles_arr[0]) as $roles
    |
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
  rm -f "$products_file" "$roles_file"
}

export -f aggregate
