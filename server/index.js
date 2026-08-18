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
const garageRouter = require('./routes/garage');
const safetyRouter = require('./routes/safety');
const browsingRouter = require('./routes/browsing');
const atlasRouter = require('./routes/atlas');
const goalsRouter = require('./routes/goals');
const scheduleRouter = require('./routes/schedule');
const projectsRouter = require('./routes/projects');
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
app.use('/api/safety', safetyRouter);
app.use('/api/browsing', browsingRouter);
app.use('/api/atlas', atlasRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/projects', projectsRouter);
app.use('/garage', garageRouter);

app.use(express.static(path.join(__dirname, '..', 'public')));

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
