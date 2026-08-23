#!/usr/bin/env node
// backup-crypt.cjs — encrypt a backup before it leaves this machine, and decrypt it back.
//
//   node tools/backup-crypt.cjs encrypt <in> <out>
//   node tools/backup-crypt.cjs decrypt <in> <out>
//   node tools/backup-crypt.cjs selftest          round-trips a temp file, writes nothing else
//
// Owner instruction, 23 Aug 2026: the daily OneDrive copy of the database must be
// encrypted. It holds 6,839 real bank transactions plus health and wellbeing entries.
//
// ---------------------------------------------------------------------------------------
// THE PASSPHRASE IS NOT GENERATED HERE AND IS NEVER PRINTED.
//
// It is read from data/backup-key.txt, which is gitignored. Nothing in this repository, no
// session, and no log ever contains it. A passphrase that passed through a Claude session's
// context is one you should assume is compromised, so this tool is built never to need it.
//
// ---------------------------------------------------------------------------------------
// THE FAILURE THIS DESIGN EXISTS TO PREVENT, AND IT IS THE WHOLE POINT.
//
// The OneDrive copy exists to survive THIS DISK DYING. If the only copy of the key is on
// this disk, then in exactly that scenario the backup is a 30 MB file nobody alive can
// open. Encryption would have converted a recoverable loss into an unrecoverable one, while
// feeling like an improvement.
//
// So the passphrase MUST also exist somewhere that is not this machine — a password
// manager, a paper note, anywhere off-disk. data/backup-key.txt says so at the top of
// itself, and this tool refuses to run while the file still contains the placeholder,
// because a default key is not a key.
//
// ---------------------------------------------------------------------------------------
// WHY THESE PRIMITIVES. Node's built-in crypto only — the workspace rule is to ask before
// adding any third-party dependency, and nothing here needs one.
//
//   scrypt      key derivation, N=2^15. Deliberately slow, so a weak passphrase costs an
//               attacker time rather than being a straight lookup.
//   AES-256-GCM authenticated. A tampered or truncated file FAILS to decrypt rather than
//               yielding plausible garbage — which for a database backup is the difference
//               between "restore refused" and "restored something subtly wrong".
//   random salt and IV per file, stored in the header. Reusing either across daily backups
//               would leak that two days are similar, which for an append-mostly database
//               is most days.
//
// FILE FORMAT, so a future reader can decrypt without this script:
//   magic "MCBK1\0"  (6 bytes) · salt (32) · iv (12) · authTag (16) · ciphertext
//   key = scrypt(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128MB })

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const KEY_FILE = path.join(ROOT, 'data', 'backup-key.txt');
const MAGIC = Buffer.from('MCBK1\0', 'latin1');
const SALT_LEN = 32, IV_LEN = 12, TAG_LEN = 16;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const PLACEHOLDER = 'REPLACE-THIS-WITH-YOUR-OWN-PASSPHRASE';

function passphrase() {
  if (!fs.existsSync(KEY_FILE)) {
    throw new Error(`no passphrase file at ${KEY_FILE}. Create it, put a long passphrase on the `
      + 'first non-comment line, and STORE THE SAME PASSPHRASE OFF THIS MACHINE.');
  }
  const line = fs.readFileSync(KEY_FILE, 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0];
  if (!line) throw new Error(`${KEY_FILE} has no passphrase line (only comments or blanks).`);
  if (line === PLACEHOLDER) {
    throw new Error('the passphrase is still the placeholder. A default key is not a key — '
      + 'replace it, and store the same value somewhere that is not this disk.');
  }
  if (line.length < 16) throw new Error(`passphrase is ${line.length} characters. Use at least 16.`);
  return line;
}

function encrypt(inPath, outPath, pass) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(fs.readFileSync(inPath)), cipher.final()]);
  // The tag is only available AFTER final(), which is why the header is assembled here
  // rather than streamed — for a 30 MB file that is a fine trade for a simpler format.
  fs.writeFileSync(outPath, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]));
  return { bytesIn: fs.statSync(inPath).size, bytesOut: fs.statSync(outPath).size };
}

function decrypt(inPath, outPath, pass) {
  const buf = fs.readFileSync(inPath);
  if (buf.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN) throw new Error('file is too short to be MCBK1');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an MCBK1 file (bad magic)');
  let o = MAGIC.length;
  const salt = buf.subarray(o, o += SALT_LEN);
  const iv = buf.subarray(o, o += IV_LEN);
  const tag = buf.subarray(o, o += TAG_LEN);
  const key = crypto.scryptSync(pass, salt, 32, SCRYPT);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  // Throws on a wrong passphrase OR a tampered file. That is the point of GCM: there is no
  // "decrypted successfully into rubbish" outcome to mistake for a restore.
  fs.writeFileSync(outPath, Buffer.concat([d.update(buf.subarray(o)), d.final()]));
  return { bytesOut: fs.statSync(outPath).size };
}

// ---------------------------------------------------------------- self test
// Uses its own throwaway passphrase, so it proves the crypto without touching the real key
// and without needing one to exist. Four cases, and three of them must FAIL.
function selftest() {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mcbk-'));
  const plain = path.join(tmp, 'plain.bin');
  const enc = path.join(tmp, 'enc.bin');
  const out = path.join(tmp, 'out.bin');
  const data = crypto.randomBytes(64 * 1024);
  fs.writeFileSync(plain, data);
  const P = 'a-test-passphrase-not-the-real-one';
  let pass = 0, fail = 0;
  const check = (label, want, fn) => {
    let got;
    try { fn(); got = 'ok'; } catch (e) { got = 'threw'; }
    const good = got === want;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${label} — ${got}, wanted ${want}`);
    good ? pass++ : fail++;
  };

  check('round trip with the right passphrase', 'ok', () => {
    encrypt(plain, enc, P);
    decrypt(enc, out, P);
    if (!fs.readFileSync(out).equals(data)) throw new Error('bytes differ');
  });
  check('WRONG passphrase is rejected', 'threw', () => decrypt(enc, out, P + 'x'));
  check('TAMPERED ciphertext is rejected', 'threw', () => {
    const b = fs.readFileSync(enc);
    b[b.length - 1] ^= 0x01;
    const t = path.join(tmp, 'tampered.bin');
    fs.writeFileSync(t, b);
    decrypt(t, out, P);
  });
  check('TRUNCATED file is rejected', 'threw', () => {
    const t = path.join(tmp, 'trunc.bin');
    fs.writeFileSync(t, fs.readFileSync(enc).subarray(0, 5000));
    decrypt(t, out, P);
  });
  // The encrypted file must not simply be the plaintext.
  check('ciphertext differs from plaintext', 'ok', () => {
    if (fs.readFileSync(enc).includes(data.subarray(0, 256))) throw new Error('plaintext found in ciphertext');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'selftest') { selftest(); }
  else if (cmd === 'encrypt') { const r = encrypt(a, b, passphrase()); console.log(`encrypted ${r.bytesIn} -> ${r.bytesOut} bytes`); }
  else if (cmd === 'decrypt') { const r = decrypt(a, b, passphrase()); console.log(`decrypted -> ${r.bytesOut} bytes`); }
  else { console.log('usage: backup-crypt.cjs encrypt|decrypt <in> <out>   |   selftest'); process.exitCode = 2; }
} catch (e) {
  console.error('FAILED: ' + e.message);
  process.exitCode = 1;
}

module.exports = { encrypt, decrypt, passphrase, KEY_FILE, PLACEHOLDER };
