const CACHE_NAME = 'aura-v11';
const ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/equalizer.js',
  '/js/visualizer.js',
  '/js/jam.js',
  '/manifest.json'
];

// Offline fallback configuration
const PIPED_TIMEOUT_MS = 5000;
const SERVER_TIMEOUT_MS = 6000;
const SERVER_RETRY_COOLDOWN_MS = 30000;
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt'
];

let serverLastFailed = 0;

// Helper function to query server with cooldown and timeout
async function tryServer(request, timeoutMs = SERVER_TIMEOUT_MS) {
  const now = Date.now();
  if (now - serverLastFailed < SERVER_RETRY_COOLDOWN_MS) {
    throw new Error('Server retry cooldown active');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request.clone(), { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      serverLastFailed = Date.now();
      throw new Error(`Server returned error status: ${response.status}`);
    }
    return response;
  } catch (e) {
    clearTimeout(timer);
    serverLastFailed = Date.now();
    throw e;
  }
}

// Helper to fetch audio stream from Piped instances
async function tryPipedStream(videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PIPED_TIMEOUT_MS);

  try {
    const streamData = await Promise.any(
      PIPED_INSTANCES.map(instance =>
        fetch(`${instance}/streams/${videoId}`, { signal: controller.signal })
          .then(async (r) => {
            if (r.ok) {
              const json = await r.json();
              if (json && json.audioStreams && json.audioStreams.length > 0) {
                return json;
              }
            }
            throw new Error('Failed stream info fetch');
          })
      )
    );
    clearTimeout(timer);

    const audioStreams = streamData.audioStreams;
    // Sort descending by bitrate to select highest quality stream
    audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const bestStream = audioStreams[0];
    if (!bestStream || !bestStream.url) {
      throw new Error('No valid audio stream found');
    }

    const audioController = new AbortController();
    const audioTimer = setTimeout(() => audioController.abort(), PIPED_TIMEOUT_MS * 2);

    const audioRes = await fetch(bestStream.url, { signal: audioController.signal });
    clearTimeout(audioTimer);

    if (!audioRes.ok) {
      throw new Error('Failed to fetch audio file');
    }

    const responseHeaders = new Headers(audioRes.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Accept-Ranges', 'bytes');
    responseHeaders.set('X-Aura-Offline', 'true');
    if (!responseHeaders.has('Content-Type')) {
      responseHeaders.set('Content-Type', 'audio/mp4');
    }

    return new Response(audioRes.body, {
      status: audioRes.status,
      statusText: audioRes.statusText,
      headers: responseHeaders
    });
  } catch (e) {
    clearTimeout(timer);
    console.warn('Piped stream fallback failed:', e);
    throw e;
  }
}

// Helper to search Piped instances
async function tryPipedSearch(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PIPED_TIMEOUT_MS);

  try {
    const searchData = await Promise.any(
      PIPED_INSTANCES.map(instance =>
        fetch(`${instance}/search?q=${encodeURIComponent(query)}&filter=music_songs`, { signal: controller.signal })
          .then(async (r) => {
            if (r.ok) {
              const json = await r.json();
              if (json && json.items) {
                return json;
              }
            }
            throw new Error('Failed search fetch');
          })
      )
    );
    clearTimeout(timer);

    const auraResults = (searchData.items || [])
      .filter(item => item.url && item.url.includes('watch'))
      .map(item => {
        const urlPart = item.url.split('v=')[1];
        const videoId = urlPart ? urlPart.split('&')[0] : '';
        const durSec = item.duration || 0;
        const m = Math.floor(durSec / 60);
        const s = durSec % 60;
        return {
          id: videoId,
          title: item.title || '',
          artist: item.uploaderName || 'Unknown Artist',
          thumbnail: item.thumbnail || '',
          duration: `${m}:${s.toString().padStart(2, '0')}`,
          durationSeconds: durSec,
          type: 'song',
          album: '',
          albumId: '',
          artistId: ''
        };
      })
      .filter(t => t.id);

    return new Response(JSON.stringify(auraResults), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Aura-Offline': 'true'
      }
    });
  } catch (e) {
    clearTimeout(timer);
    console.warn('Piped search fallback failed:', e);
    throw e;
  }
}

// Helper to parse LRC lyrics strings
function parseLrc(lrcText) {
  const lines = lrcText.split("\n");
  const parsed = [];
  const regex = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const matches = [];
    let match;
    regex.lastIndex = 0; // reset regex state
    while ((match = regex.exec(line)) !== null) {
      matches.push(match);
    }
    if (matches.length === 0) continue;

    const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();

    for (const m of matches) {
      const minutes = parseInt(m[1], 10);
      const seconds = parseInt(m[2], 10);
      let milliseconds = 0;
      if (m[3]) {
        let msStr = m[3].padEnd(3, '0').substring(0, 3);
        milliseconds = parseInt(msStr, 10);
      }
      const totalSeconds = minutes * 60 + seconds + (milliseconds / 1000.0);
      parsed.push({
        time: totalSeconds,
        text: text
      });
    }
  }
  parsed.sort((a, b) => a.time - b.time);
  return parsed;
}

