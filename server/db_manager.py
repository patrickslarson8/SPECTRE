import uuid
from datetime import datetime, timezone
from sqlalchemy import create_engine, Column, Integer, String, DateTime, ForeignKey, Table, Text, JSON, event
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.ext.declarative import declarative_base
from server.config import SQLALCHEMY_DATABASE_URL

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args={"check_same_thread": False}
)


@event.listens_for(engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.close()

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

version_blocks_table = Table(
    "version_blocks",
    Base.metadata,
    Column("version_id", ForeignKey("document_versions.version_id"), primary_key=True),
    Column("block_id", ForeignKey("document_blocks.block_id"), primary_key=True)
)


class Document(Base):
    __tablename__ = "documents"
    doc_id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    last_modified = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                           onupdate=lambda: datetime.now(timezone.utc))

    versions = relationship(
        "DocumentVersion",
        back_populates="document",
        cascade="all, delete-orphan",
        order_by="DocumentVersion.timestamp"
    )

    def __repr__(self):
        return f"<Document(id={self.doc_id}, title={self.title})>"


class DocumentVersion(Base):
    __tablename__ = "document_versions"
    version_id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    changed_by = Column(String, nullable=True)  # User who made the change

    document_id = Column(Integer, ForeignKey("documents.doc_id"), nullable=False)
    document = relationship("Document", back_populates="versions")

    # Link to blocks via the association table
    blocks = relationship(
        "DocumentBlock",
        secondary=version_blocks_table,
        back_populates="versions",
        # Order is important for rendering, managed in service/rendering layer
    )

    def __repr__(self):
        return f"<DocumentVersion(id={self.version_id}, doc={self.document_id}, changed_by={self.changed_by})>"


class DocumentBlock(Base):
    __tablename__ = "document_blocks"
    block_id = Column(Integer, primary_key=True, index=True)
    block_attribute_id = Column(String, nullable=False, default=lambda: str(uuid.uuid4()))
    block_type = Column(String, nullable=False)
    content = Column(Text, nullable=True)
    style_classes = Column(String, nullable=True)
    order = Column(Integer, nullable=False, default=0)
    level = Column(Integer, nullable=True)
    alt_text = Column(String, nullable=True)

    # Table-specific attributes
    parent_block_id = Column(String, nullable=True)
    row_index = Column(Integer, nullable=True)
    col_index = Column(Integer, nullable=True)

    # Relationship back to versions (many-to-many)
    versions = relationship(
        "DocumentVersion",
        secondary=version_blocks_table,
        back_populates="blocks"
    )

    def __repr__(self):
        return (
            f"<DocumentBlock(id={self.block_id}, attr_id={self.block_attribute_id}, type={self.block_type}, order={self.order}, "
            f"parent={self.parent_block_id}, row={self.row_index}, col={self.col_index})>"
        )


def init_database():
    Base.metadata.create_all(bind=engine)
