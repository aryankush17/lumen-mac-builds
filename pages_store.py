"""Local Pages repository. HTTP boundary is independent of the editor UI."""
import json
import os
import sqlite3
import uuid
import threading
import time
import base64
import binascii
import hashlib
import io
import re
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, Response, jsonify, request, send_from_directory

MAX_DOCUMENT = 8 * 1024 * 1024
COVERS = ('', 'sand', 'sage', 'sky', 'rose', 'ink', 'dots', 'grid', 'arches', 'waves', 'confetti', 'dunes-photo', 'ocean-photo')


def now():
    return datetime.now(timezone.utc).isoformat()


def page_text(value):
    """Extract visible text, never JSON metadata, URLs or formatting names."""
    parts, stack = [], [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, list):
            stack.extend(reversed(item))
        elif isinstance(item, dict):
            if isinstance(item.get('text'), str):
                parts.append(item['text'])
            for key in ('children', 'cells', 'rows', 'content'):
                if key in item:
                    stack.append(item[key])
            if item.get('type') == 'grid':
                try:
                    grid = json.loads(item.get('props', {}).get('data', '{}'))
                    stack.extend([grid.get('rows', []), grid.get('columns', []), grid.get('notes', [])])
                except (ValueError, TypeError, AttributeError):
                    pass
    return ' '.join(parts)


class PageError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


