import { API_BASE_URL } from './config.js';
import { showNotification } from './notifications.js';

async function fetchAPI(url, options = {}) {
    const defaultOptions = {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
        },
    };
    const mergedOptions = { ...defaultOptions, ...options };
    if (mergedOptions.body && typeof mergedOptions.body !== 'string') {
        mergedOptions.body = JSON.stringify(mergedOptions.body);
    } else if (!mergedOptions.body) {
        delete mergedOptions.body;
    }


    try {
        const response = await fetch(`${API_BASE_URL}${url}`, mergedOptions);
        const data = await response.json();

        if (!response.ok) {
            const errorPayload = data?.error || {};
            const errorMessage = errorPayload.message || response.statusText || 'API request failed';
            const errorStatus = response.status;
            console.error(`API Error ${errorStatus}: ${errorMessage}`, data);
            throw { status: errorStatus, message: errorMessage, data: data };
        }

        return data;

    } catch (error) {
        console.error(`Fetch API Error for ${url}:`, error);
        if (!error.status) {
             showNotification(`Network error: ${error.message || 'Could not connect to server'}`, 'error');
        }
        throw error;
    }
}

// --- Document Endpoints ---
export const listDocuments = () => fetchAPI('/documents');
export const getDocument = (docId) => fetchAPI(`/documents/${docId}`);
export const createDocument = (title, templateName) => fetchAPI('/documents/create', {
    method: 'POST',
    body: { title, template_name: templateName }
});

// --- Version Endpoints ---
export const getVersionHistory = (docId) => fetchAPI(`/versions/${docId}`);
export const getVersion = (docId, versionId) => fetchAPI(`/versions/${docId}/${versionId}`);

// --- Template Endpoints ---
export const listTemplates = () => fetchAPI('/templates');
export const saveAsTemplate = (docId, templateName) => fetchAPI(`/documents/${docId}/save_template`, {
    method: 'POST',
    body: { template_name: templateName }
});

// --- Lock Endpoints ---
export const getCurrentLocks = (docId) => fetchAPI(`/locks?document_id=${docId}`);

// --- Table Content API ---
export const getTableContent = (docId, tableId) => fetchAPI(`/documents/${docId}/tables/${tableId}/content`);