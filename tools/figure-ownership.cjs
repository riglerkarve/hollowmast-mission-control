#!/usr/bin/env node
'use strict';

// figure-ownership.cjs — compare duplicate figures without deciding which is correct.
//
// It names the routes, fields, values and coverage window for each comparison. A mismatch is
// deliberately only a disagreement: reconciling it belongs to the route owner, not this tool.
// This script opens no database; it reads the running API only.

const BASE = process.env.MC_BASE || 'http://127.0.0.1:3000';
let findings = 0;

async function get(route) {
  const response = await fetch(BASE + route, {
    headers: { 'X-MC-By': 'codex' }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${route} answered ${response.status}`);
  return response.json();
}

function value(value) { return value === null ? 'null' : String(value); }
function heading(name, window) { console.log(`\n${name}\n  window: ${window}`); }
function source(route, field, actual) { console.log(`  ${route} ${field} = ${value(actual)}`); }
function agree() { console.log('  RESULT: AGREES'); }
function disagree() { console.log('  RESULT: DISAGREEMENT — route owners must reconcile this; this tool does not choose a value.'); findings += 1; }
function unavailable(reason) { console.log(`  RESULT: NOT COMPARED — ${reason}`); }

function equalPair(name, window, left, right) {
  heading(name, window);
  source(left.route, left.field, left.value);
  source(right.route, right.field, right.value);
  if (typeof left.value !== 'number' || typeof right.value !== 'number') unavailable('one source did not emit a numeric figure');
  else if (left.value === right.value) agree();
  else disagree();
}

(async () => {
  const [budget, wishlist, todo, todoItems, board, boardItems, schedule, scheduleEvents, financeSummary, financeTransactions, financeMonths, cash, cashCounts, income, incomeEntries, netWorth] = await Promise.all([
    get('/api/budget'), get('/api/budget/wishlist'), get('/api/todo'), get('/api/todo/items'),
    get('/api/board'), get('/api/board/items'), get('/api/schedule'), get('/api/schedule/events'),
    get('/api/finance/summary'), get('/api/finance/transactions?limit=500'), get('/api/finance/months'),
    get('/api/cash'), get('/api/cash/counts'), get('/api/income'), get('/api/income/entries?months=120'),
    get('/api/finance/net-worth'),
  ]);

  const budgetWindow = budget.month && wishlist.month && budget.month === wishlist.month
    ? `current budget month ${budget.month}` : 'UNSTATED OR DIFFERENT MONTHS';
  equalPair('Budget headroom', budgetWindow,
    { route: '/api/budget', field: 'headroomPence', value: budget.headroomPence },
    { route: '/api/budget/wishlist', field: 'headroomPence', value: wishlist.headroomPence });
  if (budgetWindow === 'UNSTATED OR DIFFERENT MONTHS') findings += 1;

  equalPair('Todo total items', 'all rows in the todo store, no filter',
    { route: '/api/todo', field: 'total', value: todo.total },
    { route: '/api/todo/items', field: 'totalInStore', value: todoItems.totalInStore });

  equalPair('Board external-item total', 'all imported board items, including closed rows',
    { route: '/api/board', field: 'counts.externalTotal', value: board.counts && board.counts.externalTotal },
    { route: '/api/board/items', field: 'items.length', value: Array.isArray(boardItems.items) ? boardItems.items.length : null });

  equalPair('Schedule stored-event total', 'all schedule rows before any optional /events filters',
    { route: '/api/schedule', field: 'counts.total', value: schedule.counts && schedule.counts.total },
    { route: '/api/schedule/events', field: 'totalStored', value: scheduleEvents.totalStored });

  const monthSum = Array.isArray(financeMonths) ? financeMonths.reduce((total, row) => total + Number(row.n || 0), 0) : null;
  heading('Finance imported transaction total', 'all ledger rows, unfiltered');
  source('/api/finance/summary', 'imported', financeSummary.imported);
  source('/api/finance/transactions?limit=500', 'total', financeTransactions.total);
  source('/api/finance/months', 'sum(n)', monthSum);
  if ([financeSummary.imported, financeTransactions.total, monthSum].every((n) => typeof n === 'number')
      && financeSummary.imported === financeTransactions.total && financeSummary.imported === monthSum) agree();
  else disagree();

  heading('Cash count records', 'all cash-count records; /counts returns at most its documented 50 newest rows');
  source('/api/cash', 'counts', cash.counts);
  source('/api/cash/counts', 'array.length', Array.isArray(cashCounts) ? cashCounts.length : null);
  if (!Array.isArray(cashCounts) || typeof cash.counts !== 'number') unavailable('one source did not emit a count');
  else if (cash.counts > 50) unavailable('the route is capped at 50, so its window is shorter than all records');
  else if (cash.counts === cashCounts.length) agree();
  else disagree();

  heading('Income total by currency', 'all recorded periods only when the summary starts within /entries?months=120 coverage');
  const incomeTotals = new Map((income.totals || []).map((row) => [row.currency, row.pence]));
  const entryTotals = new Map((incomeEntries.totals || []).map((row) => [row.currency, row.pence]));
  console.log(`  /api/income periods = ${income.firstPeriod || 'none'}..${income.lastPeriod || 'none'}`);
  console.log(`  /api/income/entries?months=120 from = ${incomeEntries.from || 'unstated'}`);
  if (!income.firstPeriod || !incomeEntries.from || income.firstPeriod < incomeEntries.from) {
    unavailable('the 120-month endpoint does not cover the summary’s full stated period');
  } else {
    const currencies = new Set([...incomeTotals.keys(), ...entryTotals.keys()]);
    let same = true;
    for (const currency of [...currencies].sort()) {
      const left = incomeTotals.get(currency);
      const right = entryTotals.get(currency);
      source('/api/income totals', currency, left);
      source('/api/income/entries?months=120 totals', currency, right);
      if (left !== right) same = false;
    }
    if (same) agree(); else disagree();
  }

  heading('Latest imported bank balance by account', 'each account’s latest transaction; both routes state its as-of date');
  const latestTransaction = new Map();
  for (const row of financeTransactions.transactions || []) {
    if (!latestTransaction.has(row.account_id)) latestTransaction.set(row.account_id, row);
  }
  let comparableBalances = 0;
  let balanceDisagreements = 0;
  for (const cashRow of netWorth.cash || []) {
    const transaction = latestTransaction.get(cashRow.id);
    if (!transaction) {
      console.log(`  /api/finance/net-worth cash[${cashRow.id}] = ${value(cashRow.pence)}; /transactions = not present in latest 500`);
      continue;
    }
    comparableBalances += 1;
    console.log(`  account ${cashRow.id}: /net-worth cash.pence = ${value(cashRow.pence)} as of ${cashRow.asOf}; /transactions balance_pence = ${value(transaction.balance_pence)} as of ${transaction.date}`);
    if (cashRow.asOf !== transaction.date || cashRow.pence !== transaction.balance_pence) {
      balanceDisagreements += 1;
      disagree();
    }
  }
  if (!comparableBalances) unavailable('no account’s latest row was in the documented 500-row transaction page');
  else if (!balanceDisagreements) agree();

  console.log(`\n${findings ? `DISAGREEMENTS OR WINDOW FINDINGS: ${findings}` : 'PASS: every comparable duplicate figure agrees; non-comparable windows are stated above.'}`);
  process.exitCode = findings ? 1 : 0;
})().catch((error) => {
  console.error(`COULD NOT COMPARE: ${error.message}`);
  process.exitCode = 2;
});
