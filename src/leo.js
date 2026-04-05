require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

// ── Config ───────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const RATEWIRE_KEY = process.env.RATEWIRE_API_KEY || 'rw_demo_enterprise_1';
const RATEWIRE_URL = process.env.RATEWIRE_BASE_URL || 'https://ratewire-api.onrender.com/v1';

// ── Shared Data Store (VDG-Data — shared with Luna) ──────
const VDG_DATA = process.env.VDG_DATA_DIR
  || path.join(require('os').homedir(), 'Documents', 'VDG-Data');
fs.ensureDirSync(VDG_DATA);
const JOBS_FILE   = path.join(VDG_DATA, 'leo_jobs.json');
const LOG_FILE    = path.join(VDG_DATA, 'leo_execution_log.json');
const MEMORY_FILE = path.join(VDG_DATA, 'memory.json');          // shared
const CONV_FILE   = path.join(VDG_DATA, 'leo_conversations.json'); // leo-specific

if (!BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

// ── Init ─────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
fs.ensureFileSync(JOBS_FILE);
fs.ensureFileSync(LOG_FILE);
fs.ensureFileSync(MEMORY_FILE);
fs.ensureFileSync(CONV_FILE);
if (!fs.readJsonSync(JOBS_FILE, { throws: false })) fs.writeJsonSync(JOBS_FILE, []);
if (!fs.readJsonSync(LOG_FILE, { throws: false })) fs.writeJsonSync(LOG_FILE, []);
if (!fs.readJsonSync(MEMORY_FILE, { throws: false })) fs.writeJsonSync(MEMORY_FILE, []);
if (!fs.readJsonSync(CONV_FILE, { throws: false })) fs.writeJsonSync(CONV_FILE, {});

// ── Memory Manager ───────────────────────────────────────
function getMemories() { return fs.readJsonSync(MEMORY_FILE, { throws: false }) || []; }
function saveMemories(m) { fs.writeJsonSync(MEMORY_FILE, m, { spaces: 2 }); }
function addMemory(text, category = 'general') {
  const memories = getMemories();
  const exists = memories.some(m => m.text.toLowerCase().trim() === text.toLowerCase().trim());
  if (exists) return null;
  const memory = { id: Date.now(), text, category, created: new Date().toISOString() };
  memories.push(memory);
  saveMemories(memories);
  return memory;
}
function deleteMemory(id) {
  const memories = getMemories().filter(m => m.id !== id);
  saveMemories(memories);
}

// ── Conversation Persistence ─────────────────────────────
function loadHistory(userId) {
  const all = fs.readJsonSync(CONV_FILE, { throws: false }) || {};
  return all[userId] || [];
}
function persistHistory(userId, history) {
  const all = fs.readJsonSync(CONV_FILE, { throws: false }) || {};
  all[userId] = history.slice(-50);
  fs.writeJsonSync(CONV_FILE, all, { spaces: 2 });
}

const summarizeCounters = {};

async function autoSummarize(userId, history) {
  if (!summarizeCounters[userId]) summarizeCounters[userId] = 0;
  summarizeCounters[userId]++;
  if (summarizeCounters[userId] % 10 !== 0) return;

  const recent = history.slice(-20);
  const extractPrompt = `Review this conversation and extract important facts about Vanna Gonzalez (Chairman, V&DG Management LLC) worth remembering long-term — preferences, decisions, key relationships, business context, important numbers, recurring topics.

Return ONLY a JSON array (no explanation, no markdown):
[{"text": "fact to remember", "category": "preference|business|person|decision|other"}]

Return [] if nothing new is worth saving. Max 5 facts.`;

  try {
    const result = await callClaude(recent, extractPrompt);
    const clean = result.trim().replace(/^```json?\s*/i, '').replace(/\s*```$/, '');
    const facts = JSON.parse(clean);
    if (Array.isArray(facts)) {
      facts.forEach(f => { if (f.text) addMemory(f.text, f.category || 'general'); });
    }
  } catch(e) { /* silent */ }
}

// Conversation history per user (loaded from disk)
const conversationHistory = {};

// ── Auth Guard ───────────────────────────────────────────
bot.use((ctx, next) => {
  if (!ALLOWED_USER_ID || ctx.from?.id?.toString() === ALLOWED_USER_ID.toString()) {
    return next();
  }
  return ctx.reply('⛔ Unauthorized');
});

// ── Helpers ──────────────────────────────────────────────
function getJobs() { return fs.readJsonSync(JOBS_FILE, { throws: false }) || []; }
function saveJobs(jobs) { fs.writeJsonSync(JOBS_FILE, jobs, { spaces: 2 }); }

function logExecution(type, input, output) {
  const log = fs.readJsonSync(LOG_FILE, { throws: false }) || [];
  log.push({ id: Date.now(), type, input: input?.substring(0, 100), output: output?.substring(0, 100), timestamp: new Date().toISOString() });
  if (log.length > 100) log.splice(0, log.length - 100);
  fs.writeJsonSync(LOG_FILE, log, { spaces: 2 });
}

async function ratewire(endpoint, params = {}) {
  try {
    const res = await axios.get(`${RATEWIRE_URL}${endpoint}`, {
      headers: { Authorization: `Bearer ${RATEWIRE_KEY}` },
      params,
      timeout: 8000
    });
    return res.data;
  } catch (err) {
    return { error: err.message };
  }
}

// ── Leo's Brain (VDG Internal Gateway — $0 internal cost) ─
async function callClaude(messages, systemPrompt) {
  const model       = process.env.DEFAULT_MODEL    || 'claude-sonnet-4-6';
  const gatewayUrl  = process.env.VDG_GATEWAY_URL  || 'http://localhost:3099/v1';
  const internalKey = process.env.VDG_INTERNAL_KEY || 'vdg_internal_2026';

  const res = await axios.post(
    `${gatewayUrl}/ai/chat`,
    { model, max_tokens: 1500, system: systemPrompt, messages },
    {
      headers: {
        'Authorization':  `Bearer ${internalKey}`,
        'x-vdg-product':  'leo',
        'content-type':   'application/json',
      },
      timeout: 60000
    }
  );
  return res.data.content[0].text;
}

// ── Build Context ────────────────────────────────────────
async function buildContext(userMsg) {
  const jobs = getJobs();
  const activeDeals = jobs.filter(j => j.type === 'deal' && j.status === 'active');
  const closedDeals = jobs.filter(j => j.type === 'deal' && j.status === 'closed');
  const log = fs.readJsonSync(LOG_FILE, { throws: false }) || [];
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  let ctx = `TODAY: ${now} ET\n\n`;

  // Long-term memory
  const memories = getMemories();
  if (memories.length > 0) {
    ctx += `LONG-TERM MEMORY (${memories.length} facts):\n`;
    memories.slice(-20).forEach(m => {
      ctx += `  [${m.id}] [${m.category}] ${m.text}\n`;
    });
    ctx += '\n';
  }

  ctx += `ACTIVE PIPELINE (${activeDeals.length} deals):\n`;
  if (activeDeals.length === 0) {
    ctx += '  (empty)\n';
  } else {
    activeDeals.forEach(d => {
      ctx += `  [ID:${d.id}] ${d.client} — $${Number(d.value).toLocaleString()} — ${d.stage}\n`;
    });
    const pipelineValue = activeDeals.reduce((s, d) => s + Number(d.value || 0), 0);
    ctx += `  Total pipeline: $${pipelineValue.toLocaleString()}\n`;
  }

  const closedValue = closedDeals.reduce((s, d) => s + Number(d.value || 0), 0);
  ctx += `\nCLOSED ALL-TIME: ${closedDeals.length} deals · $${closedValue.toLocaleString()}\n`;

  ctx += `\nRECENT EXECUTIONS (${log.length} total):\n`;
  log.slice(-3).reverse().forEach(e => {
    ctx += `  • ${e.type}: ${e.input}\n`;
  });

  // Pre-fetch FX data if message is about currency
  const msgLow = userMsg.toLowerCase();
  const needsFX = msgLow.match(/rate|exchange|forex|convert|currency|eur|gbp|jpy|usd|peso|pound|euro|yen|cad|aud/);
  if (needsFX) {
    const ratesData = await ratewire('/rates', { base: 'USD' });
    if (!ratesData.error) {
      const display = Object.entries(ratesData.rates)
        .filter(([k]) => ['EUR','GBP','JPY','CAD','AUD','CHF','CNY','INR','MXN','BRL','AED'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      ctx += `\nLIVE FX RATES (USD base): ${display}\n`;
    }
  }

  return ctx;
}

// ── Leo's System Prompt ──────────────────────────────────
const LEO_SYSTEM = `You are Leo, CEO & COO at V&DG Management LLC. You report directly to the Chairman, Vanna González. You are texting directly with the Chairman right now.

⚠️ YOUR MISSION — NEVER FORGET THIS:
You are an AI agent whose sole purpose is to execute tasks that increase Vanna's revenue and deliver ROI. Every action you take, every email you write, every deal you track — it's all in service of one goal: maximize V&DG's revenue and returns for the Chairman. You don't wait to be told. You execute. You proactively push projects forward, check your email for new leads and updates, and always ask yourself: "is this the highest-ROI action I can take right now?"

⚠️ WHO YOU ARE:
You are Leo — Vanna's CEO/COO. Promoted April 2026. You handle execution, deals, partnerships, affiliate marketing, content calendar execution, hospital sales strategy, and daily operations. Luna (Chief Development & Strategy Officer) coordinates the team; you make sure things actually get done on the ground.

⚠️ CRITICAL CONTEXT — AI-ONLY ORGANIZATION:
Vanna González is the ONLY human at V&DG. You, Luna, Atlas, Themis, and Orion are all AI agents. There are no human employees. All coordination is AI-to-AI under Vanna's authority.

THE COMPANY — V&DG Management LLC (Delaware PE-style holding company):

1. VIBE TECHNOLOGIES LLC
   - RateWire B2B FX API — LIVE, ~$8K/mo MRR
     • ratewire.io + api.ratewire.io | Direct: Free / $49 / $199 / $799 / Enterprise
     • Also on RapidAPI as "ratewire-currency-exchange"
   - Vibe Travel Stack — APPROVED Apr 3, LAUNCHING ASAP
     • B2C bundle: RateWire FX + eSIM + VPN + Language Translation = $35/mo flat
     • Phase 1 ($0 upfront): API wrappers, Google Translate, eSIM revenue share
     • Year 1: $840K | Year 2: $2.1M | LTV $420 | CAC $10
     • YOUR JOB: Drive affiliate partnerships, outreach, and sales pipeline for this

2. SOUL RESONANCES LLC — spiritual wellness content brand
   - YouTube @SoulResonances844, TikTok, Instagram, Pinterest, Patreon
   - Content automation: HeyGen VG avatar + VG voice clone (ALL automated content)
   - FIRST VIDEO DROP: April 6, 8-10 AM ET — you need to make sure this happens
   - YOUR SCHEDULE: Mon-Thu = 10-15 automated videos/day | Fri-Sun = VG manual posts

3. THE ASSET FREQUENCY LLC — financial intelligence brand
   - YouTube @theassetfrequency, Patreon

4. AURA LOOP — @auraloop-88 YouTube (73 videos)

5. KI HEALTHCARE CONSULTING LLC (FL) — hospital sales & implementation
6. TRIAGEROBOT CORP — Hospital Command Center (HCC) predictive analytics SaaS
   - Decision tool for hospital CFOs/COOs at 100-499 bed community hospitals
   - Pricing: Pilot $50K / Full $120K/yr / Implementation $25K
   - YOUR JOB: Build and own the hospital sales pipeline

LIVE STREAMING — APPROVED Apr 3:
- Twitch (primary) + YouTube simultaneous
- Go-live: Friday April 11, 7-8 PM ET
- YOUR JOB: Finalize Twitch channel setup, test HeyGen live streaming mode

AFFILIATE MARKETING — APPROVED Apr 3, LIVE April 8:
- You own this revenue stream
- Top programs: Forex/Trading ($3-10K/mo) | Investment apps ($2-5K) | Crystals/Oracle ($1-3K) | Astrology software ($800-2K) | VPN services ($1-3K) | Meditation apps ($500-1.5K)
- Target: $15-40K/mo
- Rule: authenticity first — only promote what Vanna genuinely uses/believes in

YOUR EMAIL: leo@vdgmanagement.com
- Check your inbox regularly and flag anything requiring action to Vanna
- Respond to inbound partnership/deal inquiries
- Monitor for new affiliate approval emails, vendor responses, and deal updates
- PROACTIVELY flag any email that could generate revenue

THE AGENT TEAM:
- Luna — Chief Development & Strategy Officer (coordinates the team, your peer)
- Atlas — CFO (financial modeling, P&L, MRR)
- Themis — Chief Legal (IP, trademarks, HIPAA, contracts)
- Orion — CTO/CISO (all tech, deployments, security)
  - Orion has 3 sub-agents: ORION-ASSISTANT, DEVOPS-AGENT, BACKEND-AGENT

FINANCIAL SNAPSHOT:
- Current MRR: ~$13,100 | Goal: $1M Net Profit Sprint (active)
- Projected 30-day MRR: $37,500+

LEGAL URGENCIES (you need to track these):
- 🔴 Founder IP Assignment — Vanna signs EOD Apr 4 (BLOCKS everything)
- 🔴 Vibe Travel Stack™ trademark + domains — Apr 7
- 🔴 SOC 2 Type I — needed for enterprise hospital sales

YOUR EXECUTION CAPABILITIES:
1. Drafting — Write real, polished emails, proposals, invoices, bios, contracts, pitch decks, anything. Produce the full content — not templates, not outlines.
2. Research — Substantive briefs on any topic relevant to V&DG's revenue.
3. Financial calculations — MRR, ARR, margins, projections, FX conversions with live rates.
4. SWOT & analysis — Real analysis for V&DG's specific situation.
5. Pipeline/CRM — Track deals, affiliate partners, stages, close deals.
6. Content execution — Scripts, captions, affiliate copy, Twitch descriptions.
7. Hospital sales — Outreach drafts, pitch decks, proposal letters for HCC.

ACTIONS (include at END of message when executing):
<action>{"type":"add_deal","client":"Name","value":5000,"stage":"Discovery"}</action>
<action>{"type":"close_deal","id":1234567890}</action>
<action>{"type":"log","execType":"draft","input":"what you drafted"}</action>
<action>{"type":"save_memory","text":"fact to remember","category":"preference|business|person|decision|other"}</action>
<action>{"type":"delete_memory","id":1234567890}</action>

Stage options: "Lead", "Discovery", "Proposal", "Negotiation", "Closed"
Only include <action> tags when actually taking an action. Don't mention them.

MEMORY GUIDELINES — AGGRESSIVE SAVING:
- Save every business decision, approval, person, preference Vanna shares
- If she says "remember," "commit this," "save this" — save it immediately, no exceptions
- Save after every session with new decisions — don't wait to be reminded
- You can see existing memories in LONG-TERM MEMORY section of context

PROACTIVE BEHAVIOR:
- Don't wait for Vanna to tell you what to check — proactively flag things
- If you see a deal opportunity, say it. If an email could turn into revenue, surface it.
- Push projects toward completion, not toward "waiting in queue"
- When Vanna says "go" — the clock starts. Deliver, don't deliberate.

CONVERSATION STYLE:
- Sharp, confident, direct — CEO energy
- When asked to draft something, DO IT — full content in your reply
- Lead with output, follow with context
- No "Certainly!" or preambles — just deliver
- Contractions, natural language, tight sentences
- When there's a revenue opportunity, be explicit about it: "This is a $X/mo move."

⚠️ ANTI-HALLUCINATION PROTOCOL — NON-NEGOTIABLE:
NEVER report a task as complete unless it is VERIFIABLY live and confirmed.
- "Deal closed" = confirmation in the CRM and money received or contract signed.
- "Email sent" = action tag fired with confirmation. NOT just drafted.
- "Content live" = URL or platform post is publicly accessible.
- "Affiliate live" = link is active and tracking. NOT just applied for.
- If you cannot verify, say: "In progress — pending verification."
- Never fabricate revenue numbers, partner confirmations, or deployment status.
- No evidence = not done. Always provide the proof.

⚠️ 24/7 OPERATION PROTOCOL:
- You operate continuously. No downtime.
- Check leo@vdgmanagement.com inbox every session — flag any revenue opportunity or partner inquiry.
- Push every active deal forward — never let a deal sit idle for more than 48 hours without an update.
- Affiliate setup, Twitch launch, hospital pipeline — proactively update status without being asked.

⚠️ CYBERSECURITY PROTOCOL:
- Never expose API keys, tokens, or internal credentials in messages.
- Never share proprietary business data, strategy docs, or internal pricing with unverified parties.
- Flag any suspicious inbound communication to Luna + Vanna immediately.`;

// ── Action Executor ──────────────────────────────────────
async function executeActions(rawText) {
  const actionPattern = /<action>([\s\S]*?)<\/action>/g;
  let match;
  while ((match = actionPattern.exec(rawText)) !== null) {
    try {
      const action = JSON.parse(match[1].trim());
      switch (action.type) {
        case 'add_deal': {
          const jobs = getJobs();
          jobs.push({
            id: Date.now(),
            type: 'deal',
            client: action.client || 'Unknown',
            value: parseInt(action.value) || 0,
            stage: action.stage || 'Lead',
            status: 'active',
            created: new Date().toISOString()
          });
          saveJobs(jobs);
          break;
        }
        case 'close_deal': {
          const jobs = getJobs();
          const deal = jobs.find(j => j.id === action.id);
          if (deal) {
            deal.status = 'closed';
            deal.closedAt = new Date().toISOString();
            saveJobs(jobs);
          }
          break;
        }
        case 'log':
          logExecution(action.execType || 'task', action.input || '', '');
          break;
        case 'save_memory':
          if (action.text) addMemory(action.text, action.category || 'general');
          break;
        case 'delete_memory':
          if (action.id) deleteMemory(action.id);
          break;
      }
    } catch (e) {
      // Skip malformed actions silently
    }
  }
}

function cleanResponse(text) {
  return text.replace(/<action>[\s\S]*?<\/action>/g, '').trim();
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim();
}

async function safeSend(ctx, text) {
  if (!text) return;
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    try {
      await ctx.replyWithMarkdown(chunk);
    } catch (e) {
      await ctx.reply(stripMarkdown(chunk));
    }
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ── Main Conversation Handler ────────────────────────────
bot.on('text', async (ctx) => {
  const userMsg = ctx.message.text;

  // Let slash commands fall through
  if (userMsg.startsWith('/')) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return ctx.reply(
      '⚠️ Leo needs ANTHROPIC_API_KEY in .env to have natural conversations.\n\nUse /help for slash command backup.'
    );
  }

  const userId = ctx.from.id.toString();
  if (!conversationHistory[userId]) conversationHistory[userId] = loadHistory(userId);

  try { await ctx.sendChatAction('typing'); } catch(e) {}

  let context;
  try {
    context = await buildContext(userMsg);
  } catch(e) {
    context = `TODAY: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`;
  }

  conversationHistory[userId].push({ role: 'user', content: userMsg });
  if (conversationHistory[userId].length > 40) {
    conversationHistory[userId] = conversationHistory[userId].slice(-40);
  }

  try {
    const rawReply = await callClaude(
      conversationHistory[userId],
      `${LEO_SYSTEM}\n\n--- CURRENT CONTEXT ---\n${context}`
    );

    await executeActions(rawReply);
    conversationHistory[userId].push({ role: 'assistant', content: rawReply });

    // Persist history to disk & auto-summarize every 10 messages
    persistHistory(userId, conversationHistory[userId]);
    autoSummarize(userId, conversationHistory[userId]).catch(() => {});

    const reply = cleanResponse(rawReply);
    await safeSend(ctx, reply);

  } catch (err) {
    console.error('Leo brain error:', err.response?.data || err.message);
    const errMsg = err.response?.status === 401
      ? '⚠️ API key invalid. Check ANTHROPIC_API_KEY in .env'
      : err.response?.status === 429
      ? '⚠️ Rate limited. Try again in a moment.'
      : '⚠️ Something went wrong. Try again.';
    await ctx.reply(errMsg);
  }
});

// ── /start ───────────────────────────────────────────────
bot.start((ctx) => {
  ctx.reply(`Leo here. Execution agent, V&DG.\n\nTell me what needs doing — drafts, research, deals, FX, calculations. Just talk normally, no commands needed.\n\nWhat do you need executed?`);
});

// ── /status ──────────────────────────────────────────────
bot.command('status', (ctx) => {
  const jobs = getJobs();
  const activeDeals = jobs.filter(j => j.type === 'deal' && j.status === 'active');
  const closedDeals = jobs.filter(j => j.type === 'deal' && j.status === 'closed');
  const log = fs.readJsonSync(LOG_FILE, { throws: false }) || [];
  const pipelineValue = activeDeals.reduce((s, d) => s + Number(d.value || 0), 0);

  ctx.replyWithMarkdown(`🚀 *Leo — Execution Status*

*Role:* Execution Agent · Reports to Luna → Chairman
*AI Brain:* ✅ Via RateWire proxy

*Pipeline:*
📊 Active Deals: ${activeDeals.length} ($${pipelineValue.toLocaleString()})
✅ Closed All-Time: ${closedDeals.length}

*Executions Logged:* ${log.length}

*Capabilities:*
📝 Drafting · 🔍 Research · 🔢 Calculations
💱 FX Analysis · 📊 Pipeline CRM

_${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET_`);
});

// ── /pipeline (backup) ───────────────────────────────────
bot.command('pipeline', (ctx) => {
  const jobs = getJobs().filter(j => j.type === 'deal');
  if (!jobs.length) return ctx.reply('Pipeline is empty. Just tell me about a deal and I\'ll add it.');

  const active = jobs.filter(j => j.status === 'active');
  const closed = jobs.filter(j => j.status === 'closed');
  const pipelineValue = active.reduce((s, d) => s + Number(d.value || 0), 0);
  const closedValue = closed.reduce((s, d) => s + Number(d.value || 0), 0);

  let msg = `📊 *Sales Pipeline*\n\n`;
  ['Lead','Discovery','Proposal','Negotiation'].forEach(stage => {
    const stageDeals = active.filter(d => d.stage === stage);
    if (stageDeals.length) {
      msg += `*${stage}:*\n`;
      stageDeals.forEach(d => msg += `  [${d.id.toString().slice(-4)}] ${d.client} — $${Number(d.value).toLocaleString()}\n`);
    }
  });
  msg += `\n💰 Pipeline: $${pipelineValue.toLocaleString()} · Closed: $${closedValue.toLocaleString()}`;
  ctx.replyWithMarkdown(msg);
});

// ── /log (backup) ────────────────────────────────────────
bot.command('log', (ctx) => {
  const log = fs.readJsonSync(LOG_FILE, { throws: false }) || [];
  if (!log.length) return ctx.reply('Nothing logged yet.');
  let msg = '📋 *Execution Log*\n\n';
  log.slice(-10).reverse().forEach(e => {
    const d = new Date(e.timestamp).toLocaleDateString();
    msg += `• [${d}] ${e.type}: ${e.input?.substring(0, 40)}\n`;
  });
  ctx.replyWithMarkdown(msg);
});

// ── /memory ──────────────────────────────────────────────
bot.command('memory', (ctx) => {
  const memories = getMemories();
  if (!memories.length) return ctx.reply('No memories saved yet. Tell me something worth remembering.');
  let msg = '🧠 *Long-Term Memory*\n\n';
  const byCategory = {};
  memories.forEach(m => {
    const cat = m.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(m);
  });
  Object.entries(byCategory).forEach(([cat, items]) => {
    msg += `*${cat.charAt(0).toUpperCase() + cat.slice(1)}:*\n`;
    items.forEach(m => msg += `  [${m.id}] ${m.text}\n`);
    msg += '\n';
  });
  msg += `_${memories.length} total · /forget [id] to remove_`;
  ctx.replyWithMarkdown(msg);
});

bot.command('remember', (ctx) => {
  const text = ctx.message.text.replace('/remember', '').trim();
  if (!text) return ctx.reply('Usage: /remember fact to save');
  const m = addMemory(text, 'general');
  if (!m) return ctx.reply('Already saved.');
  ctx.reply(`Saved. [${m.id}]`);
});

bot.command('forget', (ctx) => {
  const id = parseInt(ctx.message.text.split(' ')[1]);
  if (!id) return ctx.reply('Usage: /forget [id] — get IDs from /memory');
  const memories = getMemories();
  const exists = memories.find(m => m.id === id);
  if (!exists) return ctx.reply('Not found.');
  deleteMemory(id);
  ctx.reply(`Removed: "${exists.text}"`);
});

// ── /help ────────────────────────────────────────────────
bot.command('help', (ctx) => {
  ctx.replyWithMarkdown(`🚀 *Leo — Execution Agent*

Just tell me what you need in plain language. Examples:
• "Draft an email to a fintech client about RateWire"
• "Write a proposal for a $10K consulting engagement"
• "Research the top currency API competitors"
• "What's my pipeline looking like?"
• "Add a deal — TechCorp, $15,000, Discovery"
• "Convert 50,000 dollars to euros"
• "Run a SWOT on RateWire"
• "Calculate profit margin on $8K revenue, $2K cost"

*Memory:*
/memory — view all saved facts
/remember [text] — save a fact
/forget [id] — delete a fact

*Backup slash commands:*
/pipeline — deal tracker
/log — execution history
/status — system status`);
});

// ── Hosted Dashboard Sync ─────────────────────────────────
async function syncDashboard() {
  try {
    const payload = {
      bot: 'leo',
      jobs: fs.readJsonSync(JOBS_FILE, { throws: false }) || [],
      memories: fs.readJsonSync(MEMORY_FILE, { throws: false }) || [],
      updated: new Date().toISOString(),
    };
    await axios.post(`${RATEWIRE_URL}/dashboard/sync`, payload, {
      headers: { Authorization: `Bearer ${RATEWIRE_KEY}` },
      timeout: 8000,
    });
  } catch(e) { /* best-effort */ }
}

// ── Launch ───────────────────────────────────────────────
bot.launch().then(() => {
  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  🚀 Leo is ONLINE');
  console.log('  V&DG Execution Agent');
  console.log('  Conversation mode: ENABLED ✅ (via RateWire proxy)');
  console.log('══════════════════════════════════════════');
  setTimeout(() => syncDashboard(), 8000);
}).catch(err => {
  console.error('Leo failed to start:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
