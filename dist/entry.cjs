// entry.cjs  –  pkg entry point bootstrap
//
// Purpose: guarantee dotenv is loaded (with the correct .env path) BEFORE
// any bundled ESM module code runs.  In the CJS bundle produced by esbuild,
// require() calls execute in order, but we still need dotenv to fire before
// the Groq / whatsapp-web.js initialisation at the top of main.js.
//
// When packaged by @yao-pkg/pkg:
//   process.pkg           == true
//   process.execPath      == full path to wa-summariser.exe
//   => .env lives next to the .exe
//
// In plain node (dev / debugging dist manually):
//   => .env lives in process.cwd()

const path = require('path');
const dotenv = require('dotenv');

const envDir = process.pkg
    ? path.dirname(process.execPath)
    : process.cwd();

const result = dotenv.config({ path: path.join(envDir, '.env') });
if (result.error && result.error.code !== 'ENOENT') {
    console.warn('[BOOT] dotenv warning:', result.error.message);
}

// Now load the actual application bundle
require('./bundle.cjs');
