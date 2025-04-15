import { WS_HEARTBEAT_INTERVAL } from './config.js';
import { showNotification } from './notifications.js';
import * as ui from './ui.js';
import * as editor from './editor.js';
import * as tableActions from './table_actions.js';
import * as blockActions from './block_actions.js';

let socket = null;
let sessionId = null;
let currentUsername = null;
let heartbeatInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 3000; // ms

function connectWebSocket(username) {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        console.warn("WebSocket connection already open or connecting.");
        if (username !== currentUsername) {
            sendMessage('set_username', { username });
            currentUsername = username;
            ui.setUsername(username);
        }
        return;
    }

    currentUsername = username;
    const loc = window.location;
    const wsProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${loc.host}/websocket`;

    console.log(`Attempting to connect WebSocket to ${wsUrl}`);
    showNotification(`Connecting...`, 'info');

    try {
        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            console.log("WebSocket connection established.");
            reconnectAttempts = 0;
            showNotification('Connected!', 'success');
            ui.hideWebSocketClosedBanner();
            sendMessage("set_username", { username: currentUsername });
            clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(sendHeartbeat, WS_HEARTBEAT_INTERVAL);
        };

        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.debug("WebSocket message received:", data);
                handleSocketMessage(data.type, data.payload || {});
            } catch (e) {
                console.error("Error parsing WebSocket message:", e, event.data);
                showNotification("Received invalid message from server.", "error");
            }
        };

        socket.onclose = (event) => {
            console.warn(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`);
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
            socket = null;
            ui.showWebSocketClosedBanner();

            // Attempt to reconnect with exponential backoff
            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                const delay = RECONNECT_DELAY * reconnectAttempts;
                console.log(`Attempting WebSocket reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms...`);
                showNotification(`Connection lost. Reconnecting... (Attempt ${reconnectAttempts})`, 'warning');
                setTimeout(() => connectWebSocket(currentUsername), delay);
            } else {
                 console.error("WebSocket reconnect failed after max attempts.");
                 showNotification("Connection lost. Could not reconnect.", "error");
            }
        };

        socket.onerror = (error) => {
            console.error("WebSocket error:", error);
            showNotification("WebSocket connection error.", "error");
        };

    } catch (err) {
        console.error("WebSocket constructor error:", err);
        showNotification(`Failed to initiate WebSocket connection: ${err.message}`, 'error');
    }
}

function sendHeartbeat() {
    sendMessage("heartbeat", { client_time: Date.now() });
}

function sendMessage(type, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.warn("WebSocket not ready. Cannot send message:", type, payload);
        showNotification("Cannot send message: Connection not active.", "warning");
        return false;
    }
    try {
        const message = JSON.stringify({ type, payload });
        console.debug("Sending WebSocket message:", message);
        socket.send(message);
        return true;
    } catch (e) {
        console.error("Error sending WebSocket message:", e);
        showNotification(`Error sending message: ${e.message}`, 'error');
        return false;
    }
}

function handleSocketMessage(type, payload) {
    console.debug(`Handling WS message: ${type}`);
    switch (type) {
        case "session_ack":
            sessionId = payload.session_id;
            currentUsername = payload.username; // Ensure local state matches server ack
            console.debug(`Session acknowledged: ID=${sessionId}, User=${currentUsername}`);
            ui.handleSessionAck(currentUsername); // Update UI, load initial data
            break;
        case "heartbeat_ack":
            console.debug("Heartbeat acknowledged by server.");
            break;

        // Lock related messages
        case "block_locked":
        case "block_unlocked":
        case "lock_denied":
            editor.handleLockUpdate(type, payload);
            break;

        // Content / Structure update messages
        case "document_updated":
            editor.handleRemoteUpdate(payload);
            break;
        case "block_added":
            blockActions.handleRemoteBlockAdded(payload);
            break;
        case "block_deleted":
             blockActions.handleRemoteBlockDeleted(payload);
             break;
        case "table_options_updated":
             tableActions.handleRemoteOptionsUpdated(payload);
             break;

        // Error message from server
        case "error":
            console.error("Server WebSocket error:", payload.error_message);
            showNotification(`Server error: ${payload.error_message}`, 'error');
            break;

        default:
            console.warn("Unhandled WebSocket message type:", type, payload);
    }
}

export { connectWebSocket, sendMessage, sessionId, currentUsername };