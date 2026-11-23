import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src', 'app.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  write: false
});

const jsCode = result.outputFiles[0].text.replace(/<\/script>/gi, '<\\/script>');

// Validate bundled JS parses cleanly BEFORE inlining
new Function(jsCode);

const template = fs.readFileSync(path.join(root, 'src', 'app-template.html'), 'utf8');
// IMPORTANT: Use a replacer function () => jsCode so $&, $`, $' inside minified JS are NEVER expanded!
const html = template.replace('/*__INLINE_APP_BUNDLE__*/', () => jsCode);

if (html.includes('/*__INLINE_APP_BUNDLE__*/')) {
  throw new Error('Template placeholder was not replaced');
}

// Re-verify extracted inline script from final HTML parses cleanly
const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
if (!scriptMatch) throw new Error('Missing <script> block in built HTML');
new Function(scriptMatch[1]);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const outPath = path.join(root, 'dist', 'app.html');
fs.writeFileSync(outPath, html, 'utf8');
console.log(`Built & syntax-verified single-file MCP App: ${outPath} (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB)`);
