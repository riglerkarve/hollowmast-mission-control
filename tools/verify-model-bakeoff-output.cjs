#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { gateLabel } = require('./model-bakeoff.cjs');

assert.equal(gateLabel(true), 'PASS');
assert.equal(gateLabel(false), 'FAIL');
assert.equal(gateLabel(null), '----');
assert.equal(gateLabel(undefined), '----');
process.stdout.write('passed: unmeasurable bakeoff gates render as ----, not FAIL\n');
