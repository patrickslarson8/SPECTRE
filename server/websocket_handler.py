import json
import logging
import uuid
from datetime import datetime
import tornado.websocket
from server.db_manager import SessionLocal
import server.document_service as document_service
from server.block_utils import render_document_html

logger = logging.getLogger(__name__)

class CollaborationWebSocket(tornado.websocket.WebSocketHandler):
    connected_users = {} # {session_id: instance}
    locked_blocks = {}

    # --- Connection Management ---
    def open(self):
        self.session_id = str(uuid.uuid4())
        self.username = f"User_{self.session_id[:4]}"
        CollaborationWebSocket.connected_users[self.session_id] = self
        logger.info(f"WebSocket opened: session {self.session_id}")

    def on_close(self):
        logger.info(f"WebSocket closed: session {self.session_id}, user {self.username}")
        blocks_to_unlock = [
            key for key, lock_info in CollaborationWebSocket.locked_blocks.items()
            if lock_info["session_id"] == self.session_id
        ]
        for doc_block_key in blocks_to_unlock:
            self._release_lock(doc_block_key)

        if self.session_id in CollaborationWebSocket.connected_users:
            del CollaborationWebSocket.connected_users[self.session_id]

    def on_message(self, message):
        try:
            data = json.loads(message)
            msg_type = data.get("type")
            payload = data.get("payload", {})
            logger.debug(f"MSG IN <-- session {self.session_id} ({self.username}): type={msg_type}, payload={payload}")

            handler_method = getattr(self, f"handle_{msg_type}", None)
            if handler_method and callable(handler_method):
                 try:
                     handler_method(payload)
                 except Exception as e:
                     logger.exception(f"Error handling message type '{msg_type}' for session {self.session_id}: {e}")
                     self.send_error(f"Server error processing message: {msg_type}")
            else:
                logger.warning(f"Unknown message type received: {msg_type} from {self.session_id}")
                self.send_error(f"Unknown message type: {msg_type}")

        except json.JSONDecodeError:
            logger.error(f"Invalid JSON received from session {self.session_id}: {message}")
            self.send_error("Invalid JSON format.")
        except Exception as e:
            logger.exception(f"Unexpected error processing message from session {self.session_id}: {e}")
            self.send_error("Unexpected server error.")


    # --- Sending Messages ---
    def send_message(self, msg_type, payload):
        """Sends a message to this specific client."""
        try:
            message = json.dumps({"type": msg_type, "payload": payload})
            logger.debug(f"MSG OUT --> session {self.session_id} ({self.username}): type={msg_type}")
            self.write_message(message)
        except tornado.websocket.WebSocketClosedError:
            logger.warning(f"Attempted to send to closed WebSocket: session {self.session_id}")
        except Exception as e:
            logger.error(f"Error sending message to session {self.session_id}: {e}")

    def send_error(self, error_message, error_code=400):
        """Sends an error message to this specific client."""
        self.send_message("error", {
            "error_code": error_code,
            "error_message": error_message
        })

    @classmethod
    def broadcast(cls, message_data, exclude_session_id=None):
        """Broadcasts a message to all connected users, optionally excluding one."""
        message_json = json.dumps(message_data)
        msg_type = message_data.get("type", "unknown")
        logger.debug(f"BROADCAST ({msg_type}): {message_data.get('payload', {})}")
        # Iterate over a copy of the dictionary keys to avoid issues if dict changes during iteration
        for session_id, socket_instance in list(cls.connected_users.items()):
            if session_id != exclude_session_id:
                try:
                    socket_instance.write_message(message_json)
                except tornado.websocket.WebSocketClosedError:
                    logger.warning(f"Cannot broadcast to closed socket: session {session_id}")
                except Exception as e:
                    logger.error(f"Error broadcasting to session {session_id}: {e}")

    # --- Lock Management ---
    def _acquire_lock(self, doc_id_str, block_attr_id):
        """Attempts to acquire a lock, returns True if successful, False otherwise."""
        block_key = (doc_id_str, block_attr_id)
        current_lock = CollaborationWebSocket.locked_blocks.get(block_key)

        if current_lock:
            if current_lock["session_id"] == self.session_id:
                return True
            else:
                self.send_message("lock_denied", {
                    "document_id": doc_id_str,
                    "block_id": block_attr_id,
                    "locked_by": current_lock["username"],
                    "timestamp": datetime.now().isoformat()
                })
                return False
        else:
            lock_info = {"session_id": self.session_id, "username": self.username}
            CollaborationWebSocket.locked_blocks[block_key] = lock_info
            self.broadcast({
                "type": "block_locked",
                "payload": {
                    "document_id": doc_id_str,
                    "block_id": block_attr_id,
                    "locked_by": self.username,
                    "timestamp": datetime.now().isoformat()
                }
            })
            return True

    def _release_lock(self, block_key):
        """Releases a lock if it exists and broadcasts."""
        if block_key in CollaborationWebSocket.locked_blocks:
            lock_info = CollaborationWebSocket.locked_blocks.pop(block_key)
            doc_id_str, block_attr_id = block_key
            self.broadcast({
                "type": "block_unlocked",
                "payload": {
                    "document_id": doc_id_str,
                    "block_id": block_attr_id,
                    "unlocked_by": lock_info["username"],
                    "timestamp": datetime.now().isoformat()
                }
            })
            return True
        return False

    @classmethod
    def get_locks_for_document(cls, doc_id_str):
        """Class method to get current locks for a document (used by API)."""
        locks = []
        for (d_id, b_id), lock_info in cls.locked_blocks.items():
            if d_id == doc_id_str:
                locks.append({"block_id": b_id, "locked_by": lock_info["username"]})
        return locks

    @classmethod
    def is_block_locked(cls, doc_id_str, block_attr_id, exclude_session_id=None):
        """Checks if a block is locked by someone other than exclude_session_id."""
        lock_info = cls.locked_blocks.get((doc_id_str, block_attr_id))
        if lock_info and lock_info["session_id"] != exclude_session_id:
            return lock_info["username"]
        return None

    @classmethod
    def are_blocks_locked(cls, doc_id_str, block_attr_ids, exclude_session_id=None):
        """Checks if any of the specified blocks are locked by someone else."""
        for block_attr_id in block_attr_ids:
            locker = cls.is_block_locked(doc_id_str, block_attr_id, exclude_session_id)
            if locker:
                return locker
        return None


    # --- Message Handlers ---
    def handle_set_username(self, payload):
        new_username = payload.get("username")
        if new_username:
            old_username = self.username
            self.username = new_username.strip()
            logger.info(f"Session {self.session_id} username set: {old_username} -> {self.username}")
            for key, lock_info in CollaborationWebSocket.locked_blocks.items():
                if lock_info["session_id"] == self.session_id:
                    lock_info["username"] = self.username
            self.send_message("session_ack", {"session_id": self.session_id, "username": self.username})
        else:
            self.send_error("Username cannot be empty.")

    def handle_heartbeat(self, payload):
        self.send_message("heartbeat_ack", {"server_time": datetime.now().isoformat()})

    def handle_lock_block(self, payload):
        doc_id = payload.get("document_id")
        block_id = payload.get("block_id")
        if not doc_id or not block_id:
            self.send_error("doc_id and block_id required for lock_block")
            return
        self._acquire_lock(str(doc_id), block_id)

    def handle_unlock_block(self, payload):
        doc_id = payload.get("document_id")
        block_id = payload.get("block_id")
        if not doc_id or not block_id:
            self.send_error("doc_id and block_id required for unlock_block")
            return

        block_key = (str(doc_id), block_id)
        lock_info = CollaborationWebSocket.locked_blocks.get(block_key)

        if lock_info and lock_info["session_id"] == self.session_id:
            self._release_lock(block_key)
        elif lock_info:
            self.send_error(f"Cannot unlock block locked by {lock_info['username']}")
        else:
            logger.warning(f"Attempt to unlock block {block_id} which was not locked.")
            pass

    def handle_update_document(self, payload):
        doc_id_str = str(payload.get("document_id"))
        block_id = payload.get("block_id")
        content = payload.get("content", "")
        metadata = payload.get("metadata")

        if not doc_id_str or not block_id or metadata is None:
            self.send_error("doc_id, block_id, and metadata required for update_document")
            return

        if not self._acquire_lock(doc_id_str, block_id):
             return

        db = SessionLocal()
        try:
            updated_block_data = document_service.update_block(
                db, int(doc_id_str), block_id, content, metadata, self.username
            )
            if updated_block_data:
                 self.broadcast({
                     "type": "document_updated",
                     "payload": updated_block_data
                 }, exclude_session_id=self.session_id)
            else:
                 self.send_error("Failed to update block in database.")
                 self._release_lock((doc_id_str, block_id))

        except Exception as e:
            logger.exception(f"Error updating block {block_id} in doc {doc_id_str}: {e}")
            self.send_error("Server error updating document.")
            # Release lock on error
            self._release_lock((doc_id_str, block_id))
        finally:
            db.close()



    def handle_update_table_options(self, payload):
        doc_id_str = str(payload.get("document_id"))
        table_id = payload.get("table_id")
        options_json = payload.get("options_json")

        if not doc_id_str or not table_id or options_json is None:
             self.send_error("doc_id, table_id, and options_json required for update_table_options")
             return

        options_block_attr_id = f"options_{table_id}"

        db = SessionLocal()
        try:
            success = document_service.update_table_options(db, int(doc_id_str), table_id, options_json, self.username)
            if success:
                self.broadcast({
                    "type": "table_options_updated",
                    "payload": {"document_id": doc_id_str, "table_id": table_id, "options_json": options_json}
                }, exclude_session_id=self.session_id)
            else:
                self.send_error("Failed to update table options.")
        except Exception as e:
            logger.exception(f"Error updating options for table {table_id} in doc {doc_id_str}: {e}")
            self.send_error("Server error updating table options.")
        finally:
             db.close()
