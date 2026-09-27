/**
 * Headless smoke test — drives the real Chrome binary over the DevTools
 * protocol via WebSocket. Zero npm dependencies.
 *
 * Checks:
 *   - no console errors / page errors / failed requests
 *   - every stylesheet, script, image and the CV PDF returns HTTP 200
 *   - the CV link carries download="Md-Rezwanul-Haque-CV.pdf"
 *   - clicking the Download CV button actually fetches a valid PDF
 *   - all sections render and reveal, counters and typing run
 *   - burger opens/closes the right-hand slide-in menu and locks scroll
 *   - project filtering, scroll spy, progress bar and back-to-top work
 *   - dark-theme WCAG AA contrast, responsive sweep, reduced-motion support
 *
 * Usage: node tools/smoke.mjs [--port 4173]
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg('--port', 4188));
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let failures = 0;
const fail = (m) => { failures++; console.log(`  \u2717 ${m}`); };
const pass = (m) => console.log(`  \u2713 ${m}`);

/* ---- minimal websocket client (text frames only) --------------------- */
function wsConnect(url) {
    return new Promise((resolvePromise, rejectPromise) => {
        const u = new URL(url);
        const key = Buffer.from(Math.random().toString(36)).toString('base64').slice(0, 22) + '==';
        const sock = connect({ host: u.hostname, port: Number(u.port) }, () => {
            sock.write(
                `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
                `Host: ${u.host}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
            );
        });

        let buf = Buffer.alloc(0);
        let upgraded = false;
        const handlers = { message: [], close: [] };

        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (!upgraded) {
                const i = buf.indexOf('\r\n\r\n');
                if (i === -1) return;
                if (!buf.subarray(0, i).toString().includes('101')) {
                    rejectPromise(new Error('websocket upgrade failed'));
                    return;
                }
                buf = buf.subarray(i + 4);
                upgraded = true;
                resolvePromise(api);
            }
            for (;;) {
                const frame = decodeFrame();
                if (!frame) return;
                if (frame.opcode === 0x8) { handlers.close.forEach((f) => f()); return; }
                if (frame.opcode === 0x1) handlers.message.forEach((f) => f(frame.payload.toString('utf8')));
            }
        });
        sock.on('error', rejectPromise);

        function decodeFrame() {
            if (buf.length < 2) return null;
            const opcode = buf[0] & 0x0f;
            const masked = (buf[1] & 0x80) === 0x80;
            let len = buf[1] & 0x7f;
            let offset = 2;
            if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
            else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
            const maskLen = masked ? 4 : 0;
            if (buf.length < offset + maskLen + len) return null;
            const mask = masked ? buf.subarray(offset, offset + 4) : null;
            const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
            if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            buf = buf.subarray(offset + maskLen + len);
            return { opcode, payload };
        }

        function encode(str) {
            const data = Buffer.from(str, 'utf8');
            const mask = Buffer.from([0, 0, 0, 0]);
            let header;
            if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
            else if (data.length < 65536) {
                header = Buffer.alloc(4);
                header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2);
            } else {
                header = Buffer.alloc(10);
                header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2);
            }
            return Buffer.concat([header, mask, data]);
        }

        const api = {
            send: (obj) => { if (!sock.destroyed) sock.write(encode(JSON.stringify(obj))); },
            onMessage: (fn) => handlers.message.push(fn),
            onClose: (fn) => handlers.close.push(fn),
            close: () => sock.end()
        };
    });
}

