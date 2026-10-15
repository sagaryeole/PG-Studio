#!/usr/bin/env bash
# End-to-end smoke test against a running PG Studio seeded with demo/seed.sql.
# Usage: scripts/smoke-test.sh [port]      (default 4321)
# Used by CI; also handy locally after `npm run demo:db` + `npm run demo`.
set -euo pipefail

PORT="${1:-4321}"
BASE="http://127.0.0.1:${PORT}"
fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok    %s\n' "$name"
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$name" "$expected" "$actual"
    fail=1
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "PG Studio smoke test on ${BASE}"

# Wait up to 30 s for the server.
for _ in $(seq 1 30); do
  curl -sf "${BASE}/api/meta" >/dev/null 2>&1 && break
  sleep 1
done

meta="$(curl -sf "${BASE}/api/meta")"
check "meta: connected as read-only role" "false" "$(jq -r '.role.canWrite' <<<"$meta")"
check "meta: edit capability is off" "false" "$(jq -r '.capabilities.edit' <<<"$meta")"

tables="$(curl -sf "${BASE}/api/tables")"
check "tables: lists orders" "true" "$(jq '[.tables[].name] | index("orders") != null' <<<"$tables")"
check "tables: lists the view" "true" "$(jq '[.tables[].name] | index("recent_orders") != null' <<<"$tables")"

rows="$(curl -sf "${BASE}/api/tables/orders?pageSize=5")"
check "rows: page of 5" "5" "$(jq '.rows | length' <<<"$rows")"
check "rows: keyset paging by default" "keyset" "$(jq -r '.paging' <<<"$rows")"
check "rows: has next page" "true" "$(jq -r '.hasNext' <<<"$rows")"

filters='[{"c":"status","op":"eq","v":"delivered"}]'
filtered="$(curl -sf -G "${BASE}/api/tables/orders" --data-urlencode "filters=${filters}" --data-urlencode "pageSize=10")"
check "filters: only matching rows" "true" "$(jq '[.rows[][2]] | length > 0 and all(. == "delivered")' <<<"$filtered")"

count="$(curl -sf "${BASE}/api/tables/authors/count")"
check "count: exact count" "400" "$(jq -r '.count' <<<"$count")"

check "details: structure tab" "200" "$(status "${BASE}/api/tables/orders/details")"
check "export: csv" "200" "$(status "${BASE}/api/tables/authors/export?format=csv")"

routines="$(curl -sf "${BASE}/api/routines")"
check "routines: lists the demo function" "true" "$(jq '[.routines[] | select(.name == "book_rating" and .kind == "function")] | length == 1' <<<"$routines")"
check "routines: lists the demo procedure" "true" "$(jq '[.routines[] | select(.name == "refresh_book_sales" and .kind == "procedure" and .returns == null)] | length == 1' <<<"$routines")"
check "routines: overloads are separate entries" "2" "$(jq '[.routines[] | select(.name == "format_price")] | length' <<<"$routines")"
check "routines: unknown schema is 404" "404" "$(status "${BASE}/api/routines?schema=no_such_schema")"
fn_oid="$(jq -r '.routines[] | select(.name == "book_rating") | .oid' <<<"$routines")"
fn="$(curl -sf "${BASE}/api/routines/${fn_oid}")"
check "routine: definition is returned" "true" "$(jq '.definition | contains("CREATE OR REPLACE FUNCTION")' <<<"$fn")"
check "routine: volatility" "stable" "$(jq -r '.volatility' <<<"$fn")"
trg_oid="$(jq -r '.routines[] | select(.name == "normalize_isbn") | .oid' <<<"$routines")"
check "routine: lists the trigger that uses it" "books" "$(curl -sf "${BASE}/api/routines/${trg_oid}" | jq -r '.usedByTriggers[0].table')"
check "routine: non-numeric id is 400" "400" "$(status "${BASE}/api/routines/abc")"
check "routine: unknown id is 404" "404" "$(status "${BASE}/api/routines/999999999")"

# Security controls
check "unknown table is 404" "404" "$(status "${BASE}/api/tables/x%22%3B%20DROP%20TABLE%20orders%3B--")"
check "unknown sort column is 400" "400" "$(status "${BASE}/api/tables/orders?sort=nope")"
check "bad filter value is 400" "400" "$(status -G "${BASE}/api/tables/orders" --data-urlencode 'filters=[{"c":"id","op":"eq","v":"abc"}]')"
check "foreign Host header is 403" "403" "$(status -H 'Host: evil.example' "${BASE}/api/meta")"
check "cross-origin POST is 403" "403" "$(status -X POST -H 'Origin: http://evil.example' "${BASE}/api/meta")"
check "CSP header present" "1" "$(curl -sI "${BASE}/" | grep -ci '^content-security-policy:' || true)"

if [[ $fail -ne 0 ]]; then
  echo "Smoke test failed."
  exit 1
fi
echo "All smoke checks passed."
