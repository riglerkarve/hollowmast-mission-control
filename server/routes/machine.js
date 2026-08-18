'use strict';
//
// machine.js — what this computer is doing right now.
//
// Owner request 18 Aug 2026: "live analytics, cpu temp, gpu temp and other systems stats".
//
// IT OWNS NO TABLES, DELIBERATELY. Every figure here is readable from the machine in
// milliseconds, so storing it would mean keeping a second copy of something already true. The
// only state is an in-memory ring so the panel can draw a trend; it is lost on restart, and
// that is right — a chart of the last few minutes is worth having, a database of it is not.
//
// WHAT IT DOES NOT OWN. `uptime.js` owns the SERVICE's uptime (`process.uptime()`, pid,
// startedAt). This reports the MACHINE's boot time, a different figure, and does not recompute
// the service's.
//
// THE FIRST VERSION OF THIS FILE TOOK 6 SECONDS PER SAMPLE and was replaced. It asked
// PowerShell for CPU, memory and disk; measured, `powershell -NoProfile` costs 1.6 s to start
// and `Get-CimInstance Win32_Processor` alone costs 3.5 s — 97% of the total. Node answers
// almost all of it natively in 17 ms: `os.cpus()` for the model and the times deltas that give
// real utilisation, `os.totalmem/freemem`, `os.uptime()` for boot, and `fs.statfs` for the
// disk. Cross-checked against the PowerShell figures before switching: 554.7 GB free and the
// same CPU either way. nvidia-smi stays, at 155 ms, because nothing in Node knows about the GPU.
//
// The cost of that mistake was not the six seconds. It was that the cache TTL was 3 s, SHORTER
// than a sample took, so a polling panel would have kept a PowerShell process running
// permanently. A slow read behind a short cache is a busy loop wearing a cache's clothes.
//
// CPU TEMPERATURE IS NOT AVAILABLE HERE, and every surface says so rather than showing a zero.
// `MSAcpi_ThermalZoneTemperature` answers "Access denied" without elevation and is unimplemented
// on most laptops even with it. The alternatives are all third-party (LibreHardwareMonitor,
// Intel Power Gadget); adding one is the owner's decision. So the field is `{ value: null,
// why: '...' }` — absent WITH A REASON, which is a different statement from zero and from
// "not sampled yet".
const express = require('express');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const router = express.Router();

const SAMPLE_MS = 5000;
const RING = 240;                 // 20 minutes at a 5 s cadence
const DISK_EVERY = 60;            // disk barely moves; 1 in 60 samples is every 5 minutes

// Why the CPU temperature is missing. Stated once, so the endpoint, the history and the panel
// cannot drift into three different explanations of the same gap.
const CPU_TEMP_WHY = 'Windows does not expose it without elevation: MSAcpi_ThermalZoneTemperature '
  + 'answers "Access denied", and most laptops do not implement it even elevated. Reading it '
  + 'needs a third-party tool (LibreHardwareMonitor, Intel Power Gadget), which is an owner '
  + 'decision rather than something a session should add.';

let latest = null;
let prevCpu = null;               // os.cpus() snapshot, for the load delta
let ticks = 0;
let lastDisk = null;
const history = [];

function cpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times;
    const idle = t.idle;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle, total };
  });
}

// Utilisation needs two readings. Before the second one exists the honest answer is null with a
// reason, not 0 — a machine at 0% and a machine not yet measured look identical otherwise.
function cpuLoad(prev, now) {
  if (!prev || prev.length !== now.length) return { pct: null, why: 'needs two samples', perCore: [] };
  let idleD = 0, totalD = 0;
  const perCore = [];
  for (let i = 0; i < now.length; i += 1) {
    const di = now[i].idle - prev[i].idle;
    const dt = now[i].total - prev[i].total;
    perCore.push(dt > 0 ? Math.round((1 - di / dt) * 1000) / 10 : null);
    idleD += di; totalD += dt;
  }
  if (totalD <= 0) return { pct: null, why: 'no time elapsed between samples', perCore };
  return { pct: Math.round((1 - idleD / totalD) * 1000) / 10, why: null, perCore };
}

function gpuOnce() {
  const q = 'name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,clocks.current.graphics';
  return new Promise((resolve) => {
    execFile('nvidia-smi', [`--query-gpu=${q}`, '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const why = String(stderr || err.message || '').trim().split('\n')[0] || 'nvidia-smi did not answer';
          return resolve({ available: false, why });
        }
        const f = String(stdout).trim().split('\n')[0].split(',').map((s) => s.trim());
        if (f.length < 7) return resolve({ available: false, why: `nvidia-smi returned ${f.length} fields, expected 7` });
        const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };
        resolve({
          available: true, name: f[0], tempC: num(f[1]), utilPct: num(f[2]),
          memUsedMiB: num(f[3]), memTotalMiB: num(f[4]), powerW: num(f[5]), clockMHz: num(f[6]),
        });
      });
  });
}

function diskOnce() {
  return new Promise((resolve) => {
    fs.statfs('C:/', (err, s) => {
      if (err) return resolve({ available: false, why: err.message });
      resolve({
        available: true,
        freeGB: Math.round((s.bfree * s.bsize) / 1073741824 * 10) / 10,
        totalGB: Math.round((s.blocks * s.bsize) / 1073741824 * 10) / 10,
      });
    });
  });
}