/* ---- CDP driver ------------------------------------------------------ */
function createDriver(ws) {
    let nextId = 1;
    const pending = new Map();
    const events = [];

    ws.onMessage((raw) => {
        const msg = JSON.parse(raw);
        if (msg.id && pending.has(msg.id)) {
            const { resolve: r, reject: j } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) j(new Error(msg.error.message));
            else r(msg.result);
        } else if (msg.method) {
            events.push(msg);
        }
    });

    function send(sessionId, method, params = {}) {
        const id = nextId++;
        return new Promise((r, j) => {
            pending.set(id, { resolve: r, reject: j });
            ws.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
            setTimeout(() => {
                if (pending.has(id)) { pending.delete(id); j(new Error(`timeout: ${method}`)); }
            }, 30000);
        });
    }

    return { events, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- run ------------------------------------------------------------- */
const profile = await mkdtemp(join(tmpdir(), 'portfolio-smoke-'));
const server = spawn(process.execPath, ['tools/serve.mjs', '--port', String(PORT)], {
    cwd: process.cwd(), stdio: 'ignore'
});

let chrome;
let ws;
let exitCode = 0;

try {
    await sleep(700);

    chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--window-size=1440,1000', 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const wsUrl = await new Promise((r, j) => {
        let out = '';
        const timer = setTimeout(() => j(new Error('chrome did not expose a debugger port')), 20000);
        chrome.stderr.on('data', (d) => {
            out += d.toString();
            const m = out.match(/ws:\/\/[^\s]+/);
            if (m) { clearTimeout(timer); r(m[0]); }
        });
    });

    ws = await wsConnect(wsUrl);
    const driver = createDriver(ws);

    await driver.send(null, 'Target.setDiscoverTargets', { discover: true });
    const { targetId } = await driver.send(null, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await driver.send(null, 'Target.attachToTarget', { targetId, flatten: true });

    const session = {
        send: (method, params = {}) => driver.send(sessionId, method, params)
    };
    const client = { events: driver.events };

    const evaluate = async (expression) => {
        const res = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'eval failed');
        return res.result.value;
    };

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Network.enable');

    console.log('\nLoading page');
    await session.send('Page.navigate', { url: BASE + '/' });
    await sleep(3500); // web font swap + reveals + counters

    /* ---- console / errors ------------------------------------------- */
    console.log('\nConsole & network');
    const consoleErrors = client.events.filter((e) =>
        e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')
    );
    const exceptions = client.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    const logEntries = client.events.filter((e) =>
        e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)
    );
    const failedReq = client.events.filter((e) =>
        e.method === 'Network.loadingFailed' && !/net::ERR_ABORTED/.test(e.params.errorText)
    );

    if (exceptions.length) exceptions.forEach((e) => fail('uncaught exception: ' + (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text)));
    else pass('no uncaught exceptions');

    if (consoleErrors.length) consoleErrors.forEach((e) => fail('console ' + e.params.type + ': ' + e.params.args.map((a) => a.value ?? a.description).join(' ')));
    else pass('no console errors or warnings');

    if (logEntries.length) logEntries.forEach((e) => fail('log ' + e.params.entry.level + ': ' + e.params.entry.text + ' ' + (e.params.entry.url || '')));
    else pass('no log errors/warnings (incl. 404s)');

    if (failedReq.length) failedReq.forEach((e) => fail('request failed: ' + e.params.errorText));
    else pass('no failed network requests');

    /* ---- responses ---------------------------------------------------- */
    console.log('\nResource responses');
    const responses = client.events.filter((e) => e.method === 'Network.responseReceived').map((e) => e.params.response);
    const local = responses.filter((r) => r.url.startsWith(BASE));
    for (const r of local) {
        const label = r.url.replace(BASE, '') || '/';
        if (r.status !== 200) fail(`${r.status} for ${label}`);
        else pass(`200 ${label} (${r.mimeType})`);
    }

    /* ---- DOM structure ------------------------------------------------- */
    console.log('\nPage content');
    const dom = await evaluate(`(async () => {
        // Step through the whole document so every lazy reveal fires.
        // Disable smooth scrolling first, otherwise each scrollTo is animated
        // and the next call interrupts it before it arrives.
        document.documentElement.style.scrollBehavior = 'auto';
        const step = Math.round(window.innerHeight * 0.5);
        const max = document.documentElement.scrollHeight;
        let y = 0;
        while (y <= max) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, 180));
            y += step;
        }
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 500));

        const q = (s) => document.querySelector(s);
        const hidden = [...document.querySelectorAll('.reveal:not(.is-visible)')].map(e => {
            const sec = e.closest('section');
            return (sec ? sec.id : 'header/footer') + ' > ' + e.className.split(' ').slice(0, 2).join('.');
        });
        return {
            hiddenDetail: hidden,
            title: document.title,
            preloaderGone: !q('#preloader'),
            sections: [...document.querySelectorAll('section[data-section]')].map(s => s.id),
            navLinks: [...document.querySelectorAll('.slide-menu__link[data-nav]')].map(a => a.getAttribute('data-nav')),
            activeNav: q('.slide-menu__link.is-active')?.getAttribute('data-nav') || null,
            projects: document.querySelectorAll('#project-grid .project').length,
            skills: document.querySelectorAll('.skill').length,
            timeline: document.querySelectorAll('#experience .tl__item').length,
            education: document.querySelectorAll('#education .tl__item').length,
            counters: [...document.querySelectorAll('[data-count-to]')].map(e => e.textContent),
            revealsHidden: [...document.querySelectorAll('.reveal')].filter(e => !e.classList.contains('is-visible')).length,
            revealsTotal: document.querySelectorAll('.reveal').length,
            typed: q('[data-typed-roles]')?.textContent || '',
            portraitLoaded: (() => { const i = q('.blob__img'); return !!i && i.complete && i.naturalWidth > 0; })(),
            cvLinks: [...document.querySelectorAll('[data-download-cv]')].map(a => ({ href: a.getAttribute('href'), download: a.getAttribute('download') })),
            emptyLinks: [...document.querySelectorAll('a')].filter(a => !a.getAttribute('href') || a.getAttribute('href') === '#').length,
            hasThemeToggle: !!q('#theme-toggle'),
            fontFamily: getComputedStyle(document.body).fontFamily,
            headerFont: getComputedStyle(q('#navbar')).position,
            year: q('#current-year')?.textContent,
            hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
        };
    })()`);

    const expect = (cond, label) => cond ? pass(label) : fail(label);

    expect(dom.preloaderGone, 'no preloader overlay in the markup');
    expect(dom.sections.length === 6 && dom.sections.join(',') === 'about,skill,experience,projects,education,contact',
        `6 navigable sections: ${dom.sections.join(', ')}`);
    expect(dom.navLinks.length === 7, `7 slide-menu nav links: ${dom.navLinks.join(', ')}`);
    expect(dom.projects === 7, `${dom.projects} project cards`);
    expect(dom.skills === 7, `${dom.skills} skill cards`);
    expect(dom.timeline === 3, `${dom.timeline} experience entries`);
    expect(dom.education === 2, `${dom.education} education entries`);
    // Counters are zero-padded ("08+"), so check the digits are not all zero.
    const counterOk = (c) => !!c && !/^0+$/.test(String(c).replace(/[^\d]/g, ''));
    expect(dom.counters.every(counterOk), `counters animated: ${dom.counters.join(' / ')}`);
    expect(dom.revealsHidden === 0,
        `all ${dom.revealsTotal} reveal elements became visible (${dom.revealsHidden} hidden: ${dom.hiddenDetail.slice(0, 6).join(' | ') || 'none'})`);
    expect(dom.typed.length > 0, `typed role text present: "${dom.typed}"`);
    expect(dom.portraitLoaded, 'hero profile photo loaded');
    expect(dom.emptyLinks === 0, `no dead links (${dom.emptyLinks} found)`);
    expect(!dom.hScroll, 'no horizontal overflow on desktop');
    expect(dom.year === String(new Date().getFullYear()), `footer year = ${dom.year}`);
    expect(!dom.hasThemeToggle, 'single dark theme (no light-mode toggle)');
    expect(/Exo/i.test(dom.fontFamily), `Exo web font applied: ${dom.fontFamily.split(',')[0]}`);
    expect(dom.headerFont === 'fixed', `header is sticky (position: ${dom.headerFont})`);
    expect(dom.cvLinks.length === 6 && dom.cvLinks.every((l) => l.download === 'Md-Rezwanul-Haque-CV.pdf'),
        `all ${dom.cvLinks.length} CV buttons -> download="Md-Rezwanul-Haque-CV.pdf"`);

    /* ---- design system matches the reference --------------------------- */
    console.log('\nDesign system');
    const design = await evaluate(`(() => {
        const cs = (s, p) => getComputedStyle(document.querySelector(s))[p];
        const cols = (s) => cs(s, 'gridTemplateColumns').split(' ').filter(Boolean).length;
        return {
            bodyBg: cs('body', 'backgroundColor'),
            bandAlt: cs('#experience', 'backgroundColor'),
            surface: cs('.skill', 'backgroundColor'),
            gradBtn: cs('.btn--grad', 'backgroundImage'),
            gradHead: cs('.hl', 'backgroundImage') + ' | ' + cs('.hl', 'backgroundClip') + ' | ' + cs('.hl', 'color'),
            cardRadius: cs('.skill', 'borderRadius'),
            btnRadius: cs('.btn--grad', 'borderRadius'),
            tagRadius: cs('.tags li', 'borderRadius'),
            cardShadow: cs('.skill', 'boxShadow') !== 'none',
            blobAnim: cs('.blob', 'animationName'),
            blobRadius: cs('.blob', 'borderRadius'),
            blobClipRadius: cs('.blob__clip', 'borderRadius'),
            blobSize: Math.round(document.querySelector('.hero__visual').getBoundingClientRect().width),
            photoClipped: (() => { const i = document.querySelector('.blob__img'); const r = getComputedStyle(i.parentElement); return r.overflow === 'hidden' && r.borderRadius !== '0px'; })(),
            headerBlur: cs('#navbar', 'backdropFilter'),
            skillCols: cols('.skills'),
            projectCols: cols('.projects'),
            statCols: cols('.stats'),
            timelineCols: cols('#experience .tl__item'),
            tagCount: document.querySelectorAll('.tags li').length,
            scrollbar: cs('body', 'scrollbarWidth') || getComputedStyle(document.documentElement).getPropertyValue('scrollbar-color')
        };
    })()`);
    expect(design.bodyBg === 'rgb(20, 24, 36)', `base band background #141824 (${design.bodyBg})`);
    expect(design.bandAlt === 'rgb(34, 36, 51)', `alternating band #222433 (${design.bandAlt})`);
    expect(design.surface === 'rgb(27, 31, 46)', `card surface #1b1f2e (${design.surface})`);
    expect(/linear-gradient\(45deg/.test(design.gradBtn) && /240,\s*152,\s*25/.test(design.gradBtn) && /241,\s*230,\s*8/.test(design.gradBtn),
        'buttons use the amber -> yellow 45deg gradient');
    expect(/linear-gradient/.test(design.gradHead) && /text/.test(design.gradHead) && /rgba\(0, 0, 0, 0\)/.test(design.gradHead),
        'headings highlight words with clipped gradient text');
    expect(design.cardRadius === '15px' && design.tagRadius === '999px' && design.btnRadius === '4px',
        `square buttons (4px) + 15px cards + pill tags (got ${design.btnRadius} / ${design.cardRadius} / ${design.tagRadius})`);
    expect(design.cardShadow, 'cards carry a soft drop shadow');
    expect(design.blobAnim.includes('blobMorph') && design.blobAnim.includes('blobSpin'),
        `hero blob morphs and spins (${design.blobAnim})`);
    expect(/\//.test(design.blobRadius) && /\//.test(design.blobClipRadius) && design.photoClipped,
        `portrait is clipped by an organic blob shape (${design.blobRadius})`);
    expect(design.blobSize >= 300 && design.blobSize <= 440, `hero portrait layout box is ${design.blobSize}px (capped at 430px)`);
    expect(/blur/.test(design.headerBlur), `sticky header uses a frosted backdrop (${design.headerBlur})`);
    expect(design.skillCols === 3, `skills form a 3-column grid (got ${design.skillCols})`);
    expect(design.projectCols === 2, `projects form a 2-column grid (got ${design.projectCols})`);
    expect(design.statCols === 4, `hero stats form a 4-column strip (got ${design.statCols})`);
    expect(design.timelineCols === 3, `timeline uses a 3-track grid for the centre line (got ${design.timelineCols})`);
    expect(design.tagCount > 50, `${design.tagCount} technology tags rendered`);

    /* ---- CV download actually works ----------------------------------- */
    console.log('\nCV download');
    const cvCheck = await evaluate(`(async () => {
        const link = document.querySelector('[data-download-cv]');
        const res = await fetch(link.getAttribute('href'), { cache: 'no-store' });
        const buf = new Uint8Array(await res.arrayBuffer());
        return {
            status: res.status,
            type: res.headers.get('content-type'),
            bytes: buf.length,
            magic: String.fromCharCode(buf[0], buf[1], buf[2], buf[3]),
            disposition: res.headers.get('content-disposition')
        };
    })()`);
    expect(cvCheck.status === 200, `CV fetch status ${cvCheck.status}`);
    expect(cvCheck.magic === '%PDF', `CV is a real PDF (magic "${cvCheck.magic}")`);
    expect(cvCheck.bytes > 100000, `CV size ${cvCheck.bytes} bytes`);
    expect(/pdf/i.test(cvCheck.type || ''), `CV content-type: ${cvCheck.type}`);

    // Really click the hero Download CV button (default action suppressed so
    // headless Chrome does not try to save the file).
    const afterDownload = await evaluate(`(async () => {
        const link = document.querySelector('.hero__actions [data-download-cv]');
        link.addEventListener('click', (e) => e.preventDefault(), false);
        link.click();
        await new Promise(r => setTimeout(r, 200));
        const t = document.querySelector('.toast');
        return { toast: t ? t.textContent : null, visible: t ? t.classList.contains('is-visible') : false };
    })()`);
    expect(/Md-Rezwanul-Haque-CV\.pdf/.test(afterDownload.toast || '') && afterDownload.visible,
        `clicking Download CV shows: "${afterDownload.toast}"`);

    /* ---- interactions -------------------------------------------------- */
    console.log('\nInteractions');
    const filterResult = await evaluate(`(() => {
        const eduBtn = document.querySelector('.filter[data-filter="education"]');
        eduBtn.click();
        const visible = [...document.querySelectorAll('#project-grid .project')].filter(p => !p.classList.contains('is-hidden')).length;
        const pressed = eduBtn.getAttribute('aria-pressed');
        document.querySelector('.filter[data-filter="all"]').click();
        const all = [...document.querySelectorAll('#project-grid .project')].filter(p => !p.classList.contains('is-hidden')).length;
        return { visible, all, pressed };
    })()`);
    expect(filterResult.visible === 3, `filter "education" shows 3 cards (got ${filterResult.visible})`);
    expect(filterResult.all === 7, `filter "all" restores 7 cards (got ${filterResult.all})`);
    expect(filterResult.pressed === 'true', 'filter sets aria-pressed');

    const menuLocked = await evaluate(`(async () => {
        const toggle = document.getElementById('nav-toggle');
        const menu = document.getElementById('slide-menu');
        const pre = {
            hidden: menu.hidden,
            locked: document.body.classList.contains('is-locked'),
            open: menu.classList.contains('is-open')
        };
        toggle.click();
        await new Promise(r => setTimeout(r, 500));
        const open = menu.classList.contains('is-open');
        const expanded = toggle.getAttribute('aria-expanded');
        const locked = document.body.classList.contains('is-locked');
        const panelX = Math.round(menu.querySelector('.slide-menu__panel').getBoundingClientRect().right - window.innerWidth);
        toggle.click();
        await new Promise(r => setTimeout(r, 600));
        return {
            pre, open, expanded, locked, panelX,
            closed: !menu.classList.contains('is-open'),
            unlocked: !document.body.classList.contains('is-locked'),
            collapsed: toggle.getAttribute('aria-expanded') === 'false'
        };
    })()`);
    expect(menuLocked.pre.hidden && !menuLocked.pre.open && !menuLocked.pre.locked,
        'slide menu starts closed and does not lock scroll');
    expect(menuLocked.open && menuLocked.expanded === 'true' && menuLocked.locked,
        'burger opens the slide menu, slides the panel in and locks scroll');
    expect(Math.abs(menuLocked.panelX) < 4, `panel finishes flush to the right edge (offset ${menuLocked.panelX}px)`);
    expect(menuLocked.closed && menuLocked.unlocked && menuLocked.collapsed, 'burger closes the menu and unlocks scroll');

    const scrollResult = await evaluate(`(async () => {
        // Wait for the smooth scroll to actually come to rest instead of
        // guessing a sleep duration.
        const settle = async () => {
            let last = -1;
            for (let i = 0; i < 45; i++) {
                await new Promise(r => setTimeout(r, 100));
                const y = Math.round(window.pageYOffset);
                if (y === last) return y;
                last = y;
            }
            return Math.round(window.pageYOffset);
        };
        document.querySelector('.slide-menu__link[data-nav="projects"]').click();
        const y = await settle();
        await new Promise(r => setTimeout(r, 250));
        const top = document.getElementById('projects').getBoundingClientRect().top;
        return {
            top: Math.round(top),
            settled: y,
            active: document.querySelector('.slide-menu__link.is-active')?.getAttribute('data-nav'),
            progress: document.getElementById('scroll-progress-bar').style.width,
            backVisible: document.getElementById('back-to-top').classList.contains('is-visible'),
            headerScrolled: document.getElementById('navbar').classList.contains('is-scrolled')
        };
    })()`);
    expect(Math.abs(scrollResult.top) < 120, `smooth scroll landed on #projects (offset ${scrollResult.top}px)`);
    expect(scrollResult.settled > 0, `page actually scrolled to y=${scrollResult.settled}`);
    expect(scrollResult.active === 'projects', `scroll spy highlights "projects" in the menu`);
    expect(/%$/.test(scrollResult.progress) && parseFloat(scrollResult.progress) > 0,
        `progress bar ${parseFloat(scrollResult.progress).toFixed(1)}%`);
    expect(scrollResult.backVisible, 'back-to-top button visible after scroll');
    expect(scrollResult.headerScrolled, 'header switches to its scrolled state');

    const layout = await evaluate(`(() => {
        const line = document.querySelector('#experience .tl');
        const items = [...document.querySelectorAll('#experience .tl__item')];
        const mid = window.innerWidth / 2;
        const sides = items.map((it) => {
            const card = it.querySelector('.tl__card').getBoundingClientRect();
            const node = it.querySelector('.tl__node').getBoundingClientRect();
            return {
                cardSide: (card.left + card.right) / 2 < mid ? 'left' : 'right',
                nodeCentred: Math.abs((node.left + node.right) / 2 - mid) < 30
            };
        });
        const side = document.querySelector('.about__side');
        return {
            sides,
            hasLine: !!line && getComputedStyle(line, '::before').content !== 'none',
            aboutSticky: getComputedStyle(side).position
        };
    })()`);
    expect(layout.hasLine, 'experience timeline draws a centre line');
    expect(layout.sides.every((s) => s.nodeCentred), 'timeline icons sit on the centre line');
    expect(
        layout.sides.map((s) => s.cardSide).join(',') === 'left,right,left',
        `experience cards alternate sides: ${layout.sides.map((s) => s.cardSide).join(' / ')}`
    );
    expect(layout.aboutSticky === 'sticky', `About card is sticky on desktop (position: ${layout.aboutSticky})`);

    const formResult = await evaluate(`(() => {
        const form = document.getElementById('contact-form');
        form.querySelector('#cf-name').value = '';
        form.querySelector('#cf-email').value = 'not-an-email';
        form.querySelector('#cf-subject').value = 'x';
        form.querySelector('#cf-message').value = 'short';
        form.requestSubmit();
        const invalid = document.querySelectorAll('.field.has-error').length;
        const status = document.getElementById('form-status').textContent;
        return { invalid, status };
    })()`);
    expect(formResult.invalid === 4, `form validation flags all 4 bad fields (got ${formResult.invalid})`);
    expect(/fix the highlighted/i.test(formResult.status), 'form shows validation status');

    /* ---- mobile pass --------------------------------------------------- */
    console.log('\nMobile (390x844)');
    await session.send('Emulation.setDeviceMetricsOverride', {
        width: 390, height: 844, deviceScaleFactor: 2, mobile: true
    });
    await sleep(600);

    const mobileDom = await evaluate(`(() => ({
        hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        burgerVisible: getComputedStyle(document.getElementById('nav-toggle')).display !== 'none',
        desktopNav: !!document.querySelector('.nav__links'),
        menuHidden: document.getElementById('slide-menu').hidden,
        blobVisible: getComputedStyle(document.querySelector('.blob')).display !== 'none'
    }))()`);
    expect(!mobileDom.hScroll, `no horizontal overflow on mobile (${mobileDom.scrollWidth} vs ${mobileDom.clientWidth})`);
    expect(mobileDom.burgerVisible, 'hamburger menu visible on mobile');
    expect(!mobileDom.desktopNav, 'no separate desktop nav bar (hamburger only, like the reference)');
    expect(mobileDom.menuHidden, 'slide menu panel is closed on load');
    expect(mobileDom.blobVisible, 'hero morphing blob visible on mobile');

    const mobileMenuResult = await evaluate(`(async () => {
        const menu = document.getElementById('slide-menu');
        const toggle = document.getElementById('nav-toggle');
        const settle = async () => {
            let last = -1;
            for (let i = 0; i < 45; i++) {
                await new Promise(r => setTimeout(r, 100));
                const y = Math.round(window.pageYOffset);
                if (y === last) return y;
                last = y;
            }
            return Math.round(window.pageYOffset);
        };
        // Start from the top so the 1440px -> 390px reflow cannot skew the
        // landing position of the smooth scroll that follows.
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 250));

        toggle.click();
        await new Promise(r => setTimeout(r, 500));
        const open = menu.classList.contains('is-open');
        const expanded = toggle.getAttribute('aria-expanded');
        const locked = document.body.classList.contains('is-locked');
        const visible = getComputedStyle(menu.querySelector('.slide-menu__panel')).transform;

        document.querySelector('.slide-menu__link[data-nav="skill"]').click();
        const y = await settle();
        await new Promise(r => setTimeout(r, 250));
        return {
            open, expanded, locked, visible, settled: y,
            closed: !menu.classList.contains('is-open'),
            unlocked: !document.body.classList.contains('is-locked'),
            skillTop: Math.round(document.getElementById('skill').getBoundingClientRect().top)
        };
    })()`);
    expect(mobileMenuResult.open && mobileMenuResult.expanded === 'true' && mobileMenuResult.locked, 'mobile menu opens and locks scroll');
    expect(/matrix\(1, 0, 0, 1, 0, 0\)|none/.test(mobileMenuResult.visible), 'menu panel animates fully into view');
    expect(mobileMenuResult.closed && mobileMenuResult.unlocked, 'mobile menu closes and unlocks scroll');
    expect(mobileMenuResult.settled > 0, `menu link scrolled the page to y=${mobileMenuResult.settled}`);
    expect(Math.abs(mobileMenuResult.skillTop) < 120, `menu link navigates to #skill (offset ${mobileMenuResult.skillTop}px)`);

    /* ---- more viewports ------------------------------------------------ */
    console.log('\nResponsive sweep (no horizontal overflow)');
    for (const [w, h] of [[320, 640], [360, 800], [414, 896], [640, 900], [768, 1024], [900, 800], [1024, 768], [1100, 800], [1280, 800], [1366, 768], [1440, 900], [1920, 1080]]) {
        await session.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 900 });
        await evaluate('document.documentElement.style.scrollBehavior = "auto"');
        await sleep(300);
        const o = await evaluate(`(() => {
            const cw = document.documentElement.clientWidth;
            // Definitive test: can the page actually be scrolled sideways?
            const x0 = window.scrollX;
            window.scrollTo(200, window.scrollY);
            const canScrollX = window.scrollX > 0;
            window.scrollTo(x0, window.scrollY);
            const offenders = [];
            document.querySelectorAll('body *').forEach((el) => {
                if (el.closest('.slide-menu') || el.closest('.orbit') || el.closest('.blob')) return;
                const cs = getComputedStyle(el);
                if (cs.position === 'fixed' || cs.display === 'none') return;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return;
                if (r.right > cw + 1) {
                    offenders.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') +
                        ' [right=' + Math.round(r.right) + ' w=' + Math.round(r.width) + ']');
                }
            });
            return { sw: document.documentElement.scrollWidth, cw, canScrollX, offenders: offenders.slice(0, 5) };
        })()`);
        expect(!o.canScrollX,
            `${w}x${h}: no horizontal scrolling${o.sw > o.cw + 1 ? ` (clipping ${o.sw - o.cw}px of decorative bleed: ${o.offenders.join(' | ') || 'none'})` : ''}`);
    }

    /* ---- contrast & theme -------------------------------------------- */
    console.log('\nDark theme contrast');
    await session.send('Emulation.clearDeviceMetricsOverride');
    await sleep(250);
    const contrast = await evaluate(`(() => {
        const parse = (c) => c.match(/[\\d.]+/g).map(Number);
        const lum = (rgb) => { const [r,g,b] = rgb; const f = (v) => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }; return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
        const ratio = (fg, bg) => { const l1 = lum(parse(fg)), l2 = lum(parse(bg)); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

        const body = getComputedStyle(document.body);
        const lead = getComputedStyle(document.querySelector('.hero__lead'));
        const card = getComputedStyle(document.querySelector('.skill'));
        const cardText = getComputedStyle(document.querySelector('.skill__title'));
        const section = getComputedStyle(document.querySelector('#experience'));

        return {
            body: Math.round(ratio(body.color, body.backgroundColor) * 100) / 100,
            lead: Math.round(ratio(lead.color, body.backgroundColor) * 100) / 100,
            card: Math.round(ratio(cardText.color, card.backgroundColor) * 100) / 100,
            band: Math.round(ratio(body.color, section.backgroundColor) * 100) / 100,
            theme: document.documentElement.getAttribute('data-theme'),
            meta: document.querySelector('meta[name="theme-color"]').content,
            alt: getComputedStyle(document.documentElement).colorScheme
        };
    })()`);
    expect(contrast.theme === 'dark', `document is dark-only (data-theme="${contrast.theme}")`);
    expect(contrast.meta === '#141824', `theme-color meta matches the band background (${contrast.meta})`);
    expect(contrast.body >= 4.5, `body text contrast ${contrast.body}:1 (WCAG AA needs 4.5)`);
    expect(contrast.lead >= 4.5, `muted hero paragraph contrast ${contrast.lead}:1`);
    expect(contrast.card >= 4.5, `card heading on card surface contrast ${contrast.card}:1`);
    expect(contrast.band >= 4.5, `text on the alternating band contrast ${contrast.band}:1`);

    /* ---- reduced motion ------------------------------------------------ */
    console.log('\nReduced motion');
    await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await session.send('Page.reload', { ignoreCache: false });
    await sleep(2000);
    await evaluate('window.scrollTo(0, 0)');
    await sleep(600);
    const reduced = await evaluate(`(() => ({
        hidden: document.querySelectorAll('.reveal:not(.is-visible)').length,
        counters: [...document.querySelectorAll('[data-count-to]')].map(e => e.textContent),
        blob: getComputedStyle(document.querySelector('.blob')).animationName,
        caret: getComputedStyle(document.querySelector('.caret')).animationName
    }))()`);
    expect(reduced.hidden === 0, 'all reveals visible immediately with reduced motion');
    expect(reduced.counters.every(counterOk), `counters show final values immediately: ${reduced.counters.join(' / ')}`);
    expect(reduced.blob === 'none', `morphing blob animation disabled (animation-name: ${reduced.blob})`);
    expect(reduced.caret === 'none', `typing caret stops blinking (animation-name: ${reduced.caret})`);
    await session.send('Emulation.setEmulatedMedia', { features: [] });

    /* ---- final console sweep ------------------------------------------ */
    const finalErrors = client.events.filter((e) =>
        (e.method === 'Runtime.exceptionThrown') ||
        (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) ||
        (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
    );
    console.log('\nFinal error sweep (after all interactions)');
    if (finalErrors.length) {
        finalErrors.forEach((e) => fail(JSON.stringify(e.params).slice(0, 220)));
    } else {
        pass('zero console errors, exceptions or log warnings across the whole session');
    }

} catch (error) {
    fail(`harness error: ${error.message}`);
} finally {
    try { ws && ws.close(); } catch {}
    try { chrome && chrome.kill(); } catch {}
    try { server.kill(); } catch {}
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await sleep(300);
}

console.log('');
if (failures) {
    console.error(`SMOKE TEST FAILED — ${failures} failure(s)\n`);
    process.exit(1);
}
console.log('SMOKE TEST PASSED — no console errors, all assets 200, CV download verified\n');
process.exit(exitCode);
