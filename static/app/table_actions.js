import * as ws from './websocket.js';
import * as editor from './editor.js';
import { showNotification } from './notifications.js';
import * as blockActions from './block_actions.js';

const tableContextMenu = document.getElementById('table-context-menu');
let currentContextCell = null;

// --- Resize State Variables ---
let isResizing = false;
let resizingHandle = null;
let startX = 0;
let startWidthLeft = 0;
let startWidthRight = 0;
let tableBeingResized = null;
let colLeft = null;
let colRight = null;
const MIN_COL_WIDTH = 30;
const DEFAULT_COL_WIDTH = 100;

/**
 * Calculates the total width from a table's <col> elements (assuming pixel widths)
 * and sets the table's style.width explicitly.
 * @param {HTMLTableElement} tableElement
 */
function setTableWidthFromCols(tableElement) {
    if (!tableElement) return;
    const colgroup = tableElement.querySelector(':scope > colgroup');
    if (!colgroup) {
        console.warn(`Cannot set table width for ${tableElement.id}: No colgroup found.`);
        tableElement.style.width = 'auto';
        return;
    }

    let totalWidth = 0;
    const cols = Array.from(colgroup.children);

    cols.forEach((col, index) => {
        let colWidth = 0;
        // Width *must* be in style attribute and end with px by this point
        if (col.style.width && col.style.width.endsWith('px')) {
            colWidth = parseFloat(col.style.width);
            // Re-validate against minimum just in case
            if (colWidth < MIN_COL_WIDTH) {
                colWidth = MIN_COL_WIDTH;
                col.style.width = `${colWidth}px`;
            }
        } else {
            console.error(`Column ${index} in table ${tableElement.id} missing valid pixel width style ('${col.style.width}') during total calculation. Applying default.`);
            colWidth = DEFAULT_COL_WIDTH;
            col.style.width = `${colWidth}px`;
        }
        totalWidth += colWidth;
    });

    if (totalWidth > 0) {
        tableElement.style.width = `${totalWidth}px`;
        console.log(`Set table ${tableElement.id} explicit width: ${totalWidth}px`);
    } else {
        tableElement.style.width = 'auto';
        console.log(`Set table ${tableElement.id} width to auto (zero total width?).`);
    }
}

// --- Resize Handle Logic ---

/**
 * Creates/positions handles AND sets initial table width.
 * Ensures all <col> elements have a valid pixel width style.
 */
function addResizeHandles(tableElement) {
    if (!tableElement) return;
    removeResizeHandles(tableElement);

    const colgroup = tableElement.querySelector(':scope > colgroup');
    if (!colgroup || colgroup.children.length === 0) { // Handle 0 columns too
        setTableWidthFromCols(tableElement);
        return;
    }

    const cols = Array.from(colgroup.children);
    let cumulativeWidth = 0;

    // --- Step 1: Ensure all cols have a valid pixel style.width ---
    cols.forEach((col, index) => {
        let currentColWidth = 0;
        let widthChanged = false;
        if (col.style.width && col.style.width.endsWith('px')) {
            currentColWidth = parseFloat(col.style.width);
            if (isNaN(currentColWidth)) { // Check if parsing failed
                console.warn(`Column ${index} had invalid pixel style.width ('${col.style.width}'). Applying default.`);
                currentColWidth = DEFAULT_COL_WIDTH;
                widthChanged = true;
            }
        } else {
            console.warn(`Column ${index} missing pixel style.width ('${col.style.width}'). Applying default.`);
            currentColWidth = DEFAULT_COL_WIDTH;
            widthChanged = true;
        }

        // Enforce minimum width
        if (currentColWidth < MIN_COL_WIDTH) {
            currentColWidth = MIN_COL_WIDTH;
            widthChanged = true;
        }

        // Apply the validated/defaulted width back to the style *if needed*
        if (widthChanged) {
            col.style.width = `${currentColWidth}px`;
        }
    });

    // --- Step 2: Calculate cumulative widths and place handles ---
    for (let i = 0; i < cols.length - 1; i++) { // Handles go BETWEEN columns
        const col = cols[i];
        // Read the now guaranteed pixel width
        const width = parseFloat(col.style.width);
        cumulativeWidth += width;

        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        const handleWidth = 5; // Match CSS
        handle.style.left = `${cumulativeWidth - (handleWidth / 2)}px`;
        handle.style.width = `${handleWidth}px`;
        handle.dataset.columnIndex = i; // Column to the LEFT

        handle.addEventListener('mousedown', handleMouseDown);
        tableElement.appendChild(handle);
    }

    // --- Step 3: Set the total table width AFTER ensuring all cols are sized ---
    setTableWidthFromCols(tableElement);

    // console.log(`Applied/Verified fixed pixel widths, set table width, and added handles for table ${tableElement.id}`);
}

/** Removes resize handles from a table */
function removeResizeHandles(tableElement) {
    if (!tableElement) return;
    tableElement.querySelectorAll('.resize-handle').forEach(handle => {
        handle.removeEventListener('mousedown', handleMouseDown);
        handle.remove();
    });
}

