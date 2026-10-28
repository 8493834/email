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
  selected: null,
  detail: null,
  poll: null,
};


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


function show(view) {
  for (const id of ["gate", "auth", "app"]) $("#" + id).hidden = id !== view;
}

function signedOut(message) {
  state.token = null;
  state.me = null;
  localStorage.removeItem("sps_token");
  clearInterval(state.poll);
  show(state.gate ? "auth" : "gate");
  if (message) $("#li-error").textContent = message;
}

function enterApp() {
  show("app");
  $("#who").textContent = state.me.address;
  state.retention = state.me.retention_days;
  state.selected = null;
  state.detail = null;
  resetReader();
  setFolder("inbox");
  clearInterval(state.poll);
  state.poll = setInterval(() => { if (!document.hidden) loadList(); }, 30000);
}


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

async function startSession(r) {
  state.token = r.token;
  localStorage.setItem("sps_token", r.token);
  state.me = await api("/api/me");
  enterApp();
}

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
    atts,
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
        show("auth");
        $("#li-error").textContent = err.message;
        return;
      }
    }
  }
  show(state.gate ? "auth" : "gate");
})();
