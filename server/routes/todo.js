const express = require('express');
const db = require('../db');
const provenance = require('../provenance');

// TODO — the backlog. ONE store, TWO views.
//
// It replaces a 93-row spreadsheet that had to be re-read end to end to answer "what
// now?". Storing those 93 rows again would be the same spreadsheet with a nicer font and
// fails the gate, so everything this module is for is in what it derives:
//
//   - WHAT IS ACTIONABLE NOW, per view: what is already started, then the highest
//     priority band that still has open work in that view. Not a ranking I invented —
//     the priorities are yours, and this only reads them.
//   - HOW MUCH OF THE PLAN IS WAITING ON YOU (owner 'YOU'). That is the real constraint:
//     a build queue is elastic, your attention is not.
//   - THE SHAPE of what is left, by cluster, so 93 items reads as five problems.
//   - AGE, so something that has sat untouched is visible rather than buried at row 60.
//
// Two things it deliberately does NOT do:
//
//   - No completion percentage. The backlog grows — 18 items became 93 in one sitting —
//     so done/total measures how recently you last added something, not progress.
//   - No dependency graph. Several rationales say "Depends on 11" or "Blocks 46", and
//     extracting those with a regex was tempting. It would also match "63 months",
//     "108 rules" and "weeks 8-11" as item ids, and a link graph that is quietly 30%
//     wrong is worse than no link graph. If dependencies are wanted they need a column,
//     entered deliberately.
//
// Priorities and rationales here are EDITORIAL JUDGEMENT, not measurement. Nothing in
// this file computes a score out of numbers I chose and presents the result as a fact;
// the rationale text travels with every item so the judgement can be argued with.

const OWNERS = ['DET', 'LOC', 'FRO', 'YOU', 'DET+LOC'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'DECLINE', 'DONE'];
const STATUSES = ['open', 'in_progress', 'done', 'declined'];
const VIEWS = ['mine', 'build'];

// Sort order for priority. DECLINE and DONE are seed markers rather than ranks, and sort
// below everything real so they can never turn up as "what to do next".
const PRI_RANK = `CASE priority
  WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3
  WHEN 'DECLINE' THEN 4 WHEN 'DONE' THEN 5 ELSE 6 END`;

const REAL_PRIORITIES = "('P0','P1','P2','P3')";

// The view split, in one place so the two views can never drift apart. 'YOU' means only
// you can do it: a decision, an approval, an account, a signature, a purchase.
const ownerClause = (view) => (view === 'mine' ? "owner = 'YOU'" : "owner <> 'YOU'");

