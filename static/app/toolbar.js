import * as editor from './editor.js';
import * as blockActions from './block_actions.js';
// import * as undoRedo from './undo_redo.js';

const toolbar = document.querySelector('.toolbar');

export function initToolbar() {
    if (!toolbar) {
        console.error("Toolbar element not found!");
        return;
    }

    toolbar.addEventListener('click', handleToolbarClick);
    toolbar.addEventListener('change', handleToolbarChange);

    document.addEventListener('selectionchange', updateToolbarState);
    editor.getEditorContainer()?.addEventListener('focusin', () => setTimeout(updateToolbarState, 50));
}

function handleToolbarClick(event) {
    const button = event.target.closest('button.toolbar-btn');
    if (!button) return;

    event.preventDefault();
    const command = button.dataset.command;
    const blockType = button.dataset.type;

    let currentBlockId = editor.getBlockElement(document.activeElement?.closest('[data-block-id]')?.dataset.blockId)?.dataset.blockId;
    if (!currentBlockId && editor.getCurrentDocId()) { // Check if doc is loaded
        // This is a hack, avoid if possible. Better to expose from editor.js
         if(typeof editor.typingState !== 'undefined' && editor.typingState.currentBlockId) {
             currentBlockId = editor.typingState.currentBlockId;
             console.warn("Toolbar using editor.typingState directly - consider exposing a getter function.");
         }
    }


    if (command === 'undo') {
        if (currentBlockId) {
             console.log(`Toolbar Undo for block: ${currentBlockId}`);
             undoRedo.undo(currentBlockId, editor.applyUndoRedoState);
        } else { console.warn("Undo clicked but no active block found."); }
    } else if (command === 'redo') {
        if (currentBlockId) {
            console.log(`Toolbar Redo for block: ${currentBlockId}`);
            undoRedo.redo(currentBlockId, editor.applyUndoRedoState);
        } else { console.warn("Redo clicked but no active block found."); }
    } else if (command === 'addBlock' && blockType) {
         const currentBlock = editor.getBlockElement(currentBlockId);
         const afterBlockId = currentBlock?.dataset.blockId || null;
         blockActions.addBlock(blockType, afterBlockId);
    }
     else if (command) {
        if (currentBlockId && editor.getBlockElement(currentBlockId)?.isContentEditable) {
             document.execCommand(command, false, null);
             // Notify editor of change
             editor.notifyExternalChange(currentBlockId);
             updateToolbarState(); // Update button states
        } else {
             showNotification("Please focus on an editable block first.", "warning");
        }
    }
}

function handleToolbarChange(event) {
    const select = event.target.closest('select.toolbar-select');
    if (!select) return;

    const command = select.dataset.command;
    const value = select.value;

     let currentBlockId = editor.getBlockElement(document.activeElement?.closest('[data-block-id]')?.dataset.blockId)?.dataset.blockId;
      if (!currentBlockId && editor.getCurrentDocId()) {
          // Hack - see comment in handleToolbarClick
          if(typeof editor.typingState !== 'undefined' && editor.typingState.currentBlockId) {
             currentBlockId = editor.typingState.currentBlockId;
         }
     }

    if (command && value) {
        // Ensure focus is within the editor before executing
        if (currentBlockId && editor.getBlockElement(currentBlockId)?.isContentEditable) {
            document.execCommand(command, false, value);
            // Notify editor of change
            editor.notifyExternalChange(currentBlockId);
            select.selectedIndex = 0;
            updateToolbarState();
        } else {
            showNotification("Please focus on an editable block first.", "warning");
             select.selectedIndex = 0;
        }
    }
}

function updateToolbarState() {
     if (!toolbar) return;
     const commands = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'];
     commands.forEach(cmd => {
         const button = toolbar.querySelector(`button[data-command="${cmd}"]`);
         if (button) {
             try {
                 // Only query state if the editor has focus
                 if(editor.getEditorContainer()?.contains(document.activeElement)) {
                     if (document.queryCommandState(cmd)) {
                         button.classList.add('active');
                     } else {
                         button.classList.remove('active');
                     }
                 } else {
                      button.classList.remove('active');
                 }
             } catch (e) {
                 button.classList.remove('active');
             }
         }
     });

     const formatSelect = toolbar.querySelector('select[data-command="formatBlock"]');
     if (formatSelect) {
         let blockValue = '';
         try {
             const selection = window.getSelection();
             if (selection && selection.rangeCount > 0 && editor.getEditorContainer()?.contains(selection.anchorNode)) {
                 let node = selection.getRangeAt(0).startContainer;
                 node = node.nodeType === 3 ? node.parentNode : node; // Get element node
                 while (node && node !== editor.getEditorContainer()) {
                     const tagName = node.tagName.toLowerCase();
                     if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
                         const match = Array.from(formatSelect.options).find(opt => opt.value.toLowerCase() === `<${tagName}>`);
                         blockValue = match ? match.value : '';
                         break;
                     }
                     if ( (tagName === 'div' || tagName === 'p') && node.parentElement === editor.getEditorContainer()) {
                          blockValue = '';
                          break;
                     }
                     if(node.parentElement === editor.getEditorContainer()) break;

                     node = node.parentNode;
                 }
             }
         } catch (e) { /* ignore errors */ }
         formatSelect.value = blockValue;
     }
}