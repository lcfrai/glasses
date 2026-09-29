import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $entropy = [Text.Encoding]::UTF8.GetBytes('Glasses/jev/credential/v1')
  if ($request.action -eq 'protect') {
    $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.value)
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($result))
  } elseif ($request.action -eq 'unprotect') {
    $bytes = [Convert]::FromBase64String([string]$request.value)
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($result))
  } else { exit 2 }
} catch { exit 1 }
`;

export function credentialError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096 || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw credentialError('INVALID_KEY', 'Enter a valid Jev API key (8–4096 characters, without spaces).');
  }
  return value;
}

// The only secret-bearing channel is stdin/stdout of this owned child. Neither the
// command line nor an on-disk script contains the key. DPAPI binds ciphertext to
// the current Windows user; this does not protect against code running as them.
function dpapi(action, value) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolvePromise(result);
    };
    const fail = () => finish(credentialError('CREDENTIAL_STORAGE', 'Windows protected credential storage is unavailable.'));
    const timer = setTimeout(() => { child.kill(); fail(); }, 10000);
    child.on('error', fail);
    child.stderr.on('data', () => {});
    child.stdin.on('error', fail);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 32768) { child.kill(); fail(); }
    });
    child.on('close', code => code === 0 ? finish(null, output) : fail());
    child.stdin.end(JSON.stringify({ action, value }));
  });
}

export function createCredentialStore({ dataDir, platform = process.platform, protect = dpapi } = {}) {
  if (!dataDir) throw new TypeError('dataDir is required');
  const directory = join(resolve(dataDir), 'credentials');
  const file = join(directory, 'jev.dpapi.json');
  const storage = platform === 'win32' ? 'windows-dpapi' : 'session-only';
  let sessionKey = null, mutation = Promise.resolve(), cachedStatus, statusAt = 0;
  const serial = operation => {
    const result = mutation.then(operation, operation);
    mutation = result.catch(() => {});
    return result;
  };
  async function load() {
    await mutation;
    if (storage === 'session-only') return sessionKey;
    let raw;
    try { raw = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw credentialError('CREDENTIAL_STORAGE', 'Cannot read the protected Jev credential.');
    }
    try {
      if (raw.length > 32768) throw new Error();
      const record = JSON.parse(raw);
      if (record.version !== 1 || record.storage !== storage || typeof record.ciphertext !== 'string' || !/^[A-Za-z0-9+/=]+$/u.test(record.ciphertext)) throw new Error();
      return validateKey(await protect('unprotect', record.ciphertext));
    } catch {
      throw credentialError('CREDENTIAL_STORAGE', 'Cannot unlock the Jev key for this Windows user. Re-enter the key.');
    }
  }
  return {
    async status({ force = false } = {}) {
      if (!force && cachedStatus && Date.now() - statusAt < 30000) return { ...cachedStatus };
      try { cachedStatus = { configured: Boolean(await load()), storage }; }
      catch { cachedStatus = { configured: false, storage, error: 'Cannot unlock the saved Jev key. Re-enter the key.' }; }
      statusAt = Date.now();
      return { ...cachedStatus };
    },
    load,
    async save(value) {
      const key = validateKey(value);
      await serial(async () => {
        cachedStatus = undefined;
        if (storage === 'session-only') { sessionKey = key; return; }
        let temporary;
        try {
          const ciphertext = await protect('protect', key);
          if (!/^[A-Za-z0-9+/=]+$/u.test(ciphertext) || ciphertext.length > 32768) throw new Error();
          await mkdir(directory, { recursive: true, mode: 0o700 });
          temporary = join(directory, `${randomUUID()}.tmp`);
          await writeFile(temporary, JSON.stringify({ version: 1, storage, ciphertext }), { mode: 0o600, flag: 'wx' });
          await rename(temporary, file);
        } catch {
          if (temporary) await rm(temporary, { force: true }).catch(() => {});
          throw credentialError('CREDENTIAL_STORAGE', 'Could not save the Jev key in Windows protected storage.');
        }
      });
      return this.status();
    },
    async remove() {
      await serial(async () => {
        cachedStatus = undefined;
        sessionKey = null;
        try { await rm(file, { force: true }); }
        catch { throw credentialError('CREDENTIAL_STORAGE', 'Could not remove the protected Jev key.'); }
      });
      return { configured: false, storage };
    }
  };
}
