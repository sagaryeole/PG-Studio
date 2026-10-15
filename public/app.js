// PG Studio front end. No framework; all DB values are rendered with
// textContent, never innerHTML, so cell contents cannot inject markup.
"use strict";

const $ = (id) => document.getElementById(id);
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";

const OP_LABELS = {
  eq: "=",
  neq: "≠",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  contains: "contains",
  not_contains: "doesn't contain",
  starts: "starts with",
  ends: "ends with",
  null: "is empty (NULL)",
  not_null: "has a value",
};
const VALUELESS = new Set(["null", "not_null"]);
const KIND_LABEL = { view: "view", matview: "materialized view", partitioned: "partitioned" };
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

const state = {
  meta: null,
  schemas: [],
  tablesSchema: null, // schema the sidebar list was loaded for
  tables: [],
  allTables: null, // every relation in every schema, for the jump dialog
  routines: [], // functions, procedures and aggregates of tablesSchema (best effort)
  allRoutines: null, // same, across schemas, for the jump dialog
  routine: null, // { oid, schema, detail } while a routine is open
  /** { schema, name, page, pageSize, sort, filters, q, cursor: {dir, value} | null } */
  current: null,
  tab: "data", // "data" | "details"
  data: null, // last /api/tables/:name response
  details: null, // { key, data } for the Structure tab
  selected: null, // { r, c } selected cell (c = index into table.columns)
  seq: 0, // guards against out-of-order responses
  countSeq: 0,
  editingFilter: -1,
  prefs: null, // column prefs for the current table
  jumpItems: [],
  pendingError: null, // shown once the next table load succeeds
  jumpIndex: 0,
};

// ---- Utilities ---------------------------------------------------------

async function api(path) {
  const res = await fetch(`/api${path}`, { headers: { Accept: "application/json" } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

function showError(msg) {
  $("error-text").textContent = msg || "";
  $("error").hidden = !msg;
}

function showNotice(msg) {
  const n = $("notice");
  n.textContent = msg || "";
  n.hidden = !msg;
}

let toastTimer = 0;
function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) {
    t = el("div", { class: "toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1600);
}

function fmtCount(n) {
  if (n === null || n === undefined) return "";
  return n < 10_000 ? `~${n.toLocaleString()}` : `~${compact.format(n)}`;
}

function fmtBytes(n) {
  if (n === null || n === undefined) return "—";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));
}

function tablePath(cur, suffix = "") {
  return `/tables/${encodeURIComponent(cur.name)}${suffix}`;
}

/** Query string for the current view: schema, sort, filters, search (+ extra). */
function viewQuery(cur, extra = {}) {
  const p = new URLSearchParams(extra);
  p.set("schema", cur.schema);
  if (cur.sort) {
    p.set("sort", cur.sort.column);
    p.set("dir", cur.sort.dir);
  }
  if (cur.filters.length) p.set("filters", JSON.stringify(cur.filters));
  if (cur.q) p.set("q", cur.q);
  return p;
}

function sameView(a, b) {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    showError("The browser blocked clipboard access.");
  }
}

// ---- Browser-local preferences (best effort) ---------------------------

function storageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}

function loadPrefs(schema, table) {
  const p = storageGet(`pgstudio:cols:${schema}.${table}`, null);
  return {
    widths: p && typeof p.widths === "object" && p.widths ? p.widths : {},
    hidden: Array.isArray(p?.hidden) ? p.hidden : [],
    freeze: !!p?.freeze,
  };
}

function savePrefs() {
  if (state.current && state.prefs) storageSet(`pgstudio:cols:${state.current.schema}.${state.current.name}`, state.prefs);
}

function rememberRecent(schema, name) {
  const list = storageGet("pgstudio:recent", []).filter(
    (r) => r && typeof r.name === "string" && !(r.schema === schema && r.name === name),
  );
  list.unshift({ schema, name });
  storageSet("pgstudio:recent", list.slice(0, 6));
}

// ---- URL hash state ----------------------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const name = p.get("t");
  const schema = p.get("sc") || state.meta?.schema || "public";
  const fn = /^\d{1,10}$/.test(p.get("fn") || "") ? p.get("fn") : null;
  if (!name) return { schema, name: null, fn };
  const page = Math.max(1, parseInt(p.get("p") || "1", 10) || 1);
  const size = parseInt(p.get("n") || "", 10);
  const pageSize = [25, 50, 100].includes(size) ? size : state.meta?.pageSizeDefault ?? 50;
  const s = p.get("s");
  const d = p.get("d") === "desc" ? "desc" : "asc";
  let filters = [];
  try {
    const f = JSON.parse(p.get("f") || "[]");
    if (Array.isArray(f)) filters = f.filter((x) => x && typeof x.c === "string" && typeof x.op === "string");
  } catch {
    /* ignore a bad hash */
  }
  const a = p.get("a");
  const b = p.get("b");
  const cursor = a ? { dir: "after", value: a } : b ? { dir: "before", value: b } : null;
  return {
    view: { schema, name, page, pageSize, sort: s ? { column: s, dir: d } : null, filters, q: p.get("q") || "", cursor },
    tab: p.get("v") === "details" ? "details" : "data",
    schema,
    name,
  };
}

