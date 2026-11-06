// LeadDesk front end. Data lives in this browser (localStorage); AI runs on the server (/api/*).
const STAGES = ["New", "Contacted", "Interested", "Paid", "Lost"];
const ACTIVE = ["New", "Contacted", "Interested"];
const FOLLOW_UP_HOURS = 48;
const STORE = "leaddesk-v1";

const KIND = {
  sales_lead: { label: "Sales lead", cls: "brand" },
  support: { label: "Support issue", cls: "danger" },
  spam: { label: "Spam", cls: "" },
  job_seeker: { label: "Job seeker", cls: "warn" },
  other: { label: "Other", cls: "" },
};
const INTEREST = {
  bootcamp: "Bootcamp", fellowship: "Fellowship", corporate_training: "Corporate training",
  masterclass: "Free masterclass", unknown: "Not clear yet",
};
const LANG = { bangla: "বাংলা", banglish: "Banglish", english: "English" };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- state ----------
let state = load();
let samples = [];
let draft = null; // AI result waiting to be saved
let listFilter = "all";

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || { leads: [] }; } catch { return { leads: [] }; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* private mode: keep in memory */ }
  render();
}

// ---------- helpers ----------
const now = () => new Date();
const parseDhaka = (s) => new Date(s.replace(" ", "T") + ":00+06:00");
const hoursSince = (iso) => (now() - new Date(iso)) / 36e5;
function ago(iso) {
  if (!iso) return "never";
  const h = hoursSince(iso);
  if (h < 1) return "just now";
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const normPhone = (p) => { const m = (p || "").replace(/[\s-]/g, "").match(/(01\d{9})$/); return m ? m[1] : null; };
const displayName = (l) => l.name || (l.phone ? l.phone : "Unknown sender");

function lastTouch(lead) {
  return [lead.lastContactedAt, lead.lastCustomerAt].filter(Boolean).sort().pop();
}
function unanswered(lead) {
  return !lead.lastContactedAt || lead.lastCustomerAt > lead.lastContactedAt;
}
function needsFollowUp(lead) {
  if (lead.kind === "support") return !lead.resolved && hoursSince(lastTouch(lead)) > FOLLOW_UP_HOURS;
  if (lead.kind !== "sales_lead" || !ACTIVE.includes(lead.status)) return false;
  return hoursSince(lastTouch(lead)) > FOLLOW_UP_HOURS;
}
function findDuplicate(rec) {
  const phone = normPhone(rec.phone);
  return state.leads.find((l) =>
    (phone && normPhone(l.phone) === phone) ||
    (!phone && rec.name && l.name && l.name.toLowerCase() === rec.name.toLowerCase() && l.channel === rec.channel));
}

async function api(path, body) {
  const res = await fetch(`/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), 2600);
}
function waLink(phone, text) {
  const p = normPhone(phone);
  return p ? `https://wa.me/88${p}?text=${encodeURIComponent(text || "")}` : null;
}

// ---------- saving leads ----------
function upsertFromAI(ai, input) {
  const at = input.receivedAt ? parseDhaka(input.receivedAt).toISOString() : now().toISOString();
  const rec = { ...ai, phone: normPhone(ai.phone) || normPhone(input.phone), channel: input.channel };
  const msg = { id: uid(), from: "customer", text: input.message, at, channel: input.channel };
  const dup = findDuplicate(rec);

  if (dup) {
    const wasUnanswered = unanswered(dup);
    dup.messages.push(msg);
    if (wasUnanswered) dup.messages.push({ id: uid(), from: "note", at, text: "Asked again before anyone replied — reply first!" });
    dup.lastCustomerAt = at > (dup.lastCustomerAt || "") ? at : dup.lastCustomerAt;
    dup.suggestedReply = ai.suggested_reply || dup.suggestedReply;
    dup.repeatAsks = (dup.repeatAsks || 0) + 1;
    if (wasUnanswered && dup.priority !== "high") { dup.priority = "high"; dup.priority_reason = "Asked twice with no reply"; }
    for (const k of ["name", "organisation", "role", "team_size"]) dup[k] ??= rec[k];
    if (dup.interest === "unknown" && rec.interest !== "unknown") dup.interest = rec.interest;
    return { lead: dup, merged: true };
  }

  const lead = {
    id: uid(),
    name: rec.name, name_bangla: rec.name_bangla, phone: rec.phone, channel: rec.channel,
    organisation: rec.organisation, role: rec.role, team_size: rec.team_size,
    kind: rec.kind, interest: rec.interest, language: rec.language,
    status: "New", priority: rec.priority, priority_reason: rec.priority_reason,
    summary: rec.summary, questions: rec.questions || [], next_action: rec.next_action,
    suggestedReply: rec.suggested_reply, engine: rec.engine,
    createdAt: at, lastCustomerAt: at, lastContactedAt: null, resolved: false,
    messages: [msg],
  };
  state.leads.unshift(lead);
  return { lead, merged: false };
}

// ---------- render ----------
function render() {
  renderStats(); renderBoard(); renderList(); renderFollowUps();
  if (openId) renderDrawer();
}

function renderStats() {
  const L = state.leads;
  const sales = L.filter((l) => l.kind === "sales_lead");
  const fu = L.filter(needsFollowUp).length;
  const support = L.filter((l) => l.kind === "support" && !l.resolved).length;
  const paid = sales.filter((l) => l.status === "Paid").length;
  $("#stats").innerHTML = [
    ["Enquiries saved", L.length],
    ["Real sales leads", sales.length],
    ["Need follow-up (48h+)", fu, fu ? "alert" : ""],
    ["Open support issues", support, support ? "alert" : ""],
    ["Paid", paid],
  ].map(([label, n, c]) => `<div class="stat ${c || ""}"><b>${n}</b><span>${label}</span></div>`).join("");
  const badge = $("#fuCount");
  badge.textContent = fu; badge.classList.toggle("hidden", !fu);
}

function leadCard(l) {
  const od = needsFollowUp(l);
  return `<div class="lead-card ${od ? "overdue" : ""}" draggable="true" data-id="${l.id}">
    <div class="spread"><span class="name">${esc(displayName(l))}</span>${l.priority === "high" ? '<span class="pill danger">High</span>' : ""}</div>
    <div class="sum">${esc(l.summary)}</div>
    <div class="meta">
      <span class="pill brand">${esc(INTEREST[l.interest])}</span>
      <span class="pill">${esc(l.channel)}</span>
      ${od ? `<span class="pill danger">⏰ ${ago(lastTouch(l))}</span>` : ""}
      ${unanswered(l) ? '<span class="pill warn">Not replied</span>' : ""}
    </div>
  </div>`;
}

function renderBoard() {
  const sales = state.leads.filter((l) => l.kind === "sales_lead");
  $("#board").innerHTML = STAGES.map((s) => {
    const items = sales.filter((l) => l.status === s);
    return `<div class="col" data-stage="${s}">
      <div class="col-head"><span>${s}</span><small>${items.length}</small></div>
      ${items.map(leadCard).join("") || '<p class="muted" style="padding:4px">—</p>'}
    </div>`;
  }).join("");
}

const FILTERS = [
  ["all", "All"], ["sales_lead", "Sales leads"], ["followup", "Needs follow-up"],
  ["support", "Support"], ["job_seeker", "Job seekers"], ["spam", "Spam"],
];
function renderList() {
  const counts = {
    all: state.leads.length, followup: state.leads.filter(needsFollowUp).length,
    ...Object.fromEntries(Object.keys(KIND).map((k) => [k, state.leads.filter((l) => l.kind === k).length])),
  };
  $("#filters").innerHTML = FILTERS.map(([k, label]) =>
    `<button data-filter="${k}" class="${listFilter === k ? "active" : ""}">${label} <small>${counts[k] ?? 0}</small></button>`).join("");

  const q = ($("#search").value || "").toLowerCase();
  const rows = state.leads.filter((l) =>
    (listFilter === "all" || (listFilter === "followup" ? needsFollowUp(l) : l.kind === listFilter)) &&
    (!q || JSON.stringify([l.name, l.phone, l.organisation, l.summary, l.messages.map((m) => m.text)]).toLowerCase().includes(q)));

  $("#table").innerHTML = `<thead><tr><th>Name</th><th>Type</th><th>Wants</th><th>Channel</th><th>Status</th><th>Last message</th><th>Waiting</th></tr></thead>
    <tbody>${rows.map((l) => `<tr class="clickable" data-id="${l.id}">
      <td><b>${esc(displayName(l))}</b>${l.organisation ? `<br><small class="muted">${esc(l.organisation)}</small>` : ""}${l.phone ? `<br><small class="muted">${esc(l.phone)}</small>` : '<br><small class="danger-text">No phone</small>'}</td>
      <td><span class="pill ${KIND[l.kind].cls}">${KIND[l.kind].label}</span></td>
      <td>${esc(INTEREST[l.interest])}${l.team_size ? `<br><small class="muted">${l.team_size} people</small>` : ""}</td>
      <td>${esc(l.channel)}<br><small class="muted">${LANG[l.language] || ""}</small></td>
      <td>${l.kind === "sales_lead" ? esc(l.status) : l.kind === "support" ? (l.resolved ? "Resolved" : "Open") : "—"}</td>
      <td class="msg">${esc(l.messages.filter((m) => m.from === "customer").pop()?.text)}</td>
      <td>${needsFollowUp(l) ? `<span class="pill danger">${ago(lastTouch(l))}</span>` : `<small class="muted">${ago(lastTouch(l))}</small>`}</td>
    </tr>`).join("") || '<tr><td colspan="7" class="muted">Nothing here yet. Paste an enquiry or import the samples.</td></tr>'}</tbody>`;
}

function renderFollowUps() {
  const pr = { high: 0, normal: 1, low: 2 };
  const list = state.leads.filter(needsFollowUp)
    .sort((a, b) => pr[a.priority] - pr[b.priority] || lastTouch(a).localeCompare(lastTouch(b)));
  $("#fuList").innerHTML = list.map((l) => `<div class="fu" data-id="${l.id}">
      <div>
        <b>${esc(displayName(l))}</b> <span class="pill ${KIND[l.kind].cls}">${KIND[l.kind].label}</span>
        ${l.priority === "high" ? '<span class="pill danger">High</span>' : ""}
        <div class="why">${esc(l.next_action || l.summary)}</div>
        <div class="why">${unanswered(l) ? "They are waiting for our reply" : "We contacted them, no update since"} · last touch ${ago(lastTouch(l))}</div>
      </div>
      <button class="small">Open</button>
    </div>`).join("") || '<p class="muted">🎉 Everyone has been followed up in the last 48 hours.</p>';
}

// ---------- AI result (capture tab) ----------
function renderResult(ai, input) {
  const dup = findDuplicate({ ...ai, phone: normPhone(ai.phone) || normPhone(input.phone), channel: input.channel });
  const k = KIND[ai.kind];
  const warn = {
    spam: ["danger", "Looks like spam. It will be saved as spam and kept out of the pipeline."],
    support: ["danger", "This is an existing customer with a problem, not a new sale. It goes to the support list and is flagged urgent."],
    job_seeker: ["warn", "This person wants a job with us, not a course. Kept out of the sales pipeline."],
  }[ai.kind];
  $("#resultEmpty").classList.add("hidden");
  const box = $("#result");
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="result-head">
      <div>
        <h2>${esc(ai.name || "Unknown sender")}${ai.name_bangla ? ` <small class="muted">(${esc(ai.name_bangla)})</small>` : ""}</h2>
        <div class="badges">
          <span class="pill ${k.cls}">${k.label}</span>
          <span class="pill brand">${esc(INTEREST[ai.interest])}</span>
          <span class="pill">${LANG[ai.language]}</span>
          <span class="pill ${ai.priority === "high" ? "danger" : ""}">${ai.priority} priority</span>
        </div>
      </div>
      <small class="muted" title="Engine">${esc(ai.engine)}</small>
    </div>
    ${warn ? `<div class="callout ${warn[0]}">${warn[1]}</div>` : ""}
    ${dup ? `<div class="callout warn">🔁 <b>Already in the CRM:</b> ${esc(displayName(dup))} (${esc(dup.phone || dup.channel)}). Saving will add this message to their existing record instead of creating a duplicate.</div>` : ""}
    <div class="row">
      <label>Name<input data-f="name" value="${esc(ai.name)}"></label>
      <label>Phone<input data-f="phone" value="${esc(normPhone(ai.phone) || normPhone(input.phone) || "")}" placeholder="Missing — ask for it"></label>
      <label>Source<input value="${esc(input.channel)}" disabled></label>
    </div>
    <div class="row">
      <label>Wants
        <select data-f="interest">${Object.entries(INTEREST).map(([v, t]) => `<option value="${v}" ${v === ai.interest ? "selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label>Type
        <select data-f="kind">${Object.entries(KIND).map(([v, t]) => `<option value="${v}" ${v === ai.kind ? "selected" : ""}>${t.label}</option>`).join("")}</select>
      </label>
      <label>Organisation<input data-f="organisation" value="${esc(ai.organisation)}"></label>
    </div>
    <div class="callout">
      <b>What they want:</b> ${esc(ai.summary)}
      ${ai.questions?.length ? `<ul class="qs">${ai.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
      <div style="margin-top:6px"><b>Next step:</b> ${esc(ai.next_action)} <span class="muted">— ${esc(ai.priority_reason)}</span></div>
    </div>
    ${ai.kind !== "spam" ? `<div class="reply-box">
      <div class="spread" style="margin-top:14px">
        <h3 style="margin:0">Suggested reply</h3>
        <div class="seg" id="draftLang">${Object.entries(LANG).map(([v, t]) => `<button data-lang="${v}" class="${v === ai.language ? "active" : ""}">${t}</button>`).join("")}</div>
      </div>
      <textarea id="draftReply" rows="4">${esc(ai.suggested_reply)}</textarea>
    </div>` : ""}
    <div class="actions">
      <button class="primary" id="btnSave">${dup ? "Add to existing lead" : "Save to CRM"}</button>
      ${ai.kind !== "spam" ? '<button id="btnCopyDraft">Copy reply</button>' : ""}
    </div>`;
}

async function runExtract() {
  const input = {
    channel: $("#inChannel").value, senderName: $("#inName").value.trim(),
    phone: $("#inPhone").value.trim(), message: $("#inMessage").value.trim(),
    receivedAt: $("#inMessage").dataset.receivedAt || null,
  };
  if (!input.message) return toast("Paste a message first");
  const btn = $("#btnExtract");
  btn.disabled = true; btn.textContent = "Reading…";
  try {
    const ai = await api("extract", input);
    draft = { ai, input };
    renderResult(ai, input);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false; btn.textContent = "✨ Read with AI";
  }
}

function saveDraft() {
  if (!draft) return;
  const ai = { ...draft.ai };
  $$("#result [data-f]").forEach((el) => { ai[el.dataset.f] = el.value.trim() || null; });
  ai.suggested_reply = $("#draftReply")?.value ?? "";
  const { lead, merged } = upsertFromAI(ai, draft.input);
  // Keep the language the reply was last written in, so the lead panel highlights the right one.
  const chosenLang = $("#draftLang button.active")?.dataset.lang;
  if (chosenLang) lead.replyLang = chosenLang;
  save();
  toast(merged ? `Added to ${displayName(lead)}'s existing record` : `Saved ${displayName(lead)}`);
  draft = null;
  $("#result").classList.add("hidden"); $("#resultEmpty").classList.remove("hidden");
  $("#inMessage").value = ""; $("#inName").value = ""; $("#inPhone").value = "";
  delete $("#inMessage").dataset.receivedAt;
  openLead(lead.id);
}

async function importSamples() {
  if (state.leads.length && !confirm("Add the 20 sample enquiries to your current data?")) return;
  const btn = $("#btnImport"); btn.disabled = true;
  const bar = $("#importProgress"); bar.classList.remove("hidden");
  let done = 0, merged = 0, failed = 0;
  const step = () => { $("div", bar).style.width = `${(done / samples.length) * 100}%`; $("span", bar).textContent = `${done}/${samples.length}`; };
  step();
  // Read in parallel, but save in the original order (so duplicates merge correctly),
  // adding each lead to the screen as soon as everything before it is ready.
  const results = new Array(samples.length);
  let saved = 0;
  const flush = () => {
    let changed = false;
    while (saved < samples.length && results[saved] !== undefined) {
      if (results[saved]) merged += upsertFromAI(results[saved], samples[saved]).merged ? 1 : 0;
      saved++; changed = true;
    }
    if (changed) save();
  };
  const queue = samples.map((s, i) => [s, i]);
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const [s, i] = queue.shift();
      // The free AI tier sometimes rejects a burst of requests: retry twice before giving up.
      for (let attempt = 0; attempt < 3 && results[i] === undefined; attempt++) {
        try { results[i] = await api("extract", s); } catch { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); }
      }
      if (results[i] === undefined) { results[i] = null; failed++; }
      done++; step(); flush();
    }
  }));
  btn.disabled = false;
  setTimeout(() => bar.classList.add("hidden"), 1500);
  toast(`Imported ${samples.length - failed} messages · ${merged} duplicate merged${failed ? ` · ${failed} failed` : ""}`);
}

