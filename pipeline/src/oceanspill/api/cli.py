"""Command line for the server: create the schema, seed it, add accounts, serve, run the worker."""
from __future__ import annotations

import argparse
import getpass
import json
import logging
import sys
from datetime import datetime, timezone

from sqlalchemy import select

from ..config import PIPELINE_DIR
from .db import Base, Database
from .models import AreaOfInterest, AuditEntry, User
from .security import hash_password, password_problem
from .settings import SHARED_DIR, ApiSettings

ROLES = ["NTRO Admin", "NTRO Reviewer", "Analyst", "Regulator", "Viewer", "Data Operator", "Liaison"]
CLEARANCES = ["Restricted", "Confidential", "Secret"]


def _db(settings: ApiSettings) -> Database:
    return Database(settings.database_url)


def migrate(settings: ApiSettings) -> None:
    """Bring the schema up to date with Alembic, falling back to a direct create for a bare database."""
    config_path = PIPELINE_DIR / "alembic.ini"
    if config_path.exists():
        from alembic import command
        from alembic.config import Config

        config = Config(str(config_path))
        config.set_main_option("script_location", str(PIPELINE_DIR / "migrations"))
        config.set_main_option("sqlalchemy.url", settings.database_url)
        command.upgrade(config, "head")
    else:  # pragma: no cover - only when the migrations are not shipped
        db = _db(settings)
        Base.metadata.create_all(db.engine)
        _harden(db)
    print(f"schema ready at {settings.database_url}")


def _harden(db: Database) -> None:
    """On PostgreSQL, refuse UPDATE and DELETE on the audit table at the database level."""
    if db.engine.dialect.name != "postgresql":
        return
    from sqlalchemy import text
    with db.engine.begin() as conn:
        conn.execute(text("""
            CREATE OR REPLACE FUNCTION oceanspill_audit_append_only() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'audit_log is append-only';
            END;
            $$ LANGUAGE plpgsql;
        """))
        conn.execute(text("DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log"))
        conn.execute(text("""
            CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
            FOR EACH ROW EXECUTE FUNCTION oceanspill_audit_append_only();
        """))


def seed(settings: ApiSettings) -> None:
    """Load the built-in planning areas. Accounts are created explicitly, never with a default password."""
    db = _db(settings)
    areas = json.loads((SHARED_DIR / "aois.json").read_text(encoding="utf-8"))["areas"]
    added = 0
    with db.sessions() as s:
        for a in areas:
            if s.get(AreaOfInterest, a["id"]) is not None:
                continue
            b = a["bounds"]
            s.add(AreaOfInterest(id=a["id"], name=a["name"], priority=a["priority"], north=b["north"], south=b["south"],
                                 east=b["east"], west=b["west"], rationale=a["rationale"], pinned=a["pinned"],
                                 requested_by=a["requestedBy"], built_in=True))
            added += 1
        s.commit()
    print(f"{added} planning areas added ({len(areas)} defined)")


def create_user(settings: ApiSettings, args: argparse.Namespace) -> None:
    db = _db(settings)
    password = args.password or getpass.getpass("Password: ")
    if not args.password and password != getpass.getpass("Repeat password: "):
        sys.exit("passwords do not match")
    problem = password_problem(password)
    if problem:
        sys.exit(problem)
    with db.sessions() as s:
        email = args.email.strip().lower()
        if s.scalar(select(User).where(User.email == email)):
            sys.exit(f"{email} already has an account")
        count = s.scalar(select(User.id).order_by(User.id.desc())) or "U-000"
        new_id = f"U-{int(count.split('-')[1]) + 1:03d}"
        s.add(User(id=new_id, name=args.name, email=email, role=args.role, agency=args.agency,
                   clearance=args.clearance, status="Active", password_hash=hash_password(password)))
        s.add(AuditEntry(id=f"CLI-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}", actor="Command line",
                         role="Administrator", action="Account created", target=new_id,
                         detail=f"{args.name} · {args.role} · {args.agency}", category="Access", provenance="session"))
        s.commit()
    print(f"created {new_id} ({args.email}) as {args.role}")


def set_password(settings: ApiSettings, args: argparse.Namespace) -> None:
    db = _db(settings)
    password = args.password or getpass.getpass("New password: ")
    problem = password_problem(password)
    if problem:
        sys.exit(problem)
    with db.sessions() as s:
        user = s.scalar(select(User).where(User.email == args.email.strip().lower()))
        if user is None:
            sys.exit(f"no account for {args.email}")
        user.password_hash = hash_password(password)
        user.failed_logins, user.locked_until = 0, None
        s.commit()
    print(f"password set for {args.email}")


def serve(settings: ApiSettings, args: argparse.Namespace) -> None:  # pragma: no cover - runs a server
    import uvicorn
    uvicorn.run("oceanspill.api.app:create_app", factory=True, host=args.host, port=args.port,
                reload=args.reload, log_level="info")


def worker(settings: ApiSettings, args: argparse.Namespace) -> None:
    from .worker import Worker
    w = Worker(settings, offline=args.offline)
    if args.once:
        with w.db.sessions() as db:
            queued = w.schedule(db)
            ran = w.run_once(db)
        print(f"{queued} jobs queued, {ran} jobs run")
        return
    w.serve()  # pragma: no cover - long-running loop


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="oceanspill-api", description="OceanSpill server commands")
    parser.add_argument("--env-file", help="read settings from this file instead of pipeline/.env")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("migrate", help="create or update the database schema")
    sub.add_parser("seed", help="load the built-in planning areas")

    p = sub.add_parser("create-user", help="add an account (password is asked for, never echoed)")
    p.add_argument("--name", required=True)
    p.add_argument("--email", required=True)
    p.add_argument("--role", required=True, choices=ROLES)
    p.add_argument("--agency", required=True)
    p.add_argument("--clearance", default="Restricted", choices=CLEARANCES)
    p.add_argument("--password", help="not recommended; leave out to be prompted")

    p = sub.add_parser("set-password", help="set an account password")
    p.add_argument("--email", required=True)
    p.add_argument("--password", help="not recommended; leave out to be prompted")

    p = sub.add_parser("serve", help="run the API server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--reload", action="store_true")

    p = sub.add_parser("worker", help="run background jobs")
    p.add_argument("--once", action="store_true", help="run what is due and exit")
    p.add_argument("--offline", action="store_true", help="use only cached responses")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    settings = ApiSettings.load(args.env_file)

    if args.command == "migrate":
        migrate(settings)
    elif args.command == "seed":
        seed(settings)
    elif args.command == "create-user":
        create_user(settings, args)
    elif args.command == "set-password":
        set_password(settings, args)
    elif args.command == "serve":
        serve(settings, args)
    elif args.command == "worker":
        worker(settings, args)


if __name__ == "__main__":  # pragma: no cover
    main()