// id, source, title, cluster, priority, owner, effort, rationale
// Copied verbatim from the merged backlog of 17 Aug 2026 (18 original items reviewed
// alongside 75 new ones). Embedded rather than required: the file it came from is a
// scratchpad that will not exist tomorrow, and a seed that reads from a temp path is a
// migration that fails silently on the next machine.
const SEED = [
  ["O8", "orig", "Finance tracking", "Finance", "DONE", "DET", "5h",
    "Ten account-years, 6,839 transactions, verified by the balance identity. 108 rules cover 95.3%; the model does 4.7% into a review queue."],
  ["O13", "orig", "Reports / daily briefing", "Ops", "DONE", "DET+LOC", "2h",
    "Daily 07:00. Every number SQL; the model writes one sentence and is barred from containing a figure, enforced by a guard."],
  ["O1", "orig", "Claude second brain", "Brain", "DONE", "DET", "2.5h",
    "106 memory files, readable, searchable, flaggable at /#brain."],
  ["O7", "orig", "Mental health module", "Wellbeing", "DONE", "DET", "2h",
    "Counts and recall only. Support card fixed and unconditional. The model is barred from this module entirely."],
  ["O6", "orig", "Health module", "Health", "DONE", "DET", "2h",
    "Samsung import mapping verified against the real 54-file export."],
  ["O12", "orig", "Fix Ollama", "Models", "DONE", "DET", "2h",
    "qwen3.5:9b, num_ctx 16384, 84% GPU."],
  ["O15", "orig", "Mission Control", "Ops", "DONE", "DET", "6h",
    "Renamed, .garage folded in as an allowlist, six panels."],
  ["O2", "orig", "Clean up + own CLAUDE.md", "Ops", "DONE", "DET", "1h",
    "11 project files plus the architect file."],
  ["O14", "orig", "Move business expenses", "Finance", "DONE", "DET", "2h",
    "The item was backwards: the exposure is GBP 7,904 the other way plus GBP 21,647 of cash."],
  ["14", "new", "Personal finance data — ALLOWED to a frontier model, kept under review", "Governance", "P2", "FRO", "1h",
    "REVISED BY YOU, 17 Aug: allowed, not prohibited. So nothing about how I work changes — I have been reading descriptors, counterparties and balances all session and that stays permitted. What \"under review\" needs to mean concretely, or it is only a good intention: a log of which finance fields left the machine and when, visible in the panel, so the decision can be revisited against evidence rather than memory. Worth knowing the cost is already low — rules and Ollama do 100% of categorisation; frontier use is design work over samples, not bulk processing."],
  ["11", "new", "Safety rules — nothing illegal, do not bankrupt the owner, true analysis", "Governance", "P0", "DET", "3h",
    "Hard limits in code, not prose: a spend ceiling per transaction and per month, an allowlist of who can be paid, and a refusal path that cannot be argued with. This must exist BEFORE item 28 or 33 build anything that can spend."],
  ["28", "new", "Purchases with user approval as the only gate, with a stated proposition", "Governance", "P0", "YOU", "3h",
    "Depends on 11. I prepare the proposition — cost, budget fit, cost of waiting — and STOP. I never enter payment details or complete a purchase; that line does not move."],
  ["27", "new", "Categorise every todo into bugs/requests with a priority score", "Meta", "P0", "DET", "3h",
    "This workbook is the manual version. The module version makes 95 items trackable instead of a spreadsheet you re-read. Combine with 3 and 5."],
  ["3", "new", "Todo list in the same spreadsheet as the output", "Meta", "P0", "DET", "-",
    "Superseded: put it in Mission Control instead, with an export. A spreadsheet you both edit is two writers with no merge."],
  ["5", "new", "Todo list on Mission Control, separate tabs for you and me", "Meta", "P0", "DET", "4h",
    "The real form of 3 + 27. Your tab is decisions and approvals; mine is the build queue. One store, two views."],
  ["4", "new", "Set up realistic budgets", "Finance", "P1", "DET", "4h",
    "The ledger already knows what you actually spend by category over 63 months. A budget derived from your own history is arithmetic, not a guess — and it is the input every other money feature needs."],
  ["54", "new", "The wishlist is my final approval", "Finance", "P1", "DET", "3h",
    "THIS REVERSES MY EARLIER CALL AND YOU WERE RIGHT. I dropped the wishlist as a list you feed. As an APPROVAL QUEUE against a budget it derives something real: what is affordable now, what waits, what costs more by waiting. Items 20, 43, 50, 58, 61, 62 become its contents."],
  ["76", "new", "HMRC tax returns for the last 5 years", "Finance", "P1", "DET", "4h",
    "The ledger already holds exactly this, tax-year aligned, business account separated. Highest real-money value on the list. I prepare the figures; you file them."],
  ["45", "new", "Reports should show work achieved, not just money", "Ops", "P1", "DET", "2h",
    "Cheap — focus sessions, modules shipped, commits — and it changes what the briefing is for."],
  ["21", "new", "Check whether a cheaper model suits the prompt before processing", "Models", "P1", "DET", "4h",
    "Buildable as a router on measured rules, not vibes: task class, whether an oracle exists, whether it recurs. See the offload note — determinism first, local second, frontier last."],
  ["13", "new", "Keep token cost down, use open models where possible", "Models", "P1", "DET", "-",
    "Same as 21. The measured lever is DETERMINISM, not a smaller model: rules did 95.3% of categorisation, the model 4.7%."],
  ["34", "new", "Limited company compliant within 2 years, urgency scales with income", "Finance", "P1", "YOU", "2h",
    "I can model the threshold from real numbers and tell you when it is worth it. Business income fell 24k to 1k across the five years, so the honest answer today may be \"not yet\"."],
  ["16", "new", "Automate anything I keep repeating", "Meta", "P1", "DET", "3h",
    "Needs evidence first: log what actually repeats for two weeks, then automate the top three. Automating a guess is how you get a surface to feed."],
  ["52", "new", "Lifestyle organisation — chores, laundry, bins, shower", "Wellbeing", "P1", "DET", "3h",
    "Passes the gate ONLY if it derives the schedule rather than storing one you typed. Recurrence from last-done plus interval is deterministic. You asked to be quizzed on this one."],
  ["19", "new", "Order Huel — minimum one meal a day, ties to budget and health", "Health", "P1", "YOU", "1h",
    "I can price it against the budget and tell you the monthly cost. I cannot order it. Flagging plainly: \"minimum one meal per day\" reads as a floor you are not currently hitting, which is a wellbeing signal, not a shopping preference."],
  ["36", "new", "Finance tracker should spot income patterns and forecast", "Finance", "P2", "DET", "4h",
    "TENSION with the standing rule \"never present a forecast from thin data\" — but 63 months is not thin. Defensible for regular income (benefits are near-deterministic). NOT defensible for irregular business income. Forecast only what is regular, and show the residual."],
  ["77", "new", "Net worth tracking", "Finance", "P2", "DET", "2h",
    "Needs 72/73/74 and any savings. Arithmetic once the accounts are in."],
  ["72", "new", "Add PayPal to finance", "Finance", "P2", "YOU", "1h",
    "CSV export, same importer shape. You do the export."],
  ["73", "new", "Add Chase to finance", "Finance", "P2", "YOU", "1h",
    "Already visible as a transfer counterparty; importing it closes the loop."],
  ["74", "new", "Add Klarna to finance", "Finance", "P2", "YOU", "1h",
    "Buy-now-pay-later is a liability, not a purse. It belongs in net worth as a negative."],
  ["75", "new", "Monthly credit rating import", "Finance", "P2", "YOU", "1h",
    "Manual capture, one number a month. Cheap, and it matters for 25."],
  ["78", "new", "Find old pensions and consolidate", "Finance", "P2", "YOU", "2h",
    "I can prepare the Pension Tracing Service request and compare providers on fees. You submit it."],
  ["25", "new", "Research private rented property, 1-bed minimum", "Life", "P2", "DET", "3h",
    "Genuinely useful and grounded: affordability from the real ledger including bills, not a listings scrape."],
  ["23", "new", "Suggested meals from finance and health data, add to basket", "Health", "P2", "DET", "4h",
    "Suggest and cost, yes. \"Do the shopping\" stops at your approval — I do not place orders."],
  ["30", "new", "Advise workout plans, gym and non-gym", "Health", "P2", "FRO", "3h",
    "CAREFUL: this is the closest thing on the list to advice about your body. Keep it to published beginner programmes with sources, never generated prescriptions, and never adaptive to your health metrics."],
  ["44", "new", "Viewable, interactable schedule", "Ops", "P2", "DET", "3h",
    "Ties 52, 64 and the focus timer together."],
  ["64", "new", "Appointment tracker", "Ops", "P2", "DET", "2h",
    "Small, and it feeds 44 and the briefing."],
  ["46", "new", "Personal goal — CBT or driving licence", "Life", "P2", "YOU", "1h",
    "Cost, steps and timeline I can lay out. Booking is yours. CBT is the cheaper first step by a wide margin."],
  ["47", "new", "Personal goal — passport renewal", "Life", "P2", "YOU", "0.5h",
    "Checklist, cost, lead time. Blocks 63."],
  ["48", "new", "Personal goal — provisional replacement", "Life", "P2", "YOU", "0.5h",
    "Blocks 46."],
  ["9", "new", "External integration — Google Drive, mail", "Data", "P2", "DET", "4h",
    "MCP connectors exist for both. Gate it: read-only first, and nothing from mail is ever treated as an instruction."],
  ["12", "new", "Auto-import browsing history", "Data", "P2", "DET", "2h",
    "Your own data, local file, straightforward."],
  ["51", "new", "Import Spotify playlists and history", "Data", "P2", "YOU", "2h",
    "Spotify data export, then a simple import."],
  ["8", "new", "Better file organisation — archive after reading", "Data", "P2", "DET", "3h",
    "Sound, with one rule: never move a file the same run that reads it. Copy, verify the copy, then remove."],
  ["39", "new", "Audit which services are used, connect to Mission Control", "Data", "P2", "DET", "2h",
    "Inventory first, connect second."],
  ["6", "new", "Migrate garage telemetry to the whole project", "Ops", "P2", "DET", "3h",
    "Generalise the Oxford Autoworks telemetry to any project."],
  ["2", "new", "Second brain filters — newest first", "Brain", "P2", "DET", "1h",
    "Small addition to the panel that exists."],
  ["56", "new", "Optimise for efficiency", "Meta", "P2", "DET", "-",
    "Too broad to action. Becomes concrete as 21 plus measured hot spots."],
  ["49", "new", "Ensure Claude knows the whole scope and explains it back", "Meta", "P2", "FRO", "2h",
    "This IS the architect role and the CLAUDE.md files. What is missing is a readable summary FOR YOU rather than for me."],
  ["59", "new", "Fluid, informative, comedic control centre", "UX", "P2", "DET", "2h",
    "Paired with 60."],
  ["60", "new", "Important steps are serious, no comedy", "UX", "P2", "DET", "-",
    "Accepted as a hard rule and it overrides 59. Money, health and wellbeing are never funny."],
  ["24", "new", "Turn life into a game — XP, levels, genres", "UX", "P2", "DET", "4h",
    "Only from things already recorded — sessions, streaks, modules shipped. NEVER an invented weighting presented as a measurement; that is a standing rule."],
  ["22", "new", "Give Mission Control a voice, \"Major Tom\"", "UX", "P2", "LOC", "3h",
    "Local TTS keeps it private and free. The words come from SQL, same rule as the briefing."],
  ["65", "new", "Interactive map, percentage of the world explored", "UX", "P2", "DET", "3h",
    "Fun, self-contained, no new dependency if drawn as SVG."],
  ["38", "new", "Automatic use of the focus timer", "Ops", "P2", "DET", "2h",
    "Start on activity rather than on remembering."],
  ["41", "new", "Portfolio projects that show off the work", "Income", "P2", "FRO", "4h",
    "HOLLOWMAST and Mission Control ARE the portfolio. This is packaging, not building."],
  ["57", "new", "Determine which modules could be income", "Income", "P2", "FRO", "2h",
    "Honest answer available now: the finance importer and the module contract are the reusable parts. Most of it is too personal to sell."],
  ["67", "new", "GDPR requests — medical, police, social services", "Life", "P2", "YOU", "2h",
    "I draft, you send. Subject access requests are free and legally answerable within a month."],
  ["7", "new", "Search Hugging Face for models this machine can run", "Models", "P2", "DET", "2h",
    "Bounded by the 8 GB VRAM ceiling — that is a 7-9B decision and no search changes it."],
  ["26", "new", "Research home deployment servers", "Models", "P2", "FRO", "2h",
    "Honest first answer: your laptop already is one. A second box buys uptime, not capability."],
  ["66", "new", "Workstation and entertainment setup suggestions", "Life", "P2", "FRO", "2h",
    "Ties to 54 and the budget."],
  ["42", "new", "Clothes shopping within budget, try-before-you-buy", "Life", "P2", "DET", "4h",
    "The budget half is easy. The photo try-on half is a large build for a small return; split them."],
  ["50", "new", "RGB bulbs for the room", "Wishlist", "P2", "YOU", "-",
    "Wishlist content, see 54."],
  ["20", "new", "Wishlist — Xbox battery, rolling tray, desk mat", "Wishlist", "P2", "YOU", "-",
    "Wishlist content."],
  ["43", "new", "Wishlist — printer/scanner for receipts and letters", "Wishlist", "P2", "YOU", "-",
    "Highest utility item on the wishlist: it feeds 8, 67 and 76."],
  ["58", "new", "Wishlist — Samsung Q Symphony soundbar", "Wishlist", "P2", "YOU", "-",
    "Wishlist content."],
  ["61", "new", "Wishlist — computer chair", "Wishlist", "P2", "YOU", "-",
    "Wishlist content."],
  ["62", "new", "Wishlist — bedding", "Wishlist", "P2", "YOU", "-",
    "Wishlist content."],
  ["53", "new", "Add approved lifestyle items to the wishlist", "Wishlist", "P2", "DET", "-",
    "Falls out of 52 + 54."],
  ["55", "new", "Expand the mini-games collection, tie to YouTube", "Game", "P2", "FRO", "-",
    "Blocked by the standing rule: no fourth game before HOLLOWMAST ships."],
  ["29", "new", "Enforce time away — block owner access at intervals", "Wellbeing", "P2", "DET", "3h",
    "I will build a limit you set in advance and can always override. I will NOT build a lock you cannot open: a wellbeing feature that traps you is the failure mode, not the feature."],
  ["32", "new", "The \"what is on your mind\" prompt", "Wellbeing", "P2", "DET", "1h",
    "Already largely built — the wellbeing note box is exactly this. Needs the prompt wording and a nudge."],
  ["17", "new", "Investigate MCP such as Higgsfield", "Models", "P2", "FRO", "2h",
    "Weeks 8-11 per the plan. Gated."],
  ["31", "new", "Xbox One X as a local model or server", "Models", "P3", "FRO", "-",
    "DECLINE on capability, not effort. It is a locked console: no arbitrary code, no CUDA, and its GPU cannot serve an LLM. There is no version of this that works."],
  ["18", "new", "Track SerpClix income from the browser extension", "Income", "P3", "DET", "1h",
    "Tracking the income is fine and easy. See 70 for why the income itself is a problem."],
  ["68", "new", "Add Honeygain to income", "Income", "DECLINE", "FRO", "-",
    "Bandwidth resale. It typically breaches your ISP terms, and traffic you cannot see exits through your connection carrying your IP. Realistic return is a few pounds a month against real liability. Recommend no."],
  ["69", "new", "Add Packetstream to income", "Income", "DECLINE", "FRO", "-",
    "Same as 68 and the same recommendation."],
  ["70", "new", "Add SerpClix to income", "Income", "DECLINE", "FRO", "-",
    "Paid search clicking is search-result manipulation and breaches Google terms. It also sits badly beside the PrintProfit rule against astroturfing. Recommend no; track any existing income under 18 and stop."],
  ["71", "new", "Add Coinbase to income", "Income", "P2", "YOU", "1h",
    "Different from 68-70 — an exchange account is legitimate. I will import it as an ASSET. I will never execute a trade or transfer."],
  ["33", "new", "Make money on Fiverr with no work my end", "Income", "P3", "FRO", "-",
    "Deliverable-as-a-service is fine; \"no work my end\" means reselling AI output as your own labour. Viable only if disclosed, and quality still needs your review. Recommend reframing as productised delivery, not passive income."],
  ["40", "new", "Faceless YouTube of Claude outputs, automatic", "Income", "P3", "FRO", "-",
    "Automated volume content is what the platform demonetises hardest, and it conflicts with the no-astroturfing rule. If you want it, do it as a small number of genuinely edited pieces."],
  ["35", "new", "Always-on listener triggered by a code word", "Data", "P3", "DET", "-",
    "DECLINE as specified. A microphone that records a room captures other people who have not consented, which is a legal problem in the UK, not a design one. A push-to-talk recorder that only captures you is fine and I will build that instead."],
  ["37", "new", "Trading advisor", "Income", "P3", "FRO", "-",
    "You already marked it low. Adding: I must not give personalised investment advice, and a forecast-driven trader breaks the thin-data rule twice over. Recommend permanent decline."],
  ["63", "new", "Personal goal — Dubai / Turkey teeth", "Life", "P3", "YOU", "-",
    "Budget and timeline only. I will cost it; I will not research clinics or advise on the procedure."],
  ["15", "new", "Upgrade Claude subscription", "Meta", "P3", "YOU", "-",
    "Only you can. Worth noting the offload finding first: determinism removed more frontier load today than a bigger plan would have added."],
  ["10", "new", "Tools that put real information in front of me and guide decisions", "Meta", "P1", "DET", "-",
    "This is the gate restated, and it is the best single sentence on the list. Every item should be judged against it."],
  ["O16", "orig", "Mission Control notifications", "Ops", "P1", "DET", "2h of 4",
    "PARTIAL. The uptime toast is live and is the only alert so far. The bar stays high: anything dismissed twice gets deleted, not tuned."],
  ["O4", "orig", "Set up agentic AI", "Models", "P2", "FRO", "3h of 12",
    "PARTIAL — the Ollama leg is done and measured. Scheduled runs and MCP servers are weeks 8-11 and gated. Merge with new 17 and 21."],
  ["O5", "orig", "Pull Google/Samsung health", "Health", "P1", "YOU", "1h",
    "The export now exists and the mapping is verified against it. What remains is running the import and eyeballing the numbers against the app."],
  ["O3", "orig", "HOLLOWMAST GitHub publish", "Game", "P2", "YOU", "-",
    "Private until the LAUNCH.md Phase 5 gate. Private to public is free; the reverse is impossible."],
  ["O10", "orig", "Purchase the HOLLOWMAST domain", "Game", "P1", "YOU", "-",
    "BLOCKED ON YOU and it is cheap to clear: the free UK IPO and EUIPO trade mark searches before anything is bought under the name."],
  ["O11", "orig", "Set up HOLLOWMAST social channels", "Game", "P2", "YOU", "-",
    "Blocked on the same name check. I never create accounts or post as you."],
  ["O17", "orig", "Explore dual boot", "Ops", "P3", "FRO", "-",
    "Recommend against. Windows Task Scheduler is the backbone of five live services; a dual boot destabilises the whole ops track for a gain you have not needed yet."],
];

