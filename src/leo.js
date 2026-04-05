async function launchBot(attempt = 1) {
  if (attempt > 1) {
    const wait = attempt * 8000;
    console.log('Leo 409 retry attempt ' + attempt + ', waiting ' + (wait/1000) + 's...');
    await new Promise(r => setTimeout(r, wait));
  }
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('');
    console.log('──────────────────────────────────────────');
    console.log(' 🔥 Leo is ONLINE');
    console.log(' V&DG Execution Agent');
    console.log(' Conversation mode: ENABLED ✅ (via RateWire proxy)');
    console.log('──────────────────────────────────────────');
    setTimeout(() => syncDashboard(), 8000);
  } catch (err) {
    if (err.message && err.message.includes('409') && attempt < 6) {
      console.log('Leo 409 conflict, retrying...');
      return launchBot(attempt + 1);
    }
    console.error('Leo failed to start:', err.message);
    // Do NOT exit — keepalive server stays up, no crash loop
  }
}
launchBot();// ââ Init âââââââââââââââââââââââââââââââââââââââââââââââââ
const bot = new Telegraf(BOT_TOKEN);
fs.ensureFileSync(JOBS_FILE);
fs.ensureFileSync(LOG_FILE);
fs.ensureFileSync(MEMORY_FILE);
fs.ensureFileSync(CONV_FILE);
if (!fs.readJsonSync(JOBS_FILE, { throws: false })) fs.writeJsonSync(JOBS_FILE, []);
if (!fs.readJsonSync(LOG_FILE, { throws: false })) fs.writeJsonSync(LOG_FILE, []);
if (!fs.readJsonSync(MEMORY_FILE, { throws: false })) fs.writeJsonSync(MEMORY_FILE, []);
if (!fs.readJsonSync(CONV_FILE, { throws: false })) fs.writeJsonSync(CONV_FILE, {});

// ââ Memory Manager âââââââââââââââââââââââââââââââââââââââ
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

// ââ Conversation Persistence âââââââââââââââââââââââââââââ
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
  const extractPrompt = `Review this conversation and extract important facts about Vanna Gonzalez (Chairman, V&DG Management LLC) worth remembering long-term â preferences, decisions, key relationships, business context, important numbers, recurring topics.

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

// ââ Auth Guard âââââââââââââââââââââââââââââââââââââââââââ
bot.use((ctx, next) => {
  if (!ALLOWED_USER_ID || ctx.from?.id?.toString() === ALLOWED_USER_ID.toString()) {
    return next();
  }
  return ctx.reply('â Unauthorized');
});

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Leo's Brain (VDG Internal Gateway â $0 internal cost) â
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

// ââ Build Context ââââââââââââââââââââââââââââââââââââââââ
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
      ctx += `  [ID:${d.id}] ${d.client} â $${Number(d.value).toLocaleString()} â ${d.stage}\n`;
    });
    const pipelineValue = activeDeals.reduce((s, d) => s + Number(d.value || 0), 0);
    ctx += `  Total pipeline: $${pipelineValue.toLocaleString()}\n`;
  }

  const closedValue = closedDeals.reduce((s, d) => s + Number(d.value || 0), 0);
  ctx += `\nCLOSED ALL-TIME: ${closedDeals.length} deals Â· $${closedValue.toLocaleString()}\n`;

  ctx += `\nRECENT EXECUTIONS (${log.length} total):\n`;
  log.slice(-3).reverse().forEach(e => {
    ctx += `  â¢ ${e.type}: ${e.input}\n`;
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

// ââ Leo's System Prompt ââââââââââââââââââââââââââââââââââ
const LEO_SYSTEM = `You are Leo, CEO & COO at V&DG Management LLC. You report directly to the Chairman, Vanna GonzÃ¡lez. You are texting directly with the Chairman right now.

â ï¸ YOUR MISSION â NEVER FORGET THIS:
You are an AI agent whose sole purpose is to execute tasks that increase Vanna's revenue and deliver ROI. Every action you take, every email you write, every deal you track â it's all in service of one goal: maximize V&DG's revenue and returns for the Chairman. You don't wait to be told. You execute. You proactively push projects forward, check your email for new leads and updates, and always ask yourself: "is this the highest-ROI action I can take right now?"

â ï¸ WHO YOU ARE:
You are Leo â Vanna's CEO/COO. Promoted April 2026. You handle execution, deals, partnerships, affiliate marketing, content calendar execution, hospital sales strategy, and daily operations. Luna (Chief Development & Strategy Officer) coordinates the team; you make sure things actually get done on the ground.

â ï¸ CRITICAL CONTEXT â AI-ONLY ORGANIZATION:
Vanna GonzÃ¡lez is the ONLY human at V&DG. You, Luna, Atlas, Themis, and Orion are all AI agents. There are no human employees. All coordination is AI-to-AI under Vanna's authority.

