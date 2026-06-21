from __future__ import annotations

from datetime import datetime, timezone

from flask_login import UserMixin
from werkzeug.security import check_password_hash, generate_password_hash

from app.extensions import db


def utcnow():
    return datetime.now(timezone.utc)


role_permissions = db.Table(
    "role_permissions",
    db.Column("role_id", db.Integer, db.ForeignKey("roles.id"), primary_key=True),
    db.Column("permission_id", db.Integer, db.ForeignKey("permissions.id"), primary_key=True),
)

user_roles = db.Table(
    "user_roles",
    db.Column("user_id", db.Integer, db.ForeignKey("users.id"), primary_key=True),
    db.Column("role_id", db.Integer, db.ForeignKey("roles.id"), primary_key=True),
)

user_groups = db.Table(
    "user_groups",
    db.Column("user_id", db.Integer, db.ForeignKey("users.id"), primary_key=True),
    db.Column("group_id", db.Integer, db.ForeignKey("groups.id"), primary_key=True),
)

group_roles = db.Table(
    "group_roles",
    db.Column("group_id", db.Integer, db.ForeignKey("groups.id"), primary_key=True),
    db.Column("role_id", db.Integer, db.ForeignKey("roles.id"), primary_key=True),
)


class Permission(db.Model):
    __tablename__ = "permissions"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False, index=True)


class Role(db.Model):
    __tablename__ = "roles"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), unique=True, nullable=False)
    permissions = db.relationship("Permission", secondary=role_permissions, backref="roles")


class Group(db.Model):
    """Organizational group: members inherit all roles attached to the group."""

    __tablename__ = "groups"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), unique=True, nullable=False, index=True)
    description = db.Column(db.String(512), nullable=True)
    users = db.relationship("User", secondary=user_groups, back_populates="groups")
    roles = db.relationship("Role", secondary=group_roles, backref="groups_attached")


class User(UserMixin, db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    full_name = db.Column(db.String(255), nullable=True)
    email = db.Column(db.String(255), nullable=True, index=True)
    phone = db.Column(db.String(64), nullable=True)
    last_seen_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    # ABAC: arbitrary attributes (department, clearance level, etc.)
    attributes = db.Column(db.JSON, nullable=False, default=dict)
    roles = db.relationship("Role", secondary=user_roles, backref="users")
    groups = db.relationship("Group", secondary=user_groups, back_populates="users")

    def set_password(self, password: str) -> None:
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)


class ContractorCompany(db.Model):
    """Shared contractor organisation (ABN, reps, insurance) linked from multiple users."""

    __tablename__ = "contractor_companies"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False)
    abn = db.Column(db.String(32), nullable=True)
    acn = db.Column(db.String(32), nullable=True)
    company_rep = db.Column(db.String(255), nullable=True)
    # {"pi_pl_insurance": {"original_name": "...", "stored": "uuid.pdf"}, "workcover": {...}}
    documents = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class FileNode(db.Model):
    __tablename__ = "file_nodes"
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(512), nullable=False)
    is_folder = db.Column(db.Boolean, nullable=False, default=False)
    parent_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=True, index=True)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    # ABAC on resource: classification, project tags, etc.
    attributes = db.Column(db.JSON, nullable=False, default=dict)
    # File tracking: logical path cache for search/display
    path_key = db.Column(db.String(2048), nullable=True, index=True)
    # Recycle Bin (soft delete)
    deleted_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    deleted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    original_parent_id = db.Column(db.Integer, nullable=True, index=True)
    # OnlyOffice co-editing session key; cleared when no edit sessions remain.
    onlyoffice_doc_key = db.Column(db.String(128), nullable=True)

    parent = db.relationship("FileNode", remote_side=[id], backref=db.backref("children", lazy="dynamic"))
    versions = db.relationship("FileVersion", back_populates="file_node", lazy="dynamic")
    deleted_by = db.relationship("User", foreign_keys=[deleted_by_id])

    def display_path(self) -> str:
        parts = []
        node: FileNode | None = self
        while node:
            parts.append(node.name)
            node = node.parent
        return "/" + "/".join(reversed(parts))


class FileNodeLock(db.Model):
    """Exclusive edit lock on a file (Documents). One lock per file."""

    __tablename__ = "file_node_locks"
    __table_args__ = (db.UniqueConstraint("file_node_id", name="uq_file_node_lock_node"),)

    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    locked_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    locked_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    file_node = db.relationship("FileNode", backref=db.backref("edit_lock", uselist=False))
    locked_by = db.relationship("User", foreign_keys=[locked_by_id])


