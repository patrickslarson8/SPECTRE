const MAX_HISTORY = 5000;
let undoStacks = {};
let redoStacks = {};

/**
 * Ensures the undo/redo stack arrays exist for a block. Does NOT add initial state.
 * @param {string} blockId
 */
export function initStack(blockId) {
    if (!undoStacks[blockId]) {
        // console.log(`Undo stack array initializing for ${blockId}`);
        undoStacks[blockId] = [];
        redoStacks[blockId] = [];
    }
}

/**
 * Pushes a new state onto the undo stack for the block. Clears redo stack for that block.
 * Creates the stack if it doesn't exist.
 * @param {string} blockId
 * @param {string} newState - The new innerHTML state.
 */
export function pushState(blockId, newState) {
    initStack(blockId);

    const currentStack = undoStacks[blockId];

    // This captures the first state after focus/initialization
    if (currentStack.length === 0) {
         currentStack.push(newState);
         // console.log(`Pushed initial state for ${blockId}`);
         redoStacks[blockId] = [];
         return;
    }

    // If stack not empty, only push if state changed
    if (currentStack[currentStack.length - 1] !== newState) {
        currentStack.push(newState);
        // console.log(`Pushed new state for ${blockId}`);
        if (currentStack.length > MAX_HISTORY) {
            currentStack.shift();
        }
        if (redoStacks[blockId] && redoStacks[blockId].length > 0) {
            // console.log(`Clearing redo stack for ${blockId}`);
            redoStacks[blockId] = [];
        }
    }
    // else { console.log(`State unchanged for ${blockId}, not pushed.`); }
}


/**
 * Performs an undo operation for the block.
 * Pops the current state from undo, pushes it to redo, and returns the state to apply.
 * Returns null if no undo is possible.
 * @param {string} blockId
 * @returns {object | null} - Object { blockId, content } or null.
 */
export function undo(blockId) {
    if (!undoStacks[blockId] || undoStacks[blockId].length <= 1) {
        // console.log(`Cannot undo for ${blockId}: No history.`);
        return null;
    }
    initStack(blockId);
    const currentStack = undoStacks[blockId];
    const redoStack = redoStacks[blockId];

    const currentState = currentStack.pop();
    redoStack.push(currentState);

    const previousState = currentStack[currentStack.length - 1];

    console.log(`Undo for ${blockId}. Returning state to apply.`);
    return { blockId: blockId, content: previousState };
}

/**
 * Performs a redo operation for the block.
 * Pops state from redo, pushes it to undo, and returns the state to apply.
 * Returns null if no redo is possible.
 * @param {string} blockId
 * @returns {object | null} - Object { blockId, content } or null.
 */
export function redo(blockId) {
     if (!redoStacks[blockId] || redoStacks[blockId].length === 0) {
        // console.log(`Cannot redo for ${blockId}: No history.`);
        return null;
    }
     initStack(blockId);
     const currentStack = undoStacks[blockId];
     const redoStack = redoStacks[blockId];

     const nextState = redoStack.pop();
     currentStack.push(nextState);

     console.log(`Redo for ${blockId}. Returning state to apply.`);
     return { blockId: blockId, content: nextState };
}

/**
 * Gets the block ID associated with the last undo action, without modifying the stack.
 * Uses heuristic: block with >1 state in undo stack.
 * @returns {string | null} - The block ID or null if stack is empty/insufficient.
 */
export function peekUndoBlockId() {
    let lastModifiedBlockId = null;
    let maxLen = 0;
    for (const blockId in undoStacks) {
        if (undoStacks[blockId].length > 1 && undoStacks[blockId].length >= maxLen) {
             maxLen = undoStacks[blockId].length;
             lastModifiedBlockId = blockId;
        }
    }
    return lastModifiedBlockId;
}

/**
 * Gets the block ID associated with the last redo action, without modifying the stack.
 * Uses heuristic: block with >0 state in redo stack.
 * @returns {string | null} - The block ID or null if stack is empty.
 */
export function peekRedoBlockId() {
    let lastModifiedBlockId = null;
    let maxLen = 0;
    for (const blockId in redoStacks) {
         if (redoStacks[blockId].length > 0 && redoStacks[blockId].length >= maxLen) {
             maxLen = redoStacks[blockId].length;
             lastModifiedBlockId = blockId;
         }
    }
    return lastModifiedBlockId;
}

/**
 * Clears the undo and redo stacks specifically for a given blockId.
 * Called when a remote update makes the local history invalid.
 * @param {string} blockId
 */
export function clearBlockHistory(blockId) {
    if (undoStacks[blockId]) {
        console.warn(`Clearing undo history for block ${blockId} due to external change.`);
        undoStacks[blockId] = [];
    }
     if (redoStacks[blockId]) {
        // console.log(`Clearing redo history for block ${blockId} due to external change.`);
        redoStacks[blockId] = [];
    }
}

/**
 * Clears undo/redo history for all blocks, typically on document load/unload.
 */
export function clearStacks() {
    console.log("Clearing all undo/redo stacks.");
    undoStacks = {};
    redoStacks = {};
}