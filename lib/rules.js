// Keyword-based fallback used when no AI key is configured.
// It is deliberately simple: it shows what the CRM does without AI, and where it gets things wrong.

import { COMPANY_NAME } from "./company.js";

const BANGLA = /[ঀ-৿]/;
const BANGLISH_WORDS = /\b(apnader|apnar|ami|amar|koto|kibhabe|kivabe|vai|bhai|naki|hobe|hoy|pabo|pawa|jay|bolen|ta|gula|kothay|mane|ki|ei|korle|korbo|kobe|jodi|na|ache|chai)\b/i;

const has = (re, s) => re.test(s);

function language(text) {
  if (BANGLA.test(text)) return "bangla";
  const hits = (text.match(new RegExp(BANGLISH_WORDS.source, "gi")) || []).length;
  return hits >= 2 ? "banglish" : "english";
}

function cleanName(senderName) {
  if (!senderName) return { name: null, role: null, organisation: null };
  const m = senderName.match(/^([^(]+)\(([^)]*)\)/);
  if (!m) return { name: senderName.trim(), role: null, organisation: null };
  const [role, ...org] = m[2].split(",").map((s) => s.trim());
  return { name: m[1].trim(), role: role || null, organisation: org.join(", ") || null };
}

function normalisePhone(...sources) {
  for (const s of sources) {
    const m = (s || "").replace(/[\s-]/g, "").match(/(?:\+?88)?(01\d{9})/);
    if (m) return m[1];
  }
  return null;
}

export function extract({ message, channel, senderName, phone }) {
  const t = message.toLowerCase();
  const lang = language(message);
  const { name, role, organisation } = cleanName(senderName);

  let kind = "sales_lead";
  if (has(/crypto|earn \d|usd every|bit\.ly|click .* now/i, t)) kind = "spam";
  else if (has(/looking for a job|where do i apply|internship at|\bcv\b/i, t)) kind = "job_seeker";
  else if (has(/refund|cancel|money back|confirmation|পেমেন্ট করেছি|কনফার্মেশন/i, t) && !has(/do you offer refunds/i, t)) kind = "support";

  let interest = "unknown";
  if (has(/company|employees|team|staff|কোম্পানি|কর্মী/i, t)) interest = "corporate_training";
  else if (has(/fellowship|ফেলোশিপ/i, t)) interest = "fellowship";
  else if (has(/bootcamp|বুটক্যাম্প/i, t)) interest = "bootcamp";
  else if (has(/masterclass|মাস্টারক্লাস/i, t)) interest = "masterclass";

  const size = message.match(/(\d+)\s*(?:-person|people|employees|staff|জন)/i) || message.match(/([০-৯]+)\s*জন/);
  const team_size = size ? Number(String(size[1]).replace(/[০-৯]/g, (d) => "০১২৩৪৫৬৭৮৯".indexOf(d))) : null;

  const priority = kind === "spam" || kind === "job_seeker" ? "low"
    : interest === "corporate_training" || kind === "support" ? "high" : "normal";

  const lead = {
    name, name_bangla: null, phone: normalisePhone(phone, message), organisation, role, team_size,
    kind, interest, language: lang,
    summary: message.length > 90 ? message.slice(0, 90) + "…" : message,
    questions: [],
    priority, priority_reason: "Keyword rules",
    next_action: kind === "spam" ? "Ignore / hide" : kind === "support" ? "Check payment records and call back" : "Reply and answer their question",
  };
  return { ...lead, suggested_reply: reply(lead, lang) };
}

const TEMPLATES = {
  english: {
    sales_lead: (n) => `Hi ${n}, thank you for contacting ${COMPANY_NAME}! Our team will share the details with you shortly. When is a good time to call you?`,
    support: (n) => `Hi ${n}, sorry for the trouble. We are checking this right now and will get back to you today.`,
    job_seeker: (n) => `Hi ${n}, thanks for your interest in working with ${COMPANY_NAME}. Please follow our official pages for open positions.`,
  },
  banglish: {
    sales_lead: (n) => `Assalamualaikum ${n}, ${COMPANY_NAME} e message korar jonno dhonnobad! Amader team apnake details janabe. Apnake kokhon call dile subidha hobe?`,
    support: (n) => `Assalamualaikum ${n}, osubidhar jonno dukkhito. Amra ekhoni check korchi, aj-i apnake janabo.`,
    job_seeker: (n) => `Assalamualaikum ${n}, dhonnobad! Job/internship er update amader official page e deya hoy.`,
  },
  bangla: {
    sales_lead: (n) => `আসসালামু আলাইকুম ${n}, ${COMPANY_NAME}-এ মেসেজ করার জন্য ধন্যবাদ! আমাদের টিম শিগগিরই আপনাকে বিস্তারিত জানাবে। আপনাকে কখন কল করলে সুবিধা হবে?`,
    support: (n) => `আসসালামু আলাইকুম ${n}, অসুবিধার জন্য দুঃখিত। আমরা এখনই বিষয়টি দেখছি, আজকেই আপনাকে জানাব।`,
    job_seeker: (n) => `আসসালামু আলাইকুম ${n}, ধন্যবাদ! চাকরি/ইন্টার্নশিপের খবর আমাদের অফিসিয়াল পেজে দেওয়া হয়।`,
  },
};

export function reply(lead, language) {
  if (lead.kind === "spam") return "";
  const set = TEMPLATES[language] || TEMPLATES.english;
  const fn = set[lead.kind] || set.sales_lead;
  return fn(lead.name || "");
}

export function summary(leads, today) {
  const sales = leads.filter((l) => l.kind === "sales_lead");
  const by = (k) => sales.filter((l) => l.status === k).length;
  return `## Weekly summary (rule-based, no AI key)\n\n- ${leads.length} enquiries, ${sales.length} sales leads\n- New ${by("New")}, Contacted ${by("Contacted")}, Interested ${by("Interested")}, Paid ${by("Paid")}, Lost ${by("Lost")}\n- Support issues: ${leads.filter((l) => l.kind === "support").length}\n\nAdd a GEMINI_API_KEY to get a written summary with who to chase first.`;
}
