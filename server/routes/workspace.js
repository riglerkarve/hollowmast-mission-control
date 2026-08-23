'use strict';
//
// workspace.js — M258: one screen showing all projects with status,
// last commit, open items, and activity momentum.
//
// GET /api/workspace — returns { projects: [{ name, lastCommit, commitAge, commits7d,
//   openItems, itemsKnown, git, gitError, status }], missing, totalProjects,
//   declaredProjects, activeProjects, dormantProjects, parkedProjects, unknownProjects }
//
// Reads the filesystem and git directly — no new tracking to maintain.
//
// (The shape above previously advertised a `path` field this route has never returned.
// Corrected rather than added: publishing the absolute path of every project is not
// something this endpoint needs to do.)

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const git = require('../git');

const router = express.Router();

// The workspace root — THREE levels up (server/routes/ -> server/ -> mission-control/ ->
// workspace). It was two, which resolves to mission-control ITSELF, so every path built
// below was mission-control/Survive, mission-control/emberfall and so on. None exist, the
// existsSync guard skipped all twelve without a word, and the route answered 200 with an
// empty list. The panel rendered "0 projects, 0 active, 0 dormant, 0 parked" — which is
// exactly what a genuinely empty workspace would look like, so nothing ever read as wrong.
//
// ASSERTED, NOT ASSUMED. An off-by-one in a path is invisible in its output: a wrong
// directory that happens to exist returns a confident, wrong answer, and this one survived
// because it returned a *plausible* one. `rootOk` records whether the workspace actually
// looks like the workspace, and the route reports the failure rather than an empty list.
const PROJECT_DIR = path.join(__dirname, '..', '..');
const ROOT = path.join(PROJECT_DIR, '..');
const rootOk = fs.existsSync(path.join(ROOT, 'mission-control'));

// The project vocabulary has ONE OWNER — projects.js, whose own comment says so: "a second
// list of projects is a second place the truth lives". This file used to carry its own
// array of twelve bare directory names, which is part of M272 (six separate PROJECTS lists
// define the workspace vocabulary).
//
// It was not merely duplication, it was WRONG, and in a way nothing could see. The bare
// names are DIRECTORIES — 'Survive', 'mission-control'. `todo_items.project` stores DISPLAY
// names — 'HOLLOWMAST', 'Mission Control'. So the open-items count matched neither: every
// project reported 0 open items while Mission Control alone had 65. A figure that is always
// zero looks like a quiet backlog rather than a broken join, which is why it survived.
//
// projects.js carries both (`dir` and `name`), so importing it fixes the count and removes
// a duplicate list in the same change. It also carries The Garage, which this list omitted.
const { PROJECTS } = require('./projects');

router.get('/', (req, res) => {
  // A root that is not the workspace is a FAILURE TO LOOK, and it must not be served as a
  // workspace containing nothing. This is the whole reason the off-by-one went unnoticed.
  if (!rootOk) {
    return res.status(500).json({
      projects: [], missing: [], totalProjects: 0, activeProjects: 0,
      dormantProjects: 0, parkedProjects: 0, unknownProjects: 0,
      error: `workspace root does not contain mission-control: ${ROOT}`,
    });
  }

  const projects = [];
  const missing = [];

  for (const proj of PROJECTS) {
    const name = proj.name;
    const ppath = path.join(ROOT, proj.dir);
    // A declared project that is not on disk is REPORTED, not skipped. A filter that drops
    // candidates silently makes the survivors look like the whole set — and it was this
    // exact `continue` that hid all twelve when the root was wrong.
    if (!fs.existsSync(ppath)) { missing.push(name); continue; }

    // Three git states, never two. `not-a-repo` and `error` both used to land in the same
    // empty catch as "no commits", so a project whose git call FAILED rendered identically
    // to one that has simply not been committed to — and then got called 'parked', which is
    // a claim about activity made from a measurement that never happened.
    let lastCommit = null, commitAge = null, commits7d = 0;
    let gitState = 'ok', gitError = null;
    if (!git.available) {
      // Not "this project has no history" — this server cannot run git at all. Reported
      // once per project because the card is where the reader is looking, and reported as a
      // failure rather than a zero.
      gitState = 'error';
      gitError = 'git is not available to the server';
    } else if (!fs.existsSync(path.join(ppath, '.git'))) {
      gitState = 'not-a-repo';
    } else {
      const log = git.run(['log', '-1', '--format=%ai|%s'], { cwd: ppath });
      if (log.ok) {
        const line = log.out.trim();
        if (line) {
          const [date, ...subj] = line.split('|');
          lastCommit = { date: date.slice(0, 10), subject: subj.join('|').slice(0, 80) };
          const ageMs = Date.now() - new Date(date).getTime();
          commitAge = Math.floor(ageMs / 86400000);
        }
        const count = git.run(['log', '--since=7 days ago', '--oneline'], { cwd: ppath });
        // A failure counting recent commits is not zero recent commits.
        if (count.ok) commits7d = count.out.trim() ? count.out.trim().split('\n').length : 0;
        else { gitState = 'error'; gitError = count.error; }
      } else {
        // A repo with no commits yet exits non-zero on `git log`. That is a real, empty
        // history rather than a fault, and it is the one case worth separating from a
        // genuine error — otherwise a fresh repo reads as broken.
        gitState = /does not have any commits|unknown revision|ambiguous argument/i.test(String(log.error))
          ? 'no-commits' : 'error';
        if (gitState === 'error') gitError = log.error;
      }
    }

    // Open items from the backlog, matched on the DISPLAY name (what todo_items stores) and
    // on the directory, so a row filed under either spelling is counted once. Both come from
    // projects.js rather than being derived here by lowercasing and hyphenating — a guess at
    // a naming convention is how the previous version matched nothing at all.
    let openItems = 0, itemsKnown = true;
    try {
      const r = db.prepare(
        "SELECT COUNT(*) n FROM todo_items WHERE status = 'open' AND (project = ? OR project = ?)"
      ).get(name, proj.dir);
      openItems = r ? r.n : 0;
    } catch (e) { itemsKnown = false; }

    // Status: active (commits in 7d), dormant (commits in 30d), parked (none in 30d) —
    // and `unknown` when git could not be read, because every one of the other three is a
    // statement about activity that requires having measured it.
    let status;
    if (gitState === 'error') status = 'unknown';
    else if (commits7d > 0) status = 'active';
    else if (commitAge !== null && commitAge < 30) status = 'dormant';
    else status = 'parked';

    projects.push({ name, lastCommit, commitAge, commits7d, openItems, itemsKnown, git: gitState, gitError, status });
  }

  res.json({
    projects,
    missing,
    // Stated once, at the top, because "this server cannot run git" is one fact about the
    // machine and not twelve facts about the projects. Without it the panel would repeat the
    // same failure on every card and none of them would say what was actually wrong.
    gitAvailable: git.available,
    gitVersion: git.version,
    totalProjects: projects.length,
    declaredProjects: PROJECTS.length,
    activeProjects: projects.filter(p => p.status === 'active').length,
    dormantProjects: projects.filter(p => p.status === 'dormant').length,
    parkedProjects: projects.filter(p => p.status === 'parked').length,
    unknownProjects: projects.filter(p => p.status === 'unknown').length,
  });
});

module.exports = router;