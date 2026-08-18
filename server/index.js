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
const budgetRouter = require('./routes/budget');
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
const heartbeat = require('./heartbeat');
const gate = require('./gate');

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
app.use('/api/budget', budgetRouter);
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
    console.log(`  access key: ${gate.KEY}   (also in ${gate.KEY_FILE})`);
  }
  heartbeat.start();
});
