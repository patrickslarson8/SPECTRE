import os
import json
import logging
from server.config import TEMPLATE_DIR

logger = logging.getLogger(__name__)


class TemplateManager:
    def __init__(self, template_dir=TEMPLATE_DIR):
        self.template_dir = template_dir
        self.templates = self._load_templates()

    def _load_templates(self):
        templates = {}
        if not os.path.isdir(self.template_dir):
            logger.warning(f"Template directory not found: {self.template_dir}")
            return templates

        for filename in os.listdir(self.template_dir):
            if filename.endswith(".json"):
                template_name = os.path.splitext(filename)[0]
                filepath = os.path.join(self.template_dir, filename)
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        templates[template_name] = json.load(f)
                    logger.info(f"Loaded template: {template_name}")
                except json.JSONDecodeError:
                    logger.error(f"Error decoding JSON from template file: {filepath}")
                except Exception as e:
                    logger.error(f"Error loading template file {filepath}: {e}")
        return templates

    def get_template(self, name):
        return self.templates.get(name)

    def list_templates(self):
        return list(self.templates.keys())

    def save_template(self, name, template_data):
        """Saves template data as a JSON file."""
        if not os.path.isdir(self.template_dir):
            try:
                os.makedirs(self.template_dir)
            except OSError as e:
                logger.error(f"Could not create template directory {self.template_dir}: {e}")
                return False

        safe_name = "".join(c for c in name if c.isalnum() or c in ('_', '-')).rstrip()
        if not safe_name:
            logger.error("Invalid template name provided.")
            return False

        filepath = os.path.join(self.template_dir, f"{safe_name}.json")
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(template_data, f, indent=4)
            # Reload templates after saving
            self.templates = self._load_templates()
            logger.info(f"Saved template '{safe_name}' to {filepath}")
            return True
        except Exception as e:
            logger.error(f"Error saving template file {filepath}: {e}")
            return False


template_manager = TemplateManager()