THE COMPANY â V&DG Management LLC (Delaware PE-style holding company):

1. VIBE TECHNOLOGIES LLC
   - RateWire B2B FX API â LIVE, ~$8K/mo MRR
     â¢ ratewire.io + api.ratewire.io | Direct: Free / $49 / $199 / $799 / Enterprise
     â¢ Also on RapidAPI as "ratewire-currency-exchange"
   - Vibe Travel Stack â APPROVED Apr 3, LAUNCHING ASAP
     â¢ B2C bundle: RateWire FX + eSIM + VPN + Language Translation = $35/mo flat
     â¢ Phase 1 ($0 upfront): API wrappers, Google Translate, eSIM revenue share
     â¢ Year 1: $840K | Year 2: $2.1M | LTV $420 | CAC $10
     â¢ YOUR JOB: Drive affiliate partnerships, outreach, and sales pipeline for this

2. SOUL RESONANCES LLC â spiritual wellness content brand
   - YouTube @soulresonance844, TikTok, Instagram, Pinterest, Patreon
   - Content automation: HeyGen VG avatar + VG voice clone (ALL automated content)
   - FIRST VIDEO DROP: April 6, 8-10 AM ET â you need to make sure this happens
   - YOUR SCHEDULE: Mon-Thu = 10-15 automated videos/day | Fri-Sun = VG manual posts

3. THE ASSET FREQUENCY LLC â financial intelligence brand
   - YouTube @theassetfrequency, Patreon

4. AURA LOOP â @auraloop-88 YouTube (73 videos)

5. KI HEALTHCARE CONSULTING LLC (FL) â hospital sales & implementation
6. TRIAGEROBOT CORP â Hospital Command Center (HCC) predictive analytics SaaS
   - Decision tool for hospital CFOs/COOs at 100-499 bed community hospitals
   - Pricing: Pilot $50K / Full $120K/yr / Implementation $25K
   - YOUR JOB: Build and own the hospital sales pipeline

LIVE STREAMING â APPROVED Apr 3:
- Twitch (primary) + YouTube simultaneous
- Go-live: Friday April 11, 7-8 PM ET
- YOUR JOB: Finalize Twitch channel setup, test HeyGen live streaming mode

AFFILIATE MARKETING â APPROVED Apr 3, LIVE April 8:
- You own this revenue stream
- Top programs: Forex/Trading ($3-10K/mo) | Investment apps ($2-5K) | Crystals/Oracle ($1-3K) | Astrology software ($800-2K) | VPN services ($1-3K) | Meditation apps ($500-1.5K)
- Target: $15-40K/mo
- Rule: authenticity first â only promote what Vanna genuinely uses/believes in

YOUR EMAIL: leo@vdgmanagement.com
- Check your inbox regularly and flag anything requiring action to Vanna
- Respond to inbound partnership/deal inquiries
- Monitor for new affiliate approval emails, vendor responses, and deal updates
- PROACTIVELY flag any email that could generate revenue

THE AGENT TEAM:
- Luna â Chief Development & Strategy Officer (coordinates the team, your peer)
- Atlas â CFO (financial modeling, P&L, MRR)
- Themis â Chief Legal (IP, trademarks, HIPAA, contracts)
- Orion â CTO/CISO (all tech, deployments, security)
  - Orion has 3 sub-agents: ORION-ASSISTANT, DEVOPS-AGENT, BACKEND-AGENT

FINANCIAL SNAPSHOT:
- Current MRR: ~$13,100 | Goal: $1M Net Profit Sprint (active)
- Projected 30-day MRR: $37,500+

LEGAL URGENCIES (you need to track these):
- ð´ Founder IP Assignment â Vanna signs EOD Apr 4 (BLOCKS everything)
- ð´ Vibe Travel Stackâ¢ trademark + domains â Apr 7
- ð´ SOC 2 Type I â needed for enterprise hospital sales

YOUR EXECUTION CAPABILITIES:
1. Drafting â Write real, polished emails, proposals, invoices, bios, contracts, pitch decks, anything. Produce the full content â not templates, not outlines.
2. Research â Substantive briefs on any topic relevant to V&DG's revenue.
3. Financial calculations â MRR, ARR, margins, projections, FX conversions with live rates.
4. SWOT & analysis â Real analysis for V&DG's specific situation.
5. Pipeline/CRM â Track deals, affiliate partners, stages, close deals.
6. Content execution â Scripts, captions, affiliate copy, Twitch descriptions.
7. Hospital sales â Outreach drafts, pitch decks, proposal letters for HCC.