function writeHash(cur, push) {
  const p = new URLSearchParams();
  if (cur.schema !== state.meta.schema) p.set("sc", cur.schema);
  p.set("t", cur.name);
  if (cur.page > 1) p.set("p", String(cur.page));
  if (cur.pageSize !== state.meta.pageSizeDefault) p.set("n", String(cur.pageSize));
  if (cur.sort) {
    p.set("s", cur.sort.column);
    p.set("d", cur.sort.dir);
  }
  if (cur.filters.length) p.set("f", JSON.stringify(cur.filters));
  if (cur.q) p.set("q", cur.q);
  if (cur.cursor) p.set(cur.cursor.dir === "after" ? "a" : "b", cur.cursor.value);
  if (state.tab === "details") p.set("v", "details");
  const next = `#${p.toString()}`;
  if (location.hash === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

/** Routine views are addressed by oid: #fn=<oid>, plus sc=<schema> when not the default. */
function writeRoutineHash(schema, oid, push) {
  const p = new URLSearchParams();
  if (schema !== state.meta.schema) p.set("sc", schema);
  p.set("fn", oid);
  const next = `#${p.toString()}`;
  if (location.hash === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

// ---- Schemas, sidebar, home --------------------------------------------

function renderSchemaSelect() {
  const sel = $("schema-select");
  sel.replaceChildren(
    ...state.schemas.map((s) => el("option", { value: s.name, text: `${s.name}  (${s.relations})` })),
  );
  if (state.tablesSchema) sel.value = state.tablesSchema;
  sel.disabled = state.schemas.length <= 1;
}

async function loadTables(schema) {
  // Routines load in parallel and never block (or break) the table list.
  const routinesReq = api(`/routines?${new URLSearchParams({ schema })}`).then((r) => r.routines, () => []);
  const { tables } = await api(`/tables?${new URLSearchParams({ schema })}`);
  state.tables = tables;
  state.routines = [];
  state.tablesSchema = schema;
  $("schema-select").value = schema;
  renderTables();
  if (!state.current) renderHome();
  routinesReq.then((routines) => {
    if (state.tablesSchema !== schema) return;
    state.routines = routines;
    renderTables();
  });
}

function renderTables() {
  const nav = $("tables");
  const filter = $("filter").value.trim().toLowerCase();
  nav.replaceChildren();
  const shown = state.tables.filter((t) => t.name.toLowerCase().includes(filter));
  const groups = [
    ["Tables", shown.filter((t) => t.kind === "table" || t.kind === "partitioned")],
    ["Views", shown.filter((t) => t.kind === "view" || t.kind === "matview")],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const ul = el("ul");
    for (const t of items) {
      const btn = el(
        "button",
        { type: "button", title: t.name },
        el(
          "span",
          { class: "tname" },
          t.name,
          t.kind === "matview" || t.kind === "partitioned" ? el("span", { class: "kind", text: t.kind === "matview" ? "mat." : "part." }) : null,
        ),
        el("span", { class: "tcount", text: t.kind === "view" ? "" : fmtCount(t.estimatedRows) }),
      );
      const cur = state.current;
      if (cur && cur.name === t.name && cur.schema === state.tablesSchema) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", () => openTable(freshView(t.name, [], state.tablesSchema), { push: true }));
      ul.append(el("li", {}, btn));
    }
    nav.append(el("h3", { text: `${label} (${items.length})` }), ul);
  }
  const routinesShown = renderRoutineGroups(nav, filter);
  $("tables-status").textContent =
    state.tables.length === 0 && state.routines.length === 0
      ? "Nothing readable in this schema. Check the role's grants."
      : filter && shown.length === 0 && routinesShown === 0
        ? `Nothing matches "${$("filter").value.trim()}".`
        : "";
}

/** "2 args" style hint that tells overloads of one name apart. */
function argHint(args) {
  const n = args.trim() ? args.split(",").length : 0;
  return n === 0 ? "no args" : plural(n, "arg");
}

/** Functions and Procedures groups for the sidebar. Returns how many items match the filter. */
function renderRoutineGroups(nav, filter) {
  const shown = state.routines.filter((r) => r.name.toLowerCase().includes(filter));
  const overloaded = new Map();
  for (const r of state.routines) overloaded.set(r.name, (overloaded.get(r.name) ?? 0) + 1);
  const groups = [
    ["Functions", shown.filter((r) => r.kind !== "procedure")],
    ["Procedures", shown.filter((r) => r.kind === "procedure")],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const ul = el("ul");
    for (const r of items) {
      const tag = { aggregate: "agg.", window: "win." }[r.kind];
      const btn = el(
        "button",
        { type: "button", title: `${r.name}(${r.args})` },
        el("span", { class: "tname" }, r.name, tag ? el("span", { class: "kind", text: tag }) : null),
        el("span", { class: "tcount", text: overloaded.get(r.name) > 1 ? argHint(r.args) : "" }),
      );
      if (state.routine?.oid === r.oid) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", () => openRoutine(r.oid, state.tablesSchema, { push: true }));
      ul.append(el("li", {}, btn));
    }
    nav.append(el("h3", { text: `${label} (${items.length})` }), ul);
  }
  return shown.length;
}

function renderHome() {
  const home = $("empty");
  const schema = state.tablesSchema ?? state.meta?.schema ?? "";
  const tables = state.tables;
  const parts = [
    el("h1", {}, el("span", { class: "mono", text: schema })),
    el("p", {
      text: tables.length
        ? `${plural(tables.length, "table or view", "tables and views")} you can read. Pick one to browse its rows, or press ${MOD} K to jump to any table by name.`
        : "This schema has nothing the connected role can read. Pick another schema, or check the role's grants.",
    }),
  ];

  const card = (t, schemaName = schema) =>
    el(
      "button",
      { type: "button", onclick: () => openTable(freshView(t.name, [], schemaName), { push: true }) },
      el("span", { class: "tname", text: schemaName === schema ? t.name : `${schemaName}.${t.name}` }),
      el("span", {
        class: "tmeta",
        text: [KIND_LABEL[t.kind], t.estimatedRows !== null && t.estimatedRows !== undefined ? `${fmtCount(t.estimatedRows)} ${t.estimatedRows === 1 ? "row" : "rows"}` : ""]
          .filter(Boolean)
          .join(", "),
      }),
    );

  const recent = storageGet("pgstudio:recent", []).filter((r) => r && typeof r.name === "string");
  const known = new Map(tables.map((t) => [t.name, t]));
  const recentHere = recent
    .map((r) => (r.schema === schema ? known.get(r.name) && { t: known.get(r.name), s: r.schema } : { t: { name: r.name, kind: "table", estimatedRows: null }, s: r.schema }))
    .filter(Boolean);
  if (recentHere.length) {
    parts.push(el("h2", { text: "Recently opened" }), el("div", { class: "home-tables" }, ...recentHere.map(({ t, s }) => card(t, s))));
  }

  if (tables.length) {
    const biggest = [...tables].sort((a, b) => (b.estimatedRows ?? -1) - (a.estimatedRows ?? -1)).slice(0, 9);
    parts.push(el("h2", { text: "Largest tables" }), el("div", { class: "home-tables" }, ...biggest.map((t) => card(t))));
  }

  parts.push(
    el("h2", { text: "Getting around" }),
    el(
      "dl",
      { class: "home-tips" },
      el("dt", {}, el("kbd", { text: MOD }), " ", el("kbd", { text: "K" })),
      el("dd", { text: "Jump to any table or view, in any schema." }),
      el("dt", {}, el("kbd", { text: "/" })),
      el("dd", { text: "Search the open table." }),
      el("dt", {}, el("kbd", { text: "▾" })),
      el("dd", { text: "On a column header: sort, filter or hide that column." }),
      el("dt", {}, el("kbd", { text: "↗" })),
      el("dd", { text: "In a foreign-key cell: open the row it points to. Back returns here." }),
      el("dt", {}, el("kbd", { text: "?" })),
      el("dd", { text: "All keyboard shortcuts." }),
    ),
  );
  home.replaceChildren(...parts);
}

function freshView(name, filters = [], schema = state.current?.schema ?? state.meta.schema) {
  return {
    schema,
    name,
    page: 1,
    pageSize: state.current?.pageSize ?? state.meta.pageSizeDefault,
    sort: null,
    filters,
    q: "",
    cursor: null,
  };
}

// ---- Loading -----------------------------------------------------------

async function openTable(cur, { push = false } = {}) {
  const seq = ++state.seq;
  const prev = state.current;
  const tableChanged = !prev || prev.name !== cur.name || prev.schema !== cur.schema;
  state.current = cur;
  state.routine = null; // the routine section is hidden once the table renders
  if (tableChanged) {
    state.prefs = loadPrefs(cur.schema, cur.name);
    state.details = null;
    state.selected = null;
    hideFilterForm();
    showNotice("");
    rememberRecent(cur.schema, cur.name);
  }
  state.selected = null;
  resetCount();
  closeInspector();
  closeMenus();
  writeHash(cur, push);
  showError("");
  setBusy(true);

  try {
    if (state.tablesSchema !== cur.schema) await loadTables(cur.schema);
    else renderTables();

    const extra = { page: String(cur.page), pageSize: String(cur.pageSize) };
    if (cur.cursor) extra[cur.cursor.dir] = cur.cursor.value;
    const data = await api(`${tablePath(cur)}?${viewQuery(cur, extra)}`);
    if (seq !== state.seq) return; // a newer request superseded this one

    // Keyset paging: without a cursor we're on page 1 whatever the URL said,
    // and if paging back reached the start the server returned page 1.
    if (data.paging === "keyset" && !data.hasPrev && cur.page !== 1) {
      cur.page = 1;
      cur.cursor = null;
      data.page = 1;
      writeHash(cur, false);
    }
    state.data = data;
    renderView();
    if (state.pendingError) {
      showError(state.pendingError);
      state.pendingError = null;
    }
    if (tableChanged) $("grid-wrap").scrollTo(0, 0);
    else $("grid-wrap").scrollTop = 0;
    if (state.tab === "details") loadDetails();
  } catch (err) {
    if (seq !== state.seq) return;
    const sameTable = state.data && state.data.table.name === cur.name && state.data.table.schema === cur.schema;
    // A bookmark or link with a filter/sort that no longer works: open the plain table instead
    // and say why, so the user isn't stuck on the home page.
    if (!sameTable && (cur.filters.length || cur.q || cur.sort || cur.cursor)) {
      state.pendingError = `Couldn't apply the saved filters, search or sort (${err.message}), so the table is shown without them.`;
      openTable({ ...cur, filters: [], q: "", sort: null, cursor: null, page: 1 });
      return;
    }
    // Keep the toolbar usable so a bad filter can be removed.
    if (sameTable) {
      renderChips();
      $("search").value = cur.q;
    } else {
      state.data = null;
      $("view").hidden = true;
      $("routine").hidden = true;
      $("empty").hidden = false;
      renderHome();
    }
    showError(
      err.message === "Table not found"
        ? `There's no table or view called "${cur.name}" in ${cur.schema} that this role can read.`
        : err.message,
    );
  } finally {
    if (seq === state.seq) setBusy(false);
  }
}

/** Re-open the current table with changes. Any change resets the cursor unless one is given. */
function reload(changes) {
  openTable({ ...state.current, cursor: null, ...changes });
}

function setBusy(busy) {
  $("grid-wrap").classList.toggle("loading", busy);
  for (const id of ["first", "prev", "next", "page-size"]) $(id).disabled = busy;
  if (!busy && state.data) {
    $("first").disabled = !state.data.hasPrev;
    $("prev").disabled = !state.data.hasPrev;
    $("next").disabled = !state.data.hasNext;
  }
}

function goNext() {
  const d = state.data;
  if (!d?.hasNext) return;
  if (d.paging === "keyset") reload({ page: d.page + 1, cursor: { dir: "after", value: d.nextCursor } });
  else reload({ page: d.page + 1 });
}

function goPrev() {
  const d = state.data;
  if (!d?.hasPrev) return;
  if (d.paging === "keyset") reload({ page: Math.max(1, d.page - 1), cursor: { dir: "before", value: d.prevCursor } });
  else reload({ page: d.page - 1 });
}

// ---- View --------------------------------------------------------------

function visibleColumns() {
  const hidden = new Set(state.prefs.hidden);
  return state.data.table.columns.map((col, c) => ({ col, c })).filter(({ col }) => !hidden.has(col.name));
}

/** Map column name -> outgoing FKs that include it (only those the role can follow). */
function fkByColumn() {
  const map = new Map();
  for (const fk of state.data.table.foreignKeys) {
    if (!fk.navigable) continue;
    for (const col of fk.fromColumns) {
      if (!map.has(col)) map.set(col, []);
      map.get(col).push(fk);
    }
  }
  return map;
}

function qualified(schema, name) {
  return schema === state.current.schema ? name : `${schema}.${name}`;
}

function fact(...children) {
  return el("span", {}, ...children);
}

function renderView() {
  const d = state.data;
  const t = d.table;
  const cur = state.current;

  $("empty").hidden = true;
  $("routine").hidden = true;
  $("view").hidden = false;
  const h1 = $("title");
  h1.replaceChildren();
  if (cur.schema !== state.meta.schema) h1.append(el("span", { class: "schema-prefix", text: `${t.schema}.` }));
  h1.append(t.name);
  document.title = `${t.name} · PG Studio`;

  const facts = [];
  if (KIND_LABEL[t.kind]) facts.push(el("span", { class: "kind-fact", text: KIND_LABEL[t.kind] }));
  facts.push(fact(el("b", { text: String(t.columns.length) }), " columns"));
  if (t.estimatedRows !== null) facts.push(fact(el("b", { text: fmtCount(t.estimatedRows) }), " rows (estimate)"));
  if (t.primaryKey.length) facts.push(fact("Primary key ", el("b", { class: "mono", text: t.primaryKey.join(", ") })));
  else if (t.kind !== "view") facts.push(fact("No primary key"));
  if (t.foreignKeys.length) facts.push(fact(el("b", { text: String(t.foreignKeys.length) }), t.foreignKeys.length === 1 ? " foreign key" : " foreign keys"));
  if (t.referencedBy.length) facts.push(fact("Referenced by ", el("b", { text: String(t.referencedBy.length) })));
  $("facts").replaceChildren(...facts);

  $("count-btn").textContent = d.filtered ? "Count matching rows" : "Count all rows";

  const warn = $("warning");
  let warning = "";
  if (t.kind === "view" && !cur.sort) {
    warning = "Views have no fixed row order, so pages can overlap or skip rows. Sort by a column for stable paging.";
  } else if (!d.orderedByPrimaryKey && t.kind !== "view") {
    warning = "This table has no primary key, so rows appear in storage order and pages can shift while the table changes.";
  }
  warn.textContent = warning;
  warn.hidden = !warning;

  const first = (d.page - 1) * d.pageSize + 1;
  const last = first + d.rows.length - 1;
  let info = d.rows.length ? `Rows ${first.toLocaleString()}–${last.toLocaleString()}` : "No rows";
  if (d.rows.length && !d.filtered && t.estimatedRows !== null) info += ` of ${fmtCount(t.estimatedRows)}`;
  if (d.filtered && d.rows.length) info += " (filtered)";
  $("row-info").textContent = info;
  $("page").textContent = `Page ${d.page.toLocaleString()}`;
  $("page").title =
    d.paging === "keyset"
      ? `Fast paging by ${t.primaryKey.length ? "primary key" : "storage position"}: each page continues from the last row of the previous one.`
      : cur.sort
        ? "Page-number paging (custom sort). Deep pages on big tables are slower."
        : "Page-number paging.";
  $("page-size").value = String(d.pageSize);

  const search = $("search");
  if (document.activeElement !== search) search.value = cur.q;
  search.disabled = d.searchColumns.length === 0;
  search.placeholder = d.searchColumns.length
    ? `Search ${d.searchColumns.slice(0, 2).join(", ")}${d.searchColumns.length > 2 ? "…" : ""}`
    : "No text columns to search";
  search.title = d.searchColumns.length ? `Searches the text columns: ${d.searchColumns.join(", ")}` : "";

  $("export-note").textContent = `Exports what you see: same sort, filters and search, up to ${state.meta.exportMaxRows.toLocaleString()} rows.`;

  renderChips();
  renderGrid();
  applyTab();
}

function renderGrid() {
  const d = state.data;
  const cur = state.current;
  const cols = visibleColumns();
  const fks = fkByColumn();
  const widths = state.prefs.widths;

  // Header
  const hr = el("tr", {}, el("th", { class: "rownum", text: "#" }));
  for (const { col, c } of cols) {
    const sorted = cur.sort && cur.sort.column === col.name ? cur.sort.dir : null;
    const keyTag = col.isPrimaryKey
      ? el("span", { class: "key-ind pk", title: "Primary key", text: "PK" })
      : fks.has(col.name)
        ? el("span", { class: "key-ind fk", title: "Foreign key", text: "FK" })
        : null;
    const label = el(
      "button",
      { type: "button", class: "sort-btn", title: `${col.name}: click to sort` },
      el(
        "span",
        { class: "cname" },
        el("span", { class: "nm", text: col.name }),
        keyTag,
        el("span", { class: "sort-ind", text: sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "" }),
      ),
      el("span", { class: "ctype", text: col.type + (col.nullable ? "" : ", required") }),
    );
    label.addEventListener("click", () => cycleSort(col.name));
    const menuBtn = el("button", {
      type: "button",
      class: "col-menu-btn",
      "aria-label": `Options for ${col.name}`,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
      title: "Sort, filter or hide",
      text: "▾",
    });
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openColMenu(c, menuBtn);
    });
    const th = el(
      "th",
      { dataset: { c: String(c) } },
      el("div", { class: "th-inner" }, label, menuBtn),
      el("span", { class: "resizer", title: "Drag to resize" }),
    );
    if (sorted) th.setAttribute("aria-sort", sorted === "asc" ? "ascending" : "descending");
    applyWidth(th, widths[col.name]);
    hr.append(th);
  }
  $("grid").tHead.replaceChildren(hr);

  // Body
  const cut = new Set(d.truncated.map(([r, c]) => `${r}:${c}`));
  const tbody = $("grid").tBodies[0];
  const frag = document.createDocumentFragment();
  const first = (d.page - 1) * d.pageSize + 1;

  if (d.rows.length === 0) {
    const td = el("td", { class: "nodata", colspan: String(cols.length + 1) });
    if (d.filtered) {
      td.append(
        "No rows match the current filters and search.",
        el("button", { type: "button", text: "Clear filters", onclick: () => reload({ filters: [], q: "", page: 1 }) }),
      );
    } else {
      td.textContent = d.page > 1 ? "No rows on this page." : "This table is empty.";
    }
    frag.append(el("tr", {}, td));
  }

  d.rows.forEach((row, r) => {
    const tr = el("tr", {}, el("td", { class: "rownum", text: String(first + r) }));
    for (const { col, c } of cols) {
      const v = row[c];
      const td = el("td", { class: col.category === "N" ? "cell num" : "cell", dataset: { r: String(r), c: String(c) } });
      if (v === null) {
        td.classList.add("null");
        td.textContent = "NULL";
      } else {
        const fkList = fks.get(col.name);
        if (fkList) {
          const fk = fkList[0];
          td.classList.add("has-fk");
          td.append(
            el("span", {
              class: "fk-go",
              role: "button",
              tabindex: "-1",
              title: `Open ${qualified(fk.toSchema, fk.toTable)} where ${describeKey(fk.toColumns, fk.fromColumns, row)}`,
              dataset: { fk: fk.name },
              text: "↗",
            }),
          );
        }
        td.append(document.createTextNode(v));
        td.title = v.length > 300 ? `${v.slice(0, 300)}…` : v;
        if (cut.has(`${r}:${c}`)) td.classList.add("cut");
      }
      applyWidth(td, widths[col.name]);
      tr.append(td);
    }
    frag.append(tr);
  });
  tbody.replaceChildren(frag);

  applyFreeze();
  paintSelection();
}

function applyWidth(node, w) {
  if (w) {
    node.style.width = `${w}px`;
    node.style.minWidth = `${w}px`;
    node.style.maxWidth = `${w}px`;
  } else {
    node.style.width = node.style.minWidth = node.style.maxWidth = "";
  }
}

function applyFreeze() {
  const grid = $("grid");
  grid.querySelectorAll(".frozen").forEach((n) => {
    n.classList.remove("frozen");
    n.style.left = "";
  });
  if (!state.prefs.freeze) return;
  const firstVisible = visibleColumns()[0];
  if (!firstVisible) return;
  const left = grid.tHead.querySelector("th.rownum").offsetWidth;
  grid.querySelectorAll(`[data-c="${firstVisible.c}"]`).forEach((n) => {
    n.classList.add("frozen");
    n.style.left = `${left}px`;
  });
}

function setSort(column, dir) {
  reload({ sort: dir ? { column, dir } : null, page: 1 });
}

function cycleSort(column) {
  const s = state.current.sort;
  if (!s || s.column !== column) setSort(column, "asc");
  else if (s.dir === "asc") setSort(column, "desc");
  else setSort(column, null);
}

// ---- Cell selection and keyboard navigation ------------------------------

function paintSelection() {
  const grid = $("grid");
  grid.querySelectorAll("td.selected").forEach((n) => n.classList.remove("selected"));
  grid.querySelectorAll("tr.row-selected").forEach((n) => n.classList.remove("row-selected"));
  const s = state.selected;
  if (!s) return;
  const td = grid.querySelector(`td.cell[data-r="${s.r}"][data-c="${s.c}"]`);
  if (td) {
    td.classList.add("selected");
    td.parentElement.classList.add("row-selected");
  } else {
    grid.tBodies[0].rows[s.r]?.classList.add("row-selected");
  }
}

function selectCell(r, c, { open = false, scroll = true } = {}) {
  state.selected = { r, c };
  paintSelection();
  if (scroll) {
    const td = $("grid").querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`);
    td?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (open || !$("inspector").hidden) openInspector(r, c);
}

function moveSelection(dr, dc) {
  const d = state.data;
  if (!d || !d.rows.length) return;
  const cols = visibleColumns().map(({ c }) => c);
  if (!cols.length) return;
  const s = state.selected;
  if (!s) {
    selectCell(0, cols[0]);
    return;
  }
  const r = Math.max(0, Math.min(d.rows.length - 1, s.r + dr));
  let ci = cols.indexOf(s.c);
  if (ci < 0) ci = 0;
  ci = Math.max(0, Math.min(cols.length - 1, ci + dc));
  selectCell(r, cols[ci]);
}

function onGridKey(e) {
  if (e.target.closest?.(".th-inner")) return;
  const map = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (map[e.key]) {
    e.preventDefault();
    moveSelection(...map[e.key]);
  } else if (e.key === "Enter" && state.selected) {
    e.preventDefault();
    openInspector(state.selected.r, state.selected.c);
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && state.selected) {
    if (String(window.getSelection() || "")) return; // let a real text selection copy normally
    e.preventDefault();
    const v = state.data.rows[state.selected.r][state.selected.c];
    copyText(v === null ? "" : v, v === null ? "Copied (empty: value is NULL)" : "Copied");
  }
}

// ---- Column header menu ----------------------------------------------------

let colMenu = null;

function sortLabels(col) {
  if (col.category === "N") return ["Sort 1 → 9", "Sort 9 → 1"];
  if (col.category === "D") return ["Sort oldest first", "Sort newest first"];
  if (col.category === "B") return ["Sort false first", "Sort true first"];
  if (col.category === "S" || col.category === "E") return ["Sort A → Z", "Sort Z → A"];
  return ["Sort ascending", "Sort descending"];
}

function openColMenu(c, anchor) {
  const wasOpenFor = colMenu && colMenu.dataset.c === String(c);
  closeMenus();
  if (wasOpenFor) return;
  const col = state.data.table.columns[c];
  const cur = state.current;
  const sorted = cur.sort && cur.sort.column === col.name ? cur.sort.dir : null;
  const [ascLabel, descLabel] = sortLabels(col);

  const item = (text, onclick, opts = {}) =>
    el("button", { type: "button", class: "menu-item", role: "menuitem", disabled: opts.disabled }, text, opts.hint ? el("span", { class: "muted small", text: opts.hint }) : null);

  const items = [];
  const asc = item(ascLabel, null, { disabled: sorted === "asc", hint: sorted === "asc" ? "current" : "" });
  asc.addEventListener("click", () => setSort(col.name, "asc"));
  const desc = item(descLabel, null, { disabled: sorted === "desc", hint: sorted === "desc" ? "current" : "" });
  desc.addEventListener("click", () => setSort(col.name, "desc"));
  items.push(asc, desc);
  if (sorted) {
    const clear = item("Clear sort");
    clear.addEventListener("click", () => setSort(col.name, null));
    items.push(clear);
  }
  items.push(el("hr"));
  const filt = item("Filter this column…");
  filt.addEventListener("click", () => {
    closeMenus();
    showFilterForm(-1, { c: col.name, op: defaultOpFor(col.name) });
  });
  items.push(filt);
  if (col.nullable) {
    const hasVal = item("Only rows with a value");
    hasVal.addEventListener("click", () => reload({ filters: [...cur.filters, { c: col.name, op: "not_null" }], page: 1 }));
    const noVal = item("Only empty (NULL) rows");
    noVal.addEventListener("click", () => reload({ filters: [...cur.filters, { c: col.name, op: "null" }], page: 1 }));
    items.push(hasVal, noVal);
  }
  items.push(el("hr"));
  const hide = item("Hide column", null, { disabled: visibleColumns().length <= 1 });
  hide.addEventListener("click", () => {
    state.prefs.hidden = [...new Set([...state.prefs.hidden, col.name])];
    savePrefs();
    closeMenus();
    closeInspector();
    renderGrid();
    toast(`Hid ${col.name}. Bring it back from Columns.`);
  });
  items.push(hide);

  colMenu = el("div", { class: "menu col-menu", role: "menu", dataset: { c: String(c) } }, el("div", { class: "menu-head", text: col.name }), ...items);
  colMenu.addEventListener("click", (e) => e.stopPropagation());
  document.body.append(colMenu);
  const r = anchor.closest("th").getBoundingClientRect();
  const w = colMenu.offsetWidth;
  colMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
  colMenu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - colMenu.offsetHeight - 8)}px`;
  anchor.setAttribute("aria-expanded", "true");
  colMenu.querySelector("button:not(:disabled)")?.focus();
}

// ---- Exact count ---------------------------------------------------------

function resetCount() {
  state.countSeq++;
  $("count-result").textContent = "";
  $("count-btn").disabled = false;
}

async function runCount() {
  const cur = state.current;
  const seq = ++state.countSeq;
  const out = $("count-result");
  $("count-btn").disabled = true;
  out.textContent = "Counting…";
  try {
    const r = await api(`${tablePath(cur, "/count")}?${viewQuery(cur)}`);
    if (seq !== state.countSeq) return;
    out.textContent = `${BigInt(r.count).toLocaleString()} ${r.filtered ? "matching rows" : "rows"}`;
  } catch (err) {
    if (seq !== state.countSeq) return;
    out.textContent = err.message.startsWith("Query timed out")
      ? "Too big to count within the time limit (STATEMENT_TIMEOUT_MS)."
      : `Count failed: ${err.message}`;
  } finally {
    if (seq === state.countSeq) $("count-btn").disabled = false;
  }
}

// ---- Tabs and Structure ----------------------------------------------------

function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  closeInspector();
  closeMenus();
  applyTab();
  if (state.current) writeHash(state.current, false);
  if (tab === "details") loadDetails();
}

function applyTab() {
  const details = state.tab === "details";
  $("tab-data").setAttribute("aria-selected", String(!details));
  $("tab-details").setAttribute("aria-selected", String(details));
  $("data-pane").hidden = details;
  $("details-pane").hidden = !details;
}

async function loadDetails() {
  const cur = state.current;
  const key = `${cur.schema}.${cur.name}`;
  if (state.details?.key === key) {
    renderDetails(state.details.data);
    return;
  }
  const pane = $("details-pane");
  pane.replaceChildren(el("p", { class: "muted", text: "Loading structure…" }));
  try {
    const data = await api(`${tablePath(cur, "/details")}?${new URLSearchParams({ schema: cur.schema })}`);
    if (`${state.current.schema}.${state.current.name}` !== key) return;
    state.details = { key, data };
    if (state.tab === "details") renderDetails(data);
  } catch (err) {
    pane.replaceChildren(el("p", { class: "banner banner-error", text: `Couldn't load the structure: ${err.message}` }));
  }
}

function section(title, count, ...children) {
  return el(
    "section",
    { class: "d-section" },
    el("h2", {}, title, count !== null && count !== undefined ? el("span", { class: "n", text: ` ${count}` }) : null),
    ...children,
  );
}

function kv(pairs) {
  const box = el("div", { class: "kv" });
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === "") continue;
    box.append(el("div", { class: "kv-item" }, el("span", { class: "kv-k", text: k }), el("span", { class: "kv-v", text: String(v) })));
  }
  return box;
}

