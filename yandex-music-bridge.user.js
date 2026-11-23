// ==UserScript==
// @name         Yandex Music Link-Parser Bridge
// @namespace    http://oterworlds.xyz/
// @version      10.1
// @description  Автоматическая отправка текущего трека из Яндекс Музыки в OBS
// @author       oter-dev
// @match        https://music.yandex.ru/*
// @connect      yandex-bridge.kirillselivonchik0.workers.dev
// @updateURL    https://raw.githubusercontent.com/oter-dev/denmiten-music/main/yandex-music-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/oter-dev/denmiten-music/main/yandex-music-bridge.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @inject-into  content
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const WORKER_URL = 'https://yandex-bridge.kirillselivonchik0.workers.dev/';
    const HEARTBEAT_MS = 8000;

    let lastStateKey = '';
    let lastSentAt = 0;
    let isSending = false;
    let debounceTimer = null;

    function sendData(data) {
        if (isSending) return;
        isSending = true;

        GM_xmlhttpRequest({
            method: 'POST',
            url: WORKER_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(data),
            timeout: 5000,
            onload: function (res) {
                isSending = false;
                if (res.status < 200 || res.status >= 300) {
                    console.warn('[OBS Bridge] Ошибка сервера:', res.status);
                }
            },
            onerror: function () {
                isSending = false;
            },
            ontimeout: function () {
                isSending = false;
            }
        });
    }

    function normalizeCover(url) {
        if (!url) return '';
        return String(url).replace(/(?:\/m?\d+x\d+|%%)(?=[?#]|$)/, (m) =>
            m.startsWith('/') ? '/400x400' : '400x400'
        );
    }

    function getMediaSessionData() {
        const candidates = [];
        try { if (window.wrappedJSObject?.navigator?.mediaSession) candidates.push(window.wrappedJSObject.navigator.mediaSession); } catch (_) {}
        try { if (typeof unsafeWindow !== 'undefined' && unsafeWindow.navigator?.mediaSession) candidates.push(unsafeWindow.navigator.mediaSession); } catch (_) {}
        try { if (navigator.mediaSession) candidates.push(navigator.mediaSession); } catch (_) {}

        let title = '';
        let artist = '';
        let cover = '';
        let playbackState = 'none';

        for (const ms of candidates) {
            try {
                if (playbackState === 'none' && ms.playbackState && ms.playbackState !== 'none') {
                    playbackState = String(ms.playbackState);
                }
                if (!title && ms.metadata?.title) {
                    title = String(ms.metadata.title).trim();
                    artist = String(ms.metadata.artist || '').trim();
                    const artworks = ms.metadata.artwork;
                    if (artworks && artworks.length > 0) {
                        cover = String(artworks[artworks.length - 1].src || '');
                    }
                }
            } catch (_) {}
        }

        return { title, artist, cover, playbackState };
    }

    function findPlayerBar() {
        const directSelectors = [
            '[class*="PlayerBarDesktop"]',
            '[class*="PlayerBar_root"]',
            '[class*="PlayerBar"]',
            '[data-testid*="PLAYER_BAR" i]',
            '[data-test-id*="PLAYER_BAR" i]'
        ];

        for (const sel of directSelectors) {
            const el = document.querySelector(sel);
            if (el && el.querySelector('button')) return el;
        }

        const control = document.querySelector(
            '[data-testid*="NEXT_TRACK" i], [data-test-id*="NEXT_TRACK" i], ' +
            'button[aria-label*="Следующ" i], button[aria-label*="Next" i], ' +
            'footer [role="slider"], footer input[type="range"]'
        );

        if (control) {
            let el = control.parentElement;
            while (el && el !== document.body) {
                const r = el.getBoundingClientRect();
                if (r.width >= window.innerWidth * 0.45 && r.height <= 220 && el.querySelectorAll('button').length >= 2) {
                    return el;
                }
                el = el.parentElement;
            }
        }

        const legacy = document.querySelector('.player-controls');
        if (legacy) return legacy.closest('.bar, footer, div') || legacy.parentElement;

        return null;
    }

    function getDomState(playerBar) {
        if (!playerBar) return { title: '', artist: '', cover: '', isPlaying: null };

        let title = '';
        const titleEl =
            playerBar.querySelector('a[href*="/track/"]') ||
            playerBar.querySelector('a[href*="/album/"]') ||
            playerBar.querySelector('[class*="Meta_title" i], [class*="TrackTitle" i]');
        if (titleEl) title = titleEl.textContent.trim();

        let artist = '';
        const artistLinks = Array.from(playerBar.querySelectorAll('a[href*="/artist/"]'));
        if (artistLinks.length > 0) {
            artist = [...new Set(artistLinks.map((a) => a.textContent.trim()).filter(Boolean))].join(', ');
        } else {
            const artistEl = playerBar.querySelector('[class*="Meta_artists" i], [class*="artists" i]');
            if (artistEl) artist = artistEl.textContent.trim();
        }

        let cover = '';
        const imgEl = playerBar.querySelector(
            'img[src*="get-music-cover"], img[src*="avatars.yandex.net"], img[srcset*="avatars.yandex.net"]'
        );
        if (imgEl) cover = imgEl.currentSrc || imgEl.src || '';

        let isPlaying = null;
        if (
            playerBar.querySelector(
                '[data-testid*="PAUSE" i], [data-test-id*="PAUSE" i], ' +
                'button[aria-label*="Пауза" i], button[aria-label*="Pause" i], ' +
                'button use[href*="pause" i], button use[xlink\\:href*="pause" i], ' +
                '.player-controls__btn_pause'
            )
        ) {
            isPlaying = true;
        } else if (
            playerBar.querySelector(
                '[data-testid*="PLAY" i], [data-test-id*="PLAY" i], ' +
                'button[aria-label*="Воспроизвест" i], button[aria-label*="Слушать" i], button[aria-label*="Play" i], ' +
                'button use[href*="play" i], button use[xlink\\:href*="play" i], ' +
                '.player-controls__btn_play'
            )
        ) {
            isPlaying = false;
        }

        return { title, artist, cover, isPlaying };
    }

    function collectTrackData() {
        const ms = getMediaSessionData();
        const playerBar = findPlayerBar();
        const dom = getDomState(playerBar);

        const title = dom.title || ms.title;
        const artist = dom.artist || ms.artist || 'Яндекс Музыка';
        const cover = normalizeCover(dom.cover || ms.cover);

        let isPlaying = false;
        if (dom.isPlaying !== null) {
            isPlaying = dom.isPlaying;
        } else if (ms.playbackState === 'playing') {
            isPlaying = true;
        }

        return { title, artist, cover, isPlaying };
    }

    function checkTrack(force = false) {
        try {
            const currentData = collectTrackData();
            if (!currentData.title) return;

            const stateKey = JSON.stringify(currentData);
            const now = Date.now();
            const changed = stateKey !== lastStateKey;
            const heartbeatDue = now - lastSentAt >= HEARTBEAT_MS;

            if (changed || force || heartbeatDue) {
                lastStateKey = stateKey;
                lastSentAt = now;
                sendData(currentData);
                if (changed) {
                    console.log('[OBS Bridge] Трек обновлён:', currentData);
                }
            }
        } catch (e) {
            console.error('[OBS Bridge] Ошибка:', e);
        }
    }

    if (document.body) {
        const observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => checkTrack(false), 250);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-label', 'src', 'href']
        });
    }

    setInterval(() => checkTrack(false), 1000);
    document.addEventListener('visibilitychange', () => checkTrack(true));

    console.info('[OBS Bridge] v10.1 запущен');
})();