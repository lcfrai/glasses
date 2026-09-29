import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const q=value=>JSON.stringify(value);
const port=process.env.GLASSES_PORT||'4317';
process.stdout.write(`# Add this block to project .codex/config.toml; preserve existing entries.\n# Keep the Glasses local server running (./glasses.ps1 start on Windows).\n# glasses_local avoids the unrelated Visual Foundry glasses plugin.\n[mcp_servers.glasses_local]\ncommand = ${q(process.execPath)}\nargs = [${q(path.join(root,'src/mcp.mjs'))}]\ncwd = ${q(root)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\n\n[mcp_servers.glasses_local.env]\nGLASSES_URL = ${q('http://127.0.0.1:'+port)}\n`);
