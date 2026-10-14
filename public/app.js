// PG Studio front end. No framework; all DB values are rendered with
// textContent, never innerHTML, so cell contents cannot inject markup.
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  tables: [],
  current: null, // { name, page, pageSize }
  data: null, // last /api/tables/:name response
  selected: null, // { r, c }
  seq: 0, // guards against out-of-order responses
};

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

function showError(msg) {
  const el = $("error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function fmtCount(n) {
  if (n === null || n === undefined) return "";
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `~${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `~${Math.round(n / 1e3)}k`;
  return `~${n.toLocaleString()}`;
}

// ---- URL hash state ----------------------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const name = p.get("t");
  if (!name) return null;
  const page = Math.max(1, parseInt(p.get("p") || "1", 10) || 1);
  const size = parseInt(p.get("n") || "", 10);
  const pageSize = [25, 50, 100].includes(size) ? size : state.meta?.pageSizeDefault ?? 50;
  return { name, page, pageSize };
}

function writeHash(cur) {
  const p = new URLSearchParams({ t: cur.name, p: String(cur.page), n: String(cur.pageSize) });
  const next = `#${p.toString()}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

// ---- Sidebar -----------------------------------------------------------

function renderTables() {
  const list = $("tables");
  const filter = $("filter").value.trim().toLowerCase();
  list.replaceChildren();
  const shown = state.tables.filter((t) => t.name.toLowerCase().includes(filter));
  for (const t of shown) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = t.name;
    if (state.current && state.current.name === t.name) btn.setAttribute("aria-current", "true");

    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = t.name;
    const count = document.createElement("span");
    count.className = "tcount";
    count.textContent = fmtCount(t.estimatedRows);

    btn.append(name, count);
    btn.addEventListener("click", () =>
      openTable({ name: t.name, page: 1, pageSize: state.current?.pageSize ?? state.meta.pageSizeDefault }),
    );
    li.append(btn);
    list.append(li);
  }
  $("tables-status").textContent =
    state.tables.length === 0
      ? "No readable tables in this schema."
      : `${shown.length} of ${state.tables.length} tables`;
}

// ---- Grid --------------------------------------------------------------

async function openTable(cur) {
  const seq = ++state.seq;
  state.current = cur;
  state.selected = null;
  closeInspector();
  writeHash(cur);
  renderTables();
  showError("");
  setPagerBusy(true);

  try {
    const qs = new URLSearchParams({ page: String(cur.page), pageSize: String(cur.pageSize) });
    const data = await api(`/tables/${encodeURIComponent(cur.name)}?${qs}`);
    if (seq !== state.seq) return; // a newer request superseded this one
    state.data = data;
    renderGrid();
  } catch (err) {
    if (seq !== state.seq) return;
    state.data = null;
    $("view").hidden = true;
    $("empty").hidden = false;
    showError(err.message);
  } finally {
    if (seq === state.seq) setPagerBusy(false);
  }
}

function setPagerBusy(busy) {
  for (const id of ["prev", "next", "page-size"]) $(id).disabled = busy;
  if (!busy && state.data) {
    $("prev").disabled = state.data.page <= 1;
    $("next").disabled = !state.data.hasNext;
  }
}

function renderGrid() {
  const d = state.data;
  const t = d.table;

  $("empty").hidden = true;
  $("view").hidden = false;
  $("title").textContent = t.name;

  const bits = [`${t.columns.length} columns`];
  if (t.estimatedRows !== null) bits.push(`${fmtCount(t.estimatedRows)} rows (estimate)`);
  bits.push(t.primaryKey.length ? `PK: ${t.primaryKey.join(", ")}` : "no primary key");
  if (t.kind === "partitioned") bits.push("partitioned");
  $("subtitle").textContent = bits.join(" · ");

  const warn = $("warning");
  if (!d.orderedByPrimaryKey) {
    warn.textContent =
      "No primary key: rows are shown in physical order, so pages can shift if the table changes. " +
      "Rows without a primary key also can't be edited safely.";
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }

  const first = (d.page - 1) * d.pageSize + 1;
  $("page").textContent = d.rows.length
    ? `Page ${d.page} · rows ${first.toLocaleString()}–${(first + d.rows.length - 1).toLocaleString()}`
    : `Page ${d.page}`;
  $("page-size").value = String(d.pageSize);

  // Header
  const thead = $("grid").tHead;
  const hr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "rownum";
  corner.textContent = "#";
  hr.append(corner);
  for (const c of t.columns) {
    const th = document.createElement("th");
    const name = document.createElement("span");
    name.textContent = c.name;
    if (c.isPrimaryKey) name.className = "pk";
    const type = document.createElement("span");
    type.className = "ctype";
    type.textContent = c.type + (c.nullable ? "" : " · not null");
    th.append(name, type);
    th.title = `${c.name} : ${c.type}`;
    hr.append(th);
  }
  thead.replaceChildren(hr);

  // Body
  const cut = new Set(d.truncated.map(([r, c]) => `${r}:${c}`));
  const tbody = $("grid").tBodies[0];
  const frag = document.createDocumentFragment();

  if (d.rows.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = t.columns.length + 1;
    td.className = "nodata";
    td.textContent = d.page > 1 ? "No rows on this page." : "This table is empty.";
    tr.append(td);
    frag.append(tr);
  }

  d.rows.forEach((row, r) => {
    const tr = document.createElement("tr");
    const num = document.createElement("td");
    num.className = "rownum";
    num.textContent = String(first + r);
    tr.append(num);

    row.forEach((v, c) => {
      const td = document.createElement("td");
      td.className = "cell";
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      if (v === null) {
        td.classList.add("null");
        td.textContent = "NULL";
      } else {
        td.textContent = v;
        td.title = v.length > 300 ? `${v.slice(0, 300)}…` : v;
        if (cut.has(`${r}:${c}`)) td.classList.add("cut");
      }
      tr.append(td);
    });
    frag.append(tr);
  });
  tbody.replaceChildren(frag);
}

// ---- Inspector (future: becomes the cell editor) -----------------------

function openInspector(r, c) {
  const d = state.data;
  const col = d.table.columns[c];
  const v = d.rows[r][c];
  const isCut = d.truncated.some(([rr, cc]) => rr === r && cc === c);

  document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
  document.querySelector(`.grid td[data-r="${r}"][data-c="${c}"]`)?.classList.add("selected");
  state.selected = { r, c };

  $("insp-col").textContent = col.name;
  $("insp-type").textContent = col.type + (col.isPrimaryKey ? " · primary key" : "");
  const pre = $("insp-value");
  pre.textContent = v === null ? "NULL" : v;
  pre.classList.toggle("null", v === null);

  const notes = [];
  if (isCut) notes.push(`Value cut at ${state.meta.cellCharLimit.toLocaleString()} characters.`);
  if (col.isGenerated) notes.push("Generated column.");
  $("insp-note").textContent = notes.join(" ");
  $("insp-copy").disabled = v === null;
  $("inspector").hidden = false;
}

function closeInspector() {
  $("inspector").hidden = true;
  document.querySelectorAll(".grid td.selected").forEach((el) => el.classList.remove("selected"));
  state.selected = null;
}

// ---- Wiring ------------------------------------------------------------

function wire() {
  $("filter").addEventListener("input", renderTables);

  $("prev").addEventListener("click", () => {
    if (state.current && state.current.page > 1) openTable({ ...state.current, page: state.current.page - 1 });
  });
  $("next").addEventListener("click", () => {
    if (state.current && state.data?.hasNext) openTable({ ...state.current, page: state.current.page + 1 });
  });
  $("page-size").addEventListener("change", (e) => {
    if (state.current) openTable({ ...state.current, page: 1, pageSize: parseInt(e.target.value, 10) });
  });

  $("grid").tBodies[0].addEventListener("click", (e) => {
    const td = e.target.closest("td.cell");
    if (!td) return;
    openInspector(Number(td.dataset.r), Number(td.dataset.c));
  });

  $("insp-close").addEventListener("click", closeInspector);
  $("insp-copy").addEventListener("click", async () => {
    const s = state.selected;
    if (!s) return;
    const v = state.data.rows[s.r][s.c];
    if (v === null) return;
    try {
      await navigator.clipboard.writeText(v);
      $("insp-copy").textContent = "Copied";
      setTimeout(() => ($("insp-copy").textContent = "Copy value"), 1200);
    } catch {
      showError("Clipboard not available.");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInspector();
  });

  window.addEventListener("hashchange", () => {
    const cur = readHash();
    if (cur && (cur.name !== state.current?.name || cur.page !== state.current?.page || cur.pageSize !== state.current?.pageSize)) {
      openTable(cur);
    }
  });
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