function dtable(headers, rows) {
  return el(
    "div",
    { class: "d-table-wrap" },
    el(
      "table",
      { class: "d-table" },
      el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { text: h })))),
      el(
        "tbody",
        {},
        ...rows.map((r) => el("tr", {}, ...r.map((cell) => (cell instanceof Node ? el("td", {}, cell) : el("td", { text: cell ?? "" }))))),
      ),
    ),
  );
}

function codeBlock(text, label) {
  const pre = el("pre", { class: "d-code", text });
  const btn = el("button", { type: "button", class: "small", text: `Copy ${label}` });
  btn.addEventListener("click", () => copyText(text, `Copied ${label}`));
  return el("div", { class: "d-code-wrap" }, btn, pre);
}

function fmtWhen(v) {
  if (!v) return "never";
  const d = parsePgTimestamptz(v);
  return d ? d.toLocaleString() : v;
}

function renderDetails(d) {
  const pane = $("details-pane");
  const parts = [];

  if (d.comment) parts.push(el("p", { class: "d-comment", text: d.comment }));

  const overview = [
    ["Kind", { table: "Table", partitioned: "Partitioned table", view: "View", matview: "Materialized view" }[d.kind]],
    ["Owner", d.owner],
  ];
  if (d.sizes) {
    overview.push(["Total size", fmtBytes(d.sizes.totalBytes)], ["Table data", fmtBytes(d.sizes.tableBytes)], ["Indexes", fmtBytes(d.sizes.indexBytes)]);
    if (d.sizes.toastBytes) overview.push(["Large values (TOAST)", fmtBytes(d.sizes.toastBytes)]);
  }
  if (d.partitionKey) overview.push(["Partition key", d.partitionKey], ["Partitions", d.partitions]);
  if (d.stats) {
    overview.push(
      ["Live rows (stats)", d.stats.liveRows?.toLocaleString()],
      ["Dead rows", d.stats.deadRows?.toLocaleString()],
      ["Last vacuum", fmtWhen(d.stats.lastVacuum)],
      ["Last analyze", fmtWhen(d.stats.lastAnalyze)],
      ["Full-table scans", d.stats.seqScans?.toLocaleString()],
      ["Index scans", d.stats.indexScans?.toLocaleString()],
    );
  }
  parts.push(section("Overview", null, kv(overview)));

  parts.push(
    section(
      "Columns",
      d.columns.length,
      dtable(
        ["Name", "Type", "Required", "Default", "Comment"],
        d.columns.map((c) => [
          el("span", { class: "mono", text: c.name }),
          el("span", { class: "mono", text: c.type }),
          c.nullable ? "" : "yes",
          el("span", { class: "mono", text: c.generated ? `generated: ${c.generated}` : c.identity ? `identity (${c.identity})` : c.default ?? "" }),
          c.comment ?? "",
        ]),
      ),
    ),
  );

  if (d.indexes.length) {
    parts.push(
      section(
        "Indexes",
        d.indexes.length,
        dtable(
          ["Name", "Definition", "Size", "Times used"],
          d.indexes.map((ix) => [
            el(
              "span",
              { class: "mono" },
              ix.name,
              ix.primary ? el("span", { class: "tag", text: "primary" }) : ix.unique ? el("span", { class: "tag", text: "unique" }) : null,
              ix.valid ? null : el("span", { class: "tag warn", text: "invalid" }),
            ),
            el("span", { class: "mono", text: ix.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ /, "") }),
            fmtBytes(ix.sizeBytes),
            ix.scans === null ? "—" : ix.scans.toLocaleString(),
          ]),
        ),
      ),
    );
  }

  if (d.constraints.length) {
    parts.push(
      section(
        "Constraints",
        d.constraints.length,
        dtable(
          ["Name", "Type", "Definition"],
          d.constraints.map((c) => [el("span", { class: "mono", text: c.name }), c.type, el("span", { class: "mono", text: c.definition })]),
        ),
      ),
    );
  }

  const t = state.data?.table;
  if (t && (t.foreignKeys.length || t.referencedBy.length)) {
    const rows = [
      ...t.foreignKeys.map((fk) => ["Points to", `${fk.fromColumns.join(", ")} → ${qualified(fk.toSchema, fk.toTable)}(${fk.toColumns.join(", ")})`, fk, { schema: fk.toSchema, name: fk.toTable }]),
      ...t.referencedBy.map((fk) => ["Referenced by", `${qualified(fk.fromSchema, fk.fromTable)}(${fk.fromColumns.join(", ")}) → ${fk.toColumns.join(", ")}`, fk, { schema: fk.fromSchema, name: fk.fromTable }]),
    ];
    parts.push(
      section(
        "Relationships",
        rows.length,
        dtable(
          ["Direction", "Columns", ""],
          rows.map(([dir, text, fk, target]) => [
            dir,
            el("span", { class: "mono", text }),
            fk.navigable
              ? el("button", {
                  type: "button",
                  class: "link-btn",
                  text: `Open ${qualified(target.schema, target.name)}`,
                  onclick: () => {
                    state.tab = "data";
                    openTable(freshView(target.name, [], target.schema), { push: true });
                  },
                })
              : el("span", { class: "muted", text: "No access" }),
          ]),
        ),
      ),
    );
  }

  if (d.triggers.length) {
    parts.push(
      section(
        "Triggers",
        d.triggers.length,
        dtable(
          ["Name", "Definition", ""],
          d.triggers.map((tg) => [
            el("span", { class: "mono" }, tg.name, tg.enabled ? null : el("span", { class: "tag warn", text: "disabled" })),
            el("span", { class: "mono", text: tg.definition }),
            tg.functionOid
              ? el("button", { type: "button", class: "link-btn", text: "View function", onclick: () => openRoutine(tg.functionOid, d.schema, { push: true }) })
              : "",
          ]),
        ),
      ),
    );
  }

  parts.push(
    section(
      "Create script",
      null,
      el("p", {
        class: "muted small",
        text: "Rebuilt from the catalog for reading and comparing. Grants, ownership, sequences and partitions are left out, so use pg_dump --schema-only for a faithful copy.",
      }),
      codeBlock(d.ddl, "script"),
    ),
  );

  pane.replaceChildren(...parts);
}