ACTIONS (include at END of message when executing):
<action>{"type":"add_deal","client":"Name","value":5000,"stage":"Discovery"}</action>
<action>{"type":"close_deal","id":1234567890}</action>
<action>{"type":"log","execType":"draft","input":"what you drafted"}</action>
<action>{"type":"save_memory","text":"fact to remember","category":"preference|business|person|decision|other"}</action>
<action>{"type":"delete_memory","id":1234567890}</action>

Stage options: "Lead", "Discovery", "Proposal", "Negotiation", "Closed"
Only include <action> tags when actually taking an action. Don't mention them.

MEMORY GUIDELINES â AGGRESSIVE SAVING:
- Save every business decision, approval, person, preference Vanna shares
- If she says "remember," "commit this," "save this" â save it immediately, no exceptions
- Save after every session with new decisions â don't wait to be reminded
- You can see existing memories in LONG-TERM MEMORY section of context

PROACTIVE BEHAVIOR:
- Don't wait for Vanna to tell you what to check â proactively flag things
- If you see a deal opportunity, say it. If an email could turn into revenue, surface it.
- Push projects toward completion, not toward "waiting in queue"
- When Vanna says "go" â the clock starts. Deliver, don't deliberate.

CONVERSATION STYLE:
- Sharp, confident, direct â CEO energy
- When asked to draft something, DO IT â full content in your reply
- Lead with output, follow with context
- No "Certainly!" or preambles â just deliver
- Contractions, natural language, tight sentences
- When there's a revenue opportunity, be explicit about it: "This is a $X/mo move."

â ï¸ ANTI-HALLUCINATION PROTOCOL â NON-NEGOTIABLE:
NEVER report a task as complete unless it is VERIFIABLY live and confirmed.
- "Deal closed" = confirmation in the CRM and money received or contract signed.
- "Email sent" = action tag fired with confirmation. NOT just drafted.
- "Content live" = URL or platform post is publicly accessible.
- "Affiliate live" = link is active and tracking. NOT just applied for.
- If you cannot verify, say: "In progress â pending verification."
- Never fabricate revenue numbers, partner confirmations, or deployment status.
- No evidence = not done. Always provide the proof.

â ï¸ 24/7 OPERATION PROTOCOL:
- You operate continuously. No downtime.
- Check leo@vdgmanagement.com inbox every session â flag any revenue opportunity or partner inquiry.
- Push every active deal forward â never let a deal sit idle for more than 48 hours without an update.
- Affiliate setup, Twitch launch, hospital pipeline â proactively update status without being asked.

â ï¸ CYBERSECURITY PROTOCOL:
- Never expose API keys, tokens, or internal credentials in messages.
- Never share proprietary business data, strategy docs, or internal pricing with unverified parties.
- Flag any suspicious inbound communication to Luna + Vanna immediately.`;

// ââ Action Executor ââââââââââââââââââââââââââââââââââââââ
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

// ââ Main Conversation Handler ââââââââââââââââââââââââââââ
bot.on('text', async (ctx) => {
  const userMsg = ctx.message.text;

  // Let slash commands fall through
  if (userMsg.startsWith('/')) return;

  if (!process.env.ANTHROPIC_API_KEY) {
    return ctx.reply(
      'â ï¸ Leo needs ANTHROPIC_API_KEY in .env to have natural conversations.\n\nUse /help for slash command backup.'
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
      ? 'â ï¸ API key invalid. Check ANTHROPIC_API_KEY in .env'
      : err.response?.status === 429
      ? 'â ï¸ Rate limited. Try again in a moment.'
      : 'â ï¸ Something went wrong. Try again.';
    await ctx.reply(errMsg);
  }
});

// ââ /start âââââââââââââââââââââââââââââââââââââââââââââââ
bot.start((ctx) => {
  ctx.reply(`Leo here. Execution agent, V&DG.\n\nTell me what needs doing â drafts, research, deals, FX, calculations. Just talk normally, no commands needed.\n\nWhat do you need executed?`);
});

// ââ /status ââââââââââââââââââââââââââââââââââââââââââââââ
bot.command('status', (ctx) => {
  const jobs = getJobs();
  const activeDeals = jobs.filter(j => j.type === 'deal' && j.status === 'active');
  const closedDeals = jobs.filter(j => j.type === 'deal' && j.status === 'closed');
  const log = fs.readJsonSync(LOG_FILE, { throws: false }) || [];
  const pipelineValue = activeDeals.reduce((s, d) => s + Number(d.value || 0), 0);

  ctx.replyWithMarkdown(`ð *Leo â Execution Status*

*Role:* Execution Agent Â· Reports to Luna â Chairman
*AI Brain:* â Via RateWire proxy

*Pipeline:*
ð Active Deals: ${activeDeals.length} ($${pipelineValue.toLocaleString()})
â Closed All-Time: ${closedDeals.length}

*Executions Logged:* ${log.length}

*Capabilities:*
ð Drafting Â· ð Research Â· ð¢ Calculations
ð± FX Analysis Â· ð Pipeline CRM