// ---------- drawer ----------
let openId = null;
function openLead(id) {
  openId = id;
  $("#drawer").classList.remove("hidden"); $("#scrim").classList.remove("hidden");
  renderDrawer();
}
function closeLead() {
  openId = null;
  $("#drawer").classList.add("hidden"); $("#scrim").classList.add("hidden");
}
const getLead = (id) => state.leads.find((l) => l.id === id);

function renderDrawer() {
  const l = getLead(openId);
  if (!l) return closeLead();
  const wa = waLink(l.phone, l.suggestedReply);
  const lang = l.replyLang || l.language;
  $("#drawer").innerHTML = `
    <div class="spread">
      <h2>${esc(displayName(l))}</h2>
      <button class="link" data-act="close">✕ Close</button>
    </div>
    <div class="badges">
      <span class="pill ${KIND[l.kind].cls}">${KIND[l.kind].label}</span>
      <span class="pill brand">${esc(INTEREST[l.interest])}</span>
      <span class="pill">${esc(l.channel)}</span>
      ${needsFollowUp(l) ? `<span class="pill danger">⏰ Follow-up overdue (${ago(lastTouch(l))})</span>` : ""}
      ${l.repeatAsks ? `<span class="pill warn">Asked ${l.repeatAsks + 1}×</span>` : ""}
    </div>
    ${!l.phone ? '<div class="callout warn">No phone number yet — ask for it in your reply so the lead is not lost.</div>' : ""}

    <div class="row">
      <label>Name<input data-edit="name" value="${esc(l.name)}"></label>
      <label>Phone<input data-edit="phone" value="${esc(l.phone)}"></label>
      <label>${l.kind === "sales_lead" ? "Status" : l.kind === "support" ? "Support" : "Type"}
        ${l.kind === "sales_lead"
          ? `<select data-edit="status">${STAGES.map((s) => `<option ${s === l.status ? "selected" : ""}>${s}</option>`).join("")}</select>`
          : l.kind === "support"
            ? `<select data-edit="resolved"><option value="false" ${!l.resolved ? "selected" : ""}>Open</option><option value="true" ${l.resolved ? "selected" : ""}>Resolved</option></select>`
            : `<input value="${KIND[l.kind].label}" disabled>`}
      </label>
    </div>
    <div class="row">
      <label>Wants<select data-edit="interest">${Object.entries(INTEREST).map(([v, t]) => `<option value="${v}" ${v === l.interest ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Type<select data-edit="kind">${Object.entries(KIND).map(([v, t]) => `<option value="${v}" ${v === l.kind ? "selected" : ""}>${t.label}</option>`).join("")}</select></label>
      <label>Organisation<input data-edit="organisation" value="${esc(l.organisation)}"></label>
    </div>
    <div class="callout"><b>Next step:</b> ${esc(l.next_action)}</div>

    <h3>Conversation</h3>
    <div class="timeline">
      ${l.messages.map((m) => `<div class="bubble ${m.from}">${esc(m.text)}<small>${m.from === "team" ? "Team" : m.from === "note" ? "Note" : esc(m.channel || "Customer")} · ${fmt(m.at)}</small></div>`).join("")}
    </div>

    ${l.kind !== "spam" ? `
    <div class="reply-box">
      <div class="spread" style="margin-top:14px">
        <h3 style="margin:0">Suggested reply</h3>
        <div class="seg">${Object.entries(LANG).map(([v, t]) => `<button data-act="lang" data-lang="${v}" class="${v === lang ? "active" : ""}">${t}</button>`).join("")}</div>
      </div>
      <textarea id="replyText" rows="5">${esc(l.suggestedReply)}</textarea>
      <input id="replyHint" placeholder="Optional instruction, e.g. 'offer a call on Saturday' then press ✨">
      <div class="actions">
        <button data-act="regen">✨ Rewrite with AI</button>
        <button data-act="copy">Copy</button>
        ${wa ? `<a href="${wa}" target="_blank" rel="noopener"><button data-act="wa">Open in WhatsApp</button></a>` : ""}
        <button class="primary" data-act="sent">✓ Mark as sent</button>
      </div>
    </div>` : ""}

    <h3>Add a new message from them</h3>
    <textarea id="newMsg" rows="2" placeholder="Paste their latest message or a call note"></textarea>
    <div class="actions">
      <button data-act="addmsg">Add to conversation</button>
      <button class="link danger-text" data-act="delete" style="margin-left:auto">Delete lead</button>
    </div>`;
}

async function drawerAction(act, el) {
  const l = getLead(openId);
  if (!l) return;
  if (act === "close") return closeLead();
  if (act === "copy") { await navigator.clipboard?.writeText($("#replyText").value); return toast("Reply copied"); }
  if (act === "lang" || act === "regen") {
    if (act === "lang") l.replyLang = el.dataset.lang;
    const btn = $('[data-act="regen"]'); btn.disabled = true; btn.textContent = "Writing…";
    try {
      const r = await api("reply", { lead: l, language: l.replyLang || l.language, instruction: $("#replyHint").value });
      l.suggestedReply = r.reply;
      save();
    } catch (e) { toast(e.message); renderDrawer(); }
    return;
  }
  if (act === "sent") {
    const text = $("#replyText").value.trim();
    const at = now().toISOString();
    if (text) l.messages.push({ id: uid(), from: "team", text, at });
    l.lastContactedAt = at;
    if (l.kind === "sales_lead" && l.status === "New") l.status = "Contacted";
    save(); return toast("Logged as contacted — follow-up clock reset");
  }
  if (act === "addmsg") {
    const text = $("#newMsg").value.trim();
    if (!text) return;
    l.messages.push({ id: uid(), from: "customer", text, at: now().toISOString(), channel: l.channel });
    l.lastCustomerAt = now().toISOString();
    save(); return drawerAction("regen");
  }
  if (act === "delete" && confirm(`Delete ${displayName(l)}?`)) {
    state.leads = state.leads.filter((x) => x.id !== l.id);
    closeLead(); save();
  }
}

// ---------- summary ----------
function markdown(md) {
  const lines = esc(md).split("\n");
  let html = "", inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const li = line.match(/^\s*[-*]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) html += `<h3>${h[1]}</h3>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}
async function writeSummary() {
  if (!state.leads.length) return toast("No enquiries yet");
  const btn = $("#btnSummary"); btn.disabled = true; btn.textContent = "Writing…";
  try {
    const r = await api("summary", { leads: state.leads, today: fmt(now().toISOString()) });
    $("#summary").classList.remove("muted");
    $("#summary").innerHTML = markdown(r.summary) + `<p class="muted"><small>Written by ${esc(r.engine)}</small></p>`;
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "✨ Write with AI"; }
}

// ---------- events ----------
document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tabs button");
  if (tab) {
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b === tab));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${tab.dataset.tab}`));
    return;
  }
  const act = e.target.closest("#drawer [data-act]");
  if (act) return drawerAction(act.dataset.act, act);
  const card = e.target.closest("[data-id]");
  if (card && !e.target.closest("#drawer")) return openLead(card.dataset.id);
  const f = e.target.closest("[data-filter]");
  if (f) { listFilter = f.dataset.filter; return renderList(); }
  const dl = e.target.closest("#draftLang button");
  if (dl) return regenDraft(dl);
  if (e.target.id === "btnSave") return saveDraft();
  if (e.target.id === "btnCopyDraft") { navigator.clipboard?.writeText($("#draftReply").value); return toast("Reply copied"); }
  if (e.target.id === "scrim") return closeLead();
});

async function regenDraft(btn) {
  $$("#draftLang button").forEach((b) => b.classList.toggle("active", b === btn));
  const ta = $("#draftReply"); ta.disabled = true;
  try {
    const lead = { ...draft.ai, status: "New", messages: [{ from: "customer", text: draft.input.message, at: "now" }] };
    const r = await api("reply", { lead, language: btn.dataset.lang });
    ta.value = r.reply;
  } catch (e) { toast(e.message); }
  ta.disabled = false;
}

document.addEventListener("change", (e) => {
  const ed = e.target.closest("#drawer [data-edit]");
  if (!ed) return;
  const l = getLead(openId);
  const k = ed.dataset.edit;
  l[k] = k === "resolved" ? ed.value === "true" : ed.value.trim() || null;
  if (k === "phone") l.phone = normPhone(ed.value) || ed.value.trim() || null;
  save();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLead(); });

// Drag and drop on the pipeline board
document.addEventListener("dragstart", (e) => {
  const c = e.target.closest?.(".lead-card");
  if (c) e.dataTransfer.setData("text/plain", c.dataset.id);
});
document.addEventListener("dragover", (e) => {
  const col = e.target.closest?.(".col");
  if (col) { e.preventDefault(); col.classList.add("drag-over"); }
});
document.addEventListener("dragleave", (e) => e.target.closest?.(".col")?.classList.remove("drag-over"));
document.addEventListener("drop", (e) => {
  const col = e.target.closest?.(".col");
  if (!col) return;
  e.preventDefault();
  const l = getLead(e.dataTransfer.getData("text/plain"));
  if (l && l.status !== col.dataset.stage) {
    l.status = col.dataset.stage;
    if (col.dataset.stage !== "New" && !l.lastContactedAt) l.lastContactedAt = now().toISOString();
    save(); toast(`${displayName(l)} → ${l.status}`);
  }
});

$("#btnExtract").addEventListener("click", runExtract);
$("#btnImport").addEventListener("click", importSamples);
$("#btnSummary").addEventListener("click", writeSummary);
$("#search").addEventListener("input", renderList);
$("#btnReset").addEventListener("click", () => {
  if (confirm("Delete all enquiries in this browser?")) { state = { leads: [] }; closeLead(); save(); }
});
$("#sampleSelect").addEventListener("change", (e) => {
  const s = samples.find((x) => String(x.id) === e.target.value);
  if (!s) return;
  $("#inChannel").value = s.channel; $("#inName").value = s.senderName; $("#inPhone").value = s.phone;
  $("#inMessage").value = s.message; $("#inMessage").dataset.receivedAt = s.receivedAt;
  e.target.value = "";
});

// ---------- boot ----------
(async () => {
  render();
  try {
    samples = await (await fetch("sample-enquiries.json")).json();
    $("#sampleSelect").innerHTML += samples.map((s) =>
      `<option value="${s.id}">#${s.id} ${esc(s.senderName.split("(")[0])} — ${esc(s.message.slice(0, 40))}…</option>`).join("");
  } catch { /* samples optional */ }
  try {
    const st = await (await fetch("/api/status")).json();
    const el = $("#engine");
    el.textContent = st.ai ? `AI: ${st.engine}` : "AI offline · rule-based mode";
    el.className = `engine ${st.ai ? "on" : "off"}`;
  } catch { $("#engine").textContent = "Server not reachable"; }
})();