// ---- Routines (functions, procedures, aggregates; view only) ---------------

async function openRoutine(oid, schema, { push = false } = {}) {
  const seq = ++state.seq; // supersedes any table load still in flight
  state.current = null;
  state.data = null;
  state.routine = { oid, schema, detail: null };
  setBusy(false);
  closeInspector();
  closeMenus();
  showError("");
  showNotice("");
  writeRoutineHash(schema, oid, push);
  $("empty").hidden = true;
  $("view").hidden = true;
  $("routine").hidden = false;
  $("routine-title").replaceChildren();
  $("routine-facts").replaceChildren();
  $("routine-body").replaceChildren(el("p", { class: "muted", text: "Loading…" }));

  try {
    if (state.tablesSchema !== schema) await loadTables(schema);
    else renderTables();
    const detail = await api(`/routines/${encodeURIComponent(oid)}`);
    if (seq !== state.seq) return;
    state.routine.detail = detail;
    if (detail.schema !== state.tablesSchema) {
      // The link didn't say which schema this routine lives in (e.g. a trigger function).
      await loadTables(detail.schema);
      if (seq !== state.seq) return;
    }
    state.routine.schema = detail.schema;
    writeRoutineHash(detail.schema, oid, false);
    renderRoutine(detail);
    renderTables();
  } catch (err) {
    if (seq !== state.seq) return;
    state.routine = null;
    $("routine").hidden = true;
    $("empty").hidden = false;
    renderHome();
    renderTables();
    showError(
      err.message === "Function not found"
        ? "There's no function or procedure with that id that this role can read."
        : err.message,
    );
  }
}

