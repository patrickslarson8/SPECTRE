import json
import tornado.web
import logging
from server.db_manager import SessionLocal
import server.document_service as document_service
from server.template_manager import template_manager
from server.block_utils import render_document_html

logger = logging.getLogger(__name__)


class BaseHandler(tornado.web.RequestHandler):
    def set_default_headers(self):
        self.set_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.set_header("Pragma", "no-cache")
        self.set_header("Expires", "0")
        self.set_header("Content-Type", "application/json")

    def write_error(self, status_code, **kwargs):
        self.set_header('Content-Type', 'application/json')
        response = {'error': {'code': status_code, 'message': self._reason}}
        if "exc_info" in kwargs:
            logger.error("API Error", exc_info=kwargs["exc_info"])
        self.finish(json.dumps(response))


class ListDocumentsHandler(BaseHandler):
    def get(self):
        db = SessionLocal()
        try:
            docs = document_service.list_documents(db)
            response_docs = [{
                "document_id": doc.doc_id,
                "title": doc.title,
                "last_modified": doc.last_modified.isoformat() if doc.last_modified else None
            } for doc in docs]
            self.write({"documents": response_docs})
        finally:
            db.close()


class CreateDocumentHandler(BaseHandler):
    def post(self):
        try:
            data = json.loads(self.request.body.decode("utf-8"))
            title = data.get("title")
            template_name = data.get("template_name")
        except (json.JSONDecodeError, TypeError):
            raise tornado.web.HTTPError(400, reason="Invalid JSON body")

        if not title or not template_name:
            raise tornado.web.HTTPError(400, reason="Title and template_name are required")

        db = SessionLocal()
        try:
            changed_by = self.get_current_user()
            new_doc = document_service.create_document_from_template(db, title, template_name, changed_by)
            if not new_doc:
                raise tornado.web.HTTPError(400,
                                            reason=f"Template '{template_name}' not found or error creating document.")

            response = {
                "document_id": new_doc.doc_id,
                "title": new_doc.title,
                "last_modified": new_doc.last_modified.isoformat() if new_doc.last_modified else None
            }
            self.write(json.dumps(response))
        except Exception as e:
            logger.exception(f"Error creating document: {e}")
            raise tornado.web.HTTPError(500, reason="Internal server error creating document")
        finally:
            db.close()


class GetDocumentHandler(BaseHandler):
    def get(self, document_id_str):
        try:
            document_id = int(document_id_str)
        except ValueError:
            raise tornado.web.HTTPError(400, reason="Invalid document ID format")

        db = SessionLocal()
        try:
            doc = document_service.get_document(db, document_id)
            if not doc:
                raise tornado.web.HTTPError(404, reason="Document not found")

            if not doc.versions:
                logger.warning(f"Document {document_id} found but has no versions.")
                rendered_html = ""
                last_mod = doc.last_modified
            else:
                latest_version = doc.versions[-1]
                rendered_html = render_document_html(latest_version.blocks)
                last_mod = latest_version.timestamp

            response = {
                "document_id": doc.doc_id,
                "title": doc.title,
                "content": rendered_html,
                "last_modified": last_mod.isoformat() if last_mod else None
            }
            self.write(json.dumps(response))
        except tornado.web.HTTPError:
            raise
        except Exception as e:
            logger.exception(f"Error getting document {document_id}: {e}")
            raise tornado.web.HTTPError(500, reason="Internal server error fetching document")
        finally:
            db.close()


class ListTemplatesHandler(BaseHandler):
    def get(self):
        try:
            template_names = template_manager.list_templates()
            self.write({"templates": template_names})
        except Exception as e:
            logger.exception("Error listing templates")
            raise tornado.web.HTTPError(500, "Error listing templates")


class SaveAsTemplateHandler(BaseHandler):
    def post(self, document_id_str):
        try:
            document_id = int(document_id_str)
        except ValueError:
            raise tornado.web.HTTPError(400, reason="Invalid document ID format")

        try:
            data = json.loads(self.request.body.decode("utf-8"))
            template_name = data.get("template_name")
        except (json.JSONDecodeError, TypeError):
            raise tornado.web.HTTPError(400, reason="Invalid JSON body")

        if not template_name:
            raise tornado.web.HTTPError(400, reason="Template name is required")

        db = SessionLocal()
        try:
            success = document_service.save_document_as_template(db, document_id, template_name)
            if success:
                self.write({"message": f"Template '{template_name}' saved successfully."})
            else:
                raise tornado.web.HTTPError(500, reason="Failed to save template")
        except Exception as e:
            logger.exception(f"Error saving document {document_id} as template '{template_name}': {e}")
            raise tornado.web.HTTPError(500, reason="Internal server error saving template")
        finally:
            db.close()


class GetVersionHistoryHandler(BaseHandler):
    def get(self, document_id_str):
        try:
            document_id = int(document_id_str)
        except ValueError:
            raise tornado.web.HTTPError(400, reason="Invalid document ID format")

        db = SessionLocal()
        try:
            versions_data = document_service.get_document_versions(db, document_id)
            if versions_data is None:
                raise tornado.web.HTTPError(404, reason="Document not found")

            self.write(json.dumps({
                "document_id": document_id,
                "versions": versions_data
            }))
        except tornado.web.HTTPError:
            raise
        except Exception as e:
            logger.exception(f"Error getting version history for doc {document_id}: {e}")
            raise tornado.web.HTTPError(500, reason="Internal server error fetching version history")
        finally:
            db.close()


class GetVersionHandler(BaseHandler):
    def get(self, document_id_str, version_id_str):
        try:
            document_id = int(document_id_str)
            version_id = int(version_id_str)
        except ValueError:
            raise tornado.web.HTTPError(400, reason="Invalid document or version ID format")

        db = SessionLocal()
        try:
            version = document_service.get_specific_version(db, document_id, version_id)
            if not version:
                raise tornado.web.HTTPError(404, reason="Document or version not found")

            doc = document_service.get_document(db, document_id)
            rendered_html = render_document_html(version.blocks)

            response = {
                "document_id": document_id,
                "document_title": doc.title if doc else "Unknown",
                "version_id": version.version_id,
                "timestamp": version.timestamp.isoformat(),
                "changed_by": version.changed_by or "Unknown",
                "content": rendered_html
            }
            self.write(json.dumps(response))
        except tornado.web.HTTPError:
            raise
        except Exception as e:
            logger.exception(f"Error getting version {version_id} for doc {document_id}: {e}")
            raise tornado.web.HTTPError(500, reason="Internal server error fetching version")
        finally:
            db.close()


class GetLocksHandler(BaseHandler):
    def get(self):
        doc_id_str = self.get_argument("document_id", None)
        if not doc_id_str:
            raise tornado.web.HTTPError(400, reason="Missing document_id query parameter")

        from server.websocket_handler import CollaborationWebSocket
        locks_data = CollaborationWebSocket.get_locks_for_document(doc_id_str)

        self.write(json.dumps({
            "document_id": doc_id_str,
            "locks": locks_data
        }))


class GetTableContentHandler(BaseHandler):
    def get(self, document_id_str, table_attr_id):
        try:
            document_id = int(document_id_str)
        except ValueError:
            raise tornado.web.HTTPError(400, reason="Invalid document ID format")

        if not table_attr_id:
            raise tornado.web.HTTPError(400, reason="Missing table attribute ID")

        db = SessionLocal()
        try:
            content_data = document_service.get_table_content_api(db, document_id, table_attr_id)
            if content_data is None:
                raise tornado.web.HTTPError(404, reason="Document or table not found")

            self.write(json.dumps({
                "document_id": document_id,
                "table_id": table_attr_id,
                "content": content_data
            }))
        except tornado.web.HTTPError:
            raise
        except Exception as e:
            logger.exception(f"Error getting content for table {table_attr_id} in doc {document_id}: {e}")
            raise tornado.web.HTTPError(500, reason="Internal server error fetching table content")
        finally:
            db.close()
