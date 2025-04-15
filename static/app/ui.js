import * as api from './api.js';
import { showNotification } from './notifications.js';
import * as editor from './editor.js';

// DOM Elements
const loadingOverlay = document.getElementById('loading-overlay');
const loginSection = document.getElementById("login-section");
const mainInterface = document.getElementById("main-interface");
const usernameInput = document.getElementById("username-input");
const documentListSelect = document.getElementById("document-list");
const templateListSelect = document.getElementById("template-list");
const wsClosedNotice = document.getElementById('ws-closed-notice');
const editorContainer = document.getElementById('editor-container');

let currentUsername = null;

export function initUI() {
    setTimeout(() => {
        if(loadingOverlay) loadingOverlay.style.opacity = '0';
        setTimeout(() => { if(loadingOverlay) loadingOverlay.style.display = 'none'; }, 500);
    }, 200);

    // Initial state
    if (loginSection) loginSection.classList.remove('hidden');
    if (mainInterface) mainInterface.classList.add('hidden');
    if (wsClosedNotice) wsClosedNotice.style.display = 'none';
}

export function setUsername(username) {
    currentUsername = username;
}

export function handleSessionAck(username) {
    setUsername(username);
    if (loginSection) loginSection.classList.add('hidden');
    if (mainInterface) mainInterface.classList.remove('hidden');
    loadDocumentList();
    loadTemplateList();
}

export function showLoadingOverlay() {
    if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
        loadingOverlay.style.opacity = '1';
    }
}

export function hideLoadingOverlay() {
     if (loadingOverlay) {
        loadingOverlay.style.opacity = '0';
        setTimeout(() => { if(loadingOverlay) loadingOverlay.style.display = 'none'; }, 500);
    }
}

export async function loadDocumentList() {
    if (!documentListSelect) return;
    try {
        showLoadingOverlay();
        const data = await api.listDocuments();
        populateDocumentDropdown(data.documents || []);
    } catch (error) {
        showNotification("Failed to load document list.", "error");
        // Handle error appropriately
    } finally {
         hideLoadingOverlay();
    }
}

function populateDocumentDropdown(docs) {
    documentListSelect.innerHTML = ""; // Clear existing options
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "(Select Document)";
    defaultOpt.disabled = true; // Make it non-selectable initially
    defaultOpt.selected = true;
    documentListSelect.appendChild(defaultOpt);

    if (docs.length === 0) {
         const noDocsOpt = document.createElement("option");
         noDocsOpt.textContent = "No documents found";
         noDocsOpt.disabled = true;
         documentListSelect.appendChild(noDocsOpt);
    } else {
        docs.forEach(doc => {
            const opt = document.createElement("option");
            opt.value = doc.document_id;
            opt.textContent = `${doc.title} (ID: ${doc.document_id})`;
            documentListSelect.appendChild(opt);
        });
    }
}

export async function loadTemplateList() {
    if (!templateListSelect) return;
    try {
        const data = await api.listTemplates();
        populateTemplateDropdown(data.templates || []);
    } catch (error) {
        showNotification("Failed to load template list.", "error");
    }
}

function populateTemplateDropdown(templates) {
    // Keep the default "-- Select Template --" option
    while (templateListSelect.options.length > 1) {
        templateListSelect.remove(1);
    }

    if (templates.length === 0) {
         const noTplOpt = document.createElement("option");
         noTplOpt.textContent = "No templates available";
         noTplOpt.disabled = true;
         templateListSelect.appendChild(noTplOpt);
    } else {
        templates.forEach(name => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            templateListSelect.appendChild(opt);
        });
    }
}


export function showVersionHistory() {
    const docId = documentListSelect.value;
    if (!docId) {
        showNotification("Please select a document first.", "warning");
        return;
    }
    window.open(`/static/version_history.html?document_id=${docId}`, "_blank");
}

export function showWebSocketClosedBanner() {
    if (wsClosedNotice) wsClosedNotice.style.display = 'block';
}

export function hideWebSocketClosedBanner() {
    if (wsClosedNotice) wsClosedNotice.style.display = 'none';
}

export function displayEditorPlaceholder(message = "Select or create a document to begin.") {
     if (editorContainer) {
        editorContainer.innerHTML = `<p class="placeholder">${message}</p>`;
    }
}

export function clearEditorPlaceholder() {
     const placeholder = editorContainer?.querySelector('.placeholder');
     if (placeholder) {
         placeholder.remove();
     }
}