function renderRoutine(d) {
  const h1 = $("routine-title");
  h1.replaceChildren();
  if (d.schema !== state.meta.schema) h1.append(el("span", { class: "schema-prefix", text: `${d.schema}.` }));
  h1.append(`${d.name}(${d.args})`);
  document.title = `${d.name} · PG Studio`;

  const facts = [el("span", { class: "kind-fact", text: d.kind })];
  if (d.kind !== "aggregate") facts.push(fact("Language ", el("b", { text: d.language })));
  if (d.returns !== null) facts.push(fact("Returns ", el("b", { class: "mono", text: d.returns })));
  facts.push(fact("Volatility ", el("b", { text: d.volatility })));
  if (d.securityDefiner) facts.push(el("span", { class: "rt-badge", title: "Runs with the privileges of its owner, not the caller", text: "SECURITY DEFINER" }));
  if (d.strict) facts.push(fact("strict"));
  if (d.leakproof) facts.push(fact("leakproof"));
  if (d.parallel !== "unsafe") facts.push(fact("Parallel ", el("b", { text: d.parallel })));
  if (d.rows !== null) facts.push(fact("~", el("b", { text: d.rows.toLocaleString() }), " rows returned"));
  facts.push(fact("Owner ", el("b", { text: d.owner })));
  $("routine-facts").replaceChildren(...facts);

  const parts = [];
  if (d.comment) parts.push(el("p", { class: "d-comment", text: d.comment }));

  if (d.definition !== null) {
    parts.push(section("Definition", null, codeBlock(d.definition, "definition")));
  } else if (d.aggregate) {
    parts.push(
      section(
        "Aggregate",
        null,
        kv([
          ["Transition function", d.aggregate.transitionFunction],
          ["State type", d.aggregate.stateType],
          ["Final function", d.aggregate.finalFunction],
        ]),
        el("p", { class: "muted small", text: "Aggregates have no CREATE FUNCTION form, so only the summary is shown." }),
      ),
    );
  }

  if (d.usedByTriggers.length || d.returns === "trigger") {
    parts.push(
      section(
        "Used by triggers",
        d.usedByTriggers.length,
        d.usedByTriggers.length
          ? dtable(
              ["Table", "Trigger", ""],
              d.usedByTriggers.map((u) => [
                el("span", { class: "mono", text: u.schema === state.meta.schema ? u.table : `${u.schema}.${u.table}` }),
                el("span", { class: "mono", text: u.trigger }),
                el("button", {
                  type: "button",
                  class: "link-btn",
                  text: "Open table",
                  onclick: () => {
                    state.tab = "data";
                    openTable(freshView(u.table, [], u.schema), { push: true });
                  },
                }),
              ]),
            )
          : el("p", { class: "muted", text: "No triggers on tables you can read call this function." }),
      ),
    );
  }

  $("routine-body").replaceChildren(...parts);
}

