# LeadDesk

**AI enquiry CRM for Bangla, Banglish and English**

**Live demo:** https://biai-crm-eight.vercel.app (click **Import all 20** to load the sample enquiries)

Small businesses in Bangladesh get customer messages on WhatsApp, Facebook, website forms and phone calls, written in Bangla, Banglish or English. Messages get lost, and nobody can see who needs a follow-up.

LeadDesk fixes that. Paste any message and the AI turns it into a clean lead, sorts it, and writes a reply in the customer's own language.

## Features

- **AI reads the message**: it fills in the name (without the job title), phone, company, team size, what the person wants, and their questions.
- **Sorts every message**: sales lead, support issue, spam or job seeker. Only real sales leads go into the pipeline.
- **Replies in the customer's language**: বাংলা, Banglish or English, with one click to switch. You can give the AI an instruction ("offer a Saturday call") or open the reply straight in WhatsApp.
- **Grounded in your facts**: the AI is told to use only what is written in [`lib/company.js`](lib/company.js), and to say the team will confirm anything else. Replies are drafts for a person to check before sending, because the small free model occasionally adds a detail of its own.
- **Pipeline**: New → Contacted → Interested → Paid / Lost, with drag and drop.
- **48-hour follow-up reminders**: red badges and a priority-sorted list of who is waiting.
- **Duplicate merging**: a second message from the same phone number joins the existing lead. If nobody had replied yet, the lead is flagged and raised to high priority.
- **AI weekly summary**: the numbers, who to call first, and what customers keep asking.
- **Works without AI**: a keyword-based fallback keeps the app running with no API key.

The sample data is 20 fictional enquiries for a fictional company, "Alo Academy". Change [`lib/company.js`](lib/company.js) to use it for your own business.

## Run it locally

Needs Node 20+.

```bash
npm install
cp .env.example .env   # add a free GEMINI_API_KEY
npm run dev            # http://localhost:3000
```

A free Gemini key is available at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

## Deploy on Vercel

1. Push the repository to GitHub.
2. In Vercel, choose **New Project** and import the repository. No build settings are needed.
3. Add the environment variable `GEMINI_API_KEY`, then deploy.

## How it's built

- `public/`: the front end (plain HTML, CSS and JavaScript, no build step). Data is saved in the browser (localStorage).
- `api/`: serverless functions for reading messages, writing replies and the weekly summary. The API key stays on the server.
- `lib/ai.js`: prompts and AI logic. One Zod schema defines a lead, and the model must return exactly that structure (structured outputs), so every result has valid categories.
- `lib/gemini.js`: Google Gemini (`gemini-3.5-flash-lite`). It switches to `gemini-3.5-flash` if the first model is busy or out of quota, and retries on rate limits.
- A script check makes sure Banglish and English replies contain only Latin letters. If Bangla, Hindi or Arabic letters slip in, the reply is rewritten.
- `lib/rules.js`: the keyword fallback.
- `dev-server.js`: a local server that runs the same `api/` handlers as Vercel.
- Anthropic's Claude API is also supported: set `ANTHROPIC_API_KEY` instead of the Gemini key.

## What's next

- A shared database with login and a lead owner for each lead
- Direct WhatsApp Business and Messenger integration instead of pasting
- A daily digest of overdue follow-ups

## Author

Dip Bhattacharjee