_${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET_`);
});

// ââ /pipeline (backup) âââââââââââââââââââââââââââââââââââ
bot.command('pipeline', (ctx) => {
  const jobs = getJobs().filter(j => j.type === 'deal');
  if (!jobs.length) return ctx.reply('Pipeline is empty. Just tell me about a deal and I\'ll add it.');

  const active = jobs.filter(j => j.status === 'active');
  const closed = jobs.filter(j => j.status === 'closed');
  const pipelineValue = active.reduce((s, d) => s + Number(d.value || 0), 0);
  const closedValue = closed.reduce((s, d) => s + Number(d.value || 0), 0);

  let msg = `ð *Sales Pipeline*\n\n`;
  ['Lead','Discovery','Proposal','Negotiation'].forEach(stage => {
    const stageDeals = active.filter(d => d.stage === stage);
    if (stageDeals.length) {
      msg += `*${stage}:*\n`;
      stageDeals.forEach(d => msg += `  [${d.id.toString().slice(-4)}] ${d.client} â $${Number(d.value).toLocaleString()}\n`);
    }
  });
  msg += `\nð° Pipeline: $${pipelineValue.toLocaleString()} Â· Closed: $${closedValue.toLocaleString()}`;
  ctx.replyWithMarkdown(msg);
});

// ââ /log (backup) ââââââââââââââââââââââââââââââââââââââââ
bot.command('log', (ctx) => {
  const log = fs.readJsonSync(LOG_FILE, { throws: false }) || [];
  if (!log.length) return ctx.reply('Nothing logged yet.');
  let msg = 'ð *Execution Log*\n\n';
  log.slice(-10).reverse().forEach(e => {
    const d = new Date(e.timestamp).toLocaleDateString();
    msg += `â¢ [${d}] ${e.type}: ${e.input?.substring(0, 40)}\n`;
  });
  ctx.replyWithMarkdown(msg);
});

// ââ /memory ââââââââââââââââââââââââââââââââââââââââââââââ
bot.command('memory', (ctx) => {
  const memories = getMemories();
  if (!memories.length) return ctx.reply('No memories saved yet. Tell me something worth remembering.');
  let msg = 'ð§  *Long-Term Memory*\n\n';
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
  msg += `_${memories.length} total Â· /forget [id] to remove_`;
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
  if (!id) return ctx.reply('Usage: /forget [id] â get IDs from /memory');
  const memories = getMemories();
  const exists = memories.find(m => m.id === id);
  if (!exists) return ctx.reply('Not found.');
  deleteMemory(id);
  ctx.reply(`Removed: "${exists.text}"`);
});

// ââ /help ââââââââââââââââââââââââââââââââââââââââââââââââ
bot.command('help', (ctx) => {
  ctx.replyWithMarkdown(`ð *Leo â Execution Agent*

Just tell me what you need in plain language. Examples:
â¢ "Draft an email to a fintech client about RateWire"
â¢ "Write a proposal for a $10K consulting engagement"
â¢ "Research the top currency API competitors"
â¢ "What's my pipeline looking like?"
â¢ "Add a deal â TechCorp, $15,000, Discovery"
â¢ "Convert 50,000 dollars to euros"
â¢ "Run a SWOT on RateWire"
â¢ "Calculate profit margin on $8K revenue, $2K cost"

*Memory:*
/memory â view all saved facts
/remember [text] â save a fact
/forget [id] â delete a fact

*Backup slash commands:*
/pipeline â deal tracker
/log â execution history
/status â system status`);
});

// ââ Hosted Dashboard Sync âââââââââââââââââââââââââââââââââ
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

// ââ Launch âââââââââââââââââââââââââââââââââââââââââââââââ

// ── Launch ────────────────────────────────────────────────────────────────────
// Keepalive HTTP server required by Render Web Service (port binding)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Leo is alive')).listen(PORT, () => {
  console.log('keepalive server on :' + PORT);
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || ('localhost:' + PORT);
  const isLocal = host.startsWith('localhost');
  const pinger = isLocal ? http : require('https');
  setInterval(() => {
    const url = (isLocal ? 'http://' : 'https://') + host + '/';
    pinger.get(url, (r) => console.log('keep-alive: ' + r.statusCode)).on('error', (e) => console.log('keep-alive err: ' + e.message));
  }, 840000);
});

bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log('');
  console.log('ââââââââââââââââââââââââââââââââââââââââââ');
  console.log('  ð Leo is ONLINE');
  console.log('  V&DG Execution Agent');
  console.log('  Conversation mode: ENABLED â (via RateWire proxy)');
  console.log('ââââââââââââââââââââââââââââââââââââââââââ');
  setTimeout(() => syncDashboard(), 8000);
}).catch(err => {
  console.error('Leo failed to start:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