async function tick() {
  const now = cpuTimes();
  const load = cpuLoad(prevCpu, now);
  prevCpu = now;

  const gpu = await gpuOnce();
  if (ticks % DISK_EVERY === 0 || !lastDisk) lastDisk = await diskOnce();
  ticks += 1;

  const cpus = os.cpus();
  const totalMB = Math.round(os.totalmem() / 1048576);
  const usedMB = Math.round((os.totalmem() - os.freemem()) / 1048576);

  latest = {
    at: new Date().toISOString(),
    cpu: {
      model: (cpus[0] && cpus[0].model || '').trim(),
      // Logical processors. Physical core count is only available through WMI, which this
      // module deliberately no longer calls, so it is not claimed rather than guessed.
      threads: cpus.length,
      loadPct: load.pct,
      loadWhy: load.why,
      perCorePct: load.perCore,
      tempC: null,
      tempWhy: CPU_TEMP_WHY,
    },
    gpu,
    memory: { usedMB, totalMB, usedPct: totalMB ? Math.round((usedMB / totalMB) * 1000) / 10 : null },
    disk: lastDisk,
    machine: {
      platform: `${os.type()} ${os.release()}`,
      bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
      uptimeHours: Math.round(os.uptime() / 360) / 10,
    },
    service: { rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    sampleMs: SAMPLE_MS,
  };

  const notes = [];
  if (!gpu.available) notes.push(`GPU stats unavailable: ${gpu.why}`);
  if (load.pct === null) notes.push(`CPU load not yet computable: ${load.why}`);
  notes.push('CPU temperature is not available on this machine — see cpu.tempWhy.');
  latest.notes = notes;

  history.push({
    at: latest.at,
    cpuLoadPct: load.pct,
    gpuTempC: gpu.available ? gpu.tempC : null,
    gpuUtilPct: gpu.available ? gpu.utilPct : null,
    memUsedPct: latest.memory.usedPct,
  });
  while (history.length > RING) history.shift();
}

// Sampled on a timer rather than on request, so a request never waits for a subprocess and a
// fast poll cannot multiply the work. unref'd: this must never be the reason the process lives.
// SAMPLING IS NOT STARTED BY REQUIRING THIS FILE, and that is deliberate.
//
// The nightly briefing requires this module for one helper. When the sampler started at
// module scope, that require spawned nvidia-smi and set a 5-second timer inside a job that
// only wanted a memory figure -- a background process started as a side effect of an import.
// The server calls startSampling() when it mounts the route; nothing else has to.
let timer = null;
function startSampling() {
  if (timer) return timer;                 // idempotent: two callers must not double the rate
  timer = setInterval(() => { tick().catch(() => {}); }, SAMPLE_MS);
  if (timer.unref) timer.unref();          // never the reason the process stays alive
  tick().catch(() => {});
  return timer;
}

// GET /api/machine — the newest sample, with its age. Never blocks.
router.get('/', (req, res) => {
  if (!latest) {
    // 'sampling' is not an error and not zero: the first CPU load needs two readings.
    return res.json({ state: 'sampling', sampleMs: SAMPLE_MS, note: 'No sample yet. The first CPU load figure needs two readings.' });
  }
  res.json({ state: 'ok', ageMs: Date.now() - new Date(latest.at).getTime(), ...latest });
});

// GET /api/machine/history — the in-memory ring, for a trend line.
router.get('/history', (req, res) => {
  res.json({
    samples: history,
    count: history.length,
    capacity: RING,
    sampleMs: SAMPLE_MS,
    since: history.length ? history[0].at : null,
    inMemoryOnly: true,
    note: 'In memory only, lost on restart. Nothing is stored: every figure is readable from '
      + 'the machine on demand, and a second copy would be a second place the truth lives. '
      + 'Says how many samples it holds, because a two-point chart and a twenty-minute chart '
      + 'look the same at a glance.',
  });
});

// A single instantaneous reading of the two things that actually bite, for callers outside
// this process.
//
// WHY THIS EXISTS SEPARATELY FROM THE SAMPLER ABOVE. The ring and its 5-second timer live in
// the SERVER's memory. The nightly briefing is a different process: requiring this module there
// gets an empty ring and starts a second sampler that would spawn nvidia-smi every five seconds
// for the life of the job. So this function touches neither.
//
// IT READS ONLY MEMORY AND DISK, deliberately. CPU load cannot be had from one reading -- it is
// a delta between two -- and reporting a single-sample "load" would be a fabricated number.
// GPU needs a subprocess. Memory and disk are the two that fill up and stop things working, and
// Node answers both in microseconds.
//
// IT SETS NO THRESHOLD. It returns the percentages and lets the caller decide what is worth
// saying, because a threshold is a choice and the module that owns the reading should not also
// own someone else's opinion about it.
function pressureNow() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const usedMB = Math.round((os.totalmem() - os.freemem()) / 1048576);
  const memPct = totalMB ? Math.round((usedMB / totalMB) * 1000) / 10 : null;

  let disk = { available: false, why: 'not read' };
  try {
    const s = fs.statfsSync('C:/');
    const freeGB = Math.round((s.bfree * s.bsize) / 1073741824 * 10) / 10;
    const totalGB = Math.round((s.blocks * s.bsize) / 1073741824 * 10) / 10;
    disk = {
      available: true,
      freeGB,
      totalGB,
      usedPct: totalGB ? Math.round(((totalGB - freeGB) / totalGB) * 1000) / 10 : null,
    };
  } catch (e) {
    disk = { available: false, why: e.message };
  }

  return {
    at: new Date().toISOString(),
    memory: { usedMB, totalMB, usedPct: memPct },
    disk,
    // Named so a reader knows what this deliberately does not answer.
    notMeasured: 'CPU load needs two samples and GPU needs a subprocess; neither is read here.',
  };
}

module.exports = router;
module.exports.startSampling = startSampling;
module.exports.pressureNow = pressureNow;
