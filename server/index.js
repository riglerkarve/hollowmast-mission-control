const express = require('express');
const path = require('node:path');
const os = require('node:os');

const tasksRouter = require('./routes/tasks');
const sessionsRouter = require('./routes/sessions');
const statsRouter = require('./routes/stats');
const uptimeRouter = require('./routes/uptime');
const financeRouter = require('./routes/finance');
const briefingRouter = require('./routes/briefing');
const brainRouter = require('./routes/brain');
const workRouter = require('./routes/work');
const exerciseRouter = require('./routes/exercise');
const budgetRouter = require('./routes/budget');
const cashRouter = require('./routes/cash');
const mailRouter = require('./routes/mail');
const driveRouter = require('./routes/drive');
const alertsRouter = require('./routes/alerts');
const todoRouter = require('./routes/todo');
const incomeRouter = require('./routes/income');
const lifestyleRouter = require('./routes/lifestyle');
const wellbeingRouter = require('./routes/wellbeing');
const healthRouter = require('./routes/health');
const serversRouter = require('./routes/servers');
const panelUsageRouter = require('./routes/panel-usage');
// Both route files existed with endpoints and were never mounted, so their panels
// fetched a 404 and rendered empty. A panel that renders is not a panel that works.
const habitTrackerRouter = require('./routes/habit-tracker');
const launchReadinessRouter = require('./routes/launch-readiness');
// M148: the SEPARATE, later question — go commercial once HOLLOWMAST has shipped and been
// played. launch-readiness.js checks fitness to ship; phase5.js is not that route extended.
const phase5Router = require('./routes/phase5');
const garageRouter = require('./routes/garage');
const safetyRouter = require('./routes/safety');
const browsingRouter = require('./routes/browsing');
const atlasRouter = require('./routes/atlas');
const boardRouter = require('./routes/board');
const teamRouter = require('./routes/team');
const goalsRouter = require('./routes/goals');
const viabilityRouter = require('./routes/viability');
const scheduleRouter = require('./routes/schedule');
const workingHoursRouter = require('./routes/working-hours');
const projectsRouter = require('./routes/projects');
const machineRouter = require('./routes/machine');
const analyticsRouter = require('./routes/analytics');
const voiceRouter = require('./routes/voice');
const ledeRouter = require('./routes/lede');
const activityRouter = require('./routes/activity');
const commandRouter = require('./routes/command');
const inboxRouter = require('./routes/inbox');
const staleRouter = require('./routes/stale');
const agentsRouter = require('./routes/agents');
const healthCheckRouter = require('./routes/health-check');
const prioritizeRouter = require('./routes/prioritize');
const creativeRouter = require('./routes/creative');
const serendipityRouter = require('./routes/serendipity');
const journalRouter = require('./routes/journal');
const venturesRouter = require('./routes/ventures');
const digestRouter = require('./routes/digest');
const decisionsRouter = require('./routes/decisions');
const changesRouter = require('./routes/changes');
const timeAllocationRouter = require('./routes/timeallocation');
const workspaceRouter = require('./routes/workspace');
const crmRouter = require('./routes/crm');
const inventoryRouter = require('./routes/inventory');
const hollowmastRouter = require('./routes/hollowmast');
const gitHeatmapRouter = require('./routes/git-heatmap');
const printprofitRouter = require('./routes/printprofit');
const bulkImportRouter = require('./routes/bulk-import');
const searchRouter = require('./routes/search');
const dependencyGraphRouter = require('./routes/dependency-graph');
const healthScoreRouter = require('./routes/health-score');
const recurringCostsRouter = require('./routes/recurring-costs');
const goalStalenessRouter = require('./routes/goal-staleness');
const browsingRecallRouter = require('./routes/browsing-recall');
const safetyRetroRouter = require('./routes/safety-retro');
const claudeTimelineRouter = require('./routes/claude-timeline');
const socialRouter = require('./routes/social');
const weeklySynthesisRouter = require('./routes/weekly-synthesis');
const sunoRouter = require('./routes/suno');
const openTasksRouter = require('./routes/open-tasks');
const heartbeat = require('./heartbeat');
const gate = require('./gate');
const provenance = require('./provenance');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] Uncaught exception:`, err);
  heartbeat.crashed(`uncaughtException: ${err && err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, err);
  heartbeat.crashed(`unhandledRejection: ${err && err.message}`);
  process.exit(1);
});

const app = express();
app.use(express.json());

// Who wrote this? Default unknown, never guessed. See server/provenance.js.
app.use(provenance.middleware);

// Carry that identity down into the database layer, so a read of a sensitive table is
// attributed to whoever made the request rather than to the process. Backlog #14.
// Mounted immediately after provenance and BEFORE the gate, so a request that is about to
// be refused is still attributed — a rejected probe is exactly the access worth recording.
app.use((req, res, next) => db.runAs(req.by, next));

// The unlock page must be reachable before the gate, or there is no way through it.
gate.mount(app);

