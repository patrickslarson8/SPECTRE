import * as api from './api.js';
import * as ws from './websocket.js';
import { showNotification } from './notifications.js';
import * as ui from './ui.js';
import * as undoRedo from './undo_redo.js';
import * as tableActions from './table_actions.js';
import * as blockActions from './block_actions.js';
import { TIME_UPDATE_THRESHOLD_MS, CHAR_UPDATE_THRESHOLD } from './config.js';

const editorContainer = document.getElementById('editor-container');
const documentListSelect = document.getElementById("document-list");

let currentDocId = null;
let typingState = {
    currentBlockId: null,
    charCountSinceLastUpdate: 0,
    timerId: null
};
let blockMetadataCache = {};
let activeLocks = {};


export function initEditor() {
    if (!editorContainer) {
        console.error("Editor container not found!");
        return;
    }
    console.debug("Initializing editor event listeners.");
    editorContainer.addEventListener('focusin', handleBlockFocus);
    editorContainer.addEventListener('focusout', handleBlockBlur);
    editorContainer.addEventListener('input', handleBlockInput);
    editorContainer.addEventListener('keydown', handleKeyDown);
    ui.displayEditorPlaceholder();
}

export async function handleSelectDocument() {
    const docId = documentListSelect.value;
    if (!docId || docId === currentDocId) return;

    console.log(`Selecting document: ${docId}`);
    ui.showLoadingOverlay();
    currentDocId = docId;
    blockMetadataCache = {};
    activeLocks = {};
    undoRedo.clearStacks();

    try {
        const docData = await api.getDocument(docId);
        if (!docData) throw new Error("Document data not found.");

        console.debug("Rendering document content...");
        renderDocumentContent(docData.content);
        document.title = `SPECTRE - ${docData.title}`;

        console.debug("Fetching locks...");
        const lockData = await api.getCurrentLocks(docId);
        applyInitialLocks(lockData.locks || []);

        showNotification(`Loaded document: ${docData.title}`, 'info');
        console.debug("Document load complete.");

    } catch (error) {
        console.error("Failed to load document or locks:", error);
        showNotification(`Error loading document: ${error.message || 'Unknown error'}`, 'error');
        currentDocId = null;
        documentListSelect.value = "";
        ui.displayEditorPlaceholder("Error loading document.");
        document.title = `SPECTRE`;
    } finally {
        ui.hideLoadingOverlay();
    }
}

function renderDocumentContent(htmlContent) {
    if (!editorContainer) return;
    console.debug("Clearing placeholder.");
    ui.clearEditorPlaceholder();
    editorContainer.innerHTML = htmlContent || "";

    // Reset typing state
    typingState.currentBlockId = null;
    typingState.charCountSinceLastUpdate = 0;
    clearTimeout(typingState.timerId);
    typingState.timerId = null;

    console.debug("Setting block editability and caching metadata...");
    editorContainer.querySelectorAll('[data-block-id]').forEach(block => {
        const blockId = block.dataset.blockId;
        const blockType = block.dataset.blockType;
        const tagName = block.tagName;

        if (tagName === 'HR' || blockType === 'table-options' || blockType === 'table') {
             block.contentEditable = "false";
        } else {
             // Default others to editable (will be overridden by locks/styles)
             block.contentEditable = "true";
        }
        // console.log(`Block ${blockId} (${tagName}, type ${blockType}) initial contentEditable: ${block.contentEditable}`);

        blockMetadataCache[blockId] = getBlockMetadata(block);

    });
    console.debug("Document rendered, metadata cached:", Object.keys(blockMetadataCache).length, "blocks");
    console.debug("Attaching Table Listeners (Resize Handles)...");
    editorContainer.querySelectorAll('table[data-block-type="table"]').forEach(table => {
        if (typeof tableActions.addTableListeners === 'function') {
             tableActions.addTableListeners(table);
        } else {
            console.error("tableActions.addTableListeners is not defined or not imported.");
        }
    });
}

