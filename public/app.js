// PG Studio front end. No framework; all DB values are rendered with
// textContent, never innerHTML, so cell contents cannot inject markup.
"use strict";

const $ = (id) => document.getElementById(id);

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
  null: "is null",
  not_null: "is not null",
};
const VALUELESS = new Set(["null", "not_null"]);

const state = {
  meta: null,
  tables: [],
  /** { name, page, pageSize, sort: {column, dir} | null, filters: [{c, op, v?}], q } */
  current: null,
  data: null, // last /api/tables/:name response
  selected: null, // { r, c }
  seq: 0, // guards against out-of-order responses
  editingFilter: -1, // index of the chip being edited, or -1 for a new filter
  prefs: null, // column prefs for the current table
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
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function showError(msg) {
  const e = $("error");
  e.textContent = msg || "";
  e.hidden = !msg;
}

function showNotice(msg) {
  const n = $("notice");
  n.textContent = msg || "";
  n.hidden = !msg;
}

function fmtCount(n) {
  if (n === null || n === undefined) return "";
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `~${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `~${Math.round(n / 1e3)}k`;
  return `~${n.toLocaleString()}`;
}

function viewQuery(cur, extra = {}) {
  const p = new URLSearchParams(extra);
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

// ---- Per-table column preferences (browser-local, best effort) ---------

function prefsKey(table) {
  return `pgstudio:cols:${state.meta?.schema ?? "public"}.${table}`;
}

function loadPrefs(table) {
  const empty = { widths: {}, hidden: [], freeze: false };
  try {
    const raw = localStorage.getItem(prefsKey(table));
    if (!raw) return empty;
    const p = JSON.parse(raw);
    return {
      widths: p && typeof p.widths === "object" && p.widths ? p.widths : {},
      hidden: Array.isArray(p?.hidden) ? p.hidden : [],
      freeze: !!p?.freeze,
    };
  } catch {
    return empty;
  }
}

function savePrefs() {
  if (!state.current || !state.prefs) return;
  try {
    localStorage.setItem(prefsKey(state.current.name), JSON.stringify(state.prefs));
  } catch {
    /* storage unavailable: prefs last for this page only */
  }
}

// ---- URL hash state ----------------------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const name = p.get("t");
  if (!name) return null;
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
  return { name, page, pageSize, sort: s ? { column: s, dir: d } : null, filters, q: p.get("q") || "" };
}

function writeHash(cur, push) {
  const p = new URLSearchParams({ t: cur.name, p: String(cur.page), n: String(cur.pageSize) });
  if (cur.sort) {
    p.set("s", cur.sort.column);
    p.set("d", cur.sort.dir);
  }
  if (cur.filters.length) p.set("f", JSON.stringify(cur.filters));
  if (cur.q) p.set("q", cur.q);
  const next = `#${p.toString()}`;
  if (location.hash === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

// ---- Sidebar -----------------------------------------------------------

function renderTables() {
  const list = $("tables");
  const filter = $("filter").value.trim().toLowerCase();
  list.replaceChildren();
  const shown = state.tables.filter((t) => t.name.toLowerCase().includes(filter));
  for (const t of shown) {
    const btn = el(
      "button",
      { type: "button", title: t.name },
      el("span", { class: "tname", text: t.name }),
      el("span", { class: "tcount", text: fmtCount(t.estimatedRows) }),
    );
    if (state.current && state.current.name === t.name) btn.setAttribute("aria-current", "true");
    btn.addEventListener("click", () => openTable(freshView(t.name), { push: true }));
    list.append(el("li", {}, btn));
  }
  $("tables-status").textContent =
    state.tables.length === 0
      ? "No readable tables in this schema."
      : `${shown.length} of ${state.tables.length} tables`;
}

function freshView(name, filters = []) {
  return {
    name,
    page: 1,
    pageSize: state.current?.pageSize ?? state.meta.pageSizeDefault,
    sort: null,
    filters,
    q: "",
  };
}

// ---- Loading -----------------------------------------------------------

async function openTable(cur, { push = false } = {}) {
  const seq = ++state.seq;
  const tableChanged = state.current?.name !== cur.name;
  state.current = cur;
  state.selected = null;
  if (tableChanged) {
    state.prefs = loadPrefs(cur.name);
    hideFilterForm();
    showNotice("");
  }
  closeInspector();
  closeMenus();
  writeHash(cur, push);
  renderTables();
  showError("");
  setBusy(true);

  try {
    const qs = viewQuery(cur, { page: String(cur.page), pageSize: String(cur.pageSize) });
    const data = await api(`/tables/${encodeURIComponent(cur.name)}?${qs}`);
    if (seq !== state.seq) return; // a newer request superseded this one
    state.data = data;
    renderView();
  } catch (err) {
    if (seq !== state.seq) return;
    // Keep the toolbar usable so a bad filter can be removed.
    if (state.data && state.data.table.name === cur.name) {
      renderChips();
      $("search").value = cur.q;
    } else {
      state.data = null;
      $("view").hidden = true;
      $("empty").hidden = false;
    }
    showError(err.message);
  } finally {
    if (seq === state.seq) setBusy(false);
  }
}

function reload(changes) {
  openTable({ ...state.current, ...changes });
}

function setBusy(busy) {
  for (const id of ["prev", "next", "page-size"]) $(id).disabled = busy;
  if (!busy && state.data) {
    $("prev").disabled = state.data.page <= 1;
    $("next").disabled = !state.data.hasNext;
  }
}

// ---- View --------------------------------------------------------------

function visibleColumns() {
  const hidden = new Set(state.prefs.hidden);
  return state.data.table.columns.map((col, c) => ({ col, c })).filter(({ col }) => !hidden.has(col.name));
}

/** Map column name -> outgoing FKs that include it (navigable, same schema only). */
function fkByColumn() {
  const t = state.data.table;
  const map = new Map();
  for (const fk of t.foreignKeys) {
    if (!fk.navigable || fk.toSchema !== state.meta.schema) continue;
    for (const col of fk.fromColumns) {
      if (!map.has(col)) map.set(col, []);
      map.get(col).push(fk);
    }
  }
  return map;
}

function renderView() {
  const d = state.data;
  const t = d.table;
  const cur = state.current;

  $("empty").hidden = true;
  $("view").hidden = false;
  $("title").textContent = t.name;

  const bits = [`${t.columns.length} columns`];
  if (d.filtered) bits.push("filtered");
  else if (t.estimatedRows !== null) bits.push(`${fmtCount(t.estimatedRows)} rows (estimate)`);
  bits.push(t.primaryKey.length ? `PK: ${t.primaryKey.join(", ")}` : "no primary key");
  if (t.foreignKeys.length) bits.push(`${t.foreignKeys.length} FK`);
  if (t.referencedBy.length) bits.push(`referenced by ${t.referencedBy.length}`);
  if (t.kind === "partitioned") bits.push("partitioned");
  $("subtitle").textContent = bits.join(" · ");

  const warn = $("warning");
  warn.hidden = d.orderedByPrimaryKey;
  if (!d.orderedByPrimaryKey) {
    warn.textContent =
      "No primary key: rows are shown in physical order, so pages can shift if the table changes. " +
      "Rows without a primary key also can't be edited safely.";
  }

  const first = (d.page - 1) * d.pageSize + 1;
  $("page").textContent = d.rows.length
    ? `Page ${d.page} · rows ${first.toLocaleString()}–${(first + d.rows.length - 1).toLocaleString()}`
    : `Page ${d.page}`;
  $("page-size").value = String(d.pageSize);

  const search = $("search");
  if (document.activeElement !== search) search.value = cur.q;
  search.disabled = d.searchColumns.length === 0;
  search.placeholder = d.searchColumns.length
    ? `Search ${d.searchColumns.slice(0, 3).join(", ")}${d.searchColumns.length > 3 ? "…" : ""}`
    : "No text columns to search";
  search.title = d.searchColumns.length ? `Searches: ${d.searchColumns.join(", ")}` : "";

  $("export-note").textContent = `Current view (sort, filters, search), up to ${state.meta.exportMaxRows.toLocaleString()} rows.`;

  renderChips();
  renderGrid();
}

function renderGrid() {
  const d = state.data;
  const t = d.table;
  const cur = state.current;
  const cols = visibleColumns();
  const fks = fkByColumn();
  const widths = state.prefs.widths;

  // Header
  const hr = el("tr", {}, el("th", { class: "rownum", text: "#" }));
  for (const { col, c } of cols) {
    const sorted = cur.sort && cur.sort.column === col.name ? cur.sort.dir : null;
    const label = el(
      "button",
      { type: "button", class: "sort-btn", title: `Sort by ${col.name}` },
      el(
        "span",
        { class: "cname" },
        el("span", { class: col.isPrimaryKey ? "pk" : fks.has(col.name) ? "fk" : "", text: col.name }),
        el("span", { class: "sort-ind", text: sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "" }),
      ),
      el("span", { class: "ctype", text: col.type + (col.nullable ? "" : " · not null") }),
    );
    label.addEventListener("click", () => cycleSort(col.name));
    const th = el("th", { dataset: { c: String(c) } }, label, el("span", { class: "resizer", title: "Drag to resize" }));
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
    const msg = d.filtered
      ? "No rows match the current filters."
      : d.page > 1
        ? "No rows on this page."
        : "This table is empty.";
    frag.append(el("tr", {}, el("td", { class: "nodata", colspan: String(cols.length + 1), text: msg })));
  }

  d.rows.forEach((row, r) => {
    const tr = el("tr", {}, el("td", { class: "rownum", text: String(first + r) }));
    for (const { col, c } of cols) {
      const v = row[c];
      const td = el("td", { class: "cell", dataset: { r: String(r), c: String(c) } });
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
              tabindex: "0",
              title: `Open ${fk.toTable} where ${describeKey(fk.toColumns, fk.fromColumns, row)}`,
              dataset: { fk: fk.name },
              text: "→",
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

function cycleSort(column) {
  const s = state.current.sort;
  let next;
  if (!s || s.column !== column) next = { column, dir: "asc" };
  else if (s.dir === "asc") next = { column, dir: "desc" };
  else next = null;
  reload({ sort: next, page: 1 });
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
    const w = Math.max(48, Math.min(1200, Math.round(startW + ev.clientX - startX)));
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

// ---- Columns menu ------------------------------------------------------

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
  menu.append(el("label", { class: "menu-check strong" }, freeze, el("span", { text: "Freeze first column" })));
  menu.append(el("hr"));

  const list = el("div", { class: "menu-list" });
  for (const col of t.columns) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !hidden.has(col.name);
    cb.addEventListener("change", () => {
      const h = new Set(state.prefs.hidden);
      if (cb.checked) h.delete(col.name);
      else h.add(col.name);
      // Keep at least one column visible.
      if (h.size >= t.columns.length) {
        cb.checked = true;
        return;
      }
      state.prefs.hidden = [...h];
      savePrefs();
      closeInspector();
      renderGrid();
    });
    list.append(el("label", { class: "menu-check" }, cb, el("span", { class: "mono", text: col.name })));
  }
  menu.append(list);
  menu.append(el("hr"));
  menu.append(
    el("button", {
      type: "button",
      text: "Reset widths and visibility",
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
}

// ---- Filters -----------------------------------------------------------

function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  const cur = state.current;
  cur.filters.forEach((f, i) => {
    const text = VALUELESS.has(f.op) ? `${f.c} ${OP_LABELS[f.op]}` : `${f.c} ${OP_LABELS[f.op] ?? f.op} ${f.v}`;
    chips.append(
      el(
        "span",
        { class: "chip" },
        el("button", { type: "button", class: "chip-text", title: "Edit filter", text, onclick: () => showFilterForm(i) }),
        el("button", {
          type: "button",
          class: "chip-x",
          "aria-label": `Remove filter ${text}`,
          text: "×",
          onclick: () => reload({ filters: cur.filters.filter((_, j) => j !== i), page: 1 }),
        }),
      ),
    );
  });
  if (cur.filters.length > 1) {
    chips.append(
      el("button", { type: "button", class: "link-btn small", text: "Clear all", onclick: () => reload({ filters: [], page: 1 }) }),
    );
  }
}

function showFilterForm(index = -1, preset = null) {
  const t = state.data.table;
  state.editingFilter = index;
  const f = preset ?? (index >= 0 ? state.current.filters[index] : null);

  const colSel = $("ff-col");
  colSel.replaceChildren(...t.columns.map((c) => el("option", { value: c.name, text: `${c.name} (${c.type})` })));
  const opSel = $("ff-op");
  opSel.replaceChildren(...state.meta.filterOps.map((op) => el("option", { value: op, text: OP_LABELS[op] ?? op })));

  colSel.value = f?.c ?? t.columns[0]?.name ?? "";
  opSel.value = f?.op ?? defaultOpFor(colSel.value);
  $("ff-val").value = f?.v ?? "";
  syncValueInput();
  $("filter-form").hidden = false;
  (VALUELESS.has(opSel.value) ? opSel : $("ff-val")).focus();
}

function defaultOpFor(colName) {
  const col = state.data.table.columns.find((c) => c.name === colName);
  return col && (col.category === "S" || col.category === "U") ? "contains" : "eq";
}

function syncValueInput() {
  const valueless = VALUELESS.has($("ff-op").value);
  $("ff-val").hidden = valueless;
  $("ff-val").required = !valueless;
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
  showNotice("Preparing export…");
  try {
    const qs = viewQuery(cur, { format });
    const res = await fetch(`/api/tables/${encodeURIComponent(cur.name)}/export?${qs}`);
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
    const parts = [`Exported ${rows.toLocaleString()} rows to ${name}.`];
    if (res.headers.get("X-Export-Limit-Hit") === "1") {
      parts.push(`Stopped at the ${state.meta.exportMaxRows.toLocaleString()}-row limit: add filters to narrow it down.`);
    }
    const cutCells = Number(res.headers.get("X-Export-Cut-Cells") || "0");
    if (cutCells) parts.push(`${cutCells} very long values were cut at 100,000 characters.`);
    if (format === "csv") parts.push("NULL is written as an empty cell.");
    showNotice(parts.join(" "));
  } catch (err) {
    showNotice("");
    showError(`Export failed: ${err.message}`);
  }
}

// ---- Foreign-key navigation --------------------------------------------

function colIndex(name) {
  return state.data.table.columns.findIndex((c) => c.name === name);
}

/** "id = 5" or "(order_id, line) = (1, 2)" for a tooltip. */
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
  if (filters) openTable(freshView(fk.toTable, filters), { push: true });
}

function followIncoming(fk, row) {
  const filters = keyFilters(fk.fromColumns, fk.toColumns, row);
  if (filters) openTable(freshView(fk.fromTable, filters), { push: true });
}

// ---- Inspector ---------------------------------------------------------

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
  const v = row[c];
  const isCut = d.truncated.some(([rr, cc]) => rr === r && cc === c);

  document.querySelectorAll(".grid td.selected").forEach((n) => n.classList.remove("selected"));
  document.querySelector(`.grid td[data-r="${r}"][data-c="${c}"]`)?.classList.add("selected");
  state.selected = { r, c };

  const fkCols = fkByColumn();
  const tags = [col.type];
  if (col.isPrimaryKey) tags.push("primary key");
  if (fkCols.has(col.name)) tags.push("foreign key");
  if (col.isGenerated) tags.push("generated");
  $("insp-col").textContent = col.name;
  $("insp-type").textContent = tags.join(" · ");

  // Value, pretty-printed where that helps.
  const notes = [];
  let shown = v === null ? "NULL" : v;
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
  if (v !== null && col.type === "bytea" && v.startsWith("\\x") && !isCut) {
    notes.push(`${((v.length - 2) / 2).toLocaleString()} bytes`);
  }
  if (isCut) notes.push(`Value cut at ${state.meta.cellCharLimit.toLocaleString()} characters. Export to get up to 100,000.`);

  const pre = $("insp-value");
  pre.textContent = shown;
  pre.classList.toggle("null", v === null);
  $("insp-note").textContent = notes.join(" · ");
  $("insp-copy").disabled = v === null;
  $("insp-filter").textContent = v === null ? "Filter: is null" : "Filter by this value";
  $("insp-filter").disabled = isCut;

  // Relationship links
  const links = $("insp-links");
  links.replaceChildren();
  const out = (fkCols.get(col.name) || []).filter((fk) => keyFilters(fk.toColumns, fk.fromColumns, row));
  if (out.length) {
    links.append(el("p", { class: "insp-h", text: "Points to" }));
    for (const fk of out) {
      links.append(
        el("button", {
          type: "button",
          class: "link-btn",
          text: `${fk.toTable} where ${describeKey(fk.toColumns, fk.fromColumns, row)} →`,
          onclick: () => followOutgoing(fk, row),
        }),
      );
    }
  }
  const incoming = t.referencedBy.filter(
    (fk) => fk.navigable && fk.fromSchema === state.meta.schema && keyFilters(fk.fromColumns, fk.toColumns, row),
  );
  if (incoming.length) {
    links.append(el("p", { class: "insp-h", text: "Referenced by (this row)" }));
    for (const fk of incoming) {
      links.append(
        el("button", {
          type: "button",
          class: "link-btn",
          text: `${fk.fromTable}.${fk.fromColumns.join(", ")} →`,
          title: `Open ${fk.fromTable} where ${describeKey(fk.fromColumns, fk.toColumns, row)}`,
          onclick: () => followIncoming(fk, row),
        }),
      );
    }
  }

  $("inspector").hidden = false;
}

function closeInspector() {
  $("inspector").hidden = true;
  document.querySelectorAll(".grid td.selected").forEach((n) => n.classList.remove("selected"));
  state.selected = null;
}

async function copyText(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = label), 1200);
  } catch {
    showError("Clipboard not available.");
  }
}

// ---- Wiring ------------------------------------------------------------

function wire() {
  $("filter").addEventListener("input", renderTables);

  $("prev").addEventListener("click", () => {
    if (state.current && state.current.page > 1) reload({ page: state.current.page - 1 });
  });
  $("next").addEventListener("click", () => {
    if (state.current && state.data?.hasNext) reload({ page: state.current.page + 1 });
  });
  $("page-size").addEventListener("change", (e) => {
    if (state.current) reload({ page: 1, pageSize: parseInt(e.target.value, 10) });
  });

  // Search: apply after a short pause, or immediately on Enter.
  let searchTimer = 0;
  const applySearch = () => {
    clearTimeout(searchTimer);
    const q = $("search").value.trim();
    if (state.current && q !== state.current.q) reload({ q, page: 1 });
  };
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 450);
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applySearch();
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

  $("grid").tHead.addEventListener("pointerdown", startResize);

  const tbody = $("grid").tBodies[0];
  tbody.addEventListener("click", (e) => {
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
    openInspector(r, c);
  });
  tbody.addEventListener("keydown", (e) => {
    const go = e.target.closest?.(".fk-go");
    if (go && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      go.click();
    }
  });

  $("insp-close").addEventListener("click", closeInspector);
  $("insp-copy").addEventListener("click", () => {
    const s = state.selected;
    const v = s && state.data.rows[s.r][s.c];
    if (v != null) copyText(v, $("insp-copy"), "Copy value");
  });
  $("insp-copy-row").addEventListener("click", () => {
    const s = state.selected;
    if (!s) return;
    const obj = {};
    state.data.table.columns.forEach((col, i) => (obj[col.name] = state.data.rows[s.r][i]));
    copyText(JSON.stringify(obj, null, 2), $("insp-copy-row"), "Copy row as JSON");
  });
  $("insp-filter").addEventListener("click", () => {
    const s = state.selected;
    if (!s) return;
    const col = state.data.table.columns[s.c];
    const v = state.data.rows[s.r][s.c];
    const f = v === null ? { c: col.name, op: "null" } : { c: col.name, op: "eq", v };
    reload({ filters: [...state.current.filters, f], page: 1 });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeMenus();
    if (!$("filter-form").hidden) hideFilterForm();
    else closeInspector();
  });

  const onNav = () => {
    const cur = readHash();
    if (cur && !sameView(cur, state.current)) openTable(cur);
  };
  window.addEventListener("hashchange", onNav);
  window.addEventListener("popstate", onNav);
  window.addEventListener("resize", () => state.data && applyFreeze());
}

async function init() {
  wire();
  try {
    state.meta = await api("/meta");
    $("schema").textContent = state.meta.schema;
    const mode = $("mode");
    mode.textContent = state.meta.capabilities.edit ? "edit enabled" : "read-only";
    if (state.meta.role.canWrite) {
      mode.classList.add("danger");
      mode.textContent += " · role can write";
      mode.title =
        `Connected as "${state.meta.role.name}", which has write privileges. ` +
        "The app only reads, but use a SELECT-only role so that doesn't depend on the code being bug-free.";
    } else {
      mode.title = `Connected as "${state.meta.role.name}" (SELECT-only). All queries run in READ ONLY transactions.`;
    }

    const { tables } = await api("/tables");
    state.tables = tables;
    renderTables();

    const fromHash = readHash();
    if (fromHash && tables.some((t) => t.name === fromHash.name)) openTable(fromHash);
  } catch (err) {
    showError(err.message);
  }
}

init();
