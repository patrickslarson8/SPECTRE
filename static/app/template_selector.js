import * as api from './api.js';
import * as editor from './editor.js';
import * as ui from './ui.js';
import { showNotification } from './notifications.js';

const templateListSelect = document.getElementById('template-list');
const createDocBtn = document.getElementById('create-document-btn');
const saveTemplateBtn = document.getElementById('save-template-btn');

export function initTemplateSelector() {
    createDocBtn?.addEventListener('click', handleCreateDocument);
    saveTemplateBtn?.addEventListener('click', handleSaveAsTemplate);
}

export async function handleCreateDocument() {
    const selectedTemplate = templateListSelect.value;
    if (!selectedTemplate) {
        showNotification("Please select a template first.", "warning");
        return;
    }

    const title = prompt(`Enter a title for the new document (using template '${selectedTemplate}'):`);
    if (!title) {
        return;
    }

    ui.showLoadingOverlay();
    try {
        const newDoc = await api.createDocument(title, selectedTemplate);
        showNotification(`Document '${newDoc.title}' created successfully!`, 'success');
        await ui.loadDocumentList();
        const docList = document.getElementById("document-list");
        if(docList) {
             docList.value = newDoc.document_id;
             docList.dispatchEvent(new Event('change'));
        }
    } catch (error) {
        console.error("Failed to create document:", error);
        showNotification(`Error creating document: ${error.message || 'Unknown error'}`, 'error');
    } finally {
        ui.hideLoadingOverlay();
    }
}

export async function handleSaveAsTemplate() {
    const docId = editor.getCurrentDocId();
    if (!docId) {
        showNotification("Please select and load a document first.", "warning");
        return;
    }

    const templateName = prompt("Enter a name for the new template:");
    if (!templateName || !templateName.trim()) {
        return;
    }

    ui.showLoadingOverlay();
    try {
        await api.saveAsTemplate(docId, templateName.trim());
        showNotification(`Template '${templateName.trim()}' saved successfully!`, 'success');
        await ui.loadTemplateList();
    } catch (error) {
        console.error("Failed to save template:", error);
        showNotification(`Error saving template: ${error.message || 'Unknown error'}`, 'error');
    } finally {
        ui.hideLoadingOverlay();
    }
}