function applyInitialLocks(locks) {
    console.debug("Applying initial locks:", locks);
    // Reset all potentially editable blocks to editable first (in case locks were removed)
     editorContainer.querySelectorAll('[data-block-id]').forEach(el => {
         const blockType = el.dataset.blockType;
         const tagName = el.tagName;
         // Only reset things that can be editable
         if (tagName !== 'HR' && blockType !== 'table-options' && blockType !== 'table') {
            el.contentEditable = "true";
            el.style.removeProperty("background-color");
            el.style.removeProperty("outline");
            el.removeAttribute("title");
         }
     });
    // Apply locks based on fetched data
    locks.forEach(lock => {
        const block = getBlockElement(lock.block_id);
        if (block && lock.locked_by !== ws.currentUsername) {
            applyLockStyle(block, lock.locked_by);
        } else if (block && lock.locked_by === ws.currentUsername) {
            activeLocks[lock.block_id] = true;
            console.debug(`Recognized own initial lock on ${lock.block_id}`);
             removeLockStyle(block);
        }
    });
}

function handleBlockFocus(event) {
    // console.debug(">>> handleBlockFocus FIRED. Target:", event.target);
    const block = event.target.closest('[data-block-id]');
    if (!block) {
        // console.debug("Focus ignored: Event target not within a data block.");
        return;
    }
    const blockId = block.dataset.blockId;
    const isBlockEditable = block.contentEditable === 'true';
    // console.debug(`Closest block found: ${blockId}. Is Editable: ${isBlockEditable}`);
    if (blockId === typingState.currentBlockId) {
        console.debug(`Focus remains within the same block: ${blockId}. No state change needed.`);
        if (isBlockEditable) {
             undoRedo.initStack(blockId, block.innerHTML);
        }
        return;
    }

    // --- Focus has shifted to a *new* block (or from outside) ---
    // 1. Handle blur/unlock for the PREVIOUSLY focused block (if any)
    const previousBlockId = typingState.currentBlockId;
    if (previousBlockId) {
        // console.log(`Focus changed from ${previousBlockId} to ${blockId}. Processing previous block.`);
        // Force update for the previous block before losing track of it
        sendCurrentBlockUpdate(true);
        // Unlock the previous block if we held the lock
        if (activeLocks[previousBlockId]) {
            console.debug(`Requesting unlock for previous block: ${previousBlockId}`);
            ws.sendMessage('unlock_block', { document_id: currentDocId, block_id: previousBlockId });
            delete activeLocks[previousBlockId];
        }
    }

    // 2. Check if the NEW block is actually editable before proceeding
    if (!isBlockEditable) {
        // console.log(`Focus shifted to block ${blockId}, but it's not editable. Aborting focus processing.`);
        typingState.currentBlockId = null;
        typingState.charCountSinceLastUpdate = 0;
        clearTimeout(typingState.timerId);
        typingState.timerId = null;
        return;
    }

    // 3. Process focus for the NEW, *editable* block
    // console.log(`Processing focus for new editable block: ${blockId}`);
    typingState.currentBlockId = blockId;
    typingState.charCountSinceLastUpdate = 0;
    clearTimeout(typingState.timerId);
    typingState.timerId = null;
    undoRedo.initStack(blockId);

    // Attempt to acquire lock only if not already held locally (e.g., rapid clicks)
    if (!activeLocks[blockId]) {
        console.debug(`Requesting lock for block: ${blockId}`);
        if (ws.sendMessage('lock_block', { document_id: currentDocId, block_id: blockId })) {
            activeLocks[blockId] = true; // Optimistically track lock attempt
        } else {
            console.warn(`Failed to send lock_block message for ${blockId}. WS might be closed.`);
        }
    } else {
        console.debug(`Already holding local lock for ${blockId}, not requesting again.`);
    }

    console.debug(`Initializing undo stack for ${blockId}.`);
    undoRedo.initStack(blockId, block.innerHTML);
}

