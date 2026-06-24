import time
import json
import logging
import asyncio
from typing import Dict, List, Any
from fastapi import WebSocket

logger = logging.getLogger(__name__)

class JamRoom:
    def __init__(self, room_code: str, host_username: str):
        self.room_code = room_code
        self.host_username = host_username
        self.active_connections: Dict[str, WebSocket] = {}
        self.roles: Dict[str, str] = {host_username: "host"}
        self.current_track: Dict[str, Any] = {}
        self.playback_state = "PAUSED"
        self.playback_time = 0.0
        self.last_updated = time.time()
        self.queue: List[Dict[str, Any]] = []
        self.chat_history: List[Dict[str, Any]] = []
        self.host_explicitly_left = False
        self.host_pending_reconnect = False
        self.grace_period_task = None
        self.add_only_mode = False

    def get_role(self, username: str) -> str:
        return self.roles.get(username, "listener")

    def has_permission(self, username: str, action: str) -> bool:
        role = self.get_role(username)
        if role == "host":
            return True
        if role == "co-host":
            return action in ["control_playback", "add_queue", "vote_queue", "remove_queue"]
        if role == "moderator":
            return action in ["add_queue", "vote_queue", "remove_queue"]
        if role == "contributor":
            return action in ["add_queue", "vote_queue"]
        if role == "listener":
            if self.add_only_mode:
                return action == "add_queue"
            return action in ["vote_queue"]
        return False

    async def toggle_add_only_mode(self, username: str, enabled: bool):
        if username == self.host_username:
            self.add_only_mode = bool(enabled)
            await self.broadcast_state()

    async def connect(self, username: str, websocket: WebSocket):
        await websocket.accept()
        self.active_connections[username] = websocket
        if username not in self.roles:
            self.roles[username] = "listener"
        
        # If the host reconnects, cancel the grace period timer
        if username == self.host_username:
            if self.host_pending_reconnect:
                self.host_pending_reconnect = False
                if self.grace_period_task:
                    self.grace_period_task.cancel()
                    self.grace_period_task = None
                await self.broadcast({
                    "type": "host_back"
                })
                await self.add_chat_msg("System", f"Host ({username}) reconnected!", msg_type="system")
            else:
                await self.add_chat_msg("System", f"{username} joined the Jam party!", msg_type="system")
        else:
            await self.add_chat_msg("System", f"{username} joined the Jam party!", msg_type="system")

        await self.broadcast_state()

    async def disconnect(self, username: str, websocket: WebSocket = None):
        if username in self.active_connections:
            if websocket is not None and self.active_connections[username] != websocket:
                return
            del self.active_connections[username]
            
        if username == self.host_username:
            if self.host_explicitly_left:
                await self.destroy_room("host_left")
                return
            else:
                # Host dropped unexpectedly
                if len(self.active_connections) == 0:
                    await self.destroy_room("host_left")
                    return
                else:
                    self.host_pending_reconnect = True
                    await self.broadcast({
                        "type": "host_reconnecting"
                    })
                    await self.add_chat_msg("System", f"Host ({username}) disconnected. Waiting 30s to reconnect...", msg_type="system")
                    self.grace_period_task = asyncio.create_task(self.run_host_grace_period(30.0))
                    return

        # Non-host disconnection
        if len(self.active_connections) == 0:
            # If no users remain, clean up the room
            if self.grace_period_task:
                self.grace_period_task.cancel()
                self.grace_period_task = None
            if self.room_code in rooms:
                del rooms[self.room_code]
            return

        await self.add_chat_msg("System", f"{username} left the Jam party.", msg_type="system")
        await self.broadcast_state()

    async def run_host_grace_period(self, duration: float):
        try:
            await asyncio.sleep(duration)
            await self.destroy_room("host_left")
        except asyncio.CancelledError:
            pass

    async def destroy_room(self, reason: str):
        if self.grace_period_task:
            self.grace_period_task.cancel()
            self.grace_period_task = None
            
        close_msg = json.dumps({
            "type": "room_closed",
            "reason": reason
        })
        
        connections = list(self.active_connections.items())
        for user, ws in connections:
            try:
                await ws.send_text(close_msg)
                await ws.close(code=1000, reason="Host left the session")
            except Exception:
                pass
                
        self.active_connections.clear()
        if self.room_code in rooms:
            del rooms[self.room_code]

    async def close_room(self, username: str):
        if username == self.host_username:
            self.host_explicitly_left = True
            await self.destroy_room("host_left")

    async def handle_heartbeat_sync(self, username: str, video_id: str, position: float):
        if username != self.host_username:
            return
        self.playback_time = float(position)
        self.last_updated = time.time()
        # Broadcast standard playback_sync to all other clients
        await self.broadcast({
            "type": "playback_sync",
            "video_id": video_id,
            "state": self.playback_state,
            "position": self.playback_time,
            "track": self.current_track,
            "server_time": time.time() * 1000,
            "sender": username
        })

    def get_current_position(self) -> float:
        if self.playback_state == "PLAYING" and self.current_track:
            elapsed = time.time() - self.last_updated
            total_duration = self.current_track.get("durationSeconds", 300)
            return min(self.playback_time + elapsed, float(total_duration))
        return self.playback_time

    async def update_playback(self, username: str, video_id: str, state: str, position: float, track_data: Dict[str, Any] = None):
        if not self.has_permission(username, "control_playback"):
            return
        self.playback_state = state
        self.playback_time = float(position)
        self.last_updated = time.time()
        if track_data:
            self.current_track = track_data
        elif video_id and (not self.current_track or self.current_track.get("id") != video_id):
            self.current_track = {"id": video_id}
        await self.broadcast({
            "type": "playback_sync",
            "video_id": video_id,
            "state": self.playback_state,
            "position": self.playback_time,
            "track": self.current_track,
            "server_time": time.time() * 1000,
            "sender": username
        })

    async def add_to_queue(self, username: str, song: Dict[str, Any]):
        if not self.has_permission(username, "add_queue"):
            return
        if any(item["id"] == song["id"] for item in self.queue):
            return
        queue_item = {
            "id": song["id"],
            "title": song["title"],
            "artist": song["artist"],
            "thumbnail": song.get("thumbnail", ""),
            "duration": song.get("duration", ""),
            "durationSeconds": song.get("durationSeconds", 0),
            "votes": {username: 1},
            "submitted_by": username
        }
        self.queue.append(queue_item)
        self.sort_queue()
        await self.add_chat_msg("System", f"{username} added '{song['title']}' to queue.", msg_type="system")
        await self.broadcast_state()

    async def vote_song(self, username: str, song_id: str, vote: int):
        if not self.has_permission(username, "vote_queue"):
            return
        for item in self.queue:
            if item["id"] == song_id:
                if vote == 0:
                    if username in item["votes"]:
                        del item["votes"][username]
                else:
                    item["votes"][username] = vote
                break
        self.sort_queue()
        await self.broadcast_state()

    async def remove_from_queue(self, username: str, song_id: str):
        if not self.has_permission(username, "remove_queue"):
            if self.add_only_mode and self.get_role(username) == "listener":
                return
            own_song = False
            for item in self.queue:
                if item["id"] == song_id and item["submitted_by"] == username:
                    own_song = True
                    break
            if not own_song:
                return
        self.queue = [item for item in self.queue if item["id"] != song_id]
        await self.broadcast_state()

    def sort_queue(self):
        def get_net_votes(item):
            return sum(item["votes"].values())
        self.queue.sort(key=get_net_votes, reverse=True)

    async def skip_to_next(self, username: str):
        if not self.has_permission(username, "control_playback"):
            return
        if self.queue:
            next_song = self.queue.pop(0)
            self.current_track = next_song
            self.playback_state = "PLAYING"
            self.playback_time = 0.0
            self.last_updated = time.time()
            await self.add_chat_msg("System", f"Playing next queued track: '{next_song['title']}'", msg_type="system")
            await self.broadcast({
                "type": "playback_sync",
                "video_id": next_song["id"],
                "state": "PLAYING",
                "position": 0.0,
                "track": self.current_track,
                "server_time": time.time() * 1000,
                "sender": username
            })
            await self.broadcast_state()
        else:
            self.playback_state = "PAUSED"
            self.playback_time = 0.0
            self.last_updated = time.time()
            await self.broadcast({
                "type": "playback_sync",
                "video_id": "",
                "state": "PAUSED",
                "position": 0.0,
                "track": {},
                "server_time": time.time() * 1000,
                "sender": username
            })

    async def add_chat_msg(self, username: str, text: str, msg_type: str = "chat"):
        msg = {
            "username": username,
            "message": text,
            "time": time.strftime("%H:%M"),
            "type": msg_type
        }
        self.chat_history.append(msg)
        if len(self.chat_history) > 100:
            self.chat_history.pop(0)
        await self.broadcast({
            "type": "chat_message",
            "message": msg
        })

    async def trigger_reaction(self, username: str, emoji: str):
        await self.broadcast({
            "type": "reaction",
            "username": username,
            "emoji": emoji
        })

    async def set_user_role(self, host_username: str, target_user: str, new_role: str):
        if host_username != self.host_username:
            return
        if new_role in ["host", "co-host", "moderator", "contributor", "listener"]:
            if new_role == "host":
                self.roles[self.host_username] = "co-host"
                self.host_username = target_user
                self.roles[target_user] = "host"
                await self.add_chat_msg("System", f"{target_user} is now the Host. {host_username} has been changed to co-host.", msg_type="system")
            else:
                self.roles[target_user] = new_role
                await self.add_chat_msg("System", f"{target_user}'s role has been set to {new_role}.", msg_type="system")
            await self.broadcast_state()

    def get_room_state_dict(self):
        serialized_queue = []
        for item in self.queue:
            net_votes = sum(item["votes"].values())
            serialized_queue.append({
                "id": item["id"],
                "title": item["title"],
                "artist": item["artist"],
                "thumbnail": item["thumbnail"],
                "duration": item["duration"],
                "durationSeconds": item["durationSeconds"],
                "net_votes": net_votes,
                "votes": item["votes"],
                "submitted_by": item["submitted_by"]
            })
        users_list = []
        for user in self.active_connections.keys():
            users_list.append({
                "username": user,
                "role": self.get_role(user),
                "is_host": user == self.host_username
            })
        return {
            "room_code": self.room_code,
            "host_username": self.host_username,
            "add_only_mode": self.add_only_mode,
            "users": users_list,
            "playback": {
                "state": self.playback_state,
                "position": self.get_current_position(),
                "last_updated": self.last_updated,
                "current_track": self.current_track
            },
            "queue": serialized_queue,
            "chat_history": self.chat_history
        }

    async def broadcast_state(self):
        state = self.get_room_state_dict()
        await self.broadcast({
            "type": "room_state",
            "state": state
        })

    async def broadcast(self, message: dict):
        message_str = json.dumps(message)
        disconnected_users = []
        for username, ws in self.active_connections.items():
            try:
                await ws.send_text(message_str)
            except Exception:
                disconnected_users.append((username, ws))
        for username, ws in disconnected_users:
            await self.disconnect(username, ws)

rooms: Dict[str, JamRoom] = {}

def create_room(room_code: str, host_username: str) -> JamRoom:
    code = room_code.upper().strip()
    if code in rooms:
        return rooms[code]
    room = JamRoom(code, host_username)
    rooms[code] = room
    return room

def get_room(room_code: str) -> JamRoom:
    return rooms.get(room_code.upper().strip())
