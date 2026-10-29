"use strict";

const API = ((window.SPS_CONFIG && window.SPS_CONFIG.apiBase) || "").replace(/\/$/, "");
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  token: localStorage.getItem("sps_token"),
  gate: localStorage.getItem("sps_gate"),
  me: null,
  folder: "inbox",
  retention: 15,
  items: [],
  selected: null, // id of the open message
  detail: null,
  poll: null,
};

/* ------------------------------------------------------------------ helpers */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function api(path, { method = "GET", body, auth = true, blob = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.token) headers.Authorization = "Bearer " + state.token;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError("Can't reach the mail server. Check your connection and try again.", 0);
  }
  if (blob && res.ok) return res.blob();
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 && auth) signedOut("Your session ended. Please log in again.");
    throw new ApiError(data.error || `Something went wrong (${res.status}).`, res.status, data);
  }
  return data;
}

function toast(message, ms = 4500) {
  const t = $("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function displayName(field) {
  const m = (field || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return ((m && m[1].trim()) || (m && m[2]) || field || "").trim();
}

function shortDate(epoch) {
  const d = new Date(epoch * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}

const longDate = (epoch) => new Date(epoch * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function daysLeft(expiresAt) {
  return Math.max(0, Math.ceil((expiresAt * 1000 - Date.now()) / 86400000));
}

function formatSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return Math.round(n / 1024) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

/* Postmark-style ring: how much of the retention window is left. Numbers only, so innerHTML is safe. */
function ring(expiresAt) {
  const left = daysLeft(expiresAt);
  const frac = Math.min(1, left / state.retention);
  const C = 2 * Math.PI * 9;
  const span = h("span", { class: "ring" + (left <= 3 ? " low" : ""), role: "img", "aria-label": `Deletes in ${left} day${left === 1 ? "" : "s"}`, title: `Deletes in ${left} day${left === 1 ? "" : "s"}` });
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke-width="3"><circle class="track" cx="12" cy="12" r="9"/>` +
    `<circle class="arc" cx="12" cy="12" r="9" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(2)}"/></svg>`;
  return span;
}

function pin() {
  const span = h("span", { class: "pin", role: "img", "aria-label": "Marked do not delete", title: "Marked do not delete" });
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 3h8l-1.2 6.2L18 12.5V15h-5v6l-1 1-1-1v-6H6v-2.5l3.2-3.3z"/></svg>';
  return span;
}

/* ------------------------------------------------------------------ views */
function show(view) {
  for (const id of ["gate", "auth", "enterprise", "app"]) $("#" + id).hidden = id !== view;
}

function signedOut(message) {
  // Enterprise people go back to the enterprise sign-in page, everyone else to the normal one.
  const enterprise = localStorage.getItem("sps_ent") === "1";
  state.token = null;
  state.me = null;
  localStorage.removeItem("sps_token");
  clearInterval(state.poll);
  show(enterprise ? "enterprise" : state.gate ? "auth" : "gate");
  if (message) $(enterprise ? "#el-error" : "#li-error").textContent = message;
}

function enterApp() {
  show("app");
  $("#who").textContent = state.me.address;
  $("#admin-btn").hidden = !state.me.is_admin;
  const ent = state.me.enterprise;
  $("#ent-btn").hidden = !(ent && ent.role === "manager");
  $("#who-ent").hidden = !ent;
  if (ent) $("#who-ent").textContent = ent.role === "manager" ? `${ent.name} (manager)` : ent.name;
  state.retention = state.me.retention_days;
  state.selected = null;
  state.detail = null;
  resetReader();
  setFolder("inbox");
  clearInterval(state.poll);
  state.poll = setInterval(() => { if (!document.hidden) loadList(); }, 30000);
}

/* ------------------------------------------------------------------ gate / signup / login */
$("#gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $("#gate-error").textContent = "";
  try {
    const r = await api("/api/gate", { method: "POST", body: { password: $("#gate-pw").value }, auth: false });
    state.gate = r.gate_token;
    localStorage.setItem("sps_gate", r.gate_token);
    $("#gate-pw").value = "";
    show("auth");
    $("#su-user").focus();
  } catch (err) {
    $("#gate-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

async function startSession(r, viaEnterprise = false) {
  state.token = r.token;
  localStorage.setItem("sps_token", r.token);
  if (viaEnterprise) localStorage.setItem("sps_ent", "1");
  else localStorage.removeItem("sps_ent");
  state.me = await api("/api/me");
  enterApp();
}

$("#ent-open").addEventListener("click", () => { show("enterprise"); $("#el-user").focus(); });
$("#ent-back").addEventListener("click", () => {
  $("#el-error").textContent = "";
  show(state.gate ? "auth" : "gate");
});

$("#ent-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $("#el-error").textContent = "";
  try {
    const r = await api("/api/login", {
      method: "POST", auth: false,
      body: { username: $("#el-user").value, password: $("#el-pw").value, enterprise: true },
    });
    $("#el-pw").value = "";
    await startSession(r, true);
  } catch (err) {
    $("#el-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $("#su-error").textContent = "";
  try {
    const r = await api("/api/signup", {
      method: "POST", auth: false,
      body: { username: $("#su-user").value, password: $("#su-pw").value, gate_token: state.gate },
    });
    $("#su-pw").value = "";
    await startSession(r);
  } catch (err) {
    if (err.status === 403) {
      state.gate = null;
      localStorage.removeItem("sps_gate");
      show("gate");
      $("#gate-error").textContent = "Enter the access password again to create an account.";
    } else {
      $("#su-error").textContent = err.message;
    }
  } finally {
    btn.disabled = false;
  }
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $("#li-error").textContent = "";
  try {
    const r = await api("/api/login", {
      method: "POST", auth: false,
      body: { username: $("#li-user").value, password: $("#li-pw").value },
    });
    $("#li-pw").value = "";
    await startSession(r);
  } catch (err) {
    $("#li-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("#logout-btn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST" }); } catch { /* already signed out */ }
  signedOut();
});

/* ------------------------------------------------------------------ message list */
function setFolder(folder) {
  state.folder = folder;
  state.selected = null;
  resetReader();
  $("#app").dataset.view = "list";
  for (const b of document.querySelectorAll(".folder")) {
    if (b.dataset.folder === folder) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  $("#q").value = "";
  loadList();
}

for (const b of document.querySelectorAll(".folder")) b.addEventListener("click", () => setFolder(b.dataset.folder));

let listRequest = 0;
async function loadList() {
  const mine = ++listRequest;
  try {
    const q = encodeURIComponent($("#q").value.trim());
    const r = await api(`/api/messages?folder=${state.folder}&limit=100${q ? "&q=" + q : ""}`);
    if (mine !== listRequest) return;
    state.items = r.messages;
    state.retention = r.retention_days;
    $("#retention").textContent = `Emails are deleted after ${r.retention_days} days unless you mark them Do not delete.`;
    const unread = $("#unread");
    unread.textContent = r.unread;
    unread.hidden = !r.unread;
    renderList();
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

function renderList() {
  const ul = $("#items");
  ul.replaceChildren();
  const empty = $("#empty");
  empty.hidden = state.items.length > 0;
  if (!state.items.length) {
    empty.textContent = $("#q").value.trim()
      ? "No emails match your search."
      : state.folder === "inbox" ? "Your inbox is empty. New email will appear here." : "You haven't sent any email yet.";
  }
  for (const m of state.items) {
    const who = state.folder === "sent" ? "To: " + displayName(m.to) : displayName(m.from);
    const btn = h(
      "button",
      { class: "item" + (m.read ? "" : " unread"), type: "button", "aria-current": m.id === state.selected ? "true" : "false", onclick: () => openMessage(m.id) },
      h("span", { class: "from" }, who || "(unknown)"),
      h("span", { class: "when" }, shortDate(m.date)),
      h("span", { class: "subj" }, m.subject),
      h("span", { class: "snip" }, m.snippet),
      h("span", { class: "mark" }, m.keep ? pin() : ring(m.expires_at)),
    );
    ul.append(h("li", null, btn));
  }
}

let searchTimer;
$("#q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadList, 300);
});

/* ------------------------------------------------------------------ reader */
function resetReader() {
  $("#reader").replaceChildren(h("p", { class: "placeholder" }, "Select an email to read it."));
}

async function openMessage(id) {
  state.selected = id;
  renderList();
  $("#app").dataset.view = "reader";
  try {
    const d = await api(`/api/messages/${id}`);
    if (state.selected !== id) return;
    state.detail = d;
    renderReader(d);
    const row = state.items.find((m) => m.id === id);
    if (row && !row.read) {
      row.read = true;
      const unread = $("#unread");
      const n = Math.max(0, (parseInt(unread.textContent, 10) || 0) - 1);
      unread.textContent = n;
      unread.hidden = !n;
      renderList();
    }
  } catch (err) {
    toast(err.message);
  }
}

function renderReader(d) {
  const reader = $("#reader");
  const status = h("div", { class: "status" });
  if (d.keep) {
    status.append(pin(), h("span", null, "Marked Do not delete. This email stays until you delete it."));
  } else {
    const when = new Date(d.expires_at * 1000).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
    const left = daysLeft(d.expires_at);
    status.append(ring(d.expires_at), h("span", null, left === 0 ? "This email will be deleted within the hour." : `Deletes automatically in ${left} day${left === 1 ? "" : "s"} (${when}).`));
  }
  const keepBtn = h(
    "button",
    { class: "btn keep-btn", type: "button", "aria-pressed": String(d.keep), onclick: () => toggleKeep(d) },
    d.keep ? "Do not delete: on" : "Do not delete",
  );

  const meta = h("dl", { class: "meta" });
  const row = (k, v) => v && meta.append(h("dt", null, k), h("dd", null, v));
  row("From", d.from);
  row("To", d.to);
  row("Cc", d.cc);
  row("Date", d.date ? longDate(d.date) : "");

  const bodyHost = h("div");
  const showText = () => {
    bodyHost.replaceChildren(h("pre", { class: "text-body" }, d.text || stripHtmlFallback(d.html)));
  };
  const showHtml = (images) => {
    const frame = h("iframe", {
      class: "html-frame", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
      referrerpolicy: "no-referrer", title: "Formatted email",
    });
    const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https:" : ""}`;
    frame.srcdoc =
      `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<base target="_blank"><style>body{font:15px/1.5 system-ui,sans-serif;margin:12px;color:#111;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>` +
      d.html;
    frame.addEventListener("load", () => {
      try { frame.style.height = Math.min(4000, frame.contentDocument.documentElement.scrollHeight + 8) + "px"; } catch { /* keep default */ }
    });
    const bar = h("div", { class: "viewbar" });
    if (d.text) bar.append(h("button", { class: "link", type: "button", onclick: showText }, "Show plain text"));
    bar.append(images
      ? h("span", { class: "hint" }, "Images are showing.")
      : h("button", { class: "link", type: "button", onclick: () => showHtml(true) }, "Show images (the sender can see you opened this)"));
    bodyHost.replaceChildren(bar, frame);
  };
  if (d.text || !d.html) {
    showText();
    if (d.html) bodyHost.prepend(h("div", { class: "viewbar" }, h("button", { class: "link", type: "button", onclick: () => showHtml(false) }, "Show formatted version")));
  } else {
    showHtml(false);
  }

  const atts = d.attachments.length
    ? h("ul", { class: "attachments" }, d.attachments.map((a) =>
        h("li", null, h("button", { type: "button", onclick: () => downloadAttachment(d.id, a) }, a.filename, h("span", { class: "size" }, formatSize(a.size))))))
    : null;

  reader.replaceChildren(
    h("button", { class: "btn back", type: "button", onclick: () => { $("#app").dataset.view = "list"; } }, "Back to list"),
    h("h2", null, d.subject),
    meta,
    h("div", { class: "keepbar" }, status, keepBtn),
    h("div", { class: "actions" },
      d.folder === "inbox" ? h("button", { class: "btn", type: "button", onclick: () => openCompose(d) }, "Reply") : null,
      h("button", { class: "btn", type: "button", onclick: () => deleteMessage(d) }, "Delete")),
    bodyHost,
    ...(atts ? [atts] : []),
  );
  reader.scrollTop = 0;
}

function stripHtmlFallback(html) {
  if (!html) return "(This email has no text.)";
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent || "").trim() || "(This email has no text.)";
}

async function toggleKeep(d) {
  const turningOff = d.keep;
  if (turningOff && Date.now() / 1000 - d.received_at > state.retention * 86400) {
    if (!confirm(`This email is older than ${state.retention} days. If you turn off Do not delete, it will be deleted within the hour. Turn it off?`)) return;
  }
  try {
    await api(`/api/messages/${d.id}/keep`, { method: "POST", body: { keep: !d.keep } });
    await openMessage(d.id);
    loadList();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteMessage(d) {
  if (!confirm("Delete this email permanently?")) return;
  try {
    await api(`/api/messages/${d.id}`, { method: "DELETE" });
    state.selected = null;
    resetReader();
    $("#app").dataset.view = "list";
    toast("Email deleted.");
    loadList();
  } catch (err) {
    toast(err.message);
  }
}

async function downloadAttachment(id, a) {
  try {
    const blob = await api(`/api/messages/${id}/attachment/${a.index}`, { blob: true });
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: a.filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------------------------------------------ compose */
const composeDlg = $("#compose");
let replyTo = null;

function openCompose(replyTarget) {
  replyTo = replyTarget || null;
  $("#c-errors").replaceChildren();
  if (replyTarget) {
    $("#c-to").value = replyTarget.reply_to || replyTarget.from;
    $("#c-subject").value = /^re:/i.test(replyTarget.subject) ? replyTarget.subject : "Re: " + replyTarget.subject;
    const quoted = (replyTarget.text || stripHtmlFallback(replyTarget.html)).split("\n").map((l) => "> " + l).join("\n");
    $("#c-body").value = `\n\nOn ${longDate(replyTarget.date)}, ${replyTarget.from} wrote:\n${quoted}`;
  } else {
    $("#c-to").value = "";
    $("#c-subject").value = "";
    $("#c-body").value = "";
  }
  $("#c-note").hidden = !(state.me && state.me.local_only);
  composeDlg.showModal();
  if (replyTarget) {
    const body = $("#c-body");
    body.focus();
    body.setSelectionRange(0, 0);
  } else {
    $("#c-to").focus();
  }
}

$("#compose-btn").addEventListener("click", () => openCompose(null));
$("#compose-close").addEventListener("click", () => composeDlg.close());

$("#compose-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#c-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  $("#c-errors").replaceChildren();
  try {
    const payload = { to: $("#c-to").value, subject: $("#c-subject").value, body: $("#c-body").value };
    if (replyTo && replyTo.message_id) {
      payload.in_reply_to = replyTo.message_id;
      payload.references = (replyTo.references ? replyTo.references + " " : "") + replyTo.message_id;
    }
    const r = await api("/api/send", { method: "POST", body: payload });
    composeDlg.close();
    const failed = r.results.filter((x) => !x.ok);
    toast(failed.length ? `Sent, but ${failed.length} address${failed.length === 1 ? "" : "es"} failed: ${failed.map((f) => f.to).join(", ")}` : "Email sent.", failed.length ? 9000 : 4500);
    if (state.folder === "sent") loadList();
  } catch (err) {
    const list = $("#c-errors");
    const results = err.data && err.data.results;
    if (results && results.length) {
      for (const x of results.filter((r) => !r.ok)) list.append(h("li", null, `${x.to}: ${x.error}`));
    } else {
      list.append(h("li", null, err.message));
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Send";
  }
});

/* ------------------------------------------------------------------ change password */
const pwDlg = $("#pw-dialog");
$("#pw-btn").addEventListener("click", () => { $("#pw-error").textContent = ""; pwDlg.showModal(); $("#pw-cur").focus(); });
$("#pw-close").addEventListener("click", () => pwDlg.close());
$("#pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/password", { method: "POST", body: { current: $("#pw-cur").value, new: $("#pw-new").value } });
    $("#pw-cur").value = "";
    $("#pw-new").value = "";
    pwDlg.close();
    toast("Password changed. Other devices have been signed out.");
  } catch (err) {
    $("#pw-error").textContent = err.message;
  }
});

/* ------------------------------------------------------------------ admin */
const adminDlg = $("#admin-dialog");
$("#admin-btn").addEventListener("click", () => {
  $("#adm-error").textContent = "";
  adminDlg.showModal();
  loadAdmin();
});
$("#admin-close").addEventListener("click", () => adminDlg.close());

async function loadAdmin() {
  try {
    renderAdmin(await api("/api/admin/overview"));
  } catch (err) {
    $("#adm-error").textContent = err.message;
  }
}

async function adminCall(path, options, doneMessage) {
  $("#adm-error").textContent = "";
  try {
    await api(path, options);
    toast(doneMessage);
  } catch (err) {
    $("#adm-error").textContent = err.message;
  }
  await loadAdmin();
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function renderAdmin(r) {
  $("#admin-stats").textContent = `${plural(r.totals.users, "account")}, ${plural(r.totals.enterprises, "enterprise")}, ${plural(r.totals.messages, "email")} stored, ${r.totals.kept} marked Do not delete.`;
  renderAdminEnts(r.enterprises);
  $("#adm-signups").checked = r.signups_enabled;
  $("#adm-pw-src").textContent = `(now set from the ${r.password_source})`;
  const body = $("#adm-users");
  body.replaceChildren();
  for (const u of r.users) {
    const you = u.username === r.me;
    const link = (label, fn, cls = "link") => h("button", { class: cls, type: "button", onclick: fn }, label);
    body.append(h("tr", null,
      h("td", null, u.address, u.is_admin ? h("span", { class: "badge" }, "admin") : null,
        u.enterprise ? h("span", { class: "hint" }, u.ent_role === "manager" ? `${u.enterprise} (manager)` : u.enterprise) : null,
        you ? h("span", { class: "hint" }, "(you)") : null),
      h("td", null, shortDate(u.created_at)),
      h("td", null, String(u.messages)),
      h("td", null, u.last_login ? shortDate(u.last_login) : "-"),
      h("td", { class: "acts" },
        link("Reset password", () => adminResetPassword(u)),
        u.is_admin ? (you ? null : link("Remove admin", () => adminSetAdmin(u, false))) : u.enterprise ? null : link("Make admin", () => adminSetAdmin(u, true)),
        !u.is_admin && !you ? link("Delete", () => adminDelete(u), "link danger") : null),
    ));
  }
}

function renderAdminEnts(list) {
  const body = $("#adm-ents");
  body.replaceChildren();
  $("#adm-ents-empty").hidden = list.length > 0;
  $("#adm-ents-wrap").hidden = list.length === 0;
  for (const e of list) {
    body.append(h("tr", null,
      h("td", null, e.name),
      h("td", null, e.managers || "-"),
      h("td", null, `${e.used} of ${e.max_members}`),
      h("td", null, shortDate(e.created_at)),
      h("td", { class: "acts" },
        h("button", { class: "link", type: "button", onclick: () => adminEntLimit(e) }, "Change limit"),
        h("button", { class: "link danger", type: "button", onclick: () => adminEntDelete(e) }, "Delete")),
    ));
  }
}

function adminEntLimit(e) {
  const v = prompt(`Account limit for ${e.name} (now ${e.max_members}, ${e.used} in use):`, String(e.max_members));
  if (v === null) return;
  adminCall(`/api/admin/enterprises/${e.id}/limit`, { method: "POST", body: { max_members: Number(v) } }, `Limit changed for ${e.name}.`);
}

function adminEntDelete(e) {
  const typed = prompt(`This permanently deletes ${e.name}, its ${plural(e.used, "account")} and all their emails.\n\nType the enterprise name to confirm:`);
  if (!typed) return;
  adminCall(`/api/admin/enterprises/${e.id}`, { method: "DELETE", body: { confirm: typed } }, `Deleted ${e.name}.`);
}

$("#adm-ent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#ae-error").textContent = "";
  const name = $("#ae-name").value.trim();
  try {
    await api("/api/admin/enterprises", {
      method: "POST",
      body: { name, manager_username: $("#ae-user").value, manager_password: $("#ae-pw").value, max_members: Number($("#ae-seats").value) },
    });
    toast(`Created ${name}. Give its manager their address and password.`, 7000);
    e.target.reset();
  } catch (err) {
    $("#ae-error").textContent = err.message;
  }
  loadAdmin();
});

function adminResetPassword(u) {
  const pw = prompt(`New password for ${u.address} (at least 10 characters).\nThey will be signed out everywhere.`);
  if (!pw) return;
  adminCall(`/api/admin/users/${encodeURIComponent(u.username)}/reset-password`, { method: "POST", body: { password: pw } }, `Password changed for ${u.address}.`);
}

function adminSetAdmin(u, make) {
  adminCall(`/api/admin/users/${encodeURIComponent(u.username)}/admin`, { method: "POST", body: { admin: make } },
    make ? `${u.address} is now an admin.` : `${u.address} is no longer an admin.`);
}

function adminDelete(u) {
  if (!confirm(`Delete ${u.address} and all of their emails permanently?`)) return;
  adminCall(`/api/admin/users/${encodeURIComponent(u.username)}`, { method: "DELETE" }, `Deleted ${u.address}.`);
}

$("#adm-signups").addEventListener("change", (e) =>
  adminCall("/api/admin/settings", { method: "POST", body: { signups_enabled: e.target.checked } },
    e.target.checked ? "Sign-ups are open." : "Sign-ups are closed."));

$("#adm-pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("#adm-pw").value;
  if (!value) return;
  await adminCall("/api/admin/settings", { method: "POST", body: { signup_password: value } }, "Access password changed.");
  $("#adm-pw").value = "";
});

/* ------------------------------------------------------------------ enterprise manager */
const entDlg = $("#ent-dialog");
$("#ent-btn").addEventListener("click", () => {
  $("#ent-error").textContent = "";
  entDlg.showModal();
  loadEnt();
});
$("#ent-close").addEventListener("click", () => entDlg.close());

async function loadEnt() {
  try {
    renderEnt(await api("/api/enterprise/overview"));
  } catch (err) {
    $("#ent-error").textContent = err.message;
  }
}

async function entCall(path, options, doneMessage) {
  $("#ent-error").textContent = "";
  try {
    await api(path, options);
    toast(doneMessage);
  } catch (err) {
    $("#ent-error").textContent = err.message;
  }
  await loadEnt();
}

function renderEnt(r) {
  $("#ent-title").textContent = r.name;
  $("#ent-stats").textContent = `${r.used} of ${plural(r.max_members, "account")} used.`;
  const body = $("#ent-members");
  body.replaceChildren();
  for (const m of r.members) {
    const you = m.username === r.me;
    const link = (label, fn, cls = "link") => h("button", { class: cls, type: "button", onclick: fn }, label);
    const path = `/api/enterprise/members/${encodeURIComponent(m.username)}`;
    body.append(h("tr", null,
      h("td", null, m.address, m.is_manager ? h("span", { class: "badge" }, "manager") : null, you ? h("span", { class: "hint" }, "(you)") : null),
      h("td", null, shortDate(m.created_at)),
      h("td", null, String(m.messages)),
      h("td", null, m.last_login ? shortDate(m.last_login) : "-"),
      h("td", { class: "acts" },
        link("Reset password", () => {
          const pw = prompt(`New password for ${m.address} (at least 10 characters).\nThey will be signed out everywhere.`);
          if (pw) entCall(`${path}/reset-password`, { method: "POST", body: { password: pw } }, `Password changed for ${m.address}.`);
        }),
        you ? null : link(m.is_manager ? "Remove manager" : "Make manager",
          () => entCall(`${path}/manager`, { method: "POST", body: { manager: !m.is_manager } },
            m.is_manager ? `${m.address} is no longer a manager.` : `${m.address} is now a manager.`)),
        !m.is_manager && !you ? link("Delete", () => {
          if (confirm(`Delete ${m.address} and all of their emails permanently?`)) entCall(path, { method: "DELETE" }, `Deleted ${m.address}.`);
        }, "link danger") : null),
    ));
  }
}

$("#ent-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#ent-error").textContent = "";
  try {
    const r = await api("/api/enterprise/members", { method: "POST", body: { username: $("#ea-user").value, password: $("#ea-pw").value } });
    toast(`Created ${r.address}. Give them the password so they can use Enterprise sign-in.`, 7000);
    e.target.reset();
  } catch (err) {
    $("#ent-error").textContent = err.message;
  }
  loadEnt();
});

/* ------------------------------------------------------------------ install as an app (PWA) */
let installPrompt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#install-btn").hidden = isStandalone();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("#install-btn").hidden = true;
  toast("SPS Email is installed.");
});
if (isIOS && !isStandalone()) $("#install-btn").hidden = false;

$("#install-btn").addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("#install-btn").hidden = true;
  } else {
    toast("To install: tap the Share button, then Add to Home Screen.", 9000);
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

/* ------------------------------------------------------------------ start */
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.token && !$("#app").hidden) loadList(); });

(async function boot() {
  if (state.token) {
    try {
      state.me = await api("/api/me");
      enterApp();
      return;
    } catch (err) {
      if (err.status === 0) {
        // Can't reach the server (offline): show the sign-in page this person normally uses.
        const enterprise = localStorage.getItem("sps_ent") === "1";
        show(enterprise ? "enterprise" : "auth");
        $(enterprise ? "#el-error" : "#li-error").textContent = err.message;
        return;
      }
      if (err.status === 401) return; // signedOut() has already chosen the right page
    }
  }
  show(state.gate ? "auth" : "gate");
})();
