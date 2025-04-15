import * as ws from './websocket.js';
import * as editor from './editor.js';
import { showNotification } from './notifications.js';


/**
 * Sends request to add a new block.
 * @param {'text' | 'heading' | 'table' | 'hr'} blockType
 * @param {string | null} afterBlockId - ID of the block to insert after (null for end).
 */
export function addBlock(blockType, afterBlockId) {
    const docId = editor.getCurrentDocId();
    if (!docId) {
        showNotification("Please select a document first.", "warning");
        return;
    }
    console.log(`Requesting to add block type ${blockType} after ${afterBlockId}`);
    ws.sendMessage('add_block', {
        document_id: docId,
        block_type: blockType,
        after_block_id: afterBlockId
    });
}

/**
 * Sends request to delete a block.
 * @param {string} blockId
 */
export function deleteBlock(blockId) {
    const docId = editor.getCurrentDocId();
    if (!docId || !blockId) return;

    if (!confirm("Are you sure you want to delete this block?")) {
        return;
    }


    console.log(`Requesting to delete block: ${blockId}`);
    ws.sendMessage('delete_block', {
        document_id: docId,
        block_id: blockId
    });
}


/**
 * Handles the 'block_added' message from WebSocket.
 * @param {object} payload - Expected to contain document_id, added_blocks array.
 */
export function handleRemoteBlockAdded(payload) {
    const currentDocId = editor.getCurrentDocId();
    if (!currentDocId || payload.document_id !== currentDocId) return;

    console.log("Handling remote block added:", payload);
    const editorContainer = editor.getEditorContainer();
    if (!editorContainer) return;

    payload.added_blocks.forEach(blockInfo => {
        const blockElement = createBlockElement(blockInfo); // Implement this helper
        if(!blockElement) return;

        const afterBlock = payload.after_block_id ? editor.getBlockElement(payload.after_block_id) : null;
        const pivot = afterBlock ? afterBlock.nextElementSibling : editorContainer.firstChild; // Insert after or at beginning

        editorContainer.insertBefore(blockElement, pivot);

        editor.updateBlockMetadataCache(blockInfo.block_id, blockInfo); // Store received info
         if (blockElement.dataset.blockType === 'table-cell' || blockElement.tagName === 'TD' || blockElement.tagName === 'TH') {
             tableActions.addTableCellListeners(blockElement);
         }
         addBlockActionListeners(blockElement);

         // Special handling for tables: Need to assemble table structure
         if(blockInfo.type === 'table-options' || blockInfo.type === 'table-cell') {
             reassembleTable(blockInfo.parent_block_id);
         }

    });
}


/**
 * Handles the 'block_deleted' message from WebSocket.
 * @param {object} payload - Expected to contain document_id, block_id.
 */
export function handleRemoteBlockDeleted(payload) {
     const currentDocId = editor.getCurrentDocId();
    if (!currentDocId || payload.document_id !== currentDocId) return;

    console.log("Handling remote block deleted:", payload.block_id);
    const blockElement = editor.getBlockElement(payload.block_id);
    if (blockElement) {
        editor.removeBlockMetadataCache(payload.block_id);
        const metadata = editor.getBlockMetadata(blockElement);
        const parentId = metadata?.parent_block_id || payload.block_id;

        blockElement.remove();

         if (metadata && metadata.block_type !== 'table-cell' && metadata.block_type !== 'table-options') {
             const relatedTableElements = editor.getEditorContainer().querySelectorAll(`[data-parent-block-id="${parentId}"]`);
             relatedTableElements.forEach(el => {
                 editor.removeBlockMetadataCache(el.dataset.blockId);
                 el.remove();
             });
              const tableEl = document.getElementById(parentId);
              tableEl?.remove();
         }

    } else {
        console.warn(`Block element not found for remote deletion: ${payload.block_id}`);
    }
}


/**
 * Creates an HTML element for a block based on its data, trying to mirror backend logic.
 */
