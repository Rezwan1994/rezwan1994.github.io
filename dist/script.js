/* =====================================================================
   MD Rezwanul Haque — Portfolio
   Vanilla JavaScript, no dependencies.

   Modules
     1. utilities
     2. header state (scrolled + progress bar + back-to-top)
     3. slide-in menu (focus trap, scroll lock, ESC, scrim)
     4. smooth anchor scrolling
     5. reveal on scroll
     6. typed role rotator
     7. animated counters
     8. project filters
     9. scroll spy
    10. contact form validation -> mailto
    11. copy email address
    12. CV download toast
    13. footer year
   ===================================================================== */

(function () {
    'use strict';

    /* --------------------------------------------------------------- */
    /* 1. Utilities                                                     */
    /* --------------------------------------------------------------- */
    var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
    var $$ = function (sel, ctx) {
        return Array.prototype.slice.call((ctx || document).querySelectorAll(sel));
    };

    var reduceMotion = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : { matches: false };

    function prefersReduced() {
        return !!reduceMotion.matches;
    }

    function headerHeight() {
        var header = $('#navbar');
        return header ? header.offsetHeight : 70;
    }

    /* Single toast element reused for every transient message. */
    var toastEl = null;
    var toastTimer = 0;

    function toast(message) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'toast';
            toastEl.setAttribute('role', 'status');
            toastEl.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = message;
        // Force a reflow so the transition replays on rapid repeat clicks.
        void toastEl.offsetWidth;
        toastEl.classList.add('is-visible');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(function () {
            toastEl.classList.remove('is-visible');
        }, 4200);
    }

    /* --------------------------------------------------------------- */
    /* 2. Header state                                                  */
    /* --------------------------------------------------------------- */
    (function headerState() {
        var header = $('#navbar');
        var bar = $('#scroll-progress-bar');
        var toTop = $('#back-to-top');
        if (!header && !bar && !toTop) return;

        var ticking = false;

        function update() {
            var y = window.pageYOffset || document.documentElement.scrollTop;
            var docHeight = document.documentElement.scrollHeight - window.innerHeight;

            if (header) header.classList.toggle('is-scrolled', y > 24);
            if (bar && docHeight > 0) {
                bar.style.width = Math.min(100, Math.max(0, (y / docHeight) * 100)) + '%';
            }
            if (toTop) toTop.classList.toggle('is-visible', y > 460);
            ticking = false;
        }

        window.addEventListener('scroll', function () {
            if (ticking) return;
            ticking = true;
            window.requestAnimationFrame(update);
        }, { passive: true });

        window.addEventListener('resize', update, { passive: true });
        update();

        if (toTop) {
            toTop.addEventListener('click', function () {
                window.scrollTo({
                    top: 0,
                    behavior: prefersReduced() ? 'auto' : 'smooth'
                });
            });
        }
    })();

    /* --------------------------------------------------------------- */
    /* 3. Slide-in menu                                                 */
    /* --------------------------------------------------------------- */
    (function slideMenu() {
        var toggle = $('#nav-toggle');
        var menu = $('#slide-menu');
        if (!toggle || !menu) return;

        var panel = $('.slide-menu__panel', menu);
        var FOCUSABLE = 'a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])';
        var lastFocused = null;

        function open() {
            if (menu.classList.contains('is-open')) return;
            lastFocused = document.activeElement;
            menu.hidden = false;
            // Next frame so the transform transition actually plays.
            window.requestAnimationFrame(function () {
                menu.classList.add('is-open');
                toggle.classList.add('is-active');
                toggle.setAttribute('aria-expanded', 'true');
                toggle.setAttribute('aria-label', 'Close menu');
                document.body.classList.add('is-locked');
            });
            var first = panel ? $(FOCUSABLE, panel) : null;
            if (first) window.setTimeout(function () { first.focus(); }, 80);
        }

        function close() {
            if (!menu.classList.contains('is-open')) return;
            menu.classList.remove('is-open');
            toggle.classList.remove('is-active');
            toggle.setAttribute('aria-expanded', 'false');
            toggle.setAttribute('aria-label', 'Open menu');
            document.body.classList.remove('is-locked');
            window.setTimeout(function () {
                if (!menu.classList.contains('is-open')) menu.hidden = true;
            }, 420);
            if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
        }

        toggle.addEventListener('click', function () {
            if (menu.classList.contains('is-open')) close();
            else open();
        });

        $$('[data-close-menu]', menu).forEach(function (el) {
            el.addEventListener('click', close);
        });

        document.addEventListener('keydown', function (e) {
            if (!menu.classList.contains('is-open')) return;
            if (e.key === 'Escape' || e.key === 'Esc') {
                close();
                return;
            }
            if (e.key !== 'Tab' || !panel) return;
            // Keep focus inside the panel while it is open.
            var items = $$(FOCUSABLE, panel).filter(function (el) {
                return el.offsetParent !== null;
            });
            if (!items.length) return;
            var first = items[0];
            var last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });

        window.addEventListener('resize', function () {
            if (window.innerWidth > 1024 && menu.classList.contains('is-open')) close();
        });
    })();

    /* --------------------------------------------------------------- */
    /* 4. Smooth anchor scrolling                                       */
    /* --------------------------------------------------------------- */
    (function smoothAnchors() {
        document.addEventListener('click', function (e) {
            var link = e.target.closest ? e.target.closest('a[href^="#"]') : null;
            if (!link) return;

            var hash = link.getAttribute('href');
            if (!hash || hash === '#' || hash.length < 2) return;

            var target = document.getElementById(hash.slice(1));
            if (!target) return;

            e.preventDefault();
            var top = target.getBoundingClientRect().top + (window.pageYOffset || 0) - headerHeight() - 18;
            window.scrollTo({ top: Math.max(0, top), behavior: prefersReduced() ? 'auto' : 'smooth' });
            if (history.replaceState) history.replaceState(null, '', hash);
        });
    })();

    /* --------------------------------------------------------------- */
    /* 5. Reveal on scroll                                              */
    /* --------------------------------------------------------------- */
    (function reveals() {
        var items = $$('.reveal');
        if (!items.length) return;

        items.forEach(function (el) {
            var delay = el.getAttribute('data-reveal-delay');
            if (delay) el.style.setProperty('--reveal-delay', delay);
        });

        if (prefersReduced() || !('IntersectionObserver' in window)) {
            items.forEach(function (el) { el.classList.add('is-visible'); });
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('is-visible');
                io.unobserve(entry.target);
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

        items.forEach(function (el) { io.observe(el); });
    })();

    /* --------------------------------------------------------------- */
    /* 6. Typed role rotator                                            */
    /* --------------------------------------------------------------- */
    (function typedRoles() {
        var target = $('[data-typed-roles]');
        if (!target) return;

        var roles = [
            'Backend & .NET',
            'C# / ASP.NET Core',
            'Angular & TypeScript',
            'SQL Server & Oracle',
            'Azure Cloud Services',
            'Microservices & Clean Architecture',
            'Real-Time Systems'
        ];

        if (prefersReduced()) {
            target.textContent = roles[0];
            return;
        }

        var roleIndex = 0;
        var charIndex = roles[0].length;
        var deleting = true;
        var paused = false;

        target.addEventListener('mouseenter', function () { paused = true; });
        target.addEventListener('mouseleave', function () { paused = false; });

        window.setInterval(function () {
            if (paused) return;
            var word = roles[roleIndex];

            if (deleting) {
                charIndex -= 1;
                target.textContent = word.slice(0, charIndex + 1);
                if (charIndex < 0) {
                    deleting = false;
                    roleIndex = (roleIndex + 1) % roles.length;
                    charIndex = 0;
                    target.textContent = '';
                }
            } else {
                charIndex += 1;
                target.textContent = word.slice(0, charIndex);
                if (charIndex === word.length) {
                    deleting = true;
                    return;
                }
            }
        }, 70);
    })();

    /* --------------------------------------------------------------- */
    /* 7. Animated counters                                             */
    /* --------------------------------------------------------------- */
    (function counters() {
        var nodes = $$('[data-count-to]');
        if (!nodes.length) return;

        function format(el, value) {
            var pad = parseInt(el.getAttribute('data-pad') || '0', 10);
            var suffix = el.getAttribute('data-suffix') || '';
            var out = String(value);
            while (out.length < pad) out = '0' + out;
            return out + suffix;
        }

        var targetOf = function (el) {
            return parseInt(el.getAttribute('data-count-to'), 10) || 0;
        };

        // With reduced motion there is nothing to animate, so the final value
        // is written up front rather than waiting for the element to scroll in.
        if (prefersReduced()) {
            nodes.forEach(function (el) { el.textContent = format(el, targetOf(el)); });
            return;
        }

        function run(el) {
            var target = targetOf(el);
            var duration = 1500;
            var start = null;

            function step(ts) {
                if (start === null) start = ts;
                var progress = Math.min(1, (ts - start) / duration);
                // easeOutCubic
                var eased = 1 - Math.pow(1 - progress, 3);
                el.textContent = format(el, Math.round(target * eased));
                if (progress < 1) window.requestAnimationFrame(step);
                else el.textContent = format(el, target);
            }
            window.requestAnimationFrame(step);
        }

        if (!('IntersectionObserver' in window)) {
            nodes.forEach(run);
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                run(entry.target);
                io.unobserve(entry.target);
            });
        }, { threshold: 0.4 });

        nodes.forEach(function (el) { io.observe(el); });
    })();

    /* --------------------------------------------------------------- */
    /* 8. Project filters                                               */
    /* --------------------------------------------------------------- */
    (function projectFilters() {
        var buttons = $$('.filter');
        var cards = $$('#project-grid .project');
        if (!buttons.length || !cards.length) return;

        buttons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var want = btn.getAttribute('data-filter') || 'all';

                buttons.forEach(function (b) {
                    var active = b === btn;
                    b.classList.toggle('is-active', active);
                    b.setAttribute('aria-pressed', active ? 'true' : 'false');
                });

                cards.forEach(function (card) {
                    var cat = card.getAttribute('data-category');
                    var show = want === 'all' || cat === want;
                    card.classList.toggle('is-hidden', !show);
                });
            });
        });
    })();

    /* --------------------------------------------------------------- */
    /* 9. Scroll spy — highlights the current section in the menu      */
    /* --------------------------------------------------------------- */
    (function scrollSpy() {
        var links = $$('.slide-menu__link[data-nav]');
        if (!links.length || !('IntersectionObserver' in window)) return;

        var map = {};
        var sections = [];
        links.forEach(function (link) {
            var key = link.getAttribute('data-nav');
            var section = document.getElementById(key);
            if (!section) return;
            map[key] = link;
            sections.push(section);
        });
        if (!sections.length) return;

        function setActive(key) {
            links.forEach(function (l) {
                l.classList.toggle('is-active', l.getAttribute('data-nav') === key);
            });
        }

        var visible = [];
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                var id = entry.target.id;
                var at = visible.indexOf(id);
                if (entry.isIntersecting && at === -1) visible.push(id);
                else if (!entry.isIntersecting && at !== -1) visible.splice(at, 1);
            });

            if (!visible.length) {
                // Nothing intersecting (tall sections) — fall back to the last
                // section whose top has passed above the header.
                var offset = headerHeight() + 40;
                var current = sections[0].id;
                sections.forEach(function (s) {
                    if (s.getBoundingClientRect().top <= offset) current = s.id;
                });
                setActive(current);
                return;
            }
            setActive(visible[0]);
        }, { rootMargin: '-25% 0px -55% 0px', threshold: 0 });

        sections.forEach(function (s) { io.observe(s); });
        setActive('hero');
    })();

    /* --------------------------------------------------------------- */
    /* 10. Contact form validation -> prefilled mailto                 */
    /* --------------------------------------------------------------- */
    (function contactForm() {
        var form = $('#contact-form');
        if (!form) return;

        var status = $('#form-status');
        var TO_EMAIL = 'rezwan.aiub10@gmail.com';
        var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

        var RULES = {
            'cf-name': function (v) {
                if (!v.trim()) return 'Please tell me your name.';
                if (v.trim().length < 2) return 'That name looks a little short.';
                return '';
            },
            'cf-email': function (v) {
                if (!v.trim()) return 'An email address is required.';
                if (!EMAIL_RE.test(v.trim())) return 'That email address does not look valid.';
                return '';
            },
            'cf-subject': function (v) {
                if (!v.trim()) return 'Please add a subject.';
                if (v.trim().length < 3) return 'That subject looks a little short.';
                return '';
            },
            'cf-message': function (v) {
                if (!v.trim()) return 'Please write a short message.';
                if (v.trim().length < 12) return 'A little more detail would help (12+ characters).';
                return '';
            }
        };

        function fieldOf(input) { return input.closest('.field'); }

        function validate(input, showError) {
            var rule = RULES[input.id];
            if (!rule) return true;
            var message = rule(input.value);
            var wrap = fieldOf(input);
            if (wrap) wrap.classList.toggle('has-error', !!message && showError);
            var errorEl = document.querySelector('[data-error-for="' + input.id + '"]');
            if (errorEl) errorEl.textContent = showError ? message : '';
            return !message;
        }

        var inputs = Object.keys(RULES)
            .map(function (id) { return document.getElementById(id); })
            .filter(Boolean);

        inputs.forEach(function (input) {
            input.addEventListener('blur', function () { validate(input, true); });
            input.addEventListener('input', function () {
                if (fieldOf(input) && fieldOf(input).classList.contains('has-error')) validate(input, true);
            });
        });

        form.addEventListener('submit', function (e) {
            e.preventDefault();

            var valid = true;
            var firstBad = null;
            inputs.forEach(function (input) {
                if (!validate(input, true)) {
                    valid = false;
                    if (!firstBad) firstBad = input;
                }
            });

            if (!valid) {
                if (status) {
                    status.classList.remove('is-ok');
                    status.textContent = 'Please fix the highlighted fields and try again.';
                }
                if (firstBad) firstBad.focus();
                return;
            }

            var name = $('#cf-name').value.trim();
            var email = $('#cf-email').value.trim();
            var subject = $('#cf-subject').value.trim();
            var message = $('#cf-message').value.trim();

            var body = name + ' (' + email + ') wrote:\n\n' + message;
            var href = 'mailto:' + TO_EMAIL +
                '?subject=' + encodeURIComponent(subject) +
                '&body=' + encodeURIComponent(body);

            if (status) {
                status.classList.add('is-ok');
                status.textContent = 'Opening your email client with the message ready to send.';
            }
            window.location.href = href;
        });
    })();

    /* --------------------------------------------------------------- */
    /* 11. Copy email address                                           */
    /* --------------------------------------------------------------- */
    (function copyEmail() {
        var btn = $('#copy-email');
        if (!btn) return;

        var value = btn.getAttribute('data-copy') || '';
        var label = $('span', btn);

        btn.addEventListener('click', function () {
            function done(text) {
                toast(text);
                if (!label) return;
                var original = label.textContent;
                label.textContent = text;
                window.setTimeout(function () { label.textContent = original; }, 2400);
            }

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(value).then(function () {
                    done('Copied ' + value);
                }, function () {
                    done('Copy failed — the address is ' + value);
                });
                return;
            }

            // Fallback for browsers without the async clipboard API.
            var field = document.createElement('textarea');
            field.value = value;
            field.setAttribute('readonly', '');
            field.style.position = 'fixed';
            field.style.opacity = '0';
            document.body.appendChild(field);
            field.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
            document.body.removeChild(field);
            done(ok ? 'Copied ' + value : 'Copy failed — the address is ' + value);
        });
    })();

    /* --------------------------------------------------------------- */
    /* 12. CV download feedback                                         */
    /* --------------------------------------------------------------- */
    (function cvDownload() {
        $$('[data-download-cv]').forEach(function (link) {
            link.addEventListener('click', function () {
                var name = link.getAttribute('download') || 'Md-Rezwanul-Haque-CV.pdf';
                toast('Downloading ' + name + ' …');
            });
        });
    })();

    /* --------------------------------------------------------------- */
    /* 13. Footer year                                                  */
    /* --------------------------------------------------------------- */
    (function footerYear() {
        var el = $('#current-year');
        if (el) el.textContent = String(new Date().getFullYear());
    })();
})();