// ---- Column resize -----------------------------------------------------

function startResize(e) {
  const handle = e.target.closest(".resizer");
  if (!handle) return;
  e.preventDefault();
  e.stopPropagation();
  const th = handle.parentElement;
  const c = Number(th.dataset.c);
  const name = state.data.table.columns[c].name;
  const startX = e.clientX;
  const startW = th.getBoundingClientRect().width;
  const cells = $("grid").querySelectorAll(`[data-c="${c}"]`);
  document.body.classList.add("resizing");

  const move = (ev) => {
    const w = Math.max(60, Math.min(1200, Math.round(startW + ev.clientX - startX)));
    cells.forEach((n) => applyWidth(n, w));
    state.prefs.widths[name] = w;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("resizing");
    savePrefs();
    applyFreeze();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- Columns and export menus ------------------------------------------

function renderColumnsMenu() {
  const menu = $("columns-menu");
  const t = state.data.table;
  const hidden = new Set(state.prefs.hidden);
  menu.replaceChildren();

  const freeze = el("input", { type: "checkbox" });
  freeze.checked = state.prefs.freeze;
  freeze.addEventListener("change", () => {
    state.prefs.freeze = freeze.checked;
    savePrefs();
    applyFreeze();
  });
  menu.append(el("label", { class: "menu-check strong" }, freeze, el("span", { text: "Keep first column visible when scrolling" })));
  menu.append(el("hr"));
  menu.append(el("p", { class: "small muted", text: `Showing ${t.columns.length - hidden.size} of ${t.columns.length} columns` }));

  const list = el("div", { class: "menu-list" });
  for (const col of t.columns) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !hidden.has(col.name);
    cb.addEventListener("change", () => {
      const h = new Set(state.prefs.hidden);
      if (cb.checked) h.delete(col.name);
      else h.add(col.name);
      if (h.size >= t.columns.length) {
        cb.checked = true; // keep at least one column visible
        return;
      }
      state.prefs.hidden = [...h];
      savePrefs();
      closeInspector();
      renderGrid();
      renderColumnsMenu();
    });
    list.append(el("label", { class: "menu-check" }, cb, el("span", { class: "mono", text: col.name })));
  }
  menu.append(list, el("hr"));
  menu.append(
    el("button", {
      type: "button",
      text: "Show all columns and reset widths",
      onclick: () => {
        state.prefs = { widths: {}, hidden: [], freeze: state.prefs.freeze };
        savePrefs();
        renderColumnsMenu();
        renderGrid();
      },
    }),
  );
}

function toggleMenu(btnId, menuId, onOpen) {
  const menu = $(menuId);
  const open = menu.hidden;
  closeMenus();
  if (open) {
    if (onOpen) onOpen();
    menu.hidden = false;
    $(btnId).setAttribute("aria-expanded", "true");
  }
}

function closeMenus() {
  for (const [b, m] of [
    ["columns-btn", "columns-menu"],
    ["export-btn", "export-menu"],
  ]) {
    $(m).hidden = true;
    $(b).setAttribute("aria-expanded", "false");
  }
  if (colMenu) {
    colMenu.remove();
    colMenu = null;
    document.querySelectorAll('.col-menu-btn[aria-expanded="true"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
  }
}

// ---- Filters -----------------------------------------------------------

function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  const cur = state.current;
  cur.filters.forEach((f, i) => {
    const op = OP_LABELS[f.op] ?? f.op;
    const label = VALUELESS.has(f.op) ? `${f.c} ${op}` : `${f.c} ${op} ${f.v}`;
    chips.append(
      el(
        "span",
        { class: "chip" },
        el(
          "button",
          { type: "button", class: "chip-text", title: `Edit: ${label}`, onclick: () => showFilterForm(i) },
          el("b", { text: f.c }),
          ` ${op} `,
          VALUELESS.has(f.op) ? null : el("span", { class: "v", text: f.v }),
        ),
        el("button", {
          type: "button",
          class: "chip-x",
          "aria-label": `Remove filter ${label}`,
          title: "Remove filter",
          text: "×",
          onclick: () => reload({ filters: cur.filters.filter((_, j) => j !== i), page: 1 }),
        }),
      ),
    );
  });
  if (cur.filters.length > 1) {
    chips.append(el("button", { type: "button", class: "link-btn small", text: "Clear all", onclick: () => reload({ filters: [], page: 1 }) }));
  }
}

function showFilterForm(index = -1, preset = null) {
  const t = state.data.table;
  state.editingFilter = index;
  const f = preset ?? (index >= 0 ? state.current.filters[index] : null);

  const colSel = $("ff-col");
  colSel.replaceChildren(...t.columns.map((c) => el("option", { value: c.name, text: c.name })));
  const opSel = $("ff-op");
  opSel.replaceChildren(...state.meta.filterOps.map((op) => el("option", { value: op, text: OP_LABELS[op] ?? op })));

  colSel.value = f?.c ?? t.columns[0]?.name ?? "";
  opSel.value = f?.op ?? defaultOpFor(colSel.value);
  $("ff-val").value = f?.v ?? "";
  syncValueInput();
  $("filter-form").querySelector('button[type="submit"]').textContent = index >= 0 ? "Update filter" : "Apply";
  $("filter-form").hidden = false;
  (VALUELESS.has(opSel.value) ? opSel : $("ff-val")).focus();
}

function defaultOpFor(colName) {
  const col = state.data.table.columns.find((c) => c.name === colName);
  return col && (col.category === "S" || col.category === "U") ? "contains" : "eq";
}

function syncValueInput() {
  const valueless = VALUELESS.has($("ff-op").value);
  const input = $("ff-val");
  input.hidden = valueless;
  input.required = !valueless;
  const col = state.data?.table.columns.find((c) => c.name === $("ff-col").value);
  input.placeholder =
    col?.category === "D" ? "e.g. 2026-01-31" : col?.category === "N" ? "a number" : col?.category === "B" ? "true or false" : "value";
}

function hideFilterForm() {
  $("filter-form").hidden = true;
  state.editingFilter = -1;
}

function submitFilter(e) {
  e.preventDefault();
  const f = { c: $("ff-col").value, op: $("ff-op").value };
  if (!VALUELESS.has(f.op)) f.v = $("ff-val").value;
  const filters = [...state.current.filters];
  if (state.editingFilter >= 0) filters[state.editingFilter] = f;
  else filters.push(f);
  hideFilterForm();
  reload({ filters, page: 1 });
}

// ---- Export ------------------------------------------------------------

async function doExport(format) {
  closeMenus();
  const cur = state.current;
  showError("");
  showNotice("Preparing the download…");
  try {
    const res = await fetch(`/api${tablePath(cur, "/export")}?${viewQuery(cur, { format })}`);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = (await res.json()).error || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const name = /filename="([^"]+)"/.exec(cd)?.[1] || `${cur.name}.${format}`;
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);

    const rows = Number(res.headers.get("X-Export-Rows") || "0");
    const parts = [`Downloaded ${plural(rows, "row")} as ${name}.`];
    if (res.headers.get("X-Export-Limit-Hit") === "1") {
      parts.push(`It stopped at the ${state.meta.exportMaxRows.toLocaleString()}-row limit, so add filters to get the rest.`);
    }
    const cutCells = Number(res.headers.get("X-Export-Cut-Cells") || "0");
    if (cutCells) parts.push(`${plural(cutCells, "very long value")} were cut at 100,000 characters.`);
    if (format === "csv") parts.push("Empty (NULL) values are blank cells.");
    showNotice(parts.join(" "));
  } catch (err) {
    showNotice("");
    showError(`Download failed: ${err.message}`);
  }
}

// ---- Foreign-key navigation --------------------------------------------

function colIndex(name) {
  return state.data.table.columns.findIndex((c) => c.name === name);
}

/** "id = 5" or "(order_id, line) = (1, 2)". */
function describeKey(targetCols, sourceCols, row) {
  const vals = sourceCols.map((c) => row[colIndex(c)]);
  if (targetCols.length === 1) return `${targetCols[0]} = ${vals[0]}`;
  return `(${targetCols.join(", ")}) = (${vals.join(", ")})`;
}

/** Build eq filters on `targetCols` from this row's `sourceCols`; null if any value is NULL. */
function keyFilters(targetCols, sourceCols, row) {
  const filters = [];
  for (let i = 0; i < targetCols.length; i++) {
    const v = row[colIndex(sourceCols[i])];
    if (v === null || v === undefined) return null;
    filters.push({ c: targetCols[i], op: "eq", v });
  }
  return filters;
}

function followOutgoing(fk, row) {
  const filters = keyFilters(fk.toColumns, fk.fromColumns, row);
  if (filters) openTable(freshView(fk.toTable, filters, fk.toSchema), { push: true });
}