function handleMouseDown(event) {
    event.preventDefault();
    resizingHandle = event.target;
    if (!resizingHandle || !resizingHandle.classList.contains('resize-handle')) return;

    isResizing = true;
    resizingHandle.classList.add('dragging');
    startX = event.clientX;
    tableBeingResized = resizingHandle.closest('table');
    if (!tableBeingResized) { isResizing = false; return; }

    const colIndex = parseInt(resizingHandle.dataset.columnIndex, 10);
    const colgroup = tableBeingResized.querySelector(':scope > colgroup');
    if (!colgroup || colIndex < 0 || colIndex >= colgroup.children.length - 1) {
        isResizing = false; return;
    }

    colLeft = colgroup.children[colIndex];
    colRight = colgroup.children[colIndex + 1];

    // --- Get starting widths STRICTLY from style.width ---
    startWidthLeft = parseFloat(colLeft.style.width); // Should be valid px now
    startWidthRight = parseFloat(colRight.style.width); // Should be valid px now

    if (isNaN(startWidthLeft) || isNaN(startWidthRight)) {
        console.error("Failed to get valid pixel start widths. Aborting resize.");
        isResizing = false; resizingHandle.classList.remove('dragging'); return;
    }

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
}

/** Handles mouse movement during resize - RESIZE LEFT COLUMN ONLY */
function handleMouseMove(event) {
    if (!isResizing || !resizingHandle || !colLeft || !tableBeingResized) {
         if(!colRight) console.warn("MouseMove: colRight missing, but continuing.");
         return;
    }

    const currentX = event.clientX;
    const deltaX = currentX - startX;
    let newWidthLeft = startWidthLeft + deltaX;

    // --- Enforce minimum width ONLY on the left column being resized ---
    if (newWidthLeft < MIN_COL_WIDTH) {
        newWidthLeft = MIN_COL_WIDTH;
    }

    // --- Apply visual update ONLY to the left <col> style ---
    colLeft.style.width = `${newWidthLeft}px`;
    // --- DO NOT CHANGE colRight.style.width ---

    // --- Update total table width during drag ---
    // This will now sum the new width of colLeft and the existing widths of all others
    setTableWidthFromCols(tableBeingResized);

    // Update handle position based on the new left width
    const handleWidth = parseInt(resizingHandle.style.width || 5, 10);
    resizingHandle.style.left = `${newWidthLeft - (handleWidth / 2)}px`;
}

/** Ends the column resize drag */
function handleMouseUp(event) {
    if (!isResizing) return;
    isResizing = false;
    if (resizingHandle) resizingHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);


    if (!tableBeingResized) return;
    const tableId = tableBeingResized.id;
    const colgroup = tableBeingResized.querySelector(':scope > colgroup');
    if (!tableId || !colgroup) {
        resizingHandle = null; tableBeingResized = null; colLeft = null; colRight = null; startX = 0; startWidthLeft = 0; startWidthRight = 0;
        return;
    }

    // --- Get final widths from ALL columns styles ---
    const finalColWidths = Array.from(colgroup.children).map((col, index) => {
        if (col.style.width && col.style.width.endsWith('px')) {
            let width = parseFloat(col.style.width);
            if (col === colLeft && width < MIN_COL_WIDTH) {
                 width = MIN_COL_WIDTH;
                 col.style.width = `${width}px`;
            } else if(width < MIN_COL_WIDTH) {
                 width = MIN_COL_WIDTH;
                 col.style.width = `${width}px`;
            }
            return `${width}px`;
        } else {
             console.error(`Column ${index} style.width invalid at mouseup. Saving default.`);
             const defaultWidthPx = `${DEFAULT_COL_WIDTH}px`;
             col.style.width = defaultWidthPx;
             return defaultWidthPx;
        }
    });

    setTableWidthFromCols(tableBeingResized);

    console.log("Final widths to save (resize left only):", finalColWidths);
    const optionsUpdate = { columns: finalColWidths };

    ws.sendMessage('update_table_options', {
        document_id: editor.getCurrentDocId(),
        table_id: tableId,
        options_json: JSON.stringify(optionsUpdate)
    });

    addResizeHandles(tableBeingResized);

    resizingHandle = null; tableBeingResized = null; colLeft = null; colRight = null; startX = 0; startWidthLeft = 0; startWidthRight = 0;
}


// --- Handlers for WebSocket Messages ---

export function handleRemoteOptionsUpdated(payload) {
    const currentDocId = editor.getCurrentDocId();
    if (!currentDocId || String(payload.document_id) !== String(currentDocId)) return;

    console.log("Handling remote table options updated:", payload);
    const tableElement = document.getElementById(payload.table_id);
    if (!tableElement) return;

    try {
        const options = JSON.parse(payload.options_json);
        const colWidths = options.columns;
        let colgroup = tableElement.querySelector(':scope > colgroup');
        if (!colgroup) {
            colgroup = document.createElement('colgroup');
            tableElement.insertBefore(colgroup, tableElement.firstChild);
        }
        colgroup.innerHTML = '';

        if (colWidths && Array.isArray(colWidths)) {
             colWidths.forEach(width => {
                 const col = document.createElement('col');
                 let safeWidth = DEFAULT_COL_WIDTH;
                 if (typeof width === 'string' && width.endsWith('px')) {
                     let pxVal = parseFloat(width);
                     if (!isNaN(pxVal) && pxVal >= MIN_COL_WIDTH) { safeWidth = pxVal; }
                     else if (!isNaN(pxVal)) { safeWidth = MIN_COL_WIDTH; }
                 } else if (width !== 'auto') { /* Warn, use default */ }
                 col.style.width = `${safeWidth}px`;
                 colgroup.appendChild(col);
             });
             // --- Ensure handles and table width are updated ---
             addResizeHandles(tableElement); // Calls setTableWidthFromCols internally
        } else {
             tableElement.style.width = 'auto';
             removeResizeHandles(tableElement);
        }
    } catch (e) { console.error("Error applying table options update:", e, payload.options_json); }
}