function createBlockElement(blockInfo) {
    let element;
    const blockId = blockInfo.block_id || `temp_${Date.now()}`; // Use provided ID or temp
    const blockType = blockInfo.type || blockInfo.block_type || 'text';
    const content = blockInfo.content || '';
    const order = blockInfo.order !== undefined ? blockInfo.order : 0;
    const level = blockInfo.level || '';
    const styleClasses = blockInfo.style_classes || `default-${blockType}`;
    const altText = blockInfo.alt_text || '';

    try {
        switch (blockType) {
            case 'heading':
                const headingLevel = level || 2;
                element = document.createElement(`h${headingLevel}`);
                element.innerHTML = content;
                element.contentEditable = "true";
                break;
            case 'text':
                element = document.createElement('div');
                element.innerHTML = content;
                element.contentEditable = "true";
                break;
            case 'hr':
                element = document.createElement('hr');
                element.contentEditable = "false"; // HR is not editable
                break;
            case 'table-cell':
                element = document.createElement('td');
                element.innerHTML = content;
                element.dataset.rowIndex = blockInfo.row !== undefined ? blockInfo.row : '';
                element.dataset.colIndex = blockInfo.col !== undefined ? blockInfo.col : '';
                element.dataset.parentBlockId = blockInfo.parent || blockInfo.parent_block_id || '';
                element.contentEditable = "true";
                break;
            case 'table-options':
                // This block type usually doesn't have a direct visual representation in the main flow.
                // It might be rendered elsewhere or just used for data. Return null
                // console.log("Skipping direct element creation for table-options");
                return null;
            case 'table':
                element = document.createElement('table');
                element.id = blockInfo.parent_block_id || blockId;
                element.dataset.blockType = 'table';
                element.appendChild(document.createElement('colgroup'));
                element.appendChild(document.createElement('tbody'));
                element.contentEditable = "false";
                break;
            default:
                console.warn(`Creating generic div for unknown block type: ${blockType}`);
                element = document.createElement('div');
                element.innerHTML = content;
                element.contentEditable = "true";
        }

        element.dataset.blockId = blockId;
        element.dataset.blockType = blockType;
        element.dataset.order = order;
        if (level) element.dataset.level = level;
        if (altText) element.dataset.altText = altText;
        if (styleClasses) element.className = styleClasses;

        return element;

    } catch (error) {
        console.error(`Error creating block element for type ${blockType}:`, error, blockInfo);
        // Return a fallback error element
        const errorElement = document.createElement('div');
        errorElement.textContent = `Error rendering block ${blockId}`;
        errorElement.style.color = 'red';
        errorElement.dataset.blockId = blockId;
        return errorElement;
    }
}


/**
 * Reconstructs table structure in the DOM based on existing cell/option elements.
 * Ensures correct colgroups, row order, and cell placement within tbody.
 * @param {string} tableId - The parent_block_id of the table cells/options.
 */
