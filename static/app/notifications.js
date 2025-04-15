import { NOTIFICATION_TIMEOUT } from './config.js';

const notificationArea = document.getElementById('notification-area');

/**
 * Displays a non-blocking notification message.
 * @param {string} message - The message to display.
 * @param {'info' | 'success' | 'warning' | 'error'} type - The notification type.
 */
export function showNotification(message, type = 'info') {
    if (!notificationArea) {
        console.warn("Notification area not found. Message:", message);
        alert(`${type.toUpperCase()}: ${message}`); // Fallback
        return;
    }

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;

    notificationArea.appendChild(notification);

    // Auto-remove after a delay
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.5s ease';
        setTimeout(() => notification.remove(), 500); // Remove from DOM after fade
    }, NOTIFICATION_TIMEOUT);
}