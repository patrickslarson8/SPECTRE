import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
DATABASE_PATH = os.path.join(BASE_DIR, "..", "app.db")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

# WebSocket/Collaboration settings
CHAR_UPDATE_THRESHOLD = 20
TIME_UPDATE_THRESHOLD_MS = 10000
HEARTBEAT_INTERVAL_S = 5