function handleBlockBlur(event) {
    const blockLosingFocus = event.target.closest('[data-block-id]');
    if (!blockLosingFocus) {
         console.debug("Blur ignored: Event target not within a data block.");
        return;
    }

    const blockIdLosingFocus = blockLosingFocus.dataset.blockId;

    // Only process blur if it was the most recently *tracked* focused block
    if (blockIdLosingFocus !== typingState.currentBlockId) {
        console.debug(`Blur ignored: Blurred block ${blockIdLosingFocus} is not the tracked focused block ${typingState.currentBlockId}.`);
        return;
    }

    console.debug(`Blur detected on tracked block: ${blockIdLosingFocus}. Starting timeout.`);

    // Use setTimeout to allow potential immediate re-focus within the editor
    setTimeout(() => {
        console.debug(`--- Blur timeout executing for ${blockIdLosingFocus} ---`);
        const newlyFocusedElement = document.activeElement;
        const newlyFocusedBlock = newlyFocusedElement?.closest('[data-block-id]');
        const newlyFocusedBlockId = newlyFocusedBlock?.dataset.blockId;

        console.debug(`Focus after timeout: Element:`, newlyFocusedElement, `Block ID: ${newlyFocusedBlockId}`);

        // If focus is still somewhere within the same block (e.g., clicking formatting button related to it)
        // or has moved *back* to it after a brief excursion, DO NOTHING with unlock/state reset.
        // The handleBlockFocus logic will manage transitions correctly.
        if (newlyFocusedBlockId === blockIdLosingFocus) {
            console.debug(`Focus check: Still on ${blockIdLosingFocus} (or returned). No unlock/state reset needed from blur timeout.`);
            return;
        }

         // If focus has moved outside the editor entirely, or to a *different* block,
         // then we proceed with update/unlock for the block that lost focus.
         console.debug(`Focus check: Moved away from ${blockIdLosingFocus} (now on ${newlyFocusedBlockId || 'outside'}). Forcing update and unlock.`);
         sendCurrentBlockUpdate(true);

         if(activeLocks[blockIdLosingFocus]) {
              console.debug(`Requesting unlock via WS for block: ${blockIdLosingFocus}`);
              ws.sendMessage('unlock_block', { document_id: currentDocId, block_id: blockIdLosingFocus });
              delete activeLocks[blockIdLosingFocus];
         } else {
             console.debug(`No active local lock found for ${blockIdLosingFocus} to unlock.`);
         }

         // Clear typing state *only if* the block we're processing blur for
         // is still the one in typingState (i.e., handleBlockFocus for a new block hasn't already updated it).
         if(typingState.currentBlockId === blockIdLosingFocus) {
            console.debug(`Resetting typing state as block ${blockIdLosingFocus} is fully blurred.`);
            typingState.currentBlockId = null;
            typingState.charCountSinceLastUpdate = 0;
            clearTimeout(typingState.timerId);
            typingState.timerId = null;
         } else {
            console.debug(`Typing state currentBlockId (${typingState.currentBlockId}) already changed before blur processed for ${blockIdLosingFocus}. Not resetting state here.`);
         }
         console.debug(`--- Blur timeout finished for ${blockIdLosingFocus} ---`);
    }, 150);
}

function handleBlockInput(event) {
    const block = event.target.closest('[data-block-id]');

    // Check if the input event is on the currently tracked focused block and if it's editable
    if (!block || block.contentEditable !== 'true' || block.dataset.blockId !== typingState.currentBlockId) {
        return;
    }

    const blockId = typingState.currentBlockId;
    undoRedo.pushState(blockId, block.innerHTML);

    typingState.charCountSinceLastUpdate++;
    clearTimeout(typingState.timerId);

    if (typingState.charCountSinceLastUpdate >= CHAR_UPDATE_THRESHOLD) {
        sendCurrentBlockUpdate();
    } else {
        typingState.timerId = setTimeout(() => {
            if (typingState.currentBlockId === blockId) { // Check again inside timeout
                sendCurrentBlockUpdate();
            }
            typingState.timerId = null;
        }, TIME_UPDATE_THRESHOLD_MS);
    }
}


