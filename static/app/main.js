import * as api from './api.js';
import * as ws from './websocket.js';
import * as ui from './ui.js';
import * as editor from './editor.js';
import * as toolbar from './toolbar.js';
import * as templates from './template_selector.js';

function init() {
    console.log("Initializing application...");
    ui.initUI();
    templates.initTemplateSelector();
    toolbar.initToolbar();
    editor.initEditor();
    // undoRedo.init(); // Initialize undo/redo manager

    // Event listener for setting username
    const setUsernameBtn = document.getElementById("set-username-btn");
    setUsernameBtn.addEventListener("click", handleSetUsername);

    // Connect UI elements to actions
    const createDocBtn = document.getElementById("create-document-btn");
    createDocBtn.addEventListener("click", templates.handleCreateDocument); // Use template module

    const documentListSelect = document.getElementById("document-list");
    documentListSelect.addEventListener("change", editor.handleSelectDocument);

    const versionHistoryBtn = document.getElementById("version-history-btn");
    versionHistoryBtn.addEventListener("click", ui.showVersionHistory); // Basic UI action

    const saveTemplateBtn = document.getElementById("save-template-btn"); // Add this button to index.html
    saveTemplateBtn?.addEventListener("click", templates.handleSaveAsTemplate);


    console.log("Application initialized.");
}

function handleSetUsername() {
    const usernameInput = document.getElementById("username-input");
    const username = usernameInput.value.trim();
    if (!username) {
        ui.showNotification("Please enter a username.", "warning");
        return;
    }
    ui.setUsername(username);
    ws.connectWebSocket(username);
}


document.addEventListener("DOMContentLoaded", init);