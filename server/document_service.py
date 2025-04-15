import json
import uuid
import logging
from sqlalchemy.orm import Session, joinedload, selectinload, aliased
from sqlalchemy import func, desc, case
from html import escape
import html.parser  # For stripping tags in API
from typing import Union, Optional

from server.db_manager import Document, DocumentVersion, DocumentBlock, SessionLocal
from server.template_manager import template_manager  # Singleton instance

logger = logging.getLogger(__name__)


# --- HTML Stripping Utility ---
class HTMLStripper(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.reset()
        self.strict = False
        self.convert_charrefs = True
        self.text = []

    def handle_data(self, d):
        self.text.append(d)

    def get_text(self):
        return ''.join(self.text)


def strip_tags(html_content):
    """Removes HTML tags from a string."""
    if not html_content:
        return ""
    try:
        s = HTMLStripper()
        s.feed(html_content)
        return s.get_text()
    except Exception as e:
        logger.warning(f"Error stripping tags: {e}. Returning original content.")
        return html_content  # Fallback


# --- Helper Functions ---
def _get_latest_version(db: Session, doc_id: int) -> Optional[DocumentVersion]:
    """Gets the most recent version of a document."""
    return db.query(DocumentVersion) \
        .filter(DocumentVersion.document_id == doc_id) \
        .order_by(DocumentVersion.timestamp.desc()) \
        .first()


def _copy_blocks_for_new_version(db: Session, source_version: DocumentVersion, new_version: DocumentVersion, exclude_attr_ids: set = None):
    """Copies block *associations* from source to new version, excluding specified attribute IDs."""
    if exclude_attr_ids is None:
        exclude_attr_ids = set()

    copied_blocks_associated = []
    for old_block in source_version.blocks:
        if old_block.block_attribute_id not in exclude_attr_ids:
            new_version.blocks.append(old_block)
            copied_blocks_associated.append(old_block) # Keep track of associated blocks

    # db.flush()

    return copied_blocks_associated


# --- Document CRUD ---
def list_documents(db: Session):
    """Lists all documents, ordered by last modified."""
    return db.query(Document).order_by(Document.last_modified.desc()).all()


def get_document(db: Session, doc_id: int):
    """Gets a single document by ID, loading versions."""
    return db.query(Document).options(selectinload(Document.versions)) \
        .filter(Document.doc_id == doc_id).first()


def create_document_from_template(db: Session, title: str, template_name: str, changed_by: str) -> Optional[Document]:
    """Creates a new document based on a JSON template."""
    template_data = template_manager.get_template(template_name)
    if not template_data:
        logger.error(f"Template '{template_name}' not found.")
        return None

    try:
        doc = Document(title=title)
        db.add(doc)
        db.flush()

        first_version = DocumentVersion(document=doc, changed_by=changed_by)
        db.add(first_version)
        db.flush()

        current_order = 0
        blocks_to_add = []

        for item in template_data:
            block_type = item.get("block_type", "text")

            if block_type == "table":
                 # 1. Generate a unique ID for THIS INSTANCE of the table concept
                 table_instance_uuid = str(uuid.uuid4())

                 # 2. Create table-options block (if options exist)
                 options = item.get("options")
                 if options:
                     options_block_attr_id = str(uuid.uuid4())
                     options_block = DocumentBlock(
                         block_attribute_id=options_block_attr_id,
                         block_type="table-options",
                         content=json.dumps(options),
                         order=current_order,
                         parent_block_id=table_instance_uuid, # Link to table instance
                         style_classes=item.get("style_classes", ""),
                     )
                     blocks_to_add.append(options_block)
                     current_order += 1

                 # 3. Create table-cell blocks
                 rows = item.get("rows", [])
                 for r_idx, row_content in enumerate(rows):
                     for c_idx, cell_content in enumerate(row_content):
                         cell_block_attr_id = str(uuid.uuid4())
                         cell_block = DocumentBlock(
                             block_attribute_id=cell_block_attr_id,
                             block_type="table-cell",
                             content=cell_content,
                             order=current_order,
                             row_index=r_idx,
                             col_index=c_idx,
                             parent_block_id=table_instance_uuid,
                             style_classes=item.get("style_classes", ""),
                         )
                         blocks_to_add.append(cell_block)
                         current_order += 1
            else:
                 # For non-table blocks (heading, text, hr, etc.)
                 block_attr_id = str(uuid.uuid4())
                 block = DocumentBlock(
                    block_attribute_id=block_attr_id,
                    block_type=block_type,
                    content=item.get("content", ""),
                    style_classes=item.get("style_classes", ""),
                    level=item.get("level"),
                    alt_text=item.get("alt_text", ""),
                    order=current_order,
                    parent_block_id=None,
                    row_index=None,
                    col_index=None
                 )
                 blocks_to_add.append(block)
                 current_order += 1

        # After loop: Associate blocks with the version
        for block_obj in blocks_to_add:
            db.add(block_obj)
            first_version.blocks.append(block_obj)

        db.commit()
        db.refresh(doc)
        logger.info(f"Created document '{title}' (ID: {doc.doc_id}) from template '{template_name}' by {changed_by}.")
        return doc

    except Exception as e:
        db.rollback()
        logger.exception(f"Error creating document from template '{template_name}': {e}")
        return None


def save_document_as_template(db: Session, doc_id: int, template_name: str) -> bool:
    """Saves the latest structure of a document as a new JSON template file."""
    latest_version = _get_latest_version(db, doc_id)
    if not latest_version:
        logger.error(f"Cannot save template: No versions found for document {doc_id}")
        return False

    # Fetch blocks
    version_with_blocks = db.query(DocumentVersion) \
        .options(selectinload(DocumentVersion.blocks)) \
        .filter(DocumentVersion.version_id == latest_version.version_id) \
        .one()

    sorted_blocks = sorted(version_with_blocks.blocks, key=lambda b: b.order)

    template_structure = []
    processed_tables = set()  # Keep track of tables already handled

    for block in sorted_blocks:
        if block.block_type == "table-cell" or block.block_type == "table-options":
            # Handled when the corresponding 'table' block is processed
            continue

        is_table_related = block.parent_block_id is not None
        table_id_to_process = None

        block_data = {
            "block_type": block.block_type,
            "content": block.content,
            "style_classes": block.style_classes,
            "level": block.level,
            "alt_text": block.alt_text
        }

        potential_parent_id = block.parent_block_id or block.block_attribute_id

        if potential_parent_id and potential_parent_id not in processed_tables:
            related_cells = [b for b in sorted_blocks if
                             b.block_type == 'table-cell' and b.parent_block_id == potential_parent_id]
            related_options_block = next((b for b in sorted_blocks if
                                          b.block_type == 'table-options' and b.parent_block_id == potential_parent_id),
                                         None)

            if related_cells:  # If we found cells, treat this as a table structure
                processed_tables.add(potential_parent_id)
                table_entry = {
                    "block_type": "table",
                    "parent_block_id": potential_parent_id,
                    "options": json.loads(
                        related_options_block.content) if related_options_block and related_options_block.content else None,
                    "rows": []
                }
                rows_dict = {}
                max_col = 0
                for cell in related_cells:
                    r_idx, c_idx = cell.row_index, cell.col_index
                    if r_idx not in rows_dict: rows_dict[r_idx] = {}
                    rows_dict[r_idx][c_idx] = cell.content
                    max_col = max(max_col, c_idx)

                num_cols = max_col + 1
                for r_idx in sorted(rows_dict.keys()):
                    row_list = [rows_dict[r_idx].get(c_idx, "") for c_idx in range(num_cols)]
                    table_entry["rows"].append(row_list)

                template_structure.append(table_entry)
                continue  # Skip adding the original block if it was part of the table structure

        # If it wasn't part of an aggregated table, add the block directly
        template_structure.append(block_data)

    return template_manager.save_template(template_name, template_structure)


# --- Versioning ---
def get_document_versions(db: Session, doc_id: int):
    """Gets version history (ID, timestamp, changer) for a document."""
    doc = db.query(Document).filter(Document.doc_id == doc_id).first()
    if not doc:
        return None  # Indicate document not found

    versions = db.query(DocumentVersion.version_id, DocumentVersion.timestamp, DocumentVersion.changed_by) \
        .filter(DocumentVersion.document_id == doc_id) \
        .order_by(DocumentVersion.timestamp.desc()) \
        .all()

    return [
        {"version_id": v.version_id, "timestamp": v.timestamp.isoformat(), "changed_by": v.changed_by or "Unknown"}
        for v in versions
    ]


def get_specific_version(db: Session, doc_id: int, version_id: int):
    """Gets a specific version with its blocks loaded."""
    return db.query(DocumentVersion) \
        .options(selectinload(DocumentVersion.blocks)) \
        .filter(DocumentVersion.document_id == doc_id, DocumentVersion.version_id == version_id) \
        .first()


def revert_to_version(db: Session, doc_id: int, version_id: int, changed_by: str) -> Optional[DocumentVersion]:
    """Creates a new version by copying blocks from an older version."""
    doc = db.query(Document).filter(Document.doc_id == doc_id).first()
    if not doc:
        logger.error(f"Cannot revert: Document {doc_id} not found.")
        return None

    version_to_revert_from = get_specific_version(db, doc_id, version_id)
    if not version_to_revert_from:
        logger.error(f"Cannot revert: Version {version_id} for doc {doc_id} not found.")
        return None

    try:
        new_version = DocumentVersion(document=doc, changed_by=f"{changed_by} (reverted to v{version_id})")
        db.add(new_version)
        db.flush()

        _copy_blocks_for_new_version(db, version_to_revert_from, new_version)

        db.commit()
        logger.info(
            f"Document {doc_id} reverted to state of version {version_id} as new version {new_version.version_id} by {changed_by}.")
        db.refresh(new_version)
        return new_version
    except Exception as e:
        db.rollback()
        logger.exception(f"Error reverting document {doc_id} to version {version_id}: {e}")
        return None


# --- Block Manipulation ---
def update_block(db: Session, doc_id: int, block_attr_id: str, content: str, metadata: dict, changed_by: str):
    """Updates a single block, creating a new document version."""
    doc = db.query(Document).filter(Document.doc_id == doc_id).first()
    if not doc: return None
    latest_version = _get_latest_version(db, doc_id)
    if not latest_version: return None

    # Find the original block in the latest version to get its immutable props
    original_block = next((b for b in latest_version.blocks if b.block_attribute_id == block_attr_id), None)
    if not original_block:
        logger.error(f"Block with attr_id {block_attr_id} not found in latest version of doc {doc_id}.")
        return None

    try:
        new_version = DocumentVersion(document=doc, changed_by=changed_by)
        db.add(new_version)
        db.flush()

        # Copy all blocks EXCEPT the one being updated
        _copy_blocks_for_new_version(db, latest_version, new_version, exclude_attr_ids={block_attr_id})

        # Create the new block instance
        updated_block = DocumentBlock(
            block_attribute_id=block_attr_id,  # Keep same identifier
            block_type=metadata.get("block_type", original_block.block_type),
            content=content,
            style_classes=metadata.get("style_classes", original_block.style_classes),
            order=original_block.order,  # Keep original order
            level=metadata.get("level", original_block.level),
            alt_text=metadata.get("alt_text", original_block.alt_text),
            parent_block_id=metadata.get("parent_block_id", original_block.parent_block_id),
            row_index=metadata.get("row_index", original_block.row_index),
            col_index=metadata.get("col_index", original_block.col_index)
        )
        db.add(updated_block)
        new_version.blocks.append(updated_block)

        db.commit()
        logger.info(
            f"Block {block_attr_id} updated in doc {doc_id} (new version {new_version.version_id}) by {changed_by}.")
        return {
            "document_id": doc_id,
            "version_id": new_version.version_id,
            "block_id": block_attr_id,
            "content_html": content,  # Send back the new content
            "metadata": metadata,  # Send back metadata used
            "timestamp": new_version.timestamp.isoformat()
        }
    except Exception as e:
        db.rollback()
        logger.exception(f"Error updating block {block_attr_id} in doc {doc_id}: {e}")
        return None


def add_block(db: Session, doc_id: int, block_type: str, after_block_attr_id: Optional[str], changed_by: str):
    """Adds a new block after a specified block (or at the end)."""
    doc = db.query(Document).filter(Document.doc_id == doc_id).first()
    if not doc: return None
    latest_version = _get_latest_version(db, doc_id)
    # Handle case of adding to an empty document (no latest_version)

    target_order = 0
    if latest_version:
        if after_block_attr_id:
            after_block = next((b for b in latest_version.blocks if b.block_attribute_id == after_block_attr_id), None)
            if after_block:
                target_order = after_block.order + 1
            else:
                logger.warning(f"after_block_id {after_block_attr_id} not found, adding block at the end.")
                max_order = db.query(func.max(DocumentBlock.order)) \
                    .join(DocumentVersion.blocks) \
                    .filter(DocumentVersion.version_id == latest_version.version_id) \
                    .scalar()
                target_order = (max_order or -1) + 1
        else:
            max_order = db.query(func.max(DocumentBlock.order)) \
                .join(DocumentVersion.blocks) \
                .filter(DocumentVersion.version_id == latest_version.version_id) \
                .scalar()
            target_order = (max_order or -1) + 1

    try:
        new_version = DocumentVersion(document=doc, changed_by=changed_by)
        db.add(new_version)
        db.flush()

        newly_added_blocks_info = []
        blocks_to_add_to_version = []

        # Copy existing blocks and adjust order
        if latest_version:
            copied_blocks = _copy_blocks_for_new_version(db, latest_version, new_version)
            # Increment order for blocks at or after the target position IN THE NEW VERSION
            for block_copy in new_version.blocks:  # Iterate over the just copied blocks
                if block_copy.order >= target_order:
                    block_copy.order += 1  # Make space for the new block
        else:
            copied_blocks = []

        # --- Create the new block(s) ---
        new_block_attr_id = str(uuid.uuid4())
        new_block_data = {
            "block_attribute_id": new_block_attr_id,
            "block_type": block_type,
            "content": f"New {block_type}",
            "style_classes": f"default-{block_type}",
            "order": target_order,
            "level": 2 if block_type == 'heading' else None,
        }

        # Special handling for tables
        if block_type == 'table':
            table_parent_id = new_block_attr_id  # Table's own ID is the parent for cells/options
            new_block_data["parent_block_id"] = table_parent_id


            # 2. Create default table-options
            default_options = {"columns": ["150px", "150px"]}
            options_block = DocumentBlock(
                block_attribute_id=f"options_{table_parent_id}",
                block_type="table-options",
                content=json.dumps(default_options),
                order=target_order + 1,
                parent_block_id=table_parent_id
            )
            db.add(options_block)
            blocks_to_add_to_version.append(options_block)
            newly_added_blocks_info.append(
                {"block_id": options_block.block_attribute_id, "type": "table-options", "order": options_block.order,
                 "content": options_block.content})

            # 3. Create default table-cells
            num_rows, num_cols = 2, 2
            cell_order_start = target_order + 2
            for r in range(num_rows):
                for c in range(num_cols):
                    cell_block = DocumentBlock(
                        block_attribute_id=str(uuid.uuid4()),
                        block_type="table-cell",
                        content="",
                        order=cell_order_start + (r * num_cols) + c,
                        row_index=r,
                        col_index=c,
                        parent_block_id=table_parent_id
                    )
                    db.add(cell_block)
                    blocks_to_add_to_version.append(cell_block)
                    newly_added_blocks_info.append(
                        {"block_id": cell_block.block_attribute_id, "type": "table-cell", "order": cell_block.order,
                         "row": r, "col": c, "parent": table_parent_id})

            # Shift order of subsequent original blocks further
            order_shift = 1 + (num_rows * num_cols)  # Options + cells
            for block_copy in new_version.blocks:
                if block_copy not in blocks_to_add_to_version and block_copy.order >= target_order:
                    block_copy.order += order_shift

        else:  # Simple block (text, heading, hr)
            new_block = DocumentBlock(**new_block_data)
            db.add(new_block)
            blocks_to_add_to_version.append(new_block)
            newly_added_blocks_info.append(
                {"block_id": new_block.block_attribute_id, "type": new_block.block_type, "order": new_block.order,
                 "content": new_block.content})
            # Order shift is just 1 for simple blocks
            for block_copy in new_version.blocks:
                if block_copy not in blocks_to_add_to_version and block_copy.order >= target_order:
                    block_copy.order += 1

        # Add the newly created block(s) to the version relationship
        for b in blocks_to_add_to_version:
            new_version.blocks.append(b)

        db.commit()
        logger.info(
            f"Block type '{block_type}' added to doc {doc_id} (new version {new_version.version_id}) by {changed_by}.")
        return {
            "document_id": doc_id,
            "version_id": new_version.version_id,
            "added_blocks": newly_added_blocks_info,
            "after_block_id": after_block_attr_id,
            "timestamp": new_version.timestamp.isoformat()
        }

    except Exception as e:
        db.rollback()
        logger.exception(f"Error adding block to doc {doc_id}: {e}")
        return None


def delete_block(db: Session, doc_id: int, block_attr_id: str, changed_by: str) -> bool:
    """Deletes a block and its associated children (like table cells)."""
    doc = db.query(Document).filter(Document.doc_id == doc_id).first()
    if not doc: return False
    latest_version = _get_latest_version(db, doc_id)
    if not latest_version: return False

    # Find the block to delete in the latest version
    block_to_delete = next((b for b in latest_version.blocks if b.block_attribute_id == block_attr_id), None)
    if not block_to_delete:
        logger.warning(f"Block {block_attr_id} not found for deletion in doc {doc_id}.")
        return False

    deleted_block_order = block_to_delete.order
    ids_to_exclude = {block_attr_id}

    if block_to_delete.block_type != 'table-cell' and block_to_delete.block_type != 'table-options':
        child_blocks = [b for b in latest_version.blocks if b.parent_block_id == block_attr_id]
        for child in child_blocks:
            ids_to_exclude.add(child.block_attribute_id)

    try:
        new_version = DocumentVersion(document=doc, changed_by=changed_by)
        db.add(new_version)
        db.flush()

        copied_blocks = _copy_blocks_for_new_version(db, latest_version, new_version, exclude_attr_ids=ids_to_exclude)

        order_decrement = 1
        for block_copy in new_version.blocks:
            if block_copy.order > deleted_block_order:
                block_copy.order -= 1

        db.commit()
        logger.info(
            f"Block {block_attr_id} (and potential children) deleted from doc {doc_id} (new version {new_version.version_id}) by {changed_by}.")
        return True

    except Exception as e:
        db.rollback()
        logger.exception(f"Error deleting block {block_attr_id} from doc {doc_id}: {e}")
        return False


# --- Table Manipulation ---

def add_table_row(db: Session, doc_id: int, table_attr_id: str, after_row_index: Optional[str], changed_by: str):
    """Adds a new row to a table."""
    doc = db.query(Document).filter(Document.doc_id == doc_id).first()
    if not doc: return None
    latest_version = _get_latest_version(db, doc_id)
    if not latest_version: return None

    table_blocks = [b for b in latest_version.blocks if b.parent_block_id == table_attr_id]
    table_cells = [b for b in table_blocks if b.block_type == 'table-cell']

    if not table_cells:
        logger.warning(f"Cannot add row: No cells found for table {table_attr_id} in doc {doc_id}.")
        return None

    max_row = -1
    max_col = -1
    for cell in table_cells:
        if cell.row_index is not None: max_row = max(max_row, cell.row_index)
        if cell.col_index is not None: max_col = max(max_col, cell.col_index)
    num_cols = max_col + 1
    new_row_index = (after_row_index + 1) if after_row_index is not None else (max_row + 1)

    try:
        new_version = DocumentVersion(document=doc, changed_by=changed_by)
        db.add(new_version)
        db.flush()

        newly_added_cells_info = []
        new_cell_block_objs = []

        copied_blocks = _copy_blocks_for_new_version(db, latest_version, new_version)

        for block_copy in new_version.blocks:
            if block_copy.parent_block_id == table_attr_id and block_copy.block_type == 'table-cell' and block_copy.row_index >= new_row_index:
                block_copy.row_index += 1

        max_table_order = max((b.order for b in table_blocks),
                              default=latest_version.blocks[-1].order if latest_version.blocks else -1)
        new_cell_start_order = max_table_order + 1

        for c_idx in range(num_cols):
            new_cell = DocumentBlock(
                block_attribute_id=str(uuid.uuid4()),
                block_type='table-cell',
                content='',
                order=new_cell_start_order + c_idx,
                row_index=new_row_index,
                col_index=c_idx,
                parent_block_id=table_attr_id
            )
            db.add(new_cell)
            new_version.blocks.append(new_cell)
            new_cell_block_objs.append(new_cell)
            newly_added_cells_info.append({
                "block_id": new_cell.block_attribute_id, "order": new_cell.order,
                "row": new_row_index, "col": c_idx, "content": ""
            })

        db.commit()
        logger.info(
            f"Row added at index {new_row_index} to table {table_attr_id} in doc {doc_id} (new version {new_version.version_id}) by {changed_by}.")
        return {
            "document_id": doc_id,
            "version_id": new_version.version_id,
            "table_id": table_attr_id,
            "new_row_index": new_row_index,
            "added_cells": newly_added_cells_info,
            "timestamp": new_version.timestamp.isoformat()
        }

    except Exception as e:
        db.rollback()
        logger.exception(f"Error adding row to table {table_attr_id} in doc {doc_id}: {e}")
        return None


def update_table_options(db: Session, doc_id: int, table_attr_id: str, new_options_json: str, changed_by: str) -> bool:
    """Updates the content of the table-options block."""
    # Find the options block associated with the table_attr_id
    latest_version = _get_latest_version(db, doc_id)
    if not latest_version: return False

    options_block_attr_id = None
    for block in latest_version.blocks:
        if block.parent_block_id == table_attr_id and block.block_type == 'table-options':
            options_block_attr_id = block.block_attribute_id
            break

    if not options_block_attr_id:
        # Option block might not exist yet, create it? Or error? Let's error for now.
        logger.error(f"No table-options block found for table {table_attr_id} in doc {doc_id}.")
        return False

    # Use the generic update_block function
    metadata = {"block_type": "table-options", "parent_block_id": table_attr_id}  # Need to pass necessary metadata
    result = update_block(db, doc_id, options_block_attr_id, new_options_json, metadata, changed_by)
    return result is not None


# --- API Specific ---
def get_table_content_api(db: Session, doc_id: int, table_attr_id: str):
    """Gets the text content of a table's cells for API use."""
    latest_version = _get_latest_version(db, doc_id)
    if not latest_version:
        doc_exists = db.query(Document.doc_id).filter(Document.doc_id == doc_id).first()
        return None if not doc_exists else []  # Return empty list if doc exists but no version/table

    # Query blocks directly associated with the version for efficiency
    table_cells = db.query(DocumentBlock) \
        .join(version_blocks_table) \
        .filter(version_blocks_table.c.version_id == latest_version.version_id) \
        .filter(DocumentBlock.parent_block_id == table_attr_id) \
        .filter(DocumentBlock.block_type == 'table-cell') \
        .order_by(DocumentBlock.row_index, DocumentBlock.col_index) \
        .all()

    if not table_cells:
        # Check if the parent_id actually exists in this version to differentiate not found vs empty
        parent_exists = any(b.parent_block_id == table_attr_id for b in latest_version.blocks)
        return None if not parent_exists else []

    rows_dict = {}
    max_col = -1
    for cell in table_cells:
        r_idx, c_idx = cell.row_index, cell.col_index
        if r_idx is None or c_idx is None: continue

        if r_idx not in rows_dict:
            rows_dict[r_idx] = {}
        rows_dict[r_idx][c_idx] = strip_tags(cell.content)
        max_col = max(max_col, c_idx)

    num_cols = max_col + 1
    content_data = []
    for r_idx in sorted(rows_dict.keys()):
        row_list = [rows_dict[r_idx].get(c_idx, "") for c_idx in range(num_cols)]
        content_data.append(row_list)

    return content_data