async function handleKeyDown(event) {
     if (event.ctrlKey) {
         let actionType = null;
         if (event.key === 'z' || event.key === 'Z') {
             actionType = 'undo';
         } else if (event.key === 'y' || event.key === 'Y') {
             actionType = 'redo';
         }

         if (actionType) {
             event.preventDefault();
             console.debug(`Global ${actionType} requested via key`);

             const currentFocusedBlockId = typingState.currentBlockId;
             const targetBlockId = (actionType === 'undo') ? undoRedo.peekUndoBlockId() : undoRedo.peekRedoBlockId();

             if (!targetBlockId) {
                 console.log(`${actionType} stack empty or ambiguous.`);
                 if (actionType === 'undo') {
                     showNotification("Unable to perform undo: Nothing to undo or history cleared due to external changes.", "warning");
                 } else {
                     showNotification("Unable to perform redo: Nothing to redo.", "warning");
                 }
                 return;
             }

             const targetBlockElement = getBlockElement(targetBlockId);
             if (!targetBlockElement) {
                 console.warn(`Cannot ${actionType}: Target block ${targetBlockId} not found in DOM.`);
                 showNotification(`Cannot ${actionType}: Block no longer exists.`, "error");
                 if (actionType === 'undo') undoRedo.clearAllRedoStacks(); // History invalid
                 return;
             }

             // Scenario 1: Focused on the target block
             if (currentFocusedBlockId === targetBlockId && targetBlockElement.contentEditable === 'true') {
                 console.debug(`Performing ${actionType} on currently focused block ${targetBlockId}`);
                 const stateToApply = (actionType === 'undo') ? undoRedo.undo(targetBlockId) : undoRedo.redo(targetBlockId);
                 if (stateToApply) {
                     targetBlockElement.innerHTML = stateToApply.content;
                     sendSpecificBlockUpdate(targetBlockId, stateToApply.content, getBlockMetadata(targetBlockElement));
                 }
             }
             // Scenario 2: Not focused on the target block (or not focused at all)
             else {
                 console.debug(`Performing ${actionType} on non-focused block ${targetBlockId}`);

                 // Check lock status by another user
                 if (isBlockLockedByOther(targetBlockId)) {
                      console.warn(`Cannot ${actionType}: Block ${targetBlockId} is locked by another user.`);
                      showNotification(`Cannot ${actionType}: Block is locked by another user. Undo/Redo history for this block may be invalid.`, "warning");
                      if (actionType === 'undo') undoRedo.clearAllRedoStacks(); // Clear redo if blocked
                      return;
                 }

                 // Check if block is editable (might be locked by *self* but focus lost)
                 const isTargetEditable = targetBlockElement.contentEditable === 'true';

                 // Proceed with simulated edit sequence
                 const stateToApply = (actionType === 'undo') ? undoRedo.undo(targetBlockId) : undoRedo.redo(targetBlockId);
                 if (stateToApply) {
                     // Apply change locally FIRST
                     targetBlockElement.innerHTML = stateToApply.content;
                     const metadata = getBlockMetadata(targetBlockElement); // Get metadata *after* content change

                     ws.sendMessage('lock_block', { document_id: currentDocId, block_id: targetBlockId });

                     // Send Update
                     // Use a small delay to allow lock message to process server-side
                     await new Promise(resolve => setTimeout(resolve, 50));
                     ws.sendMessage('update_document', {
                        document_id: currentDocId,
                        block_id: targetBlockId,
                        content: stateToApply.content,
                        metadata: metadata
                     });

                     // Unlock Immediately
                     await new Promise(resolve => setTimeout(resolve, 50));
                     ws.sendMessage('unlock_block', { document_id: currentDocId, block_id: targetBlockId });

                      // Clear redo stack if an undo was successfully simulated off-block,
                      // as external changes might have happened.
                      if (actionType === 'undo') {
                         undoRedo.clearBlockHistory(targetBlockId); // Clear both stacks for safety after off-block undo
                     }

                 } else {
                     // Undo/redo failed (stack empty) even when off-block
                      console.warn(`${actionType} failed unexpectedly for non-focused block ${targetBlockId}. Stack might be empty.`);
                       if (actionType === 'undo') {
                            showNotification("Unable to perform undo: Nothing to undo or history cleared due to external changes.", "warning");
                       } else {
                            showNotification("Unable to perform redo: Nothing to redo.", "warning");
                       }
                 }
             }
         }
     }
}


