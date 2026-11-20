
/* =========================================================
   RfbM — PLAYLIST ANALYTICS
   Supabase + Cloudflare Turnstile
   ========================================================= */

(function () {

    "use strict";


    const CONFIG = window.RfbMAnalyticsConfig;

    if (
        !CONFIG ||
        !CONFIG.supabaseUrl ||
        !CONFIG.publishableKey ||
        !CONFIG.functionUrl ||
        !CONFIG.turnstileSiteKey
    ) {
        console.error("RfbM Analytics : configuration missing.");
        return;
    }


    const HEARTBEAT_INTERVAL = 15000;

    const STORAGE_SESSION_ID = "rfbm_analytics_session_id";
    const STORAGE_SESSION_TOKEN = "rfbm_analytics_session_token";


    let audio = null;

    let sessionId = null;
    let sessionToken = null;

    let turnstileWidget = null;
    let turnstileReady = false;

    let isActuallyPlaying = false;
    let isPaused = false;

    let currentTrackSignature = "";
    let currentTrackInfo = null;

    let listenSeconds = 0;

    let heartbeatTimer = null;
    let pauseTimer = null;
    let endTimer = null;

    let startPromise = null;


    /* -----------------------------------------------------
       DEVICE AND BROWSER
       ----------------------------------------------------- */

    function getDeviceType() {

        const ua = navigator.userAgent || "";

        if (/tablet|ipad/i.test(ua)) {
            return "tablet";
        }

        if (/mobile|android|iphone|ipod/i.test(ua)) {
            return "mobile";
        }

        return "desktop";
    }


    function getBrowser() {

        const ua = navigator.userAgent || "";

        if (/Edg\//i.test(ua)) return "Edge";
        if (/OPR\//i.test(ua)) return "Opera";
        if (/Chrome\//i.test(ua)) return "Chrome";
        if (/Firefox\//i.test(ua)) return "Firefox";
        if (/Safari\//i.test(ua)) return "Safari";

        return "Other";
    }


    /* -----------------------------------------------------
       CURRENT PLAYLIST AND TRACK
       ----------------------------------------------------- */

    
function getCurrentTrackInfo() {

    let state = {};

    try {

        if (
            typeof window.RfbMPlaylistState === "function"
        ) {
            state = window.RfbMPlaylistState() || {};
        }

    } catch (error) {
        state = {};
    }


    const playlist =
        Array.isArray(state.playlist)
            ? state.playlist
            : [];

    const track =
        playlist[state.trackIndex] || null;


    const title =
        track?.title ||
        track?.name ||
        track?.track ||
        document.querySelector("#playlistTitle")?.textContent?.trim() ||
        "Unknown track";


    const artist =
        state.artist ||
        track?.artist ||
        track?.Artist ||
        "";


    const source =
        track?.src ||
        track?.url ||
        audio?.currentSrc ||
        audio?.src ||
        "";


    return {

        playlist_name: "RfbM Playlists",

        track_title: String(title).slice(0, 200),

        artist_name: String(artist).slice(0, 200),

        signature: [
            title,
            artist,
            source
        ].join("|")

    };
}

    /* -----------------------------------------------------
       SESSION STORAGE
       ----------------------------------------------------- */

    function loadStoredSession() {

        try {

            sessionId =
                sessionStorage.getItem(STORAGE_SESSION_ID);

            sessionToken =
                sessionStorage.getItem(STORAGE_SESSION_TOKEN);

        } catch (error) {

            sessionId = null;
            sessionToken = null;
        }
    }


    function saveStoredSession() {

        try {

            if (sessionId && sessionToken) {

                sessionStorage.setItem(
                    STORAGE_SESSION_ID,
                    sessionId
                );

                sessionStorage.setItem(
                    STORAGE_SESSION_TOKEN,
                    sessionToken
                );
            }

        } catch (error) {
            // Storage unavailable.
        }
    }


    function clearStoredSession() {

        try {

            sessionStorage.removeItem(STORAGE_SESSION_ID);
            sessionStorage.removeItem(STORAGE_SESSION_TOKEN);

        } catch (error) {
            // Storage unavailable.
        }

        sessionId = null;
        sessionToken = null;
    }


    function createSessionId() {

        if (
            crypto &&
            typeof crypto.randomUUID === "function"
        ) {
            return crypto.randomUUID();
        }

        throw new Error("Secure UUID generation unavailable.");
    }

   
/* -----------------------------------------------------
   TURNSTILE INITIALIZATION
   ----------------------------------------------------- */

let turnstileInitPromise = null;
let pendingTurnstileRequest = null;


function initializeTurnstile() {

    if (turnstileReady) {
        return Promise.resolve();
    }

    if (turnstileInitPromise) {
        return turnstileInitPromise;
    }


    turnstileInitPromise = new Promise(function (resolve, reject) {

        let attempts = 0;

        const checkTurnstile = setInterval(function () {

            attempts++;

            if (
                window.turnstile &&
                typeof window.turnstile.render === "function"
            ) {

                clearInterval(checkTurnstile);

                try {

                    const container =
                        document.createElement("div");

                    container.id =
                        "rfbm-turnstile-container";

                    container.style.position = "fixed";
                    container.style.left = "-10000px";
                    container.style.top = "0";

                    document.body.appendChild(container);


                    turnstileWidget =
                        window.turnstile.render(
                            container,
                            {
                                sitekey: CONFIG.turnstileSiteKey,

                                action: "rfbm_start",

                                size: "invisible",

                                execution: "execute",

                                callback: function (token) {

                                    if (
                                        pendingTurnstileRequest &&
                                        token
                                    ) {

                                        const request =
                                            pendingTurnstileRequest;

                                        pendingTurnstileRequest = null;

                                        clearTimeout(request.timeout);

                                        request.resolve(token);
                                    }
                                },

                                "error-callback": function () {

                                    if (pendingTurnstileRequest) {

                                        const request =
                                            pendingTurnstileRequest;

                                        pendingTurnstileRequest = null;

                                        clearTimeout(request.timeout);

                                        request.reject(
                                            new Error("Turnstile verification failed.")
                                        );
                                    }
                                },

                                "expired-callback": function () {

                                    if (pendingTurnstileRequest) {

                                        const request =
                                            pendingTurnstileRequest;

                                        pendingTurnstileRequest = null;

                                        clearTimeout(request.timeout);

                                        request.reject(
                                            new Error("Turnstile token expired.")
                                        );
                                    }
                                }
                            }
                        );


                    turnstileReady = true;

                    resolve();

                } catch (error) {

                    turnstileInitPromise = null;

                    reject(error);
                }

                return;
            }


            if (attempts >= 200) {

                clearInterval(checkTurnstile);

                turnstileInitPromise = null;

                reject(
                    new Error("Turnstile did not load.")
                );
            }

        }, 100);

    });


    return turnstileInitPromise;
}


async function getTurnstileToken() {

    await initializeTurnstile();


    return new Promise(function (resolve, reject) {

        if (pendingTurnstileRequest) {

            reject(
                new Error("A Turnstile request is already running.")
            );

            return;
        }


        const timeout = setTimeout(function () {

            pendingTurnstileRequest = null;

            reject(
                new Error("Turnstile verification timed out.")
            );

        }, 30000);


        pendingTurnstileRequest = {
            resolve: resolve,
            reject: reject,
            timeout: timeout
        };


        try {

            window.turnstile.reset(turnstileWidget);

            window.turnstile.execute(turnstileWidget);

        } catch (error) {

            clearTimeout(timeout);

            pendingTurnstileRequest = null;

            reject(error);
        }

    });
}

    /* -----------------------------------------------------
       SUPABASE REQUEST
       ----------------------------------------------------- */

    async function sendRequest(action, trackInfo, seconds, extra) {

        if (!sessionId) {
            throw new Error("No analytics session.");
        }


        const payload = {

            action: action,

            session_id: sessionId,

            playlist_name:
                trackInfo?.playlist_name || null,

            track_title:
                trackInfo?.track_title || null,

            artist_name:
                trackInfo?.artist_name || null,

            listen_seconds:
                Math.max(0, Math.min(86400, Math.floor(seconds || 0))),

            ...(extra || {})

        };


        const headers = {

            "Content-Type": "application/json",

            "apikey": CONFIG.publishableKey

        };


        if (
            action !== "start" &&
            sessionToken
        ) {

            payload.session_token = sessionToken;
        }


        const response = await fetch(
            CONFIG.functionUrl,
            {
                method: "POST",
                headers: headers,
                body: JSON.stringify(payload),
                keepalive: action === "stop"
            }
        );


        let result = {};

        try {
            result = await response.json();
        } catch (error) {
            result = {};
        }


        if (!response.ok || !result.ok) {

            throw new Error(
                result.error ||
                "Analytics request failed: " + response.status
            );
        }

        return result;
    }


    /* -----------------------------------------------------
       START SESSION
       ----------------------------------------------------- */

    async function startSession(trackInfo) {

        if (startPromise) {
            return startPromise;
        }


        startPromise = (async function () {

            try {

                sessionId = createSessionId();

                const turnstileToken =
                    await getTurnstileToken();


                const result = await sendRequest(
                    "start",
                    trackInfo,
                    0,
                    {
                        turnstile_token: turnstileToken
                    }
                );


                if (!result.session_token) {
                    throw new Error("Session token missing.");
                }


                sessionToken = result.session_token;

                saveStoredSession();

                currentTrackInfo = trackInfo;

                currentTrackSignature =
                    trackInfo.signature;

                isPaused = false;

                listenSeconds = 0;

                startHeartbeat();

                return true;

            } catch (error) {

                clearStoredSession();

                console.warn(
                    "RfbM Analytics : session start failed.",
                    error.message
                );

                return false;

            } finally {

                startPromise = null;
            }

        })();


        return startPromise;
    }


    /* -----------------------------------------------------
       HEARTBEAT
       ----------------------------------------------------- */

    function startHeartbeat() {

        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
        }


        heartbeatTimer = setInterval(async function () {

            if (
                !sessionToken ||
                !isActuallyPlaying
            ) {
                return;
            }


            try {

                await sendRequest(
                    "heartbeat",
                    currentTrackInfo,
                    0
                );

            } catch (error) {

                console.warn(
                    "RfbM Analytics : heartbeat failed.",
                    error.message
                );
            }

        }, HEARTBEAT_INTERVAL);
    }


    /* -----------------------------------------------------
       PAUSE / RESUME / TRACK CHANGE
       ----------------------------------------------------- */

    async function handlePlaying() {

        if (pauseTimer) {
            clearTimeout(pauseTimer);
            pauseTimer = null;
        }

        if (endTimer) {
            clearTimeout(endTimer);
            endTimer = null;
        }


        isActuallyPlaying = true;


        const newTrackInfo = getCurrentTrackInfo();


        if (!sessionId || !sessionToken) {

            await startSession(newTrackInfo);

            return;
        }


        if (isPaused) {

            try {

                await sendRequest(
                    "resume",
                    newTrackInfo,
                    listenSeconds
                );

                isPaused = false;

                listenSeconds = 0;

                currentTrackInfo = newTrackInfo;

                currentTrackSignature =
                    newTrackInfo.signature;

            } catch (error) {

                console.warn(
                    "RfbM Analytics : resume failed.",
                    error.message
                );
            }

            return;
        }


        if (
            currentTrackSignature &&
            newTrackInfo.signature !== currentTrackSignature
        ) {

            try {

                await sendRequest(
                    "track_change",
                    currentTrackInfo,
                    listenSeconds
                );

                listenSeconds = 0;

                currentTrackInfo = newTrackInfo;

                currentTrackSignature =
                    newTrackInfo.signature;

            } catch (error) {

                console.warn(
                    "RfbM Analytics : track change failed.",
                    error.message
                );
            }
        }
    }


    function handlePause() {

        isActuallyPlaying = false;


        if (endTimer) {
            return;
        }


        if (pauseTimer) {
            clearTimeout(pauseTimer);
        }


        pauseTimer = setTimeout(async function () {

            if (
                !audio ||
                !audio.paused ||
                audio.ended ||
                !sessionToken ||
                isPaused
            ) {
                return;
            }


            try {

                await sendRequest(
                    "pause",
                    currentTrackInfo,
                    listenSeconds
                );

                isPaused = true;

                listenSeconds = 0;

            } catch (error) {

                console.warn(
                    "RfbM Analytics : pause failed.",
                    error.message
                );
            }

        }, 600);
    }


    /* -----------------------------------------------------
       LISTENING TIME
       ----------------------------------------------------- */

    setInterval(function () {

        if (
            isActuallyPlaying &&
            audio &&
            !audio.paused &&
            !audio.ended
        ) {
            listenSeconds++;
        }

    }, 1000);


    /* -----------------------------------------------------
       TRACK END
       ----------------------------------------------------- */

    function handleEnded() {

        isActuallyPlaying = false;


        if (endTimer) {
            clearTimeout(endTimer);
        }


        endTimer = setTimeout(async function () {

            if (
                !audio ||
                !audio.paused ||
                !sessionToken
            ) {
                return;
            }


            try {

                await sendRequest(
                    "stop",
                    currentTrackInfo,
                    listenSeconds
                );

            } catch (error) {

                console.warn(
                    "RfbM Analytics : stop failed.",
                    error.message
                );
            }


            clearStoredSession();

            isPaused = false;

            listenSeconds = 0;

            currentTrackInfo = null;

            currentTrackSignature = "";

            endTimer = null;

        }, 3000);
    }


    /* -----------------------------------------------------
       PAGE EXIT
       ----------------------------------------------------- */

    window.addEventListener("pagehide", function () {

        if (
            !sessionId ||
            !sessionToken
        ) {
            return;
        }


        sendRequest(
            "stop",
            currentTrackInfo,
            listenSeconds
        ).catch(function () {});


        clearStoredSession();

    });


    /* -----------------------------------------------------
       AUDIO INITIALIZATION
       ----------------------------------------------------- */
    
function initializeAnalytics() {

    audio = window.RfbMPlaylistAudio || null;

    if (!audio) {
        return false;
    }


    loadStoredSession();


    if (
        audio.dataset.rfbmAnalyticsAttached === "true"
    ) {
        return true;
    }

    audio.dataset.rfbmAnalyticsAttached = "true";


    audio.addEventListener(
        "playing",
        handlePlaying
    );


    audio.addEventListener(
        "pause",
        handlePause
    );


    audio.addEventListener(
        "ended",
        handleEnded
    );


    audio.addEventListener(
        "waiting",
        function () {
            isActuallyPlaying = false;
        }
    );


    audio.addEventListener(
        "playing",
        function () {
            isActuallyPlaying = true;
        }
    );


    console.info(
        "RfbM Analytics : initialized."
    );

    return true;
}

    /* -----------------------------------------------------
       WAIT FOR THE PLAYER
       ----------------------------------------------------- */

    let initializationAttempts = 0;

    const initializationTimer = setInterval(function () {

        initializationAttempts++;

        if (initializeAnalytics()) {

            clearInterval(initializationTimer);

            return;
        }


        if (initializationAttempts >= 200) {

            clearInterval(initializationTimer);

            console.warn(
                "RfbM Analytics : playlist player not found."
            );
        }

    }, 100);


})();