function reassembleTable(tableId) {
    console.log(`Reassembling table structure for ${tableId}`);
    const editorContainer = editor.getEditorContainer();
    if (!editorContainer) return;

    let tableElement = document.getElementById(tableId);
    const cellElements = Array.from(editorContainer.querySelectorAll(`[data-block-type="table-cell"][data-parent-block-id="${tableId}"]`));

    const optionsBlockId = `options_${tableId}`;
    let optionsData = editor.getBlockMetadata(editor.getBlockElement(optionsBlockId));
    let options = null;
    if (optionsData?.content) {
        try {
            options = JSON.parse(optionsData.content);
        } catch (e) {
            console.error(`Failed to parse options JSON for table ${tableId}:`, e);
            options = { columns: [] };
        }
    } else {
         options = { columns: [] };
    }


    // Ensure table element exists or create it
    if (!tableElement) {
        if (cellElements.length === 0) {
             console.warn(`Cannot reassemble table ${tableId}: No table element or cells found.`);
             return;
        }
        // Table element doesn't exist, create it before the first related element
        tableElement = document.createElement('table');
        tableElement.id = tableId;
        tableElement.dataset.blockType = 'table';
        tableElement.contentEditable = 'false';

        const firstRelatedElement = cellElements[0] || editor.getBlockElement(optionsBlockId);
        if (firstRelatedElement) {
             editorContainer.insertBefore(tableElement, firstRelatedElement);
        } else {
             editorContainer.appendChild(tableElement);
        }
        console.log(`Created missing table element ${tableId}`);
    }

    // Ensure colgroup exists
    let colgroup = tableElement.querySelector(':scope > colgroup');
    if (!colgroup) {
        colgroup = document.createElement('colgroup');
        const firstChild = tableElement.firstChild;
        if(firstChild) {
            tableElement.insertBefore(colgroup, firstChild);
        } else {
            tableElement.appendChild(colgroup);
        }
    }

    // Ensure tbody exists
    let tbody = tableElement.querySelector(':scope > tbody');
    if (!tbody) {
        tbody = document.createElement('tbody');
        tableElement.appendChild(tbody);
    }
    tableElement.removeChild(tbody);
    tbody.innerHTML = '';

    // Group cells by row and find max column index
    const rows = {};
    let maxCol = -1;
    let maxRow = -1;
    cellElements.forEach(cell => {
        const r = parseInt(cell.dataset.rowIndex, 10);
        const c = parseInt(cell.dataset.colIndex, 10);
        if (isNaN(r) || isNaN(c)) return;

        if (!rows[r]) rows[r] = {};
        rows[r][c] = cell; t
        maxCol = Math.max(maxCol, c);
        maxRow = Math.max(maxRow, r);
    });
    const numCols = maxCol + 1;
    const numRows = maxRow + 1;

    // Rebuild rows and append cells
    for (let rIndex = 0; rIndex < numRows; rIndex++) {
        const tr = document.createElement('tr');
        for (let cIndex = 0; cIndex < numCols; cIndex++) {
            const cell = rows[rIndex]?.[cIndex];
            if (cell) {
                 if(cell.parentNode !== tr) {
                     tr.appendChild(cell);
                 } else {
                      tr.appendChild(cell);
                 }
            } else {
                const emptyTd = document.createElement('td');
                emptyTd.dataset.rowIndex = rIndex;
                emptyTd.dataset.colIndex = cIndex;
                emptyTd.dataset.parentBlockId = tableId;
                emptyTd.contentEditable = "true";
                emptyTd.innerHTML = " ";
                tr.appendChild(emptyTd);
                 console.warn(`Missing cell element for table ${tableId}, row ${rIndex}, col ${cIndex}. Created placeholder.`);
            }
        }
        tbody.appendChild(tr);
    }

    tableElement.appendChild(tbody);


    // Update colgroup based on options and actual number of columns
    colgroup.innerHTML = '';
    const colWidths = options?.columns || [];
    for (let i = 0; i < numCols; i++) {
        const col = document.createElement('col');
        const width = colWidths[i] || 'auto';
        const safeWidth = String(width).match(/^[a-zA-Z0-9%. -]+$/) ? width : 'auto';
        col.style.width = safeWidth;
        colgroup.appendChild(col);
    }

    console.log(`Table ${tableId} reassembled. Rows: ${numRows}, Cols: ${numCols}`);
}


/**
 * Replaces an existing block element with a new one based on updated metadata.
 * Useful for fundamental changes like heading level.
 */
export function replaceBlockElement(oldElement, newMetadata, newContent) {
     if (!oldElement || !newMetadata) return;
     const newElement = createBlockElement({ ...newMetadata, content: newContent });
     if (newElement) {
         oldElement.parentNode.replaceChild(newElement, oldElement);
         addBlockActionListeners(newElement);
         editor.updateBlockMetadataCache(newMetadata.block_id, newMetadata);
     }
}