function sendCurrentBlockUpdate(force = false) {
    if (!typingState.currentBlockId) {
        return;
    }
    // Send if forced, or if changes have been made
    if (!force && typingState.charCountSinceLastUpdate === 0) {
        return;
    }

    const blockId = typingState.currentBlockId;
    const block = getBlockElement(blockId);
    if (!block) {
        console.error(`Block element not found for update: ${blockId}`);
        return;
    }

    // *** Ensure the block is actually editable before sending update ***
    if(block.contentEditable !== 'true') {
        console.warn(`Skipping update for non-editable block: ${blockId}`);
        return;
    }

    const content = block.innerHTML;
    const metadata = getBlockMetadata(block);

    if (!metadata) {
         console.error(`Metadata not found for update: ${blockId}`);
         return;
    }

    sendSpecificBlockUpdate(blockId, content, metadata);

    typingState.charCountSinceLastUpdate = 0;
    clearTimeout(typingState.timerId);
    typingState.timerId = null;
}

function sendSpecificBlockUpdate(blockId, content, metadata) {
     if (!currentDocId) {
         console.warn("sendSpecificBlockUpdate skipped: no currentDocId");
         return false;
     }

     console.debug(`Calling ws.sendMessage for update_document on block ${blockId}`);
     const success = ws.sendMessage('update_document', {
        document_id: currentDocId,
        block_id: blockId,
        content: content,
        metadata: metadata
    });
     if (!success) {
         console.error(`Failed to send update_document message for ${blockId}.`);
     }
     return success;
}


export function handleRemoteUpdate(payload) {
    if (!currentDocId || String(payload.document_id) !== String(currentDocId)) {
        return;
    }

    undoRedo.clearBlockHistory(payload.block_id);
    if (payload.block_id === typingState.currentBlockId) {
        console.warn(`Ignoring remote update for currently focused block: ${payload.block_id}. It should be locked!`);
        return;
    }
    const block = getBlockElement(payload.block_id);
    if (block) {
        const savedSelection = saveSelection(block);

        block.innerHTML = payload.content_html;
        const newMetadata = payload.metadata || {};
        updateBlockMetadataCache(payload.block_id, newMetadata);

        // Apply styling based on new metadata if needed (e.g. class change)
        if (newMetadata.style_classes !== block.className) {
            block.className = newMetadata.style_classes || "";
        }
        // Handle level changes for headings
        if (newMetadata.block_type === 'heading' && newMetadata.level) {
            const currentLevelMatch = block.tagName.match(/^H([1-6])$/);
            const currentLevel = currentLevelMatch ? currentLevelMatch[1] : null;
            if (String(currentLevel) !== String(newMetadata.level)) {
                 // Re-render the block as the correct heading tag might be easier
                 blockActions.replaceBlockElement(block, newMetadata, payload.content_html);
            }
        }
         // Handle alt text update
         if (block.dataset.altText !== (newMetadata.alt_text || "")) {
            block.dataset.altText = newMetadata.alt_text || "";
        }
        restoreSelection(block, savedSelection);


    } else {
        console.warn(`Block element not found for remote update: ${payload.block_id}`);
        // Maybe request full document refresh?
    }
}