// Loopback passes straight through, so every local caller -- the watchdog, the
// browser on this machine, the importers -- is unaffected. A caller arriving over
// the LAN must present the key. See server/gate.js.
app.use(gate.gate);

app.use('/api/tasks', tasksRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/status', uptimeRouter);
app.use('/api/finance', financeRouter);
app.use('/api/briefing', briefingRouter);
app.use('/api/brain', brainRouter);
app.use('/api/work', workRouter);
app.use('/api/exercise', exerciseRouter);
app.use('/api/budget', budgetRouter);
app.use('/api/cash', cashRouter);
app.use('/api/mail', mailRouter);
app.use('/api/drive', driveRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/todo', todoRouter);
app.use('/api/income', incomeRouter);
app.use('/api/lifestyle', lifestyleRouter);
app.use('/api/wellbeing', wellbeingRouter);
app.use('/api/health', healthRouter);
app.use('/api/servers', serversRouter);
app.use('/api/panels', panelUsageRouter);
app.use('/api/habit-tracker', habitTrackerRouter);
app.use('/api/launch-readiness', launchReadinessRouter);
app.use('/api/phase5', phase5Router);
app.use('/api/safety', safetyRouter);
app.use('/api/browsing', browsingRouter);
app.use('/api/atlas', atlasRouter);
app.use('/api/board', boardRouter);
app.use('/api/team', teamRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/viability', viabilityRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/working-hours', workingHoursRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/machine', machineRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/voice', voiceRouter);
app.use('/api/lede', ledeRouter);
app.use('/api/activity', activityRouter);
app.use('/api/voice', commandRouter);
app.use('/api/inbox', inboxRouter);
app.use('/api/stale', staleRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/health-check', healthCheckRouter);
app.use('/api/prioritize', prioritizeRouter);
app.use('/api/creative', creativeRouter);
app.use('/api/serendipity', serendipityRouter);
app.use('/api/journal', journalRouter);
app.use('/api/ventures', venturesRouter);
app.use('/api/digest', digestRouter);
app.use('/api/decisions', decisionsRouter);
app.use('/api/changes', changesRouter);
app.use('/api/time-allocation', timeAllocationRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/crm', crmRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/hollowmast', hollowmastRouter);
app.use('/api/git-heatmap', gitHeatmapRouter);
app.use('/api/printprofit', printprofitRouter);
app.use('/api/bulk-import', bulkImportRouter);
app.use('/api/search', searchRouter);
app.use('/api/dependency-graph', dependencyGraphRouter);
app.use('/api/health-score', healthScoreRouter);
app.use('/api/recurring-costs', recurringCostsRouter);
app.use('/api/goal-staleness', goalStalenessRouter);
app.use('/api/browsing-recall', browsingRecallRouter);
app.use('/api/safety-retro', safetyRetroRouter);
app.use('/api/claude-timeline', claudeTimelineRouter);
app.use('/api/social', socialRouter);
app.use('/api/weekly-synthesis', weeklySynthesisRouter);
app.use('/api/suno', sunoRouter);
app.use('/api/open-tasks', openTasksRouter);
app.use('/garage', garageRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

// Requiring the application for a fault-injection test must not bind a real port or start
// the heartbeat. The executable server path remains identical; only `node server/index.js`
// starts it. This makes route failure behaviour testable against a temporary database.
function startServer() {
// The sampler is not started by requiring the module -- other processes require it for one
// helper and must not inherit a background timer. The server that serves the panel starts it.
machineRouter.startSampling();
app.listen(PORT, HOST, () => {
  const nets = os.networkInterfaces();
  const lanAddresses = Object.values(nets)
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);

  console.log(`Dashboard running:`);
  console.log(`  http://localhost:${PORT}`);
  lanAddresses.forEach((addr) => console.log(`  http://${addr}:${PORT}  (LAN -- needs the access key)`));
  if (lanAddresses.length) {
    // THE KEY IS PRINTED ONLY TO AN INTERACTIVE TERMINAL. Under MissionControl-Server
    // stdout is redirected to logs/server-<date>.log, and it had written the enrolment key
    // there 6 times on 17 Aug and 47 times on 18 Aug. That file is gitignored and the key
    // is already on this disk in gate-key.txt, so nothing escaped -- but a log is the thing
    // people paste into a bug report or hand over when asking for help, and a secret that
    // has been pasted somewhere cannot be un-pasted. isTTY is false for a redirect and for
    // a pipe, true for a person watching, which is exactly the distinction that matters.
    if (process.stdout.isTTY) {
      console.log(`  access key: ${gate.KEY}   (also in ${gate.KEY_FILE})`);
    } else {
      console.log(`  access key: not printed to a log -- read ${gate.KEY_FILE}`);
    }
  }
  heartbeat.start();
});
}

if (require.main === module) startServer();
module.exports = app;
module.exports.startServer = startServer;
