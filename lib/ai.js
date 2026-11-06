// AI layer for LeadDesk. Provider is picked from the environment:
//   ANTHROPIC_API_KEY -> Claude, GEMINI_API_KEY -> Google Gemini (free tier),
//   neither -> the rule-based parser in rules.js, so the app never breaks.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { COMPANY_NAME, FACTS } from "./company.js";
import * as gemini from "./gemini.js";
import * as rules from "./rules.js";

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
let client;
const getClient = () => (client ??= new Anthropic());

const provider = () =>
  process.env.ANTHROPIC_API_KEY ? "claude" : process.env.GEMINI_API_KEY ? "gemini" : "rules";

export const engineName = () => ({
  claude: `Claude (${CLAUDE_MODEL})`,
  gemini: `Gemini (${gemini.MODEL})`,
  rules: "Rule-based fallback (no API key)",
})[provider()];
export const hasAI = () => provider() !== "rules";

const ExtractSchema = z.object({
  name: z.string().nullable().describe("Person's name only, without job title or company. null if unknown."),
  name_bangla: z.string().nullable().describe("If the name was written in Bangla script, a romanised English spelling of it; else null."),
  phone: z.string().nullable().describe("Bangladeshi mobile as 11 digits starting 01, or null."),
  organisation: z.string().nullable().describe("Company or organisation they represent, if any."),
  role: z.string().nullable().describe("Their job title, if mentioned."),
  team_size: z.number().int().nullable().describe("Number of people to train, if mentioned."),
  kind: z.enum(["sales_lead", "support", "spam", "job_seeker", "other"]),
  interest: z.enum(["bootcamp", "fellowship", "corporate_training", "masterclass", "unknown"]),
  language: z.enum(["bangla", "banglish", "english"]).describe("How the sender wrote: Bangla script, Bangla in Latin letters (Banglish), or English."),
  summary: z.string().describe("One short English sentence: what they want."),
  questions: z.array(z.string()).describe("The concrete questions they asked, in English."),
  priority: z.enum(["high", "normal", "low"]),
  priority_reason: z.string().describe("Why this priority, in a few words."),
  next_action: z.string().describe("The single next thing the sales team should do, in English."),
  suggested_reply: z.string().describe("Reply to send, written in the same language and style as the sender."),
});
const ReplySchema = z.object({ reply: z.string() });

const SYSTEM = `You are the enquiry assistant inside the CRM of ${COMPANY_NAME}, a Bangladeshi training company.
People message ${COMPANY_NAME} on WhatsApp, Facebook, the website form and by phone. Messages are in Bangla script, Banglish (Bangla written in English letters) or English.

Your job: read one incoming message and turn it into a clean CRM record plus a reply the team can send.

Classification rules:
- kind=sales_lead: anyone who might buy a programme (prices, schedule, discounts, instalments, "will I get a job", eligibility, class format, certificates, group/company training).
- kind=support: an existing customer with a problem (payment not confirmed, refund, cancellation, access issues). A refund policy question from someone who has NOT paid yet is still a sales_lead.
- kind=spam: ads, scams, irrelevant promotions.
- kind=job_seeker: someone asking for a job or internship AT ${COMPANY_NAME} (not a learner asking about job outcomes).
- interest=corporate_training when they speak for a company/team. interest=masterclass for the free masterclass.
- priority=high for corporate/team leads, angry customers, public-complaint threats, or payment problems. low for spam and job seekers.

Reply rules:
- Match the sender's language: Bangla script -> reply in Bangla script; Banglish -> reply in natural Banglish; English -> English.
- Banglish means Bangla words written ONLY in English (Latin) letters, e.g. "amader team apnake details janabe". A Banglish reply must contain zero Bangla-script characters.
- Use the person's name exactly as written in the sender name field (same spelling); do not translate or re-spell it.
- Phone call notes are written by staff about the caller: reply as a short SMS to that caller in English unless the note says they prefer Bangla.
- Warm, short (2-4 sentences), WhatsApp-friendly, Bangladeshi tone ("Assalamualaikum"/"Hi" as fits; "apni" form, never "tumi").
- Use only the facts below. NEVER invent prices, dates, discounts, refund terms, locations or eligibility (who can join). If a fact is missing, say the team will confirm it and ask for the detail you need (e.g. best time to call).
- Spam: suggested_reply must be an empty string. Job seeker: politely point them to the company's careers page/announcements.
- Under-18 learners: be kind, and suggest a parent/guardian joins the conversation.

Facts you may use:
${FACTS}`;

const SUMMARY_SYSTEM = "You write the weekly sales summary for a small sales team. Be concrete, use names, keep it under 250 words. Plain markdown: short headings and bullet points. No preamble.";

