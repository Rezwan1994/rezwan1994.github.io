/**
 * Build script — zero dependencies.
 *
 * 1. Cleans and repopulates ./dist
 * 2. Copies the static site (index.html, styles.css, script.js, assets/)
 * 3. Validates every local href/src resolves, every internal #anchor
 *    matches a real id, and the CV PDF is present and non-empty
 *
 * Usage: node tools/build.mjs
 */

import { readFile, writeFile, mkdir, rm, cp, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const CV_ASSET = 'assets/Md-Rezwanul-Haque-CV.pdf';
const CV_FILENAME = 'Md-Rezwanul-Haque-CV.pdf';
const REQUIRED = ['index.html', 'styles.css', 'script.js', 'assets/profile-photo.jpg', CV_ASSET];

const errors = [];
const warnings = [];

const ok = (msg) => console.log(`  \u2713 ${msg}`);
const fail = (msg) => { errors.push(msg); console.log(`  \u2717 ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`  ! ${msg}`); };

/* ------------------------------------------------------------------ */
/* 1. Verify the source tree                                          */
/* ------------------------------------------------------------------ */
console.log('\nVerifying source files');
for (const rel of REQUIRED) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
        fail(`missing source file: ${rel}`);
    } else {
        const info = await stat(abs);
        if (info.size === 0) fail(`empty source file: ${rel}`);
        else ok(`${rel} (${(info.size / 1024).toFixed(1)} kB)`);
    }
}
if (errors.length) { finish(); }

/* ------------------------------------------------------------------ */
/* 2. Validate the HTML: local refs + anchors + CV download wiring     */
/* ------------------------------------------------------------------ */
console.log('\nValidating index.html');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
ok(`${ids.size} unique element ids`);

const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
const uniqueRefs = [...new Set(refs)];
let localCount = 0;
let externalCount = 0;

for (const ref of uniqueRefs) {
    if (ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('//')) {
        externalCount++;
        continue;
    }
    if (ref.startsWith('mailto:') || ref.startsWith('tel:') || ref.startsWith('data:')) continue;

    const [path, hash] = ref.split('#');
    localCount++;

    if (path) {
        const abs = join(ROOT, path);
        if (!existsSync(abs)) fail(`broken reference: ${ref}`);
    }
    if (hash && !ids.has(hash)) fail(`anchor target not found: #${hash}`);
}
ok(`${localCount} local references resolve`);
ok(`${externalCount} external references (not fetched)`);

// Every in-page link to a section must point at a real section.
const sectionIds = new Set(
    [...html.matchAll(/<section[^>]*\sid="([^"]+)"/g)].map((m) => m[1])
);
for (const ref of uniqueRefs) {
    if (ref.startsWith('#') && ref.length > 1 && !ids.has(ref.slice(1))) {
        fail(`anchor not found: ${ref}`);
    }
}
ok(`${sectionIds.size} <section> landmarks: ${[...sectionIds].join(', ')}`);

// Download-CV wiring.
const cvLinks = [...html.matchAll(/<a\b[^>]*href="assets\/Md-Rezwanul-Haque-CV\.pdf"[^>]*>/g)].map((m) => m[0]);
if (cvLinks.length === 0) {
    fail('no Download CV link found');
} else {
    const bad = cvLinks.filter((tag) => !/download="Md-Rezwanul-Haque-CV\.pdf"/.test(tag));
    if (bad.length) fail(`${bad.length} CV link(s) missing download="Md-Rezwanul-Haque-CV.pdf"`);
    else ok(`${cvLinks.length} Download CV links wired with the professional filename`);
}

// No dead "#" placeholders.
const deadHrefs = [...html.matchAll(/href="#"/g)].length;
if (deadHrefs > 0) fail(`${deadHrefs} placeholder href="#" link(s) found — these are dead links`);
else ok('no placeholder href="#" links');

// No external JS/CSS dependencies beyond Google Fonts.
const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
for (const s of scripts) {
    if (!s.startsWith('http')) ok(`local script: ${s}`);
    else warn(`external script: ${s}`);
}
for (const s of styles) {
    if (!s.startsWith('http')) ok(`local stylesheet: ${s}`);
    else warn(`external stylesheet: ${s} (Google Fonts)`);
}
if (scripts.some((s) => /jquery|cdn\.tailwindcss|font-awesome/i.test(s))) {
    fail('legacy CDN dependencies (jQuery / Tailwind CDN / Font Awesome) still referenced');
} else {
    ok('no jQuery, Tailwind CDN or Font Awesome dependencies');
}

/* ------------------------------------------------------------------ */
/* 3. Sanity-check the JS                                              */
/* ------------------------------------------------------------------ */
console.log('\nValidating script.js');
const js = await readFile(join(ROOT, 'script.js'), 'utf8');
new Function(js); // throws on syntax error
ok('parses without syntax errors');
const jQueryApi = /\bjQuery\b|\$\(\s*document\s*\)|\$\(\s*window\s*\)|\$\.ajax|\.ready\s*\(|\.animate\s*\(|\.fadeIn\s*\(|\.slideToggle\s*\(/;
if (jQueryApi.test(js)) fail('jQuery API usage found in script.js');
else ok('vanilla JavaScript (no jQuery API usage)');
if (/TODO|FIXME|console\.log\(/.test(js)) warn('debug leftovers found (TODO/FIXME/console.log)');
else ok('no debug leftovers');

/* ------------------------------------------------------------------ */
/* 4. Verify the CV is a real PDF                                      */
/* ------------------------------------------------------------------ */
console.log('\nVerifying CV asset');
const cvPath = join(ROOT, CV_ASSET);
const cvBuffer = await readFile(cvPath);
const header = cvBuffer.subarray(0, 5).toString('latin1');
if (header !== '%PDF-') fail(`${CV_ASSET} is not a valid PDF (header: ${header})`);
else ok(`${CV_ASSET} is a valid PDF (${(cvBuffer.length / 1024).toFixed(0)} kB)`);
ok(`will download as "${CV_FILENAME}"`);

/* ------------------------------------------------------------------ */
/* 5. Emit dist/                                                       */
/* ------------------------------------------------------------------ */
console.log('\nBuilding dist/');
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const rel of ['index.html', 'styles.css', 'script.js']) {
    await cp(join(ROOT, rel), join(DIST, rel));
}
await cp(join(ROOT, 'assets'), join(DIST, 'assets'), { recursive: true });

if (!existsSync(join(DIST, CV_ASSET))) fail('CV asset missing from dist/');
else ok('CV present in dist/');

const distFiles = [];
async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else distFiles.push(relative(DIST, abs).replace(/\\/g, '/'));
    }
}
await walk(DIST);
ok(`dist/ contains ${distFiles.length} files`);

finish();

function finish() {
    console.log('');
    if (errors.length) {
        console.error(`BUILD FAILED — ${errors.length} error(s)\n`);
        for (const e of errors) console.error(`  \u2717 ${e}`);
        if (warnings.length) {
            console.error(`\n${warnings.length} warning(s)\n`);
            for (const w of warnings) console.error(`  ! ${w}`);
        }
        process.exit(1);
    }
    console.log(`BUILD OK${warnings.length ? ` (${warnings.length} warning(s))` : ''}\n`);
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log('');
    process.exit(0);
}