class PagesStore:
    def __init__(self, path):
        self.path = str(path)

    @contextmanager
    def db(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS pages (
                id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '📄', cover TEXT NOT NULL DEFAULT '',
                favorite INTEGER NOT NULL DEFAULT 0, trashed INTEGER NOT NULL DEFAULT 0,
                document TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                created TEXT NOT NULL, updated TEXT NOT NULL, legacy_source TEXT UNIQUE)''')
            db.execute('''CREATE TABLE IF NOT EXISTS record_pages (
                parent_id TEXT NOT NULL, block_id TEXT NOT NULL, record_id TEXT NOT NULL,
                page_id TEXT NOT NULL, PRIMARY KEY(parent_id,block_id,record_id))''')
            db.execute('''CREATE TABLE IF NOT EXISTS page_history (
                page_id TEXT NOT NULL, revision INTEGER NOT NULL, saved TEXT NOT NULL,
                snapshot TEXT NOT NULL, PRIMARY KEY(page_id,revision))''')
            db.commit()
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def decode(row):
        if row is None:
            raise PageError('Page not found.', 404)
        data = dict(row)
        data['document'] = json.loads(data['document'])
        data['favorite'] = bool(data['favorite'])
        data['trashed'] = bool(data['trashed'])
        return data

    def list(self):
        with self.db() as db:
            return [dict(r) for r in db.execute('SELECT id,parent_id,title,icon,cover,favorite,trashed,revision,created,updated FROM pages ORDER BY updated DESC')]

    def get(self, page_id):
        with self.db() as db:
            return self.decode(db.execute('SELECT * FROM pages WHERE id=?', (page_id,)).fetchone())

    def record_page(self, parent_id, data):
        block_id, record_id = data.get('block_id'), data.get('record_id')
        if not all(isinstance(v, str) and 0 < len(v) <= 100 for v in (block_id, record_id)):
            raise PageError('Invalid record reference.')
        with self.db() as db:
            parent = self.decode(db.execute('SELECT * FROM pages WHERE id=?', (parent_id,)).fetchone())
            if parent['trashed'] or data.get('revision') != parent['revision']:
                raise PageError('The collection changed. Reload it before opening this record.', 409)
            pending = list(parent['document'])
            collection = None
            while pending:
                block = pending.pop()
                if block.get('id') == block_id and block.get('type') == 'grid':
                    try:
                        collection = json.loads(block.get('props', {}).get('data', '{}'))
                    except (TypeError, ValueError):
                        pass
                    break
                pending.extend(block.get('children', []))
            if not isinstance(collection, dict) or not isinstance(collection.get('rowIds'), list) or record_id not in collection['rowIds']:
                raise PageError('Record no longer exists in this collection.', 404)
            index = collection['rowIds'].index(record_id)
            rows = collection.get('rows', [])
            if not isinstance(rows, list) or index >= len(rows) or not isinstance(rows[index], list):
                raise PageError('Invalid record.', 400)
            linked = db.execute('SELECT page_id FROM record_pages WHERE parent_id=? AND block_id=? AND record_id=?', (parent_id, block_id, record_id)).fetchone()
            if linked:
                page = self.decode(db.execute('SELECT * FROM pages WHERE id=?', (linked['page_id'],)).fetchone())
                if page['trashed']:
                    raise PageError('This record page is in Trash. Restore it from the sidebar.', 409)
                return page
            title = str(rows[index][0] if rows[index] else 'Untitled')[:240]
            notes = collection.get('notes', [])
            if not isinstance(notes, list):
                notes = []
            note = notes[index] if index < len(notes) and isinstance(notes[index], str) else ''
            document = [{'type': 'paragraph', 'content': line} for line in note.splitlines()] or [{'type': 'paragraph', 'content': ''}]
            pid, stamp = uuid.uuid4().hex, now()
            db.execute('INSERT INTO pages(id,parent_id,title,document,created,updated) VALUES(?,?,?,?,?,?)', (pid,parent_id,title,self.document(document),stamp,stamp))
            db.execute('INSERT INTO record_pages(parent_id,block_id,record_id,page_id) VALUES(?,?,?,?)', (parent_id,block_id,record_id,pid))
            return self.decode(db.execute('SELECT * FROM pages WHERE id=?', (pid,)).fetchone())

    def history(self, pid):
        with self.db() as db:
            self.decode(db.execute('SELECT * FROM pages WHERE id=?', (pid,)).fetchone())
            result = []
            for row in db.execute('SELECT revision,saved,snapshot FROM page_history WHERE page_id=? ORDER BY revision DESC LIMIT 50', (pid,)):
                snapshot = json.loads(row['snapshot'])
                result.append({'revision':row['revision'],'saved':row['saved'],'title':snapshot['title'], 'preview':page_text(snapshot['document'])[:300]})
            return result

    def restore_version(self, pid, data):
        version = data.get('version')
        if type(version) is not int:
            raise PageError('Choose a saved version.')
        with self.db() as db:
            row = db.execute('SELECT snapshot FROM page_history WHERE page_id=? AND revision=?', (pid,version)).fetchone()
            if not row:
                raise PageError('Saved version not found.',404)
            snapshot = json.loads(row['snapshot'])
        # Normal optimistic concurrency checks prevent a restore overwriting a newer edit.
        return self.update(pid, {k:snapshot[k] for k in ('title','icon','cover','document')} | {'revision':data.get('revision')})

    def insights(self, query='', tasks_only=False):
        needle = query.strip().casefold()[:200]
        results, tasks, task_count = [], [], 0
        with self.db() as db:
            for row in db.execute('SELECT id,title,icon,document,updated FROM pages WHERE trashed=0 ORDER BY updated DESC'):
                blocks = json.loads(row['document'])
                if tasks_only:
                    stack = list(reversed(blocks))
                    while stack:
                        block = stack.pop()
                        if not isinstance(block, dict):
                            continue
                        stack.extend(reversed(block.get('children') or []))
                        if block.get('type') == 'checkListItem' and not block.get('props', {}).get('checked', False):
                            label = page_text(block.get('content', [])).strip()
                            if label:
                                task_count += 1
                                if len(tasks) < 100:
                                    tasks.append({'page_id': row['id'], 'title': row['title'], 'block_id': block.get('id'), 'text': label[:500]})
                    continue
                text = page_text(blocks)
                title_match = needle in row['title'].casefold()
                match = text.casefold().find(needle) if needle else -1
                if not needle or title_match or match >= 0:
                    start = max(0, match - 55)
                    results.append({'id': row['id'], 'title': row['title'], 'icon': row['icon'], 'updated': row['updated'],
                                    'title_match': title_match, 'snippet': ('…' if start else '') + text[start:start+180]})
        results.sort(key=lambda item: not item['title_match'])
        return {'pages': results[:50], 'total': len(results), 'tasks': tasks, 'task_count': task_count}

    @staticmethod
    def document(value):
        if not isinstance(value, list) or any(not isinstance(b, dict) or not isinstance(b.get('type'), str) for b in value):
            raise PageError('A page must contain a list of editor blocks.')
        encoded = json.dumps(value, ensure_ascii=False)
        if len(encoded.encode('utf-8')) > MAX_DOCUMENT:
            raise PageError('This page is too large. Split it into smaller pages.', 413)
        return encoded

    def create(self, data, source=None):
        title = data.get('title', 'Untitled')
        if not isinstance(title, str):
            raise PageError('Invalid page title.')
        document = self.document(data.get('document', [{'type': 'paragraph', 'content': []}]))
        cover, icon = data.get('cover', ''), data.get('icon', '📄')
        if not isinstance(cover, str) or cover not in COVERS:
            raise PageError('Choose a built-in cover when creating a page.')
        if not isinstance(icon, str) or len(icon) > 16:
            raise PageError('Invalid icon.')
        parent = data.get('parent_id') or None
        if parent is not None and not isinstance(parent, str):
            raise PageError('Invalid parent page.')
        with self.db() as db:
            if source:
                existing = db.execute('SELECT * FROM pages WHERE legacy_source=?', (source,)).fetchone()
                if existing:
                    return self.decode(existing)
            if parent and not db.execute('SELECT id FROM pages WHERE id=? AND trashed=0', (parent,)).fetchone():
                raise PageError('Choose an existing, active parent page.')
            pid, stamp = uuid.uuid4().hex, now()
            db.execute('INSERT INTO pages(id,parent_id,title,document,created,updated,legacy_source,cover,icon) VALUES(?,?,?,?,?,?,?,?,?)',
                       (pid, parent, title[:240], document, stamp, stamp, source, cover, icon))
            return self.decode(db.execute('SELECT * FROM pages WHERE id=?', (pid,)).fetchone())

    def update(self, pid, data):
        with self.db() as db:
            current = self.decode(db.execute('SELECT * FROM pages WHERE id=?', (pid,)).fetchone())
            if data.get('revision') != current['revision']:
                raise PageError('This page changed in another window. Download your draft before reloading the saved page.', 409)
            if current['trashed'] and data.get('trashed') is not False:
                raise PageError('Restore this page before editing it.', 409)
            updates = {}
            for key, limit in [('title', 240), ('icon', 16), ('cover', 40)]:
                if key in data:
                    if not isinstance(data[key], str):
                        raise PageError('Invalid ' + key)
                    updates[key] = data[key][:limit]
            if 'cover' in updates and updates['cover'] not in COVERS:
                cover = updates['cover']
                if not re.fullmatch(r'upload-[a-f0-9]{32}', cover) or not (Path(self.path).parent / 'page-covers' / (cover + '.jpg')).is_file():
                    raise PageError('Unknown cover. Choose a built-in cover or upload an image.')
            for key in ('favorite', 'trashed'):
                if key in data:
                    if type(data[key]) is not bool:
                        raise PageError('Invalid ' + key)
                    updates[key] = int(data[key])
            if 'document' in data:
                updates['document'] = self.document(data['document'])
            parent = data.get('parent_id', current['parent_id']) or None
            if parent is not None and not isinstance(parent, str):
                raise PageError('Invalid parent page.')
            if current['trashed'] and data.get('trashed') is False and 'parent_id' not in data:
                parent = None
            if parent:
                ancestors, cursor = set(), parent
                while cursor:
                    if cursor == pid or cursor in ancestors:
                        raise PageError('A page cannot be moved inside itself or its children.')
                    ancestors.add(cursor)
                    row = db.execute('SELECT parent_id,trashed FROM pages WHERE id=?', (cursor,)).fetchone()
                    if not row or row['trashed']:
                        raise PageError('Choose an existing, active parent page.')
                    cursor = row['parent_id']
            if 'parent_id' in data:
                updates['parent_id'] = parent
            # Restore to the workspace if the former parent is in the trash.
            if current['trashed'] and data.get('trashed') is False:
                updates['parent_id'] = None
            db.execute('INSERT OR IGNORE INTO page_history(page_id,revision,saved,snapshot) VALUES(?,?,?,?)',
                       (pid,current['revision'],current['updated'],json.dumps(current,ensure_ascii=False)))
            db.execute('DELETE FROM page_history WHERE page_id=? AND revision NOT IN (SELECT revision FROM page_history WHERE page_id=? ORDER BY revision DESC LIMIT 50)', (pid,pid))
            updates.update(revision=current['revision'] + 1, updated=now())
            db.execute('UPDATE pages SET ' + ','.join(k + '=?' for k in updates) + ' WHERE id=?', (*updates.values(), pid))
            if data.get('trashed') is True:
                db.execute('''WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM pages WHERE parent_id=? UNION ALL
                    SELECT p.id FROM pages p JOIN descendants d ON p.parent_id=d.id)
                    UPDATE pages SET trashed=1,revision=revision+1,updated=? WHERE id IN (SELECT id FROM descendants)''', (pid, now()))
            return self.decode(db.execute('SELECT * FROM pages WHERE id=?', (pid,)).fetchone())


def table_block(rows):
    width = max((len(row) for row in rows), default=1)
    if width > 100 or len(rows) > 5000:
        raise PageError('This list is too large for an editor table (maximum 5,000 rows and 100 columns). The original sheet is unchanged.', 413)
    return {'type': 'table', 'content': {'type': 'tableContent', 'rows': [
        {'cells': [str(value if value is not None else '') for value in row] + [''] * (width - len(row))} for row in rows]}}


def register_pages(app, data_dir, resource_dir, csrf_token, access_allowed, sheets_dir, latest_rows):
    store = PagesStore(Path(data_dir) / 'pages.sqlite3')
    routes = Blueprint('pages', __name__)
    dist = Path(resource_dir) / 'pages_ui' / 'dist'
    access_cache = {'until': 0, 'allowed': False}
    access_lock = threading.Lock()

    @routes.before_request
    def authorize():
        # A short process-local cache avoids one licensing network call per asset
        # and keystroke save. Never cache denials; revocations take effect in <=30s.
        with access_lock:
            if time.monotonic() >= access_cache['until']:
                access_cache['allowed'] = bool(access_allowed())
                access_cache['until'] = time.monotonic() + (30 if access_cache['allowed'] else 0)
        if not access_cache['allowed']:
            return jsonify(error='A valid Lumen license is required.'), 403
        if request.content_length and request.content_length > MAX_DOCUMENT + 65536:
            return jsonify(error='Page request is too large.'), 413

    @routes.errorhandler(PageError)
    def invalid(error):
        return jsonify(error=error.message), error.status

    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise PageError('Expected a JSON object.')
        return value

    @routes.post('/api/pages-cover')
    def upload_cover():
        from PIL import Image, UnidentifiedImageError
        data = body().get('image')
        if not isinstance(data, str) or not data.startswith('data:image/jpeg;base64,') or len(data) > 3 * 1024 * 1024:
            raise PageError('Choose and crop a JPEG, PNG or WebP image first.')
        try:
            raw = base64.b64decode(data.split(',', 1)[1], validate=True)
            with Image.open(io.BytesIO(raw)) as picture:
                if picture.format != 'JPEG' or picture.size != (1600, 400):
                    raise PageError('The cover must be cropped to the preview frame.')
                picture.load()
                clean = io.BytesIO()
                picture.convert('RGB').save(clean, 'JPEG', quality=90)
                raw = clean.getvalue()
        except (ValueError, binascii.Error, UnidentifiedImageError, OSError):
            raise PageError('This image could not be read. Try another image.')
        name = 'upload-' + hashlib.sha256(raw).hexdigest()[:32]
        folder = Path(data_dir) / 'page-covers'
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / (name + '.jpg')
        if not target.exists():
            temp = folder / (uuid.uuid4().hex + '.tmp')
            temp.write_bytes(raw)
            os.replace(temp, target)
        return jsonify(cover=name)

    @routes.get('/api/pages-cover/<name>')
    def cover_image(name):
        if not re.fullmatch(r'upload-[a-f0-9]{32}', name):
            raise PageError('Cover not found.', 404)
        response = send_from_directory(Path(data_dir) / 'page-covers', name + '.jpg', mimetype='image/jpeg')
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @routes.route('/api/pages', methods=['GET', 'POST'])
    def collection():
        return jsonify(store.create(body())) if request.method == 'POST' else jsonify(pages=store.list())

    @routes.get('/api/pages-insights')
    def insights():
        return jsonify(store.insights(request.args.get('q', ''), request.args.get('mode') == 'tasks'))

    @routes.route('/api/pages/<pid>', methods=['GET', 'PATCH'])
    def item(pid):
        return jsonify(store.update(pid, body()) if request.method == 'PATCH' else store.get(pid))

    @routes.post('/api/pages/<pid>/record-page')
    def open_record_page(pid):
        return jsonify(store.record_page(pid, body()))

    @routes.get('/api/pages/<pid>/history')
    def page_history(pid):
        return jsonify(versions=store.history(pid))

    @routes.post('/api/pages/<pid>/restore-version')
    def restore_page_version(pid):
        return jsonify(store.restore_version(pid, body()))

    @routes.get('/api/pages-legacy')
    def legacy():
        result = []
        for path in Path(sheets_dir).glob('*.json'):
            try:
                sheet = json.loads(path.read_text(encoding='utf-8'))
                result.append({'id': path.stem, 'title': sheet.get('name', path.stem)})
            except (ValueError, OSError):
                continue
        return jsonify(sheets=result)

    @routes.post('/api/pages-import/<sid>')
    def import_sheet(sid):
        if not sid.isalnum() or len(sid) > 100:
            raise PageError('Invalid sheet identifier.')
        path = Path(sheets_dir) / (sid + '.json')
        if not path.is_file():
            raise PageError('Sheet not found.', 404)
        sheet = json.loads(path.read_text(encoding='utf-8'))
        tabs = sheet.get('data', [])
        if isinstance(tabs, dict):
            tabs = [tabs]
        blocks = [{'type': 'paragraph', 'content': 'Imported copy. Original spreadsheet and follow-up settings remain in Legacy sheets. Formulas are preserved as text.'}]
        for tab in tabs:
            rows = []
            source_rows = tab.get('rows', {})
            for key in sorted((k for k in source_rows if str(k).isdigit()), key=int):
                cells = source_rows[key].get('cells', {})
                indices = [int(k) for k in cells if str(k).isdigit()]
                if indices and max(indices) >= 100:
                    raise PageError('This sheet has more than 100 columns. Use Legacy sheets for this list.', 413)
                rows.append([cells.get(str(i), {}).get('text', '') for i in range(max(indices, default=0) + 1)])
            if rows:
                blocks.extend([{'type': 'heading', 'content': str(tab.get('name', 'Table')), 'props': {'level': 2}}, table_block(rows)])
        return jsonify(store.create({'title': sheet.get('name', 'Imported sheet'), 'document': blocks}, source='sheet:' + sid))

    @routes.post('/api/pages-from-run')
    def from_run():
        data = body()
        headers, rows = latest_rows()
        if not rows:
            raise PageError('No completed lead run is available.')
        return jsonify(store.create({'title': data.get('name') or 'Lead list', 'document': [table_block([headers] + [[row.get(h, '') for h in headers] for row in rows])]}))

    @routes.get('/pages-app/')
    def index():
        path = dist / 'index.html'
        if not path.exists():
            return Response('Pages has not been built. Run npm ci and npm run build in pages_ui.', status=503, mimetype='text/plain')
        response = Response(path.read_text(encoding='utf-8').replace('__CSRF_TOKEN__', csrf_token()), mimetype='text/html')
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Frame-Options'] = 'SAMEORIGIN'
        return response

    @routes.get('/pages-app/assets/<path:name>')
    def assets(name):
        return send_from_directory(dist / 'assets', name)

    @routes.get('/pages-app/fonts/<path:name>')
    def fonts(name):
        return send_from_directory(dist / 'fonts', name)

    app.register_blueprint(routes)
    return store