function stopCheck(response) {
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The model's answer was cut off.");
}

// One structured (JSON) call, on whichever provider is configured.
async function callJSON(schema, user, { strong = false } = {}) {
  if (provider() === "gemini") return gemini.generateJSON({ system: SYSTEM, user, schema: z.toJSONSchema(schema), strong });
  const response = await getClient().messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(schema) },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  stopCheck(response);
  if (!response.parsed_output) throw new Error("Could not read the AI response.");
  return response.parsed_output;
}

async function callText(system, user) {
  if (provider() === "gemini") return gemini.generateText({ system, user });
  const response = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium" },
    system,
    messages: [{ role: "user", content: user }],
  });
  stopCheck(response);
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

export async function extract({ message, channel, senderName, phone }) {
  if (!hasAI()) return { ...rules.extract({ message, channel, senderName, phone }), engine: engineName() };
  const out = await callJSON(ExtractSchema,
    `Channel: ${channel || "unknown"}\nSender name field: ${senderName || "(empty)"}\nPhone field: ${phone || "(empty)"}\n\nMessage:\n<message>\n${message}\n</message>`);
  // Safety net: Banglish and English replies must use Latin letters only.
  if (out.language !== "bangla" && NON_LATIN.test(out.suggested_reply)) {
    const lead = { ...out, status: "New", messages: [{ from: "customer", at: "now", text: message }] };
    out.suggested_reply = (await reply({ lead, language: out.language, strong: true })).reply;
  }
  return { ...out, engine: engineName() };
}

// Any letter that is not Latin (Bangla, Devanagari, Arabic, ...) breaks a Banglish/English reply.
const NON_LATIN = /[^\p{Script=Latin}\p{N}\p{P}\p{S}\p{Z}\s]/u;

export async function reply({ lead, language, instruction, strong = false }) {
  if (!hasAI()) return { reply: rules.reply(lead, language), engine: engineName() };
  const history = (lead.messages || []).map((m) => `[${m.at}] ${m.from === "team" ? "Team" : m.from === "note" ? "Internal note" : "Customer"}: ${m.text}`).join("\n");
  const ask = (extra, opts) => callJSON(ReplySchema, `Write the next reply to this person.
Reply language: ${language} (bangla = Bangla script, banglish = Bangla in Latin letters only, english = English).
Pipeline status: ${lead.status}. Interest: ${lead.interest}. Kind: ${lead.kind}. Name: ${lead.name || "unknown"}.
${instruction ? `Extra instruction from the team: ${instruction}\n` : ""}${extra}
Conversation so far:
${history}`, opts);
  let out = await ask("", { strong });
  if (language !== "bangla" && NON_LATIN.test(out.reply)) {
    out = await ask("Your last draft contained non-English letters (e.g. Bangla, Hindi or Arabic script). Rewrite it using ONLY English (Latin) letters.\n", { strong: true });
  }
  return { reply: out.reply ?? "", engine: engineName() };
}

function counts(leads) {
  const tally = (key) => leads.reduce((acc, l) => ({ ...acc, [l[key]]: (acc[l[key]] || 0) + 1 }), {});
  const sales = leads.filter((l) => l.kind === "sales_lead");
  return {
    total_enquiries: leads.length,
    by_type: tally("kind"),
    sales_leads_by_status: sales.reduce((acc, l) => ({ ...acc, [l.status]: (acc[l.status] || 0) + 1 }), {}),
    sales_leads_by_interest: sales.reduce((acc, l) => ({ ...acc, [l.interest]: (acc[l.interest] || 0) + 1 }), {}),
  };
}

export async function summary({ leads, today }) {
  if (!hasAI()) return { summary: rules.summary(leads, today), engine: engineName() };
  const compact = leads.map((l) => ({
    name: l.name, kind: l.kind, interest: l.interest, status: l.status, priority: l.priority,
    channel: l.channel, created: l.createdAt, last_contacted: l.lastContactedAt, summary: l.summary,
    organisation: l.organisation, team_size: l.team_size,
  }));
  const text = await callText(SUMMARY_SYSTEM, `Today is ${today}. A lead "needs follow-up" if it is New/Contacted/Interested and nobody contacted them in the last 48 hours.
Write: 1) the week in numbers, 2) top 3-5 people to contact first today and why, 3) patterns in what people ask (so we can fix our FAQ/ads), 4) support issues or risks.
Exact counts (use these numbers, do not recount): ${JSON.stringify(counts(leads))}

CRM data (JSON):
${JSON.stringify(compact)}`);
  return { summary: text, engine: engineName() };
}
