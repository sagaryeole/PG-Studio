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

# Connections and databases
check "connections: at least one" "true" "$(curl -sf "${BASE}/api/connections" | jq '.connections | length > 0')"
check "connections: no credentials sent" "false" "$(curl -sf "${BASE}/api/connections" | jq 'tostring | test("password|postgres://")')"
check "databases: lists analytics" "true" "$(curl -sf "${BASE}/api/databases" | jq '[.databases[].name] | index("analytics") != null')"
check "databases: other database's tables" "true" "$(curl -sf "${BASE}/api/tables?db=analytics" | jq '[.tables[].name] | index("page_views") != null')"
check "databases: meta follows the database" "analytics" "$(curl -sf "${BASE}/api/meta?db=analytics" | jq -r '.database')"
check "unknown connection is 404" "404" "$(status "${BASE}/api/tables?conn=nope")"
check "unknown database is 404" "404" "$(status "${BASE}/api/tables?db=nope")"
check "template database is 404" "404" "$(status "${BASE}/api/tables?db=template1")"

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

or_filters='[{"c":"status","op":"eq","v":"paid"},{"c":"status","op":"eq","v":"refunded"}]'
or_rows="$(curl -sf -G "${BASE}/api/tables/orders" --data-urlencode "filters=${or_filters}" --data-urlencode "match=any" --data-urlencode "pageSize=50")"
check "match=any: rows match either condition" "true" "$(jq '[.rows[][2]] | length > 0 and all(. == "paid" or . == "refunded")' <<<"$or_rows")"
count_of() { curl -sf -G "${BASE}/api/tables/orders/count" "$@" | jq -r '.count'; }
paid_n="$(count_of --data-urlencode 'filters=[{"c":"status","op":"eq","v":"paid"}]')"
refunded_n="$(count_of --data-urlencode 'filters=[{"c":"status","op":"eq","v":"refunded"}]')"
any_n="$(count_of --data-urlencode "filters=${or_filters}" --data-urlencode "match=any")"
all_n="$(count_of --data-urlencode "filters=${or_filters}")"
check "match=any: count exceeds each single filter" "true" "$([[ "$any_n" -gt "$paid_n" && "$any_n" -gt "$refunded_n" ]] && echo true || echo false)"
check "match=all: contradictory filters match nothing" "0" "$all_n"
check "match=bogus is 400" "400" "$(status -G "${BASE}/api/tables/orders" --data-urlencode "filters=${or_filters}" --data-urlencode "match=bogus")"
sql_out="$(curl -sf -G "${BASE}/api/tables/orders/sql" --data-urlencode "filters=${or_filters}" --data-urlencode "match=any")"
check "sql: has WHERE" "true" "$(jq '.sql | contains("WHERE")' <<<"$sql_out")"
check "sql: inlines literal and OR" "true" "$(jq '.sql | contains("'"'"'refunded'"'"'") and contains(" OR ")' <<<"$sql_out")"

# Security controls
check "unknown table is 404" "404" "$(status "${BASE}/api/tables/x%22%3B%20DROP%20TABLE%20orders%3B--")"
check "unknown sort column is 400" "400" "$(status "${BASE}/api/tables/orders?sort=nope")"
check "bad filter value is 400" "400" "$(status -G "${BASE}/api/tables/orders" --data-urlencode 'filters=[{"c":"id","op":"eq","v":"abc"}]')"
check "foreign Host header is 403" "403" "$(status -H 'Host: evil.example' "${BASE}/api/meta")"
check "cross-origin POST is 403" "403" "$(status -X POST -H 'Origin: http://evil.example' "${BASE}/api/meta")"
check "CSP header present" "1" "$(curl -sI "${BASE}/" | grep -ci '^content-security-policy:' || true)"

# SQL editor: read queries only, one statement, never a write
sql() {
  local body
  body="$(jq -nc --arg sql "$1" --arg mode "${2:-run}" '{sql: $sql, mode: $mode}')"
  curl -s -X POST -H 'Content-Type: application/json' -H "Origin: ${BASE}" -H 'X-PG-Studio: 1' \
    --data "$body" "${BASE}/api/sql"
}
check "sql: capability on for a read-only role" "true" "$(jq -r '.capabilities.sql' <<<"$meta")"
check "sql: runs a query" "3" "$(sql 'select id from authors order by id limit 3;' | jq '.rows | length')"
check "sql: values come back as text" '["1","a"]' "$(sql "values (1, 'a')" | jq -c '.rows[0]')"
check "sql: duplicate column names kept" "2" "$(sql 'select 1 as a, 2 as a' | jq '.columns | length')"
check "sql: row limit" "true" "$(sql 'select * from generate_series(1, 100000)' | jq '.limitHit and (.rows | length) == .rowLimit')"
check "sql: explain returns a plan" "plan" "$(sql 'select count(*) from orders' explain | jq -r '.kind')"
check "sql: explain analyze runs" "true" "$(sql 'select count(*) from orders' analyze | jq '.plan | contains("actual time")')"
check "sql: two statements rejected" "true" "$(sql 'select 1; select 2' | jq '.error | test("one statement")')"
check "sql: write hidden after COMMIT rejected" "true" "$(sql 'select 1) x; commit; delete from orders; select (1' | jq '.error | test("one statement")')"
check "sql: DELETE rejected" "true" "$(sql 'delete from orders' | jq '.error | test("only runs read queries")')"
check "sql: SET rejected" "true" "$(sql 'set statement_timeout = 0' | jq '.error | test("only runs read queries")')"
check "sql: data-modifying WITH rejected" "true" "$(sql 'with d as (delete from orders returning *) select * from d' | jq '.error | test("top level")')"
check "sql: read-only transaction" "true" "$(sql 'select * from orders for update' | jq '.error | test("read-only transaction")')"
check "sql: error position points into the query" "14" "$(sql 'select * from no_such_table' | jq '.position')"
check "sql: orders still all there" "true" "$(sql 'select count(*) > 0 as ok from orders' | jq -r '.rows[0][0] == "t"')"
check "sql: cross-origin POST is 403" "403" "$(status -X POST -H 'Content-Type: application/json' -H 'Origin: http://evil.example' -H 'X-PG-Studio: 1' --data '{"sql":"select 1"}' "${BASE}/api/sql")"
check "sql: non-JSON body is 400" "400" "$(status -X POST -H 'Content-Type: text/plain' -H "Origin: ${BASE}" -H 'X-PG-Studio: 1' --data 'select 1' "${BASE}/api/sql")"
check "sql: export csv" "200" "$(status -X POST -H 'Content-Type: application/json' -H "Origin: ${BASE}" -H 'X-PG-Studio: 1' --data '{"sql":"select * from authors"}' "${BASE}/api/sql/export?format=csv")"

if [[ $fail -ne 0 ]]; then
  echo "Smoke test failed."
  exit 1
fi
echo "All smoke checks passed."