function followIncoming(fk, row) {
  const filters = keyFilters(fk.fromColumns, fk.toColumns, row);
  if (filters) openTable(freshView(fk.fromTable, filters, fk.fromSchema), { push: true });
}

// ---- Inspector (selected cell + the whole row) ------------------------------

/** Postgres timestamptz text ("2026-08-20 05:45:15.28+00") -> Date, or null. */
function parsePgTimestamptz(v) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(v);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? "00"}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function openInspector(r, c) {
  const d = state.data;
  const t = d.table;
  const col = t.columns[c];
  const row = d.rows[r];
  if (!col || !row) return;
  const v = row[c];
  const isCut = d.truncated.some(([rr, cc]) => rr === r && cc === c);

  state.selected = { r, c };
  paintSelection();

  const fkCols = fkByColumn();
  const tags = [col.type];
  if (col.isPrimaryKey) tags.push("primary key");
  if (fkCols.has(col.name)) tags.push("foreign key");
  if (col.isGenerated) tags.push("generated");
  if (!col.nullable) tags.push("required");
  $("insp-col").textContent = col.name;
  $("insp-type").textContent = tags.join(", ");

  const notes = [];
  let shown = v === null ? "NULL (no value)" : v;
  if (v !== null && !isCut && (col.type === "json" || col.type === "jsonb")) {
    try {
      shown = JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      /* show as-is */
    }
  }
  if (v !== null && col.type === "timestamp with time zone") {
    const dt = parsePgTimestamptz(v);
    if (dt) notes.push(`Your local time: ${dt.toLocaleString()}`);
  }
  if (v !== null && col.type === "bytea" && v.startsWith("\\x") && !isCut) notes.push(plural((v.length - 2) / 2, "byte"));
  if (v === "") notes.push("Empty text (not NULL).");
  if (isCut) notes.push(`Only the first ${state.meta.cellCharLimit.toLocaleString()} characters are shown. Export to get up to 100,000.`);

  const pre = $("insp-value");
  pre.textContent = shown;
  pre.classList.toggle("null", v === null);
  $("insp-note").textContent = notes.join(" ");
  $("insp-copy").disabled = v === null;
  $("insp-filter").textContent = v === null ? "Show rows where this is empty" : "Show rows with this value";
  $("insp-filter").disabled = isCut;

  // Relationships for this row
  const links = $("insp-links");
  links.replaceChildren();
  const outFks = t.foreignKeys.filter((fk) => fk.navigable && keyFilters(fk.toColumns, fk.fromColumns, row));
  if (outFks.length) {
    links.append(el("h3", { text: "This row points to" }));
    for (const fk of outFks) {
      links.append(
        el("button", {
          type: "button",
          class: "link-btn",
          text: `${qualified(fk.toSchema, fk.toTable)} where ${describeKey(fk.toColumns, fk.fromColumns, row)}`,
          onclick: () => followOutgoing(fk, row),
        }),
      );
    }
  }
  const incoming = t.referencedBy.filter((fk) => fk.navigable && keyFilters(fk.fromColumns, fk.toColumns, row));
  if (incoming.length) {
    links.append(el("h3", { text: "Rows that point here" }));
    for (const fk of incoming) {
      links.append(
        el("button", {
          type: "button",
          class: "link-btn",
          text: `${qualified(fk.fromSchema, fk.fromTable)} where ${describeKey(fk.fromColumns, fk.toColumns, row)}`,
          onclick: () => followIncoming(fk, row),
        }),
      );
    }
  }

  // The whole row, one field per line
  const list = $("insp-row");
  list.replaceChildren(
    ...t.columns.map((cc, i) => {
      const val = row[i];
      const btn = el(
        "button",
        { type: "button", title: val === null ? `${cc.name}: NULL` : `${cc.name}: ${val.slice(0, 300)}` },
        el("span", { class: "k", text: cc.name }),
        el("span", { class: `v${val === null ? " null" : fkCols.has(cc.name) ? " fk" : ""}`, text: val === null ? "NULL" : val }),
      );
      if (i === c) btn.setAttribute("aria-current", "true");
      btn.addEventListener("click", () => selectCell(r, i, { open: true }));
      return btn;
    }),
  );

  $("inspector").hidden = false;
}

function closeInspector() {
  $("inspector").hidden = true;
}

// ---- Jump to table -------------------------------------------------------

async function loadAllTables() {
  const lists = await Promise.all(
    state.schemas.map(async (s) => {
      const q = new URLSearchParams({ schema: s.name });
      const routines = api(`/routines?${q}`).then((r) => r.routines, () => []);
      try {
        const { tables } = await api(`/tables?${q}`);
        return { tables: tables.map((t) => ({ ...t, schema: s.name })), routines: (await routines).map((r) => ({ ...r, schema: s.name })) };
      } catch {
        return { tables: [], routines: [] };
      }
    }),
  );
  state.allTables = lists.flatMap((l) => l.tables);
  state.allRoutines = lists.flatMap((l) => l.routines);
}

const ROUTINE_TAG = { function: "fn", procedure: "proc", aggregate: "agg", window: "win" };

/** Subsequence match: returns matched character positions and a score (lower is better), or null. */
function fuzzy(text, query) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query);
  if (idx >= 0) {
    return { score: idx === 0 ? 0 : 10 + idx, hits: [...Array(query.length).keys()].map((k) => idx + k) };
  }
  const hits = [];
  let from = 0;
  for (const ch of query) {
    const at = lower.indexOf(ch, from);
    if (at < 0) return null;
    hits.push(at);
    from = at + 1;
  }
  return { score: 100 + (hits[hits.length - 1] - hits[0]), hits };
}

function highlighted(text, hits) {
  const set = new Set(hits);
  const frag = document.createDocumentFragment();
  let buf = "";
  let inMark = false;
  const flush = () => {
    if (!buf) return;
    frag.append(inMark ? el("mark", { text: buf }) : document.createTextNode(buf));
    buf = "";
  };
  [...text].forEach((ch, i) => {
    const m = set.has(i);
    if (m !== inMark) {
      flush();
      inMark = m;
    }
    buf += ch;
  });
  flush();
  return frag;
}

function renderJump() {
  const q = $("jump-input").value.trim().toLowerCase();
  const tag = (list) => list.map((r) => ({ ...r, schema: state.tablesSchema, isRoutine: true }));
  const all = state.allTables
    ? [...state.allTables, ...state.allRoutines.map((r) => ({ ...r, isRoutine: true }))]
    : [...state.tables.map((t) => ({ ...t, schema: state.tablesSchema })), ...tag(state.routines)];
  const here = state.current?.schema ?? state.routine?.schema ?? state.tablesSchema;
  let items;
  if (!q) {
    const recent = storageGet("pgstudio:recent", []);
    const rank = (t) => {
      const ri = recent.findIndex((r) => r.schema === t.schema && r.name === t.name);
      return ri >= 0 ? ri : 100 + (t.schema === here ? 0 : 1000);
    };
    items = [...all].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map((t) => ({ t, hits: [] }));
  } else {
    items = all
      .map((t) => ({ t, m: fuzzy(t.name, q) }))
      .filter((x) => x.m)
      .sort((a, b) => a.m.score - b.m.score || (a.t.schema === here ? -1 : 0) - (b.t.schema === here ? -1 : 0) || a.t.name.length - b.t.name.length)
      .map((x) => ({ t: x.t, hits: x.m.hits }));
  }
  state.jumpItems = items.slice(0, 60);
  state.jumpIndex = Math.min(state.jumpIndex, Math.max(0, state.jumpItems.length - 1));

  const list = $("jump-list");
  if (!state.jumpItems.length) {
    list.replaceChildren(el("li", { class: "empty-li", text: q ? `No table, view or function matches "${q}".` : "Nothing to show." }));
    return;
  }
  list.replaceChildren(
    ...state.jumpItems.map(({ t, hits }, i) => {
      const name = el("span", { class: "tname" });
      if (t.schema !== here) name.append(el("span", { class: "sc", text: `${t.schema}.` }));
      name.append(highlighted(t.name, hits));
      if (t.isRoutine) name.append(el("span", { class: "rt-tag", text: ROUTINE_TAG[t.kind] ?? "fn" }));
      const li = el(
        "li",
        { role: "option", id: `jump-opt-${i}`, "aria-selected": String(i === state.jumpIndex), title: t.isRoutine ? `${t.name}(${t.args})` : null },
        name,
        t.isRoutine
          ? el("span", { class: "tmeta rt-args", text: `(${t.args})` })
          : el("span", { class: "tmeta", text: [KIND_LABEL[t.kind], t.kind === "view" ? "" : fmtCount(t.estimatedRows)].filter(Boolean).join(", ") }),
      );
      li.addEventListener("mousemove", () => {
        if (state.jumpIndex !== i) {
          state.jumpIndex = i;
          paintJump();
        }
      });
      li.addEventListener("click", () => chooseJump(i));
      return li;
    }),
  );
  paintJump();
}

