import json
import uuid
import logging
from types import SimpleNamespace
from html import escape

logger = logging.getLogger(__name__)

def create_block_html(block_data):
    """Generates HTML representation for a single block dict or DocumentBlock object."""
    # Handle both dicts and objects
    if isinstance(block_data, dict):
        block = SimpleNamespace(**block_data)
        block.block_attribute_id = block_data.get("block_attribute_id", str(uuid.uuid4()))
        block.block_type = block_data.get("block_type", "text")
        block.content = block_data.get("content", "")
        block.style_classes = block_data.get("style_classes", "")
        block.order = block_data.get("order", 0)
        block.level = block_data.get("level", "")
        block.alt_text = block_data.get("alt_text", "")
        block.row_index = block_data.get("row_index", None)
        block.col_index = block_data.get("col_index", None)
        block.parent_block_id = block_data.get("parent_block_id", None)
    else:  # Assume it's a DocumentBlock object
        block = block_data
        # Ensure level is represented as a string for the data attribute
        block.level = block.level if block.level is not None else ""


    safe_alt_text = escape(block.alt_text or "", quote=True)
    # Content itself is assumed to be safe HTML

    common_attrs = (
        f'data-block-id="{block.block_attribute_id}" '
        f'data-block-type="{block.block_type}" '
        f'data-order="{block.order}" '
        f'data-level="{block.level}" '
        f'data-alt-text="{safe_alt_text}" '
        f'class="{block.style_classes or ""}"'
    )

    if block.block_type == "hr":
        return f'<hr {common_attrs}>'
    elif block.block_type == "heading":
        level = block.level if block.level else 2
        return f'<h{level} {common_attrs}>{block.content}</h{level}>'
    elif block.block_type == "table-cell":
        # For initial rendering, cells are placed inside table structure later
        return (
            f'<td {common_attrs} '
            f'data-row-index="{block.row_index}" '
            f'data-col-index="{block.col_index}" '
            f'data-parent-block-id="{block.parent_block_id}" '
            f'contenteditable="true">'
            f'{block.content}'
            f'</td>'
        )
    elif block.block_type == "table-options":
         return None
    elif block.block_type == "text":
         return f'<div {common_attrs} contenteditable="true">{block.content}</div>'
    else:
         logger.warning(f"Rendering unknown block type '{block.block_type}' as simple div.")
         return f'<div {common_attrs} contenteditable="true">{block.content}</div>'


def render_document_html(blocks):
    """Renders the full HTML content for a list of DocumentBlock objects."""
    sorted_blocks = sorted(blocks, key=lambda b: b.order)

    html_parts = []
    tables = {}

    # First pass: Group table cells and options, generate HTML for non-table blocks
    for block in sorted_blocks:
        if block.block_type == "table-cell":
            if block.parent_block_id not in tables:
                tables[block.parent_block_id] = {'cells': [], 'options': None, 'min_order': block.order}
            tables[block.parent_block_id]['cells'].append(block)
            # Track minimum order for later insertion
            tables[block.parent_block_id]['min_order'] = min(tables[block.parent_block_id]['min_order'], block.order)
        elif block.block_type == "table-options":
            if block.parent_block_id not in tables:
                 tables[block.parent_block_id] = {'cells': [], 'options': None, 'min_order': block.order}
            try:
                # Ensure content is not None or empty before parsing
                if block.content and block.content.strip():
                    tables[block.parent_block_id]['options'] = json.loads(block.content)
                else:
                    logger.warning(f"Empty table-options content for parent_block_id: {block.parent_block_id}")
                    tables[block.parent_block_id]['options'] = {} # Default to empty options
            except json.JSONDecodeError as e:
                logger.error(f"Failed to parse table options JSON for parent {block.parent_block_id}: {e}. Content: '{block.content}'")
                tables[block.parent_block_id]['options'] = {} # Default on error
            # Track minimum order if options appear before cells
            tables[block.parent_block_id]['min_order'] = min(tables[block.parent_block_id]['min_order'], block.order)
        else:
            block_html = create_block_html(block)
            if block_html:
                 # Store with order for correct placement later
                html_parts.append({"order": block.order, "html": block_html, "type": "block"})

    # Second pass: Generate HTML for tables
    for parent_id, table_data in tables.items():
        if not table_data['cells']:
            logger.warning(f"Table '{parent_id}' has options but no cells, skipping render.")
            continue

        rows = {}
        max_col_index = 0
        for cell_block in table_data['cells']:
            try:
                r_index = int(cell_block.row_index)
                c_index = int(cell_block.col_index)
                max_col_index = max(max_col_index, c_index)
            except (TypeError, ValueError) as e:
                logger.error(f"Invalid row/col index for cell {cell_block.block_attribute_id}: {e}")
                continue # Skip cells with invalid indices

            if r_index not in rows:
                rows[r_index] = {}
            rows[r_index][c_index] = create_block_html(cell_block) # Generate TD html

        num_cols = max_col_index + 1
        table_html = f'<table id="{parent_id}" data-block-type="table">' # Use parent_id as table HTML id

        # Add colgroup based on options
        options = table_data.get('options') or {}
        col_widths = options.get('columns')
        if col_widths and isinstance(col_widths, list):
             table_html += "<colgroup>"
             # Ensure colgroup matches actual max columns found
             for i in range(num_cols):
                 width = col_widths[i] if i < len(col_widths) else "auto" # Default width if options mismatch
                 table_html += f'<col style="width: {escape(width)};">'
             table_html += "</colgroup>"

        table_html += "<tbody>"
        # Render rows in sorted order
        for r_index in sorted(rows.keys()):
            table_html += "<tr>"
            # Ensure all columns are rendered, even if empty
            for c_index in range(num_cols):
                 table_html += rows[r_index].get(c_index, f'<td data-row-index="{r_index}" data-col-index="{c_index}" data-parent-block-id="{parent_id}" contenteditable="true"></td>') # Add empty TD if missing
            table_html += "</tr>"
        table_html += "</tbody></table>"

        # Store table HTML with the minimum order of its constituent blocks
        html_parts.append({"order": table_data['min_order'], "html": table_html, "type": "table"})

    final_sorted_html = sorted(html_parts, key=lambda p: p['order'])

    return "".join(part["html"] for part in final_sorted_html)