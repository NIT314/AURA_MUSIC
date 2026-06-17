import httpx
import re
import logging
from ytmusicapi import YTMusic

logger = logging.getLogger(__name__)
ytmusic = YTMusic()

def parse_lrc(lrc_text: str):
    lines = lrc_text.split("\n")
    parsed = []
    time_regex = re.compile(r"\[(\d+):(\d+)(?:\.(\d+))?\]")
    for line in lines:
        line = line.strip()
        if not line:
            continue
        matches = time_regex.findall(line)
        if not matches:
            continue
        text = time_regex.sub("", line).strip()
        for m in matches:
            minutes = int(m[0])
            seconds = int(m[1])
            milliseconds = int(m[2]) if m[2] else 0
            if len(m[2]) == 1:
                milliseconds *= 100
            elif len(m[2]) == 2:
                milliseconds *= 10
            total_seconds = minutes * 60 + seconds + (milliseconds / 1000.0)
            parsed.append({
                "time": total_seconds,
                "text": text
            })
    parsed.sort(key=lambda x: x["time"])
    return parsed

def generate_synthetic_sync(plain_text: str, duration_sec: int):
    lines = [line.strip() for line in plain_text.split("\n") if line.strip()]
    if not lines:
        return []
    duration = duration_sec if duration_sec > 0 else 180
    line_count = len(lines)
    interval = duration / max((line_count + 1), 1)
    synced = []
    for idx, line in enumerate(lines):
        synced.append({
            "time": round((idx + 1) * interval, 2),
            "text": line
        })
    return synced

async def fetch_lyrics(video_id: str, title: str, artist: str, duration_seconds: int = 0):
    try:
        async with httpx.AsyncClient() as client:
            clean_title = re.sub(r"\(.*?\)|\[.*?\]", "", title).strip()
            clean_artist = re.sub(r"\(.*?\)|\[.*?\]", "", artist).strip()
            url = "https://lrclib.net/api/lookup"
            params = {
                "track_name": clean_title,
                "artist_name": clean_artist
            }
            if duration_seconds > 0:
                params["duration"] = duration_seconds
            logger.info(f"Querying lrclib for {clean_title} - {clean_artist}")
            response = await client.get(url, params=params, timeout=5.0)
            if response.status_code == 200:
                data = response.json()
                synced_lrc = data.get("syncedLyrics")
                plain_lrc = data.get("plainLyrics")
                if synced_lrc:
                    return {
                        "synced": True,
                        "lyrics": parse_lrc(synced_lrc),
                        "source": "lrclib (Synced)"
                    }
                elif plain_lrc:
                    return {
                        "synced": False,
                        "lyrics": generate_synthetic_sync(plain_lrc, duration_seconds),
                        "source": "lrclib (Plain, Auto-Synced)"
                    }
    except Exception as e:
        logger.warning(f"lrclib.net lookup failed/timed out: {e}")

    try:
        watch_playlist = ytmusic.get_watch_playlist(videoId=video_id)
        lyrics_browse_id = watch_playlist.get("lyrics")
        if lyrics_browse_id:
            yt_lyrics_data = ytmusic.get_lyrics(lyrics_browse_id)
            plain_text = yt_lyrics_data.get("lyrics", "")
            source = yt_lyrics_data.get("source", "YouTube Music")
            if plain_text:
                return {
                    "synced": False,
                    "lyrics": generate_synthetic_sync(plain_text, duration_seconds),
                    "source": f"{source} (Auto-Synced)"
                }
    except Exception as e:
        logger.warning(f"YTMusic lyrics fetch failed: {e}")

    placeholder_text = (
        f"[Instrumental Intro]\n"
        f"Playing: {title}\n"
        f"By: {artist}\n"
        f"Lyrics not found for this track.\n"
        f"Enjoy the premium spatial audio visualizer!\n"
        f"[Instrumental Outro]"
    )
    return {
        "synced": False,
        "lyrics": generate_synthetic_sync(placeholder_text, duration_seconds),
        "source": "AURA System (Synthetic)"
    }