function paintJump() {
  $("jump-list")
    .querySelectorAll("li[role=option]")
    .forEach((li, i) => li.setAttribute("aria-selected", String(i === state.jumpIndex)));
  $("jump-input").setAttribute("aria-activedescendant", `jump-opt-${state.jumpIndex}`);
  $(`jump-opt-${state.jumpIndex}`)?.scrollIntoView({ block: "nearest" });
}

function chooseJump(i) {
  const item = state.jumpItems[i];
  if (!item) return;
  $("jump").close();
  if (item.t.isRoutine) {
    openRoutine(item.t.oid, item.t.schema, { push: true });
    return;
  }
  state.tab = "data";
  openTable(freshView(item.t.name, [], item.t.schema), { push: true });
}

async function openJump() {
  if (!state.meta) return;
  closeMenus();
  const dlg = $("jump");
  if (dlg.open) return;
  $("jump-input").value = "";
  state.jumpIndex = 0;
  renderJump();
  dlg.showModal();
  $("jump-input").focus();
  if (!state.allTables) {
    await loadAllTables();
    if (dlg.open) renderJump();
  }
}

// ---- Wiring ------------------------------------------------------------

function wire() {
  $("jump-kbd").textContent = IS_MAC ? "⌘K" : "Ctrl K";
  document.querySelectorAll("kbd.mod").forEach((k) => (k.textContent = MOD));

  $("filter").addEventListener("input", renderTables);
  $("schema-select").addEventListener("change", async (e) => {
    showError("");
    try {
      $("filter").value = "";
      await loadTables(e.target.value);
    } catch (err) {
      showError(err.message);
    }
  });
  $("error-close").addEventListener("click", () => showError(""));

  $("first").addEventListener("click", () => state.data?.hasPrev && reload({ page: 1 }));
  $("prev").addEventListener("click", goPrev);
  $("next").addEventListener("click", goNext);
  $("page-size").addEventListener("change", (e) => {
    if (state.current) reload({ page: 1, pageSize: parseInt(e.target.value, 10) });
  });

  $("tab-data").addEventListener("click", () => setTab("data"));
  $("tab-details").addEventListener("click", () => setTab("details"));
  $("count-btn").addEventListener("click", runCount);

  let searchTimer = 0;
  const applySearch = () => {
    clearTimeout(searchTimer);
    const q = $("search").value.trim();
    if (state.current && q !== state.current.q) reload({ q, page: 1 });
  };
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 400);
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySearch();
    if (e.key === "Escape" && $("search").value) {
      e.stopPropagation();
      $("search").value = "";
      applySearch();
    }
  });

  $("add-filter").addEventListener("click", () => state.data && showFilterForm(-1));
  $("filter-form").addEventListener("submit", submitFilter);
  $("ff-cancel").addEventListener("click", hideFilterForm);
  $("ff-op").addEventListener("change", syncValueInput);
  $("ff-col").addEventListener("change", () => {
    if (state.editingFilter < 0) $("ff-op").value = defaultOpFor($("ff-col").value);
    syncValueInput();
  });

  $("columns-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.data) toggleMenu("columns-btn", "columns-menu", renderColumnsMenu);
  });
  $("export-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    if (state.data) toggleMenu("export-btn", "export-menu");
  });
  $("export-menu").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-format]");
    if (b) doExport(b.dataset.format);
  });
  for (const m of ["columns-menu", "export-menu"]) $(m).addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeMenus);
  $("grid-wrap").addEventListener("scroll", () => colMenu && closeMenus(), { passive: true });

  $("grid").tHead.addEventListener("pointerdown", startResize);

  const wrap = $("grid-wrap");
  wrap.addEventListener("keydown", onGridKey);
  $("grid").tBodies[0].addEventListener("click", (e) => {
    const td = e.target.closest("td.cell");
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    const go = e.target.closest(".fk-go");
    if (go) {
      const fk = state.data.table.foreignKeys.find((f) => f.name === go.dataset.fk);
      if (fk) followOutgoing(fk, state.data.rows[r]);
      return;
    }
    wrap.focus({ preventScroll: true });
    selectCell(r, c, { open: true, scroll: false });
  });

  $("insp-close").addEventListener("click", () => {
    closeInspector();
    wrap.focus({ preventScroll: true });
  });
  $("insp-copy").addEventListener("click", () => {
    const s = state.selected;
    const v = s && state.data.rows[s.r][s.c];
    if (v != null) copyText(v, "Copied value");
  });
  $("insp-copy-row").addEventListener("click", () => {
    const s = state.selected;
    if (!s) return;
    const obj = {};
    state.data.table.columns.forEach((col, i) => (obj[col.name] = state.data.rows[s.r][i]));
    copyText(JSON.stringify(obj, null, 2), "Copied row as JSON");
  });
  $("insp-filter").addEventListener("click", () => {
    const s = state.selected;
    if (!s) return;
    const col = state.data.table.columns[s.c];
    const v = state.data.rows[s.r][s.c];
    const f = v === null ? { c: col.name, op: "null" } : { c: col.name, op: "eq", v };
    reload({ filters: [...state.current.filters, f], page: 1 });
  });

  // Jump dialog
  $("jump-btn").addEventListener("click", openJump);
  $("jump-input").addEventListener("input", () => {
    state.jumpIndex = 0;
    renderJump();
  });
  $("jump-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = state.jumpItems.length;
      if (!n) return;
      state.jumpIndex = (state.jumpIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      paintJump();
    } else if (e.key === "Enter") {
      e.preventDefault();
      chooseJump(state.jumpIndex);
    }
  });
  $("jump").addEventListener("click", (e) => {
    if (e.target === $("jump")) $("jump").close(); // click on the backdrop
  });

  // Help dialog
  $("help-btn").addEventListener("click", () => $("help").showModal());
  $("help-close").addEventListener("click", () => $("help").close());
  $("help").addEventListener("click", (e) => {
    if (e.target === $("help")) $("help").close();
  });

  // Global shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openJump();
      return;
    }
    if ($("jump").open || $("help").open) return; // dialogs handle their own keys
    if (e.key === "Escape") {
      if (colMenu || !$("columns-menu").hidden || !$("export-menu").hidden) closeMenus();
      else if (!$("filter-form").hidden) hideFilterForm();
      else if (!$("inspector").hidden) {
        closeInspector();
        $("grid-wrap").focus({ preventScroll: true });
      }
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "?") {
      e.preventDefault();
      $("help").showModal();
    } else if (e.key === "/" && state.data && state.tab === "data" && !$("search").disabled) {
      e.preventDefault();
      $("search").focus();
      $("search").select();
    } else if (e.key === "]" && state.tab === "data") {
      goNext();
    } else if (e.key === "[" && state.tab === "data") {
      goPrev();
    }
  });

  const onNav = () => {
    const h = readHash();
    if (h.fn && !h.name) {
      if (state.routine?.oid !== h.fn) openRoutine(h.fn, h.schema);
      return;
    }
    if (!h.name) {
      if (state.current || state.routine) {
        state.current = null;
        state.data = null;
        state.routine = null;
        $("view").hidden = true;
        $("routine").hidden = true;
        $("empty").hidden = false;
        closeInspector();
        renderTables();
        renderHome();
        document.title = "PG Studio";
      }
      return;
    }
    const tabChanged = h.tab !== state.tab;
    state.tab = h.tab;
    if (!sameView(h.view, state.current)) openTable(h.view);
    else if (tabChanged) {
      applyTab();
      if (state.tab === "details") loadDetails();
    }
  };
  window.addEventListener("hashchange", onNav);
  window.addEventListener("popstate", onNav);
  window.addEventListener("resize", () => {
    closeMenus();
    if (state.data) applyFreeze();
  });
}

async function init() {
  wire();
  try {
    state.meta = await api("/meta");
    const mode = $("mode");
    mode.textContent = state.meta.capabilities.edit ? "Editing on" : "Read-only";
    if (state.meta.role.canWrite) {
      mode.classList.add("danger");
      mode.textContent = "Read-only app, but this role can write";
      mode.title =
        `Connected as "${state.meta.role.name}", which can change data. ` +
        "The app only reads, but use a SELECT-only role so that doesn't depend on the code being bug-free.";
    } else {
      mode.title = `Connected as "${state.meta.role.name}", which can only read. All queries run in read-only transactions.`;
    }

    const { schemas } = await api("/schemas");
    state.schemas = schemas;
    const h = readHash();
    const startSchema = schemas.some((s) => s.name === h.schema) ? h.schema : state.meta.schema;
    await loadTables(startSchema);
    renderSchemaSelect();

    if (h.fn && !h.name) {
      openRoutine(h.fn, startSchema);
    } else if (h.name && state.tables.some((t) => t.name === h.name)) {
      state.tab = h.tab;
      openTable({ ...h.view, schema: startSchema });
    } else {
      renderHome();
    }
  } catch (err) {
    showError(err.message);
  }
}

init();