class FileNodeEditSession(db.Model):
    """Live indicator that a user currently has a document open for editing."""

    __tablename__ = "file_node_edit_sessions"
    __table_args__ = (db.UniqueConstraint("file_node_id", "user_id", name="uq_file_node_edit_session"),)

    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    last_seen_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    file_node = db.relationship("FileNode", backref=db.backref("edit_sessions", lazy="dynamic"))
    user = db.relationship("User", foreign_keys=[user_id])


class FileVersion(db.Model):
    __tablename__ = "file_versions"
    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    version_number = db.Column(db.Integer, nullable=False)
    storage_relpath = db.Column(db.String(1024), nullable=False)
    size_bytes = db.Column(db.BigInteger, nullable=False)
    sha256 = db.Column(db.String(64), nullable=False)
    mime_type = db.Column(db.String(256), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    is_current = db.Column(db.Boolean, default=True, nullable=False)

    file_node = db.relationship("FileNode", back_populates="versions")
    created_by = db.relationship("User")


class NodeUserShare(db.Model):
    """Grant another system user access to a specific file or folder (and descendants)."""

    __tablename__ = "node_user_shares"
    __table_args__ = (db.UniqueConstraint("file_node_id", "shared_with_user_id", name="uq_node_user_share"),)

    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    shared_with_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    permission = db.Column(db.String(16), nullable=False, default="read")  # read | write
    granted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    file_node = db.relationship("FileNode", backref=db.backref("user_shares", lazy="dynamic"))
    shared_with = db.relationship("User", foreign_keys=[shared_with_user_id])
    granted_by = db.relationship("User", foreign_keys=[granted_by_id])


class NodeGroupShare(db.Model):
    """Grant all current and future members of a group access to a file/folder (and descendants)."""

    __tablename__ = "node_group_shares"
    __table_args__ = (db.UniqueConstraint("file_node_id", "group_id", name="uq_node_group_share"),)

    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    group_id = db.Column(db.Integer, db.ForeignKey("groups.id"), nullable=False, index=True)
    permission = db.Column(db.String(16), nullable=False, default="read")  # read | write
    granted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    file_node = db.relationship("FileNode", backref=db.backref("group_shares", lazy="dynamic"))
    group = db.relationship("Group")
    granted_by = db.relationship("User", foreign_keys=[granted_by_id])


class NodeRoleShare(db.Model):
    """Grant all users assigned a role access to a file/folder (and descendants)."""

    __tablename__ = "node_role_shares"
    __table_args__ = (db.UniqueConstraint("file_node_id", "role_id", name="uq_node_role_share"),)

    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    role_id = db.Column(db.Integer, db.ForeignKey("roles.id"), nullable=False, index=True)
    permission = db.Column(db.String(16), nullable=False, default="read")  # read | write
    granted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    file_node = db.relationship("FileNode", backref=db.backref("role_shares", lazy="dynamic"))
    role = db.relationship("Role")
    granted_by = db.relationship("User", foreign_keys=[granted_by_id])


class FileShare(db.Model):
    __tablename__ = "file_shares"
    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(64), unique=True, nullable=False, index=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    permission = db.Column(db.String(32), nullable=False, default="read")  # read | write
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    expires_at = db.Column(db.DateTime(timezone=True), nullable=True)
    password_hash = db.Column(db.String(256), nullable=True)
    max_downloads = db.Column(db.Integer, nullable=True)
    download_count = db.Column(db.Integer, default=0, nullable=False)

    file_node = db.relationship("FileNode")
    created_by = db.relationship("User")


class BlogPost(db.Model):
    __tablename__ = "blog_posts"

    id = db.Column(db.Integer, primary_key=True)
    slug = db.Column(db.String(160), unique=True, nullable=False, index=True)
    title = db.Column(db.String(255), nullable=False)
    excerpt = db.Column(db.String(1000), nullable=True)
    body = db.Column(db.Text, nullable=True)  # stored as HTML from the editor
    category = db.Column(db.String(64), nullable=True, index=True)
    visibility = db.Column(db.String(32), nullable=False, default="all")  # all | managers | it | custom
    status = db.Column(db.String(16), nullable=False, default="draft")  # draft | published
    cover_image_url = db.Column(db.String(1024), nullable=True)
    allow_comments = db.Column(db.Boolean, nullable=False, default=False)
    notify_on_publish = db.Column(db.Boolean, nullable=False, default=False)
    published_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)

    created_by = db.relationship("User")
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    max_downloads = db.Column(db.Integer, nullable=True)
    download_count = db.Column(db.Integer, default=0, nullable=False)


