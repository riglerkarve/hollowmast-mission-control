// Staged negative test for server/git.js — proves the resolver can actually FAIL.
//
// A probe that only ever reports success is indistinguishable from a dead check, so the
// "git is available" result means nothing until the same code has been made to say the
// opposite. This blanks every location resolveGit() looks in, then requires the module
// fresh, and asserts it reports a failure rather than an empty result.
process.env.GIT_EXE = 'C:\\definitely\\not\\here\\git.exe';
process.env.ProgramFiles = 'C:\\definitely-not-here';
process.env['ProgramFiles(x86)'] = 'C:\\definitely-not-here';
process.env.LOCALAPPDATA = 'C:\\definitely-not-here';
process.env.PATH = 'C:\\Windows\\system32;C:\\Windows';

const git = require('../server/git.js');

const r = git.run(['log', '-1'], { cwd: __dirname });
console.log('available :', git.available);
console.log('how       :', git.how);
console.log('run.ok    :', r.ok);
console.log('run.reason:', r.reason);
console.log('run.error :', r.error);

const pass = git.available === false && r.ok === false && r.reason === 'no-git' && r.out === '';
console.log('\nVERDICT:', pass
  ? 'PASS — reports a FAILURE with a reason, and returns no output that could be mistaken for an empty result.'
  : 'FAIL — the negative case did not behave as claimed.');
process.exit(pass ? 0 : 1);