export function handleLockUpdate(type, payload) {
     // console.log(`>>> handleLockUpdate received: Type: ${type}, Payload:`, payload);
     if (!currentDocId || String(payload.document_id) !== String(currentDocId)) {
        // console.log("Lock update ignored: Wrong document.");
        return;
    }
    const block = getBlockElement(payload.block_id);
    if (!block) {
        console.warn(`Block element ${payload.block_id} not found for lock update.`);
        return;
    }

    const isOwnLockEvent = payload.locked_by === ws.currentUsername || payload.unlocked_by === ws.currentUsername;
    const blockId = payload.block_id;

    switch (type) {
        case "block_locked":
            if (!isOwnLockEvent) {
                // Locked by someone else - invalidate local history for this block
                 console.log(`Block ${blockId} locked by other (${payload.locked_by}). Clearing local history.`);
                 undoRedo.clearBlockHistory(blockId);
                applyLockStyle(block, payload.locked_by);
                delete activeLocks[blockId];
            } else {
                 // Lock confirmed for self
                 console.log(`Lock confirmed for self on block ${blockId}`);
                removeLockStyle(block);
                activeLocks[blockId] = true;
            }
            break;
        case "block_unlocked":
             // Unlocking doesn't necessarily invalidate history
             // console.log(`Block ${blockId} unlocked by ${payload.unlocked_by}`);
             removeLockStyle(block);
             delete activeLocks[blockId];
            break;
        case "lock_denied":
             // Lock denied - invalidate local history for this block
             console.warn(`Lock denied for block ${blockId}. Clearing local history.`);
             undoRedo.clearBlockHistory(blockId);
             applyLockStyle(block, payload.locked_by);
             delete activeLocks[blockId];
            break;
    }
    // console.log("<<< handleLockUpdate END");
}

function applyLockStyle(element, lockedBy) {
     if (!element) return;
     element.contentEditable = "false";
     element.classList.add('locked');
     element.title = `Locked by ${lockedBy}`;
     element.classList.remove('editable');
     element.style.removeProperty("background-color");
     element.style.removeProperty("outline");
}

function removeLockStyle(element) {
    if (!element) return;
    const blockType = element.dataset.blockType;
    const tagName = element.tagName;

    // Only make editable if it's not an intrinsically non-editable type
    if (tagName !== 'HR' && blockType !== 'table-options' && blockType !== 'table') {
        element.contentEditable = "true";
        element.classList.add('editable');
    } else {
        element.contentEditable = "false";
        element.classList.remove('editable');
    }
    element.classList.remove('locked');
    element.removeAttribute("title");
    element.style.removeProperty("background-color");
    element.style.removeProperty("outline");
}

// --- Utility functions ---
export function getBlockElement(blockId) {
    try {
        return editorContainer?.querySelector(`[data-block-id="${String(blockId)}"]`);
    } catch (e) {
        console.error(`Error selecting block with ID ${blockId}:`, e);
        return null;
    }
}
export function getBlockMetadata(blockElement) {
    if (!blockElement || !blockElement.dataset) return null;
    const blockId = blockElement.dataset.blockId;
    if (blockMetadataCache[blockId]) {
        return blockMetadataCache[blockId];
    }

    const tagName = blockElement.tagName.toUpperCase();

    const orderAttr = blockElement.dataset.order;
    const levelAttr = blockElement.dataset.level;
    const rowIndexAttr = blockElement.dataset.rowIndex;
    const colIndexAttr = blockElement.dataset.colIndex;

    const metadata = {
        block_id: blockId,
        block_type: blockElement.dataset.blockType || "text",
        style_classes: blockElement.className || "",
        order: orderAttr !== undefined ? parseInt(orderAttr, 10) : 0,
        level: levelAttr ? parseInt(levelAttr, 10) : null,
        alt_text: blockElement.dataset.altText || "",
    };
     // Handle potential NaN from parseInt
    if (isNaN(metadata.order)) metadata.order = 0;
    if (isNaN(metadata.level)) metadata.level = null;


    // Add table-specific attributes
    if (metadata.block_type === "table-cell" || metadata.block_type === "table-options" || tagName === 'TD' || tagName === 'TH') {
        metadata.row_index = rowIndexAttr !== undefined ? parseInt(rowIndexAttr, 10) : null;
        metadata.col_index = colIndexAttr !== undefined ? parseInt(colIndexAttr, 10) : null;
        metadata.parent_block_id = blockElement.dataset.parentBlockId || null;

         if (isNaN(metadata.row_index)) metadata.row_index = null;
         if (isNaN(metadata.col_index)) metadata.col_index = null;
    }

    updateBlockMetadataCache(blockId, metadata);
    return metadata;
}