// Helper to generate synthetic sync times for plain text lyrics
function generateSyntheticSync(plainText, durationSec) {
  const lines = plainText.split("\n").map(l => l.trim()).filter(l => l);
  if (lines.length === 0) return [];
  const duration = durationSec > 0 ? durationSec : 180;
  const lineCount = lines.length;
  const interval = duration / Math.max(lineCount + 1, 1);
  const synced = [];
  for (let idx = 0; idx < lines.length; idx++) {
    synced.push({
      time: parseFloat(((idx + 1) * interval).toFixed(2)),
      text: lines[idx]
    });
  }
  return synced;
}

// Helper to query lrclib.net directly
async function tryLrclib(title, artist, durationSeconds) {
  const cleanTitle = title.replace(/\(.*?\)|\[.*?\]/g, "").trim();
  const cleanArtist = artist.replace(/\(.*?\)|\[.*?\]/g, "").trim();

  let url = `https://lrclib.net/api/lookup?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;
  if (durationSeconds > 0) {
    url += `&duration=${durationSeconds}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PIPED_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (response.ok) {
      const data = await response.json();
      const syncedLrc = data.syncedLyrics;
      const plainLrc = data.plainLyrics;

      if (syncedLrc) {
        return new Response(JSON.stringify({
          synced: true,
          lyrics: parseLrc(syncedLrc),
          source: "lrclib (Synced) [Offline]"
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Aura-Offline': 'true'
          }
        });
      } else if (plainLrc) {
        return new Response(JSON.stringify({
          synced: false,
          lyrics: generateSyntheticSync(plainLrc, durationSeconds),
          source: "lrclib (Plain, Auto-Synced) [Offline]"
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Aura-Offline': 'true'
          }
        });
      }
    }
    throw new Error('No lyrics available in response');
  } catch (e) {
    clearTimeout(timer);
    console.warn("lrclib lookup failed, returning synthetic:", e);
    return new Response(JSON.stringify({
      synced: false,
      lyrics: [],
      source: "Offline mode"
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Aura-Offline': 'true'
      }
    });
  }
}

// Orchestrator for all /api/ requests
async function handleApiRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path.includes('/api/stream')) {
    const videoId = url.searchParams.get('video_id');
    try {
      return await tryServer(request);
    } catch (err) {
      console.warn('Server stream failed, falling back to Piped:', err);
      try {
        return await tryPipedStream(videoId);
      } catch (pipedErr) {
        console.error('All Piped stream options failed:', pipedErr);
        return Response.error();
      }
    }
  }

  if (path.includes('/api/search')) {
    const query = url.searchParams.get('q');
    try {
      return await tryServer(request);
    } catch (err) {
      console.warn('Server search failed, falling back to Piped:', err);
      try {
        return await tryPipedSearch(query);
      } catch (pipedErr) {
        console.error('All Piped search options failed:', pipedErr);
        return Response.error();
      }
    }
  }

  if (path.includes('/api/suggestions')) {
    try {
      return await tryServer(request);
    } catch (err) {
      console.warn('Server suggestions failed, returning empty array:', err);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Aura-Offline': 'true'
        }
      });
    }
  }

  if (path.includes('/api/lyrics')) {
    const title = url.searchParams.get('title') || '';
    const artist = url.searchParams.get('artist') || '';
    const durationSeconds = parseInt(url.searchParams.get('duration') || '0', 10);
    try {
      return await tryServer(request);
    } catch (err) {
      console.warn('Server lyrics failed, falling back to lrclib:', err);
      return await tryLrclib(title, artist, durationSeconds);
    }
  }

  if (path.includes('/api/recommendations') || path.includes('/api/mood')) {
    try {
      return await tryServer(request);
    } catch (err) {
      console.warn(`Server ${path} failed, returning empty array:`, err);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Aura-Offline': 'true'
        }
      });
    }
  }

  // Fallback for album, artist, jam, etc.
  try {
    return await tryServer(request);
  } catch (err) {
    console.error(`API request for ${path} failed and has no fallback:`, err);
    return Response.error();
  }
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          // 🔥 FIX: 'aura-audio-cache' ko delete hone se bachaya (Offline gaane safe rahenge)
          if (key !== CACHE_NAME && key !== 'aura-audio-cache') {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) {
    e.respondWith(handleApiRequest(e.request));
    return;
  }
  
  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // 🔥 FIX 1: Sirf 'opaque' (YouTube Thumbnails) ko cache hone se roko. 
        // Fonts aur CSS (cors/basic) ko cache hone do.
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        
        const resClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, resClone);
        });
        return response;
      })
      .catch(() => {
        return caches.match(e.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse; // Cache mil gaya toh de do
          if (e.request.mode === 'navigate') return caches.match('/index.html');
          return Response.error(); // 🔥 FIX 2: Null ki jagah proper error do jisse TypeError na aaye
        });
      })
  );
});