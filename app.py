import tornado.ioloop
import tornado.web
import logging
import os
from tornado.web import StaticFileHandler, RedirectHandler

from server.api_handlers import (
    ListDocumentsHandler, CreateDocumentHandler, GetDocumentHandler,
    GetVersionHistoryHandler, GetVersionHandler, GetLocksHandler,
    ListTemplatesHandler, SaveAsTemplateHandler, GetTableContentHandler
)
from server.websocket_handler import CollaborationWebSocket
from server.db_manager import init_database, engine, Base
import server.mdns as mdns

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class CachelessStaticFileHandler(StaticFileHandler):
    def set_extra_headers(self, path):
        self.set_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')


def make_app():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.join(base_dir, "static")
    logger.info(f"Serving static files from: {static_dir}")

    settings = {
        "debug": True,
        "static_path": static_dir,
        "static_url_prefix": "/static/",
    }

    handlers = [
        # Static files and main page
        (r"/", RedirectHandler, {"url": "/static/index.html"}),
        (r"/static/(.*)", CachelessStaticFileHandler, {"path": static_dir}),

        # API Endpoints
        (r"/api/documents", ListDocumentsHandler),
        (r"/api/documents/create", CreateDocumentHandler),
        (r"/api/documents/(\d+)", GetDocumentHandler),
        (r"/api/documents/(\d+)/save_template", SaveAsTemplateHandler),
        (r"/api/documents/(\d+)/tables/([a-zA-Z0-9_-]+)/content", GetTableContentHandler),

        (r"/api/versions/(\d+)", GetVersionHistoryHandler),
        (r"/api/versions/(\d+)/(\d+)", GetVersionHandler),

        (r"/api/locks", GetLocksHandler),
        (r"/api/templates", ListTemplatesHandler),

        # WebSocket
        (r"/websocket", CollaborationWebSocket),
    ]
    return tornado.web.Application(handlers, **settings)


def main():
    responder = None
    try:
        logger.info("Initializing database...")
        init_database()

        app = make_app()
        port = 8888
        app.listen(port)
        logger.info(f"Server started on http://localhost:{port}")

        logger.info("Starting mDNS advertisement...")
        responder = mdns.start_mdns_advertisement()

        logger.info("Starting IOLoop...")
        tornado.ioloop.IOLoop.current().start()

    except Exception as e:
        logger.exception(f"Server failed to start: {e}")
    finally:
        if responder:
            logger.info("Stopping mDNS advertisement...")
            responder.stop()
        logger.info("Stopping IOLoop...")
        tornado.ioloop.IOLoop.current().stop()
        logger.info("Server stopped.")


if __name__ == "__main__":
    main()