export function updateBlockMetadataCache(blockId, metadata) {
     if (blockId && metadata) {
         metadata.block_id = metadata.block_id || blockId;
         blockMetadataCache[blockId] = metadata;
     }
}

export function removeBlockMetadataCache(blockId) {
     if (blockId) {
         delete blockMetadataCache[blockId];
     }
}

export function getCurrentDocId() {
    return currentDocId;
}

export function getEditorContainer() {
    return editorContainer;
}

// Called by modules when they modify content (e.g. undo/redo, toolbar)
// Ensures that programmatic changes are pushed to undo stack and sent over WS
export function notifyExternalChange(blockId) {
    const block = getBlockElement(blockId);
    if(block && block.contentEditable === 'true') {
        console.log(`Notifying external change for block: ${blockId}`);
        undoRedo.pushState(blockId, block.innerHTML);
        sendSpecificBlockUpdate(blockId, block.innerHTML, getBlockMetadata(block));
    }
}


export function isBlockLockedByOther(blockId) {
    const block = getBlockElement(blockId);
    if (!block) return false;

    // Check based on contentEditable and title attribute set by applyLockStyle
    if (block.contentEditable === 'false' && block.classList.contains('locked')) {
        const locker = block.title ? block.title.replace('Locked by ', '') : 'another user';
        return locker !== ws.currentUsername;
    }
    return false;
}

// --- Selection Saving/Restoring ---
function saveSelection(containerEl) {
    if (window.getSelection) {
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && containerEl.contains(sel.anchorNode) && containerEl.contains(sel.focusNode)) {
            const range = sel.getRangeAt(0);
            return {
                startContainer: range.startContainer,
                startOffset: range.startOffset,
                endContainer: range.endContainer,
                endOffset: range.endOffset
            };
        }
    }
    return null;
}

function restoreSelection(containerEl, savedSel) {
    if (savedSel && window.getSelection) {
        const sel = window.getSelection();
         if (containerEl.contains(savedSel.startContainer) && containerEl.contains(savedSel.endContainer)) {
            const range = document.createRange();
            try {
                // Ensure offsets are within bounds
                const startLen = savedSel.startContainer.length || savedSel.startContainer.childNodes.length;
                const endLen = savedSel.endContainer.length || savedSel.endContainer.childNodes.length;
                range.setStart(savedSel.startContainer, Math.min(savedSel.startOffset, startLen));
                range.setEnd(savedSel.endContainer, Math.min(savedSel.endOffset, endLen));

                sel.removeAllRanges();
                sel.addRange(range);
            } catch (e) {
                console.warn("Error restoring selection:", e, "Container:", savedSel.startContainer, "Offset:", savedSel.startOffset);
                range.selectNodeContents(containerEl);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        } else {
             console.warn("Could not restore selection: Nodes no longer exist.");
             const range = document.createRange();
             range.selectNodeContents(containerEl);
             range.collapse(true);
             sel.removeAllRanges();
             sel.addRange(range);
        }
    }
}