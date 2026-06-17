import random
from services.music_service import search_music, get_related_tracks
import logging

logger = logging.getLogger(__name__)

MOOD_QUERIES = {
    "happy": ["happy pop hits", "upbeat feel good songs", "happy morning vibe"],
    "sad": ["sad emotional hindi songs", "sad acoustic breakup songs", "lofi sad tracks"],
    "workout": ["gym workout phonk motivation", "high energy workout playlist", "edm workout beat"],
    "sleep": ["lofi sleep music", "deep sleep ambient rainfall", "peaceful sleep piano"],
    "romantic": ["romantic hindi love songs", "acoustic romantic ballads", "slow pop love hits"],
    "rain": ["rainy day chill music", "lofi rain sounds", "acoustic rainy day"]
}

AI_DJ_PHRASES = [
    "Here is a selection tuned to your current listening rhythm.",
    "Based on your recent hits, I think you'll vibe with this track.",
    "Transitioning into some acoustic grooves for the perfect aura.",
    "Keeping the energy levels high with this next mix.",
    "Time to slow down and relax with some chill ambient melodies.",
    "A legendary track that matches your listening mood."
]

def get_mood_playlist(mood: str):
    mood_key = mood.lower().strip()
    queries = MOOD_QUERIES.get(mood_key, ["chill vibes"])
    selected_query = random.choice(queries)
    results = search_music(selected_query, filter_type="songs")
    return results[:25]

def get_ai_recommendations(history_ids: list, current_video_id: str = None):
    recommendations = []
    try:
        if current_video_id:
            related = get_related_tracks(current_video_id)
            recommendations.extend(related)
        if len(recommendations) < 15 and history_ids:
            random_history_id = random.choice(history_ids)
            related_history = get_related_tracks(random_history_id)
            existing_ids = {r["id"] for r in recommendations}
            for track in related_history:
                if track["id"] not in existing_ids and track["id"] not in history_ids:
                    recommendations.append(track)
        if not recommendations:
            recommendations = search_music("trending global hits", filter_type="songs")[:15]
        for track in recommendations:
            track["ai_reason"] = random.choice(AI_DJ_PHRASES)
        return recommendations
    except Exception as e:
        logger.error(f"AI DJ failed to generate suggestions: {e}")
        return search_music("top billboard songs", filter_type="songs")[:10]