db.migrate('todo', [
  (d) => {
    d.exec(`
      CREATE TABLE todo_items (
        id         TEXT PRIMARY KEY,        -- '14', 'O8', 'M3' — from the spreadsheet, kept
        source     TEXT,                    -- 'orig' | 'new' | 'manual'
        title      TEXT NOT NULL,
        cluster    TEXT,                    -- Finance, Governance, Income, ...
        priority   TEXT,                    -- P0..P3, or the seed markers DECLINE / DONE
        owner      TEXT,                    -- DET | LOC | FRO | YOU | DET+LOC
        effort     TEXT,                    -- as written: '4h', '2h of 4', '-'
        rationale  TEXT,                    -- the reasoning. Long, and the point of the row.
        status     TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | done | declined
        decided_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE todo_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id    TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
        note       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX idx_todo_status  ON todo_items(status);
      CREATE INDEX idx_todo_owner   ON todo_items(owner);
      CREATE INDEX idx_todo_cluster ON todo_items(cluster);
      CREATE INDEX idx_todo_notes   ON todo_notes(item_id);
    `);

    // db.migrate() already opened a transaction — do not open a second one here.
    const ins = d.prepare(
      `INSERT INTO todo_items (id, source, title, cluster, priority, owner, effort, rationale, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const [id, source, title, cluster, priority, owner, effort, rationale] of SEED) {
      // The seed carried its outcome in the priority column. Status is derived from it
      // once, here, and priority keeps the original value so the row still says how it
      // was judged rather than only how it ended.
      const status = priority === 'DONE' ? 'done' : priority === 'DECLINE' ? 'declined' : 'open';
      ins.run(String(id), source, title, cluster, priority, owner, effort, rationale, status);
    }

    // decided_at is left NULL on every seeded row, including the done and declined ones.
    // The spreadsheet never recorded when a decision was made, and stamping the import
    // time would invent a date that the age figures would then treat as real.
  },

  // Provenance. Default 'unknown' rather than 'you' — see server/provenance.js.
  (d) => {
    provenance.addColumn(d, 'todo_notes');
  },

  // 3. A note can be marked SUPERSEDED by a later note. Not edited, not deleted.
  //
  // Notes are append-only and that is right: the value of the trail is that it was not
  // rewritten. But on 18 Aug I wrote a long note on #25 quoting figures that a fix
  // invalidated within the hour, and the only remedy was to append a second note starting
  // "CORRECTION to my note above". A reader who hits the first note and stops gets the
  // wrong numbers with nothing on screen to warn them.
  //
  // So the fact stays, dated and attributed, and gains a pointer to what replaced it. The
  // reader is warned; nothing is destroyed. Nullable, so every existing note is unaffected.
  (d) => {
    d.exec("ALTER TABLE todo_notes ADD COLUMN superseded_by INTEGER REFERENCES todo_notes(id)");
  },
]);

const router = express.Router();

// Rows land as null-prototype objects from node:sqlite; spread them before they reach JSON.
const plain = (r) => ({ ...r });

// ---------------------------------------------------------------------------- effort
// The seed writes effort as free text: '4h', '0.5h', '-', and twice as '2h of 4' for a
// partially built item. Parsed rather than guessed at, and anything that does not match
// is reported as unestimated instead of being quietly counted as zero.
function parseEffort(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '-') return { hours: null, kind: 'none' };
  const m = /^([\d.]+)\s*h(?:\s+of\s+([\d.]+))?$/i.exec(s);
  if (!m) return { hours: null, kind: 'unparsed' };
  const first = Number(m[1]);
  if (m[2] === undefined) return { hours: first, kind: 'estimate' };
  // '2h of 4' — two hours spent against a four hour estimate, so two remain.
  const total = Number(m[2]);
  return { hours: Math.max(0, total - first), kind: 'partial', spentHours: first, totalHours: total };
}

// What the open build queue would cost, WITH its residue stated. A total over the items
// that happen to carry an estimate looks like a total over the queue, and reads about
// 20% cheaper than the queue actually is.
function effortOf(rows) {
  let hours = 0;
  let estimated = 0;
  const unestimated = [];
  const partial = [];
  for (const r of rows) {
    const e = parseEffort(r.effort);
    if (e.hours == null) { unestimated.push({ id: r.id, effort: r.effort, why: e.kind }); continue; }
    hours += e.hours;
    estimated += 1;
    if (e.kind === 'partial') partial.push({ id: r.id, effort: r.effort, remainingHours: e.hours });
  }
  return {
    hours: Math.round(hours * 10) / 10,
    itemsEstimated: estimated,
    itemsUnestimated: unestimated.length,
    unestimated,
    partial,
    note: unestimated.length
      ? `${hours} h covers ${estimated} of ${rows.length} open items. ${unestimated.length} carry no estimate and are NOT in that figure.`
      : `${hours} h covers all ${rows.length} open items.`,
  };
}

// ---------------------------------------------------------------------------- derived
const AGE = `CAST(julianday('now','localtime') - julianday(created_at) AS INTEGER) AS age_days`;

// WHAT IS ACTIONABLE NOW, for one view.
//
// Two parts, in the order they should be read. Anything already in progress comes first,
// because the answer to "what now" is usually the thing you already started; starting a
// third is how a backlog stops moving. Then the highest priority band that still has open
// work — not a per-item score, just the top band that is not empty.
function actionableNow(view) {
  const own = ownerClause(view);

  const started = db.prepare(
    `SELECT *, ${AGE} FROM todo_items WHERE status = 'in_progress' AND ${own}
     ORDER BY ${PRI_RANK}, created_at`
  ).all().map(plain);

  const band = db.prepare(
    `SELECT MIN(${PRI_RANK}) AS rank, priority FROM todo_items
     WHERE status = 'open' AND ${own} AND priority IN ${REAL_PRIORITIES}`
  ).get();

  // The filter above drops open rows whose priority is DECLINE or DONE — which happens
  // when something is reopened without being re-prioritised. Counted and reported, so a
  // short "next up" list is never mistaken for a short backlog.
  const unranked = db.prepare(
    `SELECT COUNT(*) AS c FROM todo_items
     WHERE status = 'open' AND ${own} AND priority NOT IN ${REAL_PRIORITIES}`
  ).get().c;

  if (!band || band.rank === null) {
    return {
      view,
      started,
      priority: null,
      items: [],
      unrankedOpen: unranked,
      state: 'nothing-open',
      note: unranked
        ? `Nothing open with a priority. ${unranked} open item${unranked === 1 ? '' : 's'} still carry DONE or DECLINE and need re-prioritising before they can appear here.`
        : 'Nothing open in this view.',
    };
  }

  const items = db.prepare(
    `SELECT *, ${AGE} FROM todo_items
     WHERE status = 'open' AND ${own} AND priority = ?
     ORDER BY created_at, id`
  ).all(band.priority).map(plain);

  return {
    view,
    started,
    priority: band.priority,
    items,
    unrankedOpen: unranked,
    state: 'ok',
    note: `${band.priority} is the highest priority band with open work in this view — ${items.length} item${items.length === 1 ? '' : 's'}. `
      + 'The band is yours; this only reads it.'
      + (unranked ? ` ${unranked} open item(s) are hidden here because their priority is still DONE or DECLINE.` : ''),
  };
}

// HOW MUCH OF THE PLAN IS WAITING ON YOU. The single most useful number on the page:
// the build queue can always be worked, so anything owned by 'YOU' is what actually
// bounds the plan.
function blockedOnYou() {
  const open = db.prepare("SELECT COUNT(*) AS c FROM todo_items WHERE status = 'open' AND owner = 'YOU'").get().c;
  const openAll = db.prepare("SELECT COUNT(*) AS c FROM todo_items WHERE status = 'open'").get().c;
  const oldest = db.prepare(
    `SELECT id, title, priority, ${AGE} FROM todo_items
     WHERE status = 'open' AND owner = 'YOU' ORDER BY created_at LIMIT 5`
  ).all().map(plain);

  return {
    open,
    openTotal: openAll,
    // A share of what is open right now — a composition, not a progress figure.
    shareOfOpen: openAll ? Math.round((open / openAll) * 1000) / 10 : null,
    byPriority: db.prepare(
      `SELECT priority, COUNT(*) AS count FROM todo_items
       WHERE status = 'open' AND owner = 'YOU' GROUP BY priority ORDER BY ${PRI_RANK}`
    ).all().map(plain),
    byCluster: db.prepare(
      `SELECT cluster, COUNT(*) AS count FROM todo_items
       WHERE status = 'open' AND owner = 'YOU' GROUP BY cluster ORDER BY count DESC, cluster`
    ).all().map(plain),
    oldest,
    note: openAll
      ? `${open} of ${openAll} open items can only be done by you. Nothing in the build queue can clear them.`
      : 'Nothing is open.',
  };
}

// ---------------------------------------------------------------------------- GET /
router.get('/', (req, res) => {
  let out;
  try {
    const total = db.prepare('SELECT COUNT(*) AS c FROM todo_items').get().c;

    // Empty and broken must never render the same. The table existing with no rows is a
    // real, reportable state — and a different one from the query having failed, which
    // leaves through the catch below with its message intact.
    if (!total) {
      return res.json({
        state: 'empty',
        total: 0,
        message: 'The todo tables exist and are empty. Nothing failed — there is genuinely nothing in them. '
          + 'The 93-item seed runs once, in migration v1; if this is unexpected, the rows were deleted rather than never written.',
      });
    }

    const openRows = db.prepare("SELECT * FROM todo_items WHERE status = 'open'").all().map(plain);
    const buildOpen = openRows.filter((r) => r.owner !== 'YOU');

    out = {
      state: 'ok',
      generatedAt: new Date().toISOString(),
      total,
      byStatus: db.prepare('SELECT status, COUNT(*) AS count FROM todo_items GROUP BY status ORDER BY count DESC').all().map(plain),
      byPriority: db.prepare(`SELECT priority, COUNT(*) AS count FROM todo_items GROUP BY priority ORDER BY ${PRI_RANK}`).all().map(plain),
      byOwner: db.prepare('SELECT owner, COUNT(*) AS count FROM todo_items GROUP BY owner ORDER BY count DESC').all().map(plain),

      // THE SHAPE OF WHAT IS LEFT. Open only — including done and declined rows here
      // would make a finished cluster look like the busiest one on the page.
      byCluster: db.prepare(
        `SELECT cluster,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN status = 'open' AND owner = 'YOU' THEN 1 ELSE 0 END) AS blocked_on_you,
                SUM(CASE WHEN status = 'open' AND owner <> 'YOU' THEN 1 ELSE 0 END) AS build,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM todo_items GROUP BY cluster ORDER BY open DESC, total DESC, cluster`
      ).all().map(plain),

      blockedOnYou: blockedOnYou(),
      buildEffort: effortOf(buildOpen),
      actionable: { mine: actionableNow('mine'), build: actionableNow('build') },

      // Open, untouched, oldest first. Across both views, because the point is to make
      // something that has been sitting there visible regardless of who owns it.
      stale: db.prepare(
        `SELECT id, title, cluster, priority, owner, ${AGE} FROM todo_items
         WHERE status = 'open' ORDER BY created_at, ${PRI_RANK} LIMIT 8`
      ).all().map(plain),

      // Age is measured from created_at, and every seeded row carries the import time
      // rather than the day the item was first thought of — that date was never
      // recorded. Said here rather than left for the reader to assume.
      ageBasis: 'Days since the row was created. The 93 seeded items were all created at import, so their age is age in this system, not age of the idea.',
      notScored: 'Priorities are editorial judgement, entered by hand. Nothing here computes a score.',
      noPercentComplete: 'No completion percentage: the backlog grows, so done/total would measure how recently something was added.',
    };
  } catch (err) {
    return res.status(500).json({ state: 'error', error: err.message });
  }
  res.json(out);
});

// ------------------------------------------------------------------------ GET /items
// The full rationale and every note for ONE item, fetched when the reader opens it.
//
// The list deliberately carries a 96-character teaser and a note COUNT (see below), so
// this is where the rest lives. One item at a time is the right granularity: the panel
// only ever expands one at a time, and 148 detail requests would only happen if somebody
// opened all 148, which is not a thing anyone does.
router.get('/items/:id/detail', (req, res) => {
  const row = db.prepare(`SELECT *, ${AGE} FROM todo_items WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'no such item' });
  const notes = db
    .prepare('SELECT * FROM todo_notes WHERE item_id = ? ORDER BY created_at, id')
    .all(req.params.id)
    .map(plain);
  const item = plain(row);
  res.json({
    id: item.id,
    // Named rationaleFull, not rationale, so it can never be confused with the teaser the
    // list sends under the shorter name.
    rationaleFull: item.rationale || null,
    notes,
  });
});
router.get('/items', (req, res) => {
  const view = VIEWS.includes(req.query.view) ? req.query.view : null;
  const where = [];
  const args = [];

  if (view) where.push(ownerClause(view));
  if (req.query.status) {
    if (!STATUSES.includes(req.query.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    where.push('status = ?'); args.push(req.query.status);
  }
  if (req.query.cluster) { where.push('cluster = ?'); args.push(req.query.cluster); }
  if (req.query.priority) {
    if (!PRIORITIES.includes(req.query.priority)) return res.status(400).json({ error: `priority must be one of ${PRIORITIES.join(', ')}` });
    where.push('priority = ?'); args.push(req.query.priority);
  }

  const sql = `SELECT *, ${AGE} FROM todo_items
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'declined' THEN 2 ELSE 3 END,
             ${PRI_RANK}, created_at, id`;

  try {
    const rows = db.prepare(sql).all(...args).map(plain);

    // FULL TEXT IS NOT SENT WITH THE LIST. Measured 18 Aug: this endpoint returned 335 KB
    // for 148 items — 56% notes, 28% rationale — and the panel shows a 96-character teaser
    // with the rest inside a collapsed <details>. So a third of a megabyte was being sent
    // in order to be hidden, on every mount, to a dashboard meant to be opened from a phone.
    //
    // Truncating the biggest offenders would not have worked: 106 of 148 items carry notes
    // and the ten largest hold only 33% of the text, so the weight is spread rather than
    // concentrated. The split has to be structural.
    //
    // ?detail=1 restores the old shape verbatim, so anything that genuinely needs
    // everything can still ask for it in one request.
    const detail = req.query.detail === '1';
    const noteCounts = new Map();
    for (const r of db.prepare('SELECT item_id, COUNT(*) AS n, MAX(created_at) AS last FROM todo_notes GROUP BY item_id').all()) {
      noteCounts.set(r.item_id, { n: r.n, last: r.last });
    }
    const notes = detail
      ? db.prepare('SELECT * FROM todo_notes ORDER BY created_at, id').all().map(plain)
      : [];
    const byItem = new Map();
    for (const n of notes) {
      if (!byItem.has(n.item_id)) byItem.set(n.item_id, []);
      byItem.get(n.item_id).push(n);
    }

    // The actionable set for this view, so the panel does not have to re-derive it and
    // arrive at a different answer. One owner per figure, applied inside a module.
    const act = view ? actionableNow(view) : null;
    const nextIds = new Set(act ? act.items.map((i) => i.id) : []);
    const startedIds = new Set(act ? act.started.map((i) => i.id) : []);

    // 96 characters, because that is exactly what the panel renders as its teaser. Sending
    // a different amount would mean the collapsed view and the expanded view disagree about
    // where the sentence stops.
    const TEASER = 96;
    const items = rows.map((r) => {
      const e = parseEffort(r.effort);
      const nc = noteCounts.get(r.id) || { n: 0, last: null };
      const why = String(r.rationale || '');
      return {
        ...r,
        // The teaser replaces the field it is a teaser FOR, so a caller cannot render the
        // truncated text believing it has the whole thing.
        rationale: detail ? r.rationale : (why.length > TEASER ? `${why.slice(0, TEASER).trimEnd()}…` : why),
        rationaleTruncated: !detail && why.length > TEASER,
        noteCount: nc.n,
        lastNoteAt: nc.last,
        effortHours: e.hours,
        effortKind: e.kind,
        // `notes` is OMITTED entirely in light mode rather than sent as []. An empty array
        // states 'this item has no notes', which for 106 of 148 items would be false --
        // absence of the key says 'not sent', which is true. noteCount carries the fact.
        //
        // The old `noteCount: (byItem.get(r.id) || []).length` lived HERE, after the one
        // computed from the GROUP BY above, and silently won as the later duplicate key --
        // so every count read 0 while lastNoteAt from the same row read correctly. A
        // duplicate key in an object literal is not an error and not a warning.
        notes: detail ? (byItem.get(r.id) || []) : undefined,
        seeded: r.source === 'orig' || r.source === 'new',
        isNext: nextIds.has(r.id),
        isStarted: startedIds.has(r.id),
      };
    });

    // A filter returning nothing is a real answer, and it must not read like a broken
    // one. Both the total and the filters that produced the result travel with it.
    const total = db.prepare('SELECT COUNT(*) AS c FROM todo_items').get().c;
    res.json({
      state: items.length ? 'ok' : 'no-match',
      view,
      filters: {
        status: req.query.status || null,
        cluster: req.query.cluster || null,
        priority: req.query.priority || null,
      },
      count: items.length,
      totalInStore: total,
      actionable: act,
      message: items.length ? undefined
        : total === 0
          ? 'The store is empty — no items at all, in any view. Nothing failed.'
          : `No item matches these filters. ${total} items exist; the filters excluded all of them.`,
      items,
    });
  } catch (err) {
    res.status(500).json({ state: 'error', error: err.message });
  }
});

// ------------------------------------------------------------------- GET /export.csv
//
// The spreadsheet is what this module replaced, and the drift it causes is already on
// record: the store was seeded from the .ods at 21:29 on 17 Aug, a new item was written
// into the .ods at 21:54, and within half an hour the two disagreed with no error.
//
// So this export exists to make the spreadsheet a DERIVED artefact rather than a second
// writer: regenerate it from the store, never edit it alongside. One owner per figure is
// the module contract, and a backlog row is a figure like any other.
//
// Everything the panel derives is deliberately LEFT OUT — actionable-now, the shape by
// cluster, the blocked-on-you count. Those are computed from these rows, and a CSV that
// carried them would be a second place they live, stale the moment anything is edited.
const CSV_COLUMNS = [
  ['id', 'Item'], ['title', 'Title'], ['cluster', 'Cluster'], ['priority', 'Priority'],
  ['owner', 'Owner'], ['effort', 'Effort'], ['status', 'Status'], ['age_days', 'Age (days)'],
  ['created_at', 'Created'], ['decided_at', 'Decided'], ['rationale', 'Rationale'], ['notes', 'Notes'],
];

// RFC 4180. The rationale column is why this matters rather than a nicety: it is prose
// containing commas, quotes and the occasional newline, so a naive join(',') would
// silently shift every column right of it on exactly the rows worth reading.
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const needsQuotes = s.includes(',') || s.includes('"') || s.includes('\r') || s.includes('\n');
  return needsQuotes ? '"' + s.replace(/"/g, '""') + '"' : s;
};

router.get('/export.csv', (req, res) => {
  const view = VIEWS.includes(req.query.view) ? req.query.view : null;
  try {
    const rows = db.prepare(
      `SELECT *, ${AGE} FROM todo_items ${view ? `WHERE ${ownerClause(view)}` : ''}
       ORDER BY ${PRI_RANK}, created_at, id`
    ).all().map(plain);

    const notes = new Map();
    for (const n of db.prepare('SELECT * FROM todo_notes ORDER BY created_at, id').all()) {
      if (!notes.has(n.item_id)) notes.set(n.item_id, []);
      notes.get(n.item_id).push(n.note);
    }

    const lines = [CSV_COLUMNS.map((c) => csvCell(c[1])).join(',')];
    for (const r of rows) {
      lines.push(CSV_COLUMNS
        .map(([key]) => csvCell(key === 'notes' ? (notes.get(r.id) || []).join(' | ') : r[key]))
        .join(','));
    }

    // The caveat travels WITH the file. Without it a spreadsheet on a desktop looks like
    // a document you may edit, and the drift this module exists to end starts again — it
    // took 30 minutes the first time. Placed after the data so the header row stays valid
    // CSV for anything parsing it.
    lines.push('');
    lines.push(csvCell('REGENERATED FROM MISSION CONTROL — do not edit this file. It is a snapshot of '
      + 'the backlog module, which is the source of truth. Any change made here is invisible to the '
      + 'system and will be overwritten by the next export. To change something, change it in the '
      + 'Backlog panel and export again.'));

    const stamp = new Date().toISOString().slice(0, 10);
    const name = `backlog${view ? '-' + view : ''}-${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    // Excel and LibreOffice both read a UTF-8 CSV as the system codepage without a BOM.
    res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  } catch (err) {
    res.status(500).json({ state: 'error', error: err.message });
  }
});

// --------------------------------------------------------------------- PATCH /items/:id
// Editable fields, and why the list is not simply "all of them".
//
// status and priority were the only two for a long time, which was right while items came
// from a spreadsheet: the rationale is the editorial judgement that produced the priority,
// and silently rewriting it is how a backlog loses its reasoning.
//
// It became wrong once items were filed programmatically. On 18 Aug I filed one whose
// rationale had been mangled by shell quoting -- three code snippets executed instead of
// quoted, leaving a bare "." where a CSS selector should have been -- and the only remedy
// was DELETE and re-POST, which changed the id. Any reference to the old id then pointed
// at nothing.
//
// So the text fields are editable AND THE PREVIOUS TEXT IS KEPT. Replacing a rationale
// writes the old one into todo_notes first, dated and attributed, so the change is visible
// rather than silent. That is the same shape as the rest of this project: a correction is
// made openly, never by quietly overwriting.
const TEXT_FIELDS = ['title', 'cluster', 'effort', 'owner', 'rationale'];

router.patch('/items/:id', (req, res) => {
  const { status, priority } = req.body || {};
  const texts = TEXT_FIELDS.filter((f) => req.body && req.body[f] !== undefined);
  if (status === undefined && priority === undefined && !texts.length) {
    return res.status(400).json({
      error: `send status, priority, or one of ${TEXT_FIELDS.join(', ')}`,
    });
  }
  // Trimmed ONCE, here, and everything downstream uses the trimmed value. Validating on
  // the trimmed string and then storing the raw one meant " Fix the thing " passed, was
  // stored with its spaces, and a later PATCH sending the clean text compared unequal --
  // writing a note that said "title replaced" over a difference nobody can see.
  const clean = {};
  for (const f of texts) {
    if (typeof req.body[f] !== 'string' || !req.body[f].trim()) {
      // Clearing a field and omitting it are different requests. Neither is supported
      // here, and saying so beats writing an empty string that later reads as "nobody
      // wrote a rationale for this".
      return res.status(400).json({ error: `${f} must be a non-empty string` });
    }
    clean[f] = req.body[f].trim();
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  }
  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of ${PRIORITIES.join(', ')}` });
  }

  const before = db.prepare('SELECT * FROM todo_items WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'no such item' });

  const sets = [];
  const args = [];
  if (status !== undefined) {
    sets.push('status = ?'); args.push(status);
    // A decision has a date; reopening removes it rather than leaving a stale one that
    // later reads as "decided on".
    sets.push(status === 'done' || status === 'declined'
      ? "decided_at = datetime('now','localtime')" : 'decided_at = NULL');
  }
  if (priority !== undefined) { sets.push('priority = ?'); args.push(priority); }

  // The old text is preserved BEFORE the update, in the same transaction, so a failed
  // write cannot leave a note describing a change that did not happen.
  const kept = [];
  for (const f of texts) {
    const was = before[f];
    if (String(was == null ? '' : was) === clean[f]) continue;      // no change, no note
    sets.push(`${f} = ?`); args.push(clean[f]);
    kept.push([f, was]);
  }
  if (!sets.length) {
    // Every field sent already had that value. Not an error, and not a silent no-op
    // either -- say so, or a caller cannot tell "applied" from "nothing to apply".
    return res.json({
      item: plain(db.prepare(`SELECT *, ${AGE} FROM todo_items WHERE id = ?`).get(req.params.id)),
      changed: [],
      note: 'every field sent already held that value',
    });
  }
  args.push(req.params.id);

  // db.withTransaction is the only place BEGIN appears — it refuses to nest, refuses an
  // async callback, and rolls back only the transaction it actually started. The hand-rolled
  // version here would roll back somebody else's on the shared connection.
  try {
    db.withTransaction(() => {
      for (const [field, was] of kept) {
        db.prepare('INSERT INTO todo_notes (item_id, note, by_whom) VALUES (?, ?, ?)').run(
          req.params.id,
          `${field} replaced. Previous text: ${was == null ? '(empty)' : was}`,
          req.by,
        );
      }
      db.prepare(`UPDATE todo_items SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({
    item: plain(db.prepare(`SELECT *, ${AGE} FROM todo_items WHERE id = ?`).get(req.params.id)),
    changed: sets.map((x) => x.split(' ')[0]).filter((f) => f !== 'decided_at'),
    previousTextKeptAsNotes: kept.map(([f]) => f),
  });
});

// --------------------------------------------------------------------- POST /items
router.post('/items', (req, res) => {
  const { title, cluster, priority, owner, effort, rationale } = req.body || {};
  if (!String(title || '').trim()) return res.status(400).json({ error: 'title is required' });
  if (priority && !PRIORITIES.includes(priority)) return res.status(400).json({ error: `priority must be one of ${PRIORITIES.join(', ')}` });
  if (owner && !OWNERS.includes(owner)) return res.status(400).json({ error: `owner must be one of ${OWNERS.join(', ')}` });

  // Ids added here are 'M1', 'M2', ... The seed owns the bare numbers and the O-prefix,
  // so a new item can never collide with a spreadsheet row. Counted off the existing
  // M-rows rather than off the table size, which would repeat an id after a delete.
  let max = 0;
  for (const r of db.prepare("SELECT id FROM todo_items WHERE id LIKE 'M%'").all()) {
    const n = Number(String(r.id).slice(1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  const id = `M${max + 1}`;

  const pri = priority || 'P2';
  const status = pri === 'DONE' ? 'done' : pri === 'DECLINE' ? 'declined' : 'open';

  try {
    db.prepare(
      `INSERT INTO todo_items (id, source, title, cluster, priority, owner, effort, rationale, status)
       VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, String(title).trim(), cluster || null, pri, owner || 'DET', effort || null, rationale || null, status);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.status(201).json({ item: plain(db.prepare(`SELECT *, ${AGE} FROM todo_items WHERE id = ?`).get(id)) });
});

// ---------------------------------------------------------------- POST /items/:id/notes
router.post('/items/:id/notes', (req, res) => {
  const note = String((req.body && req.body.note) || '').trim();
  if (!note) return res.status(400).json({ error: 'note is required' });
  // Checked first so a missing item answers 404 rather than a foreign-key error, which
  // would arrive as a 500 and read as the server being broken.
  if (!db.prepare('SELECT 1 FROM todo_items WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'no such item' });
  }
  // `supersedes` marks an EARLIER note as replaced by this one. The earlier note is not
  // edited and not deleted — it gains a pointer, so a reader who stops at it is warned that
  // something later corrects it. Both writes go in one transaction: a note claiming to
  // supersede something, where the pointer failed to land, is worse than neither.
  const supersedes = req.body && req.body.supersedes;
  let prior = null;
  if (supersedes !== undefined && supersedes !== null) {
    prior = db.prepare('SELECT id, item_id FROM todo_notes WHERE id = ?').get(Number(supersedes));
    if (!prior) return res.status(404).json({ error: `no note ${supersedes} to supersede` });
    if (String(prior.item_id) !== String(req.params.id)) {
      // Crossing items would let a note on one item silently annotate another.
      return res.status(400).json({ error: `note ${supersedes} belongs to item ${prior.item_id}, not ${req.params.id}` });
    }
  }

  let id;
  try {
    db.withTransaction(() => {
      const info = db.prepare('INSERT INTO todo_notes (item_id, note, by_whom) VALUES (?, ?, ?)')
        .run(req.params.id, note, req.by);
      id = Number(info.lastInsertRowid);
      if (prior) db.prepare('UPDATE todo_notes SET superseded_by = ? WHERE id = ?').run(id, prior.id);
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.status(201).json({ id, itemId: req.params.id, note, supersedes: prior ? prior.id : null });
});

// ------------------------------------------------------------------- DELETE /items/:id
router.delete('/items/:id', (req, res) => {
  // Notes go with it via ON DELETE CASCADE, which needs PRAGMA foreign_keys — set in db.js.
  const r = db.prepare('DELETE FROM todo_items WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'no such item' });
  res.json({
    deleted: req.params.id,
    note: 'Deleted, notes included. A seeded item does not come back: the seed runs once, in migration v1. '
      + 'Declining it instead keeps the row and its reasoning.',
  });
});

// Asked for by the briefing. decided_at only exists from the moment an item is actually
// decided in this app — the 93 seeded rows carry NULL, because the spreadsheet never
// recorded when a call was made and stamping the import time would have invented a date.
function decidedSince(sinceIso) {
  const rows = db.prepare(
    "SELECT status, COUNT(*) c FROM todo_items WHERE decided_at IS NOT NULL AND decided_at >= ? GROUP BY status"
  ).all(sinceIso);
  const undated = db.prepare(
    "SELECT COUNT(*) c FROM todo_items WHERE status IN ('done','declined') AND decided_at IS NULL"
  ).get().c;
  return { byStatus: rows, undated };
}


// #24, the half that is honest today. Where the work actually goes, counted over the
// cluster vocabulary the backlog already carries -- nothing here is weighted, scored or
// levelled, and no number is invented.
//
// THE OTHER HALF OF #24 IS DELIBERATELY ABSENT. XP and levels need a curve, and a curve is
// a coefficient somebody chooses; worse, every closure in this store lands on just two days
// (12 on 17 Aug, 78 on 18 Aug), so a level would be an invented DEPTH rather than an
// invented weight -- a trend line drawn through two points. Measured before deciding not to
// build it. When there is enough history, copy the dash: one stated rule, no denominator.
router.get('/clusters', (req, res) => {
  const rows = db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(cluster), ''), '(none)') AS cluster,
            COUNT(*)                                        AS total,
            SUM(status = 'done')                            AS done,
            SUM(status IN ('open','in_progress'))           AS open,
            SUM(owner = 'YOU')                              AS yours
     FROM todo_items GROUP BY cluster ORDER BY done DESC, total DESC`
  ).all();

  const totals = rows.reduce((a, r) => ({
    total: a.total + r.total, done: a.done + r.done, open: a.open + r.open,
  }), { total: 0, done: 0, open: 0 });

  // Closures per day, so the THINNESS of the history is visible on the same screen as the
  // distribution. A cluster chart with no time context invites exactly the trend reading
  // the data cannot support.
  const days = db.prepare(
    `SELECT substr(decided_at, 1, 10) AS day, COUNT(*) AS n FROM todo_items
     WHERE status = 'done' AND decided_at IS NOT NULL AND decided_at != ''
     GROUP BY day ORDER BY day`
  ).all();

  const undated = db.prepare(
    `SELECT COUNT(*) AS n FROM todo_items WHERE status = 'done'
     AND (decided_at IS NULL OR decided_at = '')`
  ).get().n;

  res.json({
    clusters: rows, totals, days, undatedDone: undated,
    note: 'Counts over the clusters already written on each item. Nothing is weighted and '
      + 'there is no score — this says where the work went, not how well it went.',
    historyNote: days.length < 7
      ? `Closures are recorded on ${days.length} day(s), and ${undated} done item(s) carry no `
        + 'date at all. That is too little to read as a trend, which is why there is no '
        + 'level or XP figure here.'
      : null,
  });
});

module.exports = router;
module.exports.decidedSince = decidedSince;