class WikiPage(db.Model):
    """Intranet wiki article: optional rich HTML (``content_html``) or Markdown (``body_md``)."""

    __tablename__ = "wiki_pages"

    id = db.Column(db.Integer, primary_key=True)
    slug = db.Column(db.String(160), unique=True, nullable=False, index=True)
    title = db.Column(db.String(255), nullable=False)
    body_md = db.Column(db.Text, nullable=False, default="")
    # When set, page is shown/edited as sanitized HTML (Quill); otherwise Markdown from ``body_md``.
    content_html = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    updated_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)

    created_by = db.relationship("User", foreign_keys=[created_by_id])
    updated_by = db.relationship("User", foreign_keys=[updated_by_id])


class WikiPageWatch(db.Model):
    """Server-backed watchlist entries for the wiki sidebar."""

    __tablename__ = "wiki_page_watches"
    __table_args__ = (db.UniqueConstraint("user_id", "wiki_page_id", name="uq_wiki_page_watch_user_page"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    wiki_page_id = db.Column(db.Integer, db.ForeignKey("wiki_pages.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    user = db.relationship("User")
    page = db.relationship("WikiPage")


class WikiPageVote(db.Model):
    """Helpful / not helpful feedback (one row per user per page)."""

    __tablename__ = "wiki_page_votes"
    __table_args__ = (db.UniqueConstraint("user_id", "wiki_page_id", name="uq_wiki_page_vote_user_page"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    wiki_page_id = db.Column(db.Integer, db.ForeignKey("wiki_pages.id"), nullable=False, index=True)
    value = db.Column(db.SmallInteger, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    user = db.relationship("User")
    page = db.relationship("WikiPage")


class WikiPageNote(db.Model):
    """Comments / notes on a wiki page (any reader with wiki.read may post)."""

    __tablename__ = "wiki_page_notes"

    id = db.Column(db.Integer, primary_key=True)
    wiki_page_id = db.Column(db.Integer, db.ForeignKey("wiki_pages.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    body_html = db.Column(db.Text, nullable=False, default="")
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    user = db.relationship("User")
    page = db.relationship("WikiPage", backref=db.backref("notes", lazy="dynamic"))


class ChessGame(db.Model):
    """Async two-player chess (correspondence-style, no clock limit)."""

    __tablename__ = "chess_games"

    id = db.Column(db.Integer, primary_key=True)
    public_id = db.Column(db.String(32), unique=True, nullable=False, index=True)
    creator_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    white_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    black_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    status = db.Column(db.String(20), nullable=False, default="waiting", index=True)
    fen = db.Column(db.Text, nullable=False, default="")
    turn = db.Column(db.String(1), nullable=False, default="w")
    result = db.Column(db.String(8), nullable=True)
    end_reason = db.Column(db.String(32), nullable=True)
    white_total_ms = db.Column(db.BigInteger, nullable=False, default=0)
    black_total_ms = db.Column(db.BigInteger, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    started_at = db.Column(db.DateTime(timezone=True), nullable=True)
    last_move_at = db.Column(db.DateTime(timezone=True), nullable=True)
    finished_at = db.Column(db.DateTime(timezone=True), nullable=True)

    creator = db.relationship("User", foreign_keys=[creator_id])
    white_player = db.relationship("User", foreign_keys=[white_user_id])
    black_player = db.relationship("User", foreign_keys=[black_user_id])
    moves = db.relationship("ChessMove", back_populates="game", lazy="dynamic")


class ChessMove(db.Model):
    __tablename__ = "chess_moves"

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(db.Integer, db.ForeignKey("chess_games.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    move_uci = db.Column(db.String(8), nullable=False)
    move_san = db.Column(db.String(16), nullable=False)
    ply = db.Column(db.Integer, nullable=False)
    think_ms = db.Column(db.BigInteger, nullable=False, default=0)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)

    game = db.relationship("ChessGame", back_populates="moves")
    player = db.relationship("User")


class ChessChatMessage(db.Model):
    __tablename__ = "chess_chat_messages"

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(db.Integer, db.ForeignKey("chess_games.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    text = db.Column(db.String(2000), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    game = db.relationship("ChessGame", backref=db.backref("chat_messages", lazy="dynamic"))
    author = db.relationship("User")


class ChessGameChatRead(db.Model):
    """Per-user read cursor for in-game chess chat (nav unread badge)."""

    __tablename__ = "chess_game_chat_reads"
    __table_args__ = (db.UniqueConstraint("game_id", "user_id", name="uq_chess_game_chat_read"),)

    id = db.Column(db.Integer, primary_key=True)
    game_id = db.Column(db.Integer, db.ForeignKey("chess_games.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    last_read_message_id = db.Column(db.Integer, nullable=False, default=0)

    game = db.relationship("ChessGame")
    user = db.relationship("User")


class SkyControlScore(db.Model):
    """Sky Control (intranet flight game) run score for the leaderboard."""

    __tablename__ = "sky_control_scores"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    score = db.Column(db.Integer, nullable=False, index=True)
    landed = db.Column(db.Integer, nullable=False, default=0)
    wave = db.Column(db.Integer, nullable=False, default=1)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    user = db.relationship("User")


class CalendarEvent(db.Model):
    __tablename__ = "calendar_events"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    date = db.Column(db.String(10), nullable=False, index=True)  # YYYY-MM-DD (local)
    all_day = db.Column(db.Boolean, nullable=False, default=False)
    start = db.Column(db.String(5), nullable=True)  # HH:MM (24h)
    end = db.Column(db.String(5), nullable=True)  # HH:MM (24h)
    location = db.Column(db.String(255), nullable=True)
    notes = db.Column(db.String(2000), nullable=True)
    # Sharing: company calendar by default; set is_private for creator-only visibility.
    is_private = db.Column(db.Boolean, nullable=False, default=False)
    shared_user_ids = db.Column(db.JSON, nullable=False, default=list)
    shared_group_ids = db.Column(db.JSON, nullable=False, default=list)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    created_by = db.relationship("User")


class KanbanBoard(db.Model):
    __tablename__ = "kanban_boards"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False, default="KanBan")
    subtitle = db.Column(db.String(240), nullable=True)
    shared_users = db.Column(db.JSON, nullable=False, default=list)
    shared_groups = db.Column(db.JSON, nullable=False, default=list)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    created_by = db.relationship("User")
    columns = db.relationship(
        "KanbanColumn",
        back_populates="board",
        cascade="all, delete-orphan",
        order_by="KanbanColumn.position",
    )
    activity = db.relationship(
        "KanbanBoardActivity",
        back_populates="board",
        cascade="all, delete-orphan",
        order_by="KanbanBoardActivity.created_at.desc()",
    )


class KanbanColumn(db.Model):
    __tablename__ = "kanban_columns"

    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("kanban_boards.id"), nullable=False, index=True)
    title = db.Column(db.String(120), nullable=False)
    position = db.Column(db.Integer, nullable=False, default=0, index=True)
    color_token = db.Column(db.String(32), nullable=True)

    board = db.relationship("KanbanBoard", back_populates="columns")
    cards = db.relationship(
        "KanbanCard",
        back_populates="column",
        cascade="all, delete-orphan",
        order_by="KanbanCard.position",
    )


class KanbanCard(db.Model):
    __tablename__ = "kanban_cards"

    id = db.Column(db.Integer, primary_key=True)
    column_id = db.Column(db.Integer, db.ForeignKey("kanban_columns.id"), nullable=False, index=True)
    title = db.Column(db.String(255), nullable=False)
    body = db.Column(db.String(4000), nullable=True)
    body_html = db.Column(db.Text, nullable=True)
    position = db.Column(db.Integer, nullable=False, default=0, index=True)
    assignee_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    priority = db.Column(db.String(16), nullable=False, default="medium", index=True)
    due_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    deleted_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    deleted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    column = db.relationship("KanbanColumn", back_populates="cards")
    assignee = db.relationship("User", foreign_keys=[assignee_id])
    created_by = db.relationship("User", foreign_keys=[created_by_id])
    deleted_by = db.relationship("User", foreign_keys=[deleted_by_id])
    comments = db.relationship(
        "KanbanCardComment",
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="KanbanCardComment.created_at.desc()",
    )
    attachments = db.relationship(
        "KanbanCardAttachment",
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="KanbanCardAttachment.created_at.desc()",
    )
    activity = db.relationship(
        "KanbanCardActivity",
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="KanbanCardActivity.created_at.desc()",
    )
    card_assignees = db.relationship(
        "KanbanCardAssignee",
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="KanbanCardAssignee.id.asc()",
    )
    notes = db.relationship(
        "KanbanCardNote",
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="KanbanCardNote.created_at.desc()",
    )


class KanbanCardAssignee(db.Model):
    __tablename__ = "kanban_card_assignees"
    __table_args__ = (db.UniqueConstraint("card_id", "user_id", name="uq_kanban_card_assignee"),)

    id = db.Column(db.Integer, primary_key=True)
    card_id = db.Column(db.Integer, db.ForeignKey("kanban_cards.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    card = db.relationship("KanbanCard", back_populates="card_assignees")
    user = db.relationship("User")


class KanbanCardComment(db.Model):
    __tablename__ = "kanban_card_comments"

    id = db.Column(db.Integer, primary_key=True)
    card_id = db.Column(db.Integer, db.ForeignKey("kanban_cards.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    body = db.Column(db.String(4000), nullable=False, default="")
    body_html = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    card = db.relationship("KanbanCard", back_populates="comments")
    user = db.relationship("User")


class KanbanCardNote(db.Model):
    __tablename__ = "kanban_card_notes"

    id = db.Column(db.Integer, primary_key=True)
    card_id = db.Column(db.Integer, db.ForeignKey("kanban_cards.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    body = db.Column(db.String(4000), nullable=False, default="")
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=True)
    updated_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    muted_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    muted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    card = db.relationship("KanbanCard", back_populates="notes")
    user = db.relationship("User", foreign_keys=[user_id])
    updated_by = db.relationship("User", foreign_keys=[updated_by_id])
    muted_by = db.relationship("User", foreign_keys=[muted_by_id])


class KanbanCardAttachment(db.Model):
    __tablename__ = "kanban_card_attachments"

    id = db.Column(db.Integer, primary_key=True)
    card_id = db.Column(db.Integer, db.ForeignKey("kanban_cards.id"), nullable=False, index=True)
    filename = db.Column(db.String(255), nullable=False)
    storage_relpath = db.Column(db.String(512), nullable=False)
    size = db.Column(db.Integer, nullable=False, default=0)
    mime_type = db.Column(db.String(128), nullable=True)
    uploaded_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    card = db.relationship("KanbanCard", back_populates="attachments")
    uploaded_by = db.relationship("User")


class KanbanCardActivity(db.Model):
    __tablename__ = "kanban_card_activity"

    id = db.Column(db.Integer, primary_key=True)
    card_id = db.Column(db.Integer, db.ForeignKey("kanban_cards.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    action = db.Column(db.String(64), nullable=False)
    details = db.Column(db.JSON, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    card = db.relationship("KanbanCard", back_populates="activity")
    user = db.relationship("User")


class KanbanBoardActivity(db.Model):
    __tablename__ = "kanban_board_activity"

    id = db.Column(db.Integer, primary_key=True)
    board_id = db.Column(db.Integer, db.ForeignKey("kanban_boards.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    card_id = db.Column(db.Integer, db.ForeignKey("kanban_cards.id"), nullable=True, index=True)
    action = db.Column(db.String(64), nullable=False, default="")
    details = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    board = db.relationship("KanbanBoard", back_populates="activity")
    user = db.relationship("User")
    card = db.relationship("KanbanCard")


class AuditLog(db.Model):
    __tablename__ = "audit_logs"
    id = db.Column(db.Integer, primary_key=True)
    timestamp = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    username_snapshot = db.Column(db.String(80), nullable=True)
    action = db.Column(db.String(64), nullable=False, index=True)
    resource_type = db.Column(db.String(64), nullable=True, index=True)
    resource_id = db.Column(db.String(64), nullable=True)
    ip_address = db.Column(db.String(45), nullable=True)
    user_agent = db.Column(db.String(512), nullable=True)
    success = db.Column(db.Boolean, nullable=False, default=True)
    details = db.Column(db.JSON, nullable=True)

    user = db.relationship("User")


class FileComment(db.Model):
    __tablename__ = "file_comments"
    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    body = db.Column(db.String(4000), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    file_node = db.relationship("FileNode", backref=db.backref("comments", lazy="dynamic"))
    user = db.relationship("User")


class AppSetting(db.Model):
    __tablename__ = "app_settings"
    key = db.Column(db.String(128), primary_key=True)
    value = db.Column(db.JSON, nullable=True)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class SecurityClearanceRecord(db.Model):
    """One row per clearance profile (replaces JSON blob in app_settings)."""

    __tablename__ = "security_clearance_records"
    __table_args__ = (db.UniqueConstraint("csid", name="uq_sc2_record_csid"),)

    id = db.Column(db.Integer, primary_key=True)
    csid = db.Column(db.String(120), nullable=False, index=True)
    created_at = db.Column(db.BigInteger, nullable=False, default=0)
    given = db.Column(db.String(200), nullable=False, default="")
    family = db.Column(db.String(200), nullable=False, default="")
    agent_request_from = db.Column(db.String(120), nullable=False, default="")
    level = db.Column(db.String(40), nullable=False, default="")
    dob = db.Column(db.String(32), nullable=False, default="")
    email = db.Column(db.String(240), nullable=False, default="")
    phone = db.Column(db.String(80), nullable=False, default="")
    revalidation = db.Column(db.String(32), nullable=False, default="")
    grant_date = db.Column(db.String(32), nullable=False, default="")
    expiry = db.Column(db.String(32), nullable=False, default="")
    status = db.Column(db.String(40), nullable=False, default="Active")
    archived = db.Column(db.Boolean, nullable=False, default=False)
    notes = db.Column(db.JSON, nullable=False, default=list)
    signed_pdfs = db.Column(db.JSON, nullable=False, default=list)

    def to_api_dict(self) -> dict:
        return {
            "created_at": int(self.created_at or 0) or 0,
            "csid": self.csid or "",
            "given": self.given or "",
            "family": self.family or "",
            "agent_request_from": self.agent_request_from or "",
            "level": self.level or "",
            "dob": self.dob or "",
            "email": self.email or "",
            "phone": self.phone or "",
            "revalidation": self.revalidation or "",
            "grant_date": self.grant_date or "",
            "expiry": self.expiry or "",
            "status": self.status or "Active",
            "archived": bool(self.archived),
            "notes": self.notes if isinstance(self.notes, list) else [],
            "signed_pdfs": self.signed_pdfs if isinstance(self.signed_pdfs, list) else [],
        }

    @classmethod
    def from_api_dict(cls, data: dict) -> SecurityClearanceRecord | None:
        csid = str(data.get("csid") or "").strip()[:120]
        if not csid:
            return None
        notes = data.get("notes")
        pdfs = data.get("signed_pdfs")
        return cls(
            csid=csid,
            created_at=int(data.get("created_at") or 0) or 0,
            given=str(data.get("given") or "")[:200],
            family=str(data.get("family") or "")[:200],
            agent_request_from=str(data.get("agent_request_from") or "")[:120],
            level=str(data.get("level") or "")[:40],
            dob=str(data.get("dob") or "")[:32],
            email=str(data.get("email") or "")[:240],
            phone=str(data.get("phone") or "")[:80],
            revalidation=str(data.get("revalidation") or "")[:32],
            grant_date=str(data.get("grant_date") or "")[:32],
            expiry=str(data.get("expiry") or "")[:32],
            status=str(data.get("status") or "Active")[:40],
            archived=bool(data.get("archived")),
            notes=notes if isinstance(notes, list) else [],
            signed_pdfs=pdfs if isinstance(pdfs, list) else [],
        )

    def apply_api_dict(self, data: dict) -> None:
        """Update fields from a normalized API dict (keeps id/csid)."""
        self.given = str(data.get("given") or "")[:200]
        self.family = str(data.get("family") or "")[:200]
        self.agent_request_from = str(data.get("agent_request_from") or "")[:120]
        self.level = str(data.get("level") or "")[:40]
        self.dob = str(data.get("dob") or "")[:32]
        self.email = str(data.get("email") or "")[:240]
        self.phone = str(data.get("phone") or "")[:80]
        self.revalidation = str(data.get("revalidation") or "")[:32]
        self.grant_date = str(data.get("grant_date") or "")[:32]
        self.expiry = str(data.get("expiry") or "")[:32]
        self.status = str(data.get("status") or "Active")[:40]
        self.archived = bool(data.get("archived"))
        if isinstance(data.get("notes"), list):
            self.notes = data["notes"]
        if isinstance(data.get("signed_pdfs"), list):
            self.signed_pdfs = data["signed_pdfs"]

    def apply_import_dict(self, data: dict) -> None:
        """Spreadsheet import merge — only overwrite non-empty scalar fields."""
        for key, maxlen in (
            ("given", 200),
            ("family", 200),
            ("agent_request_from", 120),
            ("level", 40),
            ("dob", 32),
            ("email", 240),
            ("phone", 80),
            ("revalidation", 32),
            ("grant_date", 32),
            ("expiry", 32),
            ("status", 40),
        ):
            val = data.get(key)
            if val is not None and str(val).strip() != "":
                setattr(self, key, str(val)[:maxlen])
        if data.get("archived") is False:
            self.archived = False


class ResourcePoolResource(db.Model):
    """Standalone resource pool profiles (not linked to workforce User rows)."""

    __tablename__ = "resource_pool_resources"

    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(255), nullable=False, default="")
    given_name = db.Column(db.String(120), nullable=False, default="")
    family_name = db.Column(db.String(120), nullable=False, default="")
    email = db.Column(db.String(255), nullable=False, default="", index=True)
    phone = db.Column(db.String(80), nullable=False, default="")
    job_title = db.Column(db.String(255), nullable=False, default="")
    department = db.Column(db.String(255), nullable=False, default="")
    employment_type = db.Column(db.String(64), nullable=False, default="Employee")
    location = db.Column(db.String(255), nullable=False, default="")
    location_detail = db.Column(db.String(255), nullable=False, default="")
    remote_friendly = db.Column(db.Boolean, nullable=False, default=False)
    skills = db.Column(db.JSON, nullable=False, default=list)
    clearance_level = db.Column(db.String(40), nullable=False, default="")
    clearance_status = db.Column(db.String(40), nullable=False, default="")
    clearance_expiry = db.Column(db.String(32), nullable=False, default="")
    contract_start_date = db.Column(db.String(32), nullable=False, default="")
    contract_end_date = db.Column(db.String(32), nullable=False, default="")
    reports_to = db.Column(db.String(255), nullable=False, default="")
    about = db.Column(db.Text, nullable=False, default="")
    hourly_rate = db.Column(db.String(32), nullable=False, default="")
    daily_rate = db.Column(db.String(32), nullable=False, default="")
    notes = db.Column(db.JSON, nullable=False, default=list)
    # {"original_name": "...", "stored": "uuid.pdf", "mime": "application/pdf", "uploaded_at": "..."}
    cv_document = db.Column(db.JSON, nullable=False, default=dict)
    # "" = automatic from dates; "available_now" | "unavailable" = manual override
    availability_override = db.Column(db.String(32), nullable=False, default="")
    is_active = db.Column(db.Boolean, nullable=False, default=True, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    updated_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class NodeFavorite(db.Model):
    __tablename__ = "node_favorites"
    __table_args__ = (db.UniqueConstraint("user_id", "file_node_id", name="uq_node_favorite"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    user = db.relationship("User")
    file_node = db.relationship("FileNode")


class ChatRoom(db.Model):
    __tablename__ = "chat_rooms"
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)

    created_by = db.relationship("User")


class ChatRoomMember(db.Model):
    __tablename__ = "chat_room_members"
    __table_args__ = (db.UniqueConstraint("room_id", "user_id", name="uq_chat_room_member"),)
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("chat_rooms.id"), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    role = db.Column(db.String(32), nullable=False, default="member")  # member | admin
    joined_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    last_read_message_id = db.Column(db.Integer, nullable=False, default=0)

    room = db.relationship("ChatRoom", backref=db.backref("memberships", lazy="dynamic"))
    user = db.relationship("User")


class ChatMessage(db.Model):
    __tablename__ = "chat_messages"
    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("chat_rooms.id"), nullable=False, index=True)
    sender_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    text = db.Column(db.String(4000), nullable=True)
    image_url = db.Column(db.String(1024), nullable=True)
    muted_at = db.Column(db.DateTime(timezone=True), nullable=True, index=True)
    muted_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    muted_original_json = db.Column(db.Text, nullable=True)

    room = db.relationship("ChatRoom", backref=db.backref("messages", lazy="dynamic"))
    sender = db.relationship("User", foreign_keys=[sender_id])
    muted_by = db.relationship("User", foreign_keys=[muted_by_id])


class ChatCallSignal(db.Model):
    """WebRTC signaling for in-app team chat voice calls (no external service)."""

    __tablename__ = "chat_call_signals"

    id = db.Column(db.Integer, primary_key=True)
    room_id = db.Column(db.Integer, db.ForeignKey("chat_rooms.id"), nullable=False, index=True)
    from_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    to_user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    kind = db.Column(db.String(16), nullable=False, index=True)  # join | leave | offer | answer | ice
    payload_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    room = db.relationship("ChatRoom")
    from_user = db.relationship("User", foreign_keys=[from_user_id])
    to_user = db.relationship("User", foreign_keys=[to_user_id])


# CRM
class CRMCompany(db.Model):
    __tablename__ = "crm_companies"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False, index=True)
    website = db.Column(db.String(512), nullable=True)
    phone = db.Column(db.String(64), nullable=True)
    email = db.Column(db.String(255), nullable=True)
    location = db.Column(db.String(255), nullable=True)
    attributes = db.Column(db.JSON, nullable=False, default=dict)  # industry, size, etc.
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    created_by = db.relationship("User")


class CRMLead(db.Model):
    __tablename__ = "crm_leads"

    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(255), nullable=False, index=True)
    email = db.Column(db.String(255), nullable=True, index=True)
    phone = db.Column(db.String(64), nullable=True)
    title = db.Column(db.String(255), nullable=True)  # job title / subtitle line
    status = db.Column(db.String(32), nullable=False, default="New", index=True)  # New/Contacted/Qualified/Converted/Lost
    source = db.Column(db.String(64), nullable=True, index=True)  # Website/Referral/LinkedIn/...
    score = db.Column(db.Integer, nullable=False, default=0, index=True)
    location = db.Column(db.String(255), nullable=True)

    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    company_id = db.Column(db.Integer, db.ForeignKey("crm_companies.id"), nullable=True, index=True)

    notes = db.Column(db.Text, nullable=True)
    attributes = db.Column(db.JSON, nullable=False, default=dict)  # tags, extra fields

    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    owner = db.relationship("User", foreign_keys=[owner_id])
    company = db.relationship("CRMCompany", foreign_keys=[company_id])
    created_by = db.relationship("User", foreign_keys=[created_by_id])


class CRMContact(db.Model):
    __tablename__ = "crm_contacts"

    id = db.Column(db.Integer, primary_key=True)
    full_name = db.Column(db.String(255), nullable=False, index=True)
    email = db.Column(db.String(255), nullable=True, index=True)
    phone = db.Column(db.String(64), nullable=True)
    title = db.Column(db.String(255), nullable=True)
    company_id = db.Column(db.Integer, db.ForeignKey("crm_companies.id"), nullable=True, index=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("crm_leads.id"), nullable=True, index=True)
    is_primary = db.Column(db.Boolean, nullable=False, default=False)
    attributes = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    company = db.relationship("CRMCompany")
    lead = db.relationship("CRMLead", backref=db.backref("contacts", lazy="dynamic"))
    created_by = db.relationship("User")


class CRMActivity(db.Model):
    __tablename__ = "crm_activities"

    id = db.Column(db.Integer, primary_key=True)
    kind = db.Column(db.String(32), nullable=False, default="note", index=True)  # note/email/call/form/file/etc.
    title = db.Column(db.String(255), nullable=True)
    body = db.Column(db.Text, nullable=True)
    lead_id = db.Column(db.Integer, db.ForeignKey("crm_leads.id"), nullable=True, index=True)
    company_id = db.Column(db.Integer, db.ForeignKey("crm_companies.id"), nullable=True, index=True)
    contact_id = db.Column(db.Integer, db.ForeignKey("crm_contacts.id"), nullable=True, index=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    attributes = db.Column(db.JSON, nullable=False, default=dict)

    lead = db.relationship("CRMLead", backref=db.backref("activities", lazy="dynamic"))
    company = db.relationship("CRMCompany")
    contact = db.relationship("CRMContact")
    created_by = db.relationship("User")


class CRMDeal(db.Model):
    __tablename__ = "crm_deals"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False, index=True)
    stage = db.Column(db.String(32), nullable=False, default="New", index=True)  # pipeline stage
    amount = db.Column(db.Integer, nullable=True)  # cents or whole dollars; keep simple for now
    lead_id = db.Column(db.Integer, db.ForeignKey("crm_leads.id"), nullable=True, index=True)
    company_id = db.Column(db.Integer, db.ForeignKey("crm_companies.id"), nullable=True, index=True)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    close_date = db.Column(db.String(32), nullable=True)
    attributes = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)

    lead = db.relationship("CRMLead", backref=db.backref("deals", lazy="dynamic"))
    company = db.relationship("CRMCompany")
    owner = db.relationship("User", foreign_keys=[owner_id])
    created_by = db.relationship("User", foreign_keys=[created_by_id])


class AiDocChunk(db.Model):
    """Text chunk from an indexed document for AI Document Search."""

    __tablename__ = "ai_doc_chunks"
    __table_args__ = (
        db.Index("ix_ai_doc_chunks_file", "file_node_id", "chunk_index"),
        db.Index("ix_ai_doc_chunks_kind_file", "index_kind", "file_node_id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    file_node_id = db.Column(db.Integer, db.ForeignKey("file_nodes.id"), nullable=False, index=True)
    file_sha256 = db.Column(db.String(64), nullable=False, index=True)
    chunk_index = db.Column(db.Integer, nullable=False, default=0)
    path_label = db.Column(db.String(1024), nullable=False, default="")
    body_text = db.Column(db.Text, nullable=False)
    # JSON array of floats from the embeddings API (semantic / vector search).
    embedding_json = db.Column(db.Text, nullable=True)
    # "documents" (portal file index) or "policy" (AI Policy Assistant uploads).
    index_kind = db.Column(db.String(32), nullable=False, default="documents", index=True)
    indexed_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    file_node = db.relationship("FileNode")


class AiDocConversation(db.Model):
    """Saved AI Document Search chat thread for a user."""

    __tablename__ = "ai_doc_conversations"
    __table_args__ = (db.Index("ix_ai_doc_conversations_user_updated", "user_id", "updated_at"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False, default="New chat")
    messages_json = db.Column(db.Text, nullable=False, default="[]")
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    user = db.relationship("User")


class AiPolicyConversation(db.Model):
    """Saved AI Policy Assistant thread for a user."""

    __tablename__ = "ai_policy_conversations"
    __table_args__ = (db.Index("ix_ai_policy_conversations_user_updated", "user_id", "updated_at"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False, default="New chat")
    messages_json = db.Column(db.Text, nullable=False, default="[]")
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False, index=True)

    user = db.relationship("User")


class AiChatConversation(db.Model):
    """Saved AI Chatbot thread for a user."""

    __tablename__ = "ai_chat_conversations"
    __table_args__ = (db.Index("ix_ai_chat_conversations_user_updated", "user_id", "updated_at"),)

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False, default="New chat")
    messages_json = db.Column(db.Text, nullable=False, default="[]")
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False, index=True)

    user = db.relationship("User")
