"""Local CRM records and immutable activity history; no external sending or calling."""
import hmac
import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

from flask import Blueprint, jsonify, request

STAGES = ['New', 'Contacted', 'Qualified', 'Meeting booked', 'Proposal sent', 'Won', 'Lost']
OUTCOMES = ['No answer', 'Voicemail', 'Connected', 'Interested', 'Not interested', 'Wrong number', 'Callback requested']
DEFAULTS = {
    'contacts': dict(name='', company='', email='', phone='', website='', source='', owner='', notes='', archived=False),
    'deals': dict(contact_id='', title='', stage='New', value='0.00', currency='USD', loss_reason=''),
    'items': dict(contact_id='', kind='task', title='', due='', end='', status='Scheduled', notes=''),
    'activities': dict(contact_id='', kind='note', text='', outcome='', direction='Outgoing', duration=0, occurred=''),
}


def now():
    return datetime.now(timezone.utc).isoformat()


class CRMError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def timestamp(value):
    try:
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if date.tzinfo is None:
            raise ValueError()
        return date.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError, OverflowError):
        raise CRMError('Choose a valid date and time with a time zone.')


def validate(kind, data):
    for key, default in DEFAULTS[kind].items():
        value = data[key]
        if isinstance(default, bool):
            if not isinstance(value, bool):
                raise CRMError('Invalid archive setting.')
        elif isinstance(default, int):
            if type(value) is not int or not 0 <= value <= 1440:
                raise CRMError('Call duration must be between 0 and 1440 minutes.')
        else:
            if not isinstance(value, str) or len(value) > (10000 if key in ('notes', 'text') else 500):
                raise CRMError('A field is invalid or too long.')
            data[key] = value.strip()
    if kind == 'contacts':
        if not data['name']:
            raise CRMError('A contact name is required.')
        if data['email'] and not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', data['email']):
            raise CRMError('Enter a valid email address.')
        if data['website']:
            try:
                url = urlparse(data['website'])
                valid = url.scheme in ('http', 'https') and url.hostname and not url.username
            except ValueError:
                valid = False
            if not valid:
                raise CRMError('Website must start with https:// or http://.')
    elif kind == 'deals':
        if not data['title'] or data['stage'] not in STAGES:
            raise CRMError('Choose a deal title and valid sales stage.')
        try:
            amount = Decimal(data['value'])
            if not amount.is_finite() or amount < 0 or amount > Decimal('999999999999.99') or amount.as_tuple().exponent < -2:
                raise InvalidOperation()
            data['value'] = str(amount.quantize(Decimal('.01')))
        except InvalidOperation:
            raise CRMError('Deal value must be a positive amount with up to two decimal places.')
        data['currency'] = data['currency'].upper()
        if not re.fullmatch('[A-Z]{3}', data['currency']):
            raise CRMError('Use a three-letter currency code, such as USD or INR.')
    elif kind == 'items':
        if data['kind'] not in ('task', 'meeting') or not data['title']:
            raise CRMError('Choose a task or meeting and enter a title.')
        allowed = ('Scheduled', 'Completed', 'Cancelled', 'No-show') if data['kind'] == 'meeting' else ('Scheduled', 'Completed', 'Cancelled')
        if data['status'] not in allowed:
            raise CRMError('Invalid activity status.')
        data['due'] = timestamp(data['due'])
        if data['kind'] == 'meeting' and not data['end']:
            raise CRMError('Meetings need an end time.')
        if data['end']:
            data['end'] = timestamp(data['end'])
            if data['end'] <= data['due']:
                raise CRMError('End time must be after start time.')
    else:
        if data['kind'] not in ('note', 'call', 'outreach') or not data['text']:
            raise CRMError('Choose an activity type and enter notes.')
        if data['kind'] == 'call' and (data['outcome'] not in OUTCOMES or data['direction'] not in ('Incoming', 'Outgoing')):
            raise CRMError('Choose a call outcome and direction.')
        data['occurred'] = timestamp(data['occurred']) if data['occurred'] else now()


class CRMStore:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
            for table in ('deals', 'items', 'activities'):
                db.execute(f'CREATE TABLE IF NOT EXISTS {table} (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), data TEXT NOT NULL)')
                db.execute(f'CREATE INDEX IF NOT EXISTS {table}_contact ON {table}(contact_id)')
            db.commit()
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def state(self):
        with self.db() as db:
            return {k: [json.loads(r['data']) for r in db.execute(f'SELECT data FROM {k} ORDER BY rowid')] for k in DEFAULTS}

    def delete_contact(self, key, data):
        if not isinstance(data, dict) or set(data) != {'revision'} or type(data['revision']) is not int:
            raise CRMError('A contact revision is required.')
        with self.db() as db:
            old = self.get(db, 'contacts', key)
            if old['revision'] != data['revision']:
                raise CRMError('This contact changed. Refresh before deleting.', 409)
            for table in ('activities', 'items', 'deals'):
                db.execute(f'DELETE FROM {table} WHERE contact_id=?', (key,))
            db.execute('DELETE FROM contacts WHERE id=?', (key,))

    @staticmethod
    def get(db, table, key):
        row = db.execute(f'SELECT data FROM {table} WHERE id=?', (key,)).fetchone()
        if row is None:
            raise CRMError('Record not found.', 404)
        return json.loads(row['data'])

    @staticmethod
    def insert(db, table, data):
        if table == 'contacts':
            db.execute('INSERT INTO contacts VALUES (?,?)', (data['id'], json.dumps(data)))
        else:
            db.execute(f'INSERT INTO {table} VALUES (?,?,?)', (data['id'], data['contact_id'], json.dumps(data)))

    def audit(self, db, contact_id, text, due=None):
        stamp = now()
        self.insert(db, 'activities', dict(id=uuid.uuid4().hex, contact_id=contact_id, kind='system', text=text, due=due, occurred=stamp, created=stamp, updated=stamp, revision=1))

    def write(self, table, changes, key=None):
        if not isinstance(changes, dict) or set(changes) - (set(DEFAULTS[table]) | ({'revision'} if key else set())):
            raise CRMError('Invalid record fields.')
        if key and table == 'activities':
            raise CRMError('History cannot be overwritten.', 405)
        with self.db() as db:
            old = self.get(db, table, key) if key else None
            if old and (type(changes.get('revision')) is not int or changes['revision'] != old['revision']):
                raise CRMError('This record changed in another window. Refresh before editing.', 409)
            if old and 'contact_id' in changes and changes['contact_id'] != old['contact_id']:
                raise CRMError('A record cannot be moved to another contact.')
            data = dict(old or DEFAULTS[table])
            data.update(changes)
            validate(table, data)
            if table != 'contacts':
                contact = self.get(db, 'contacts', data['contact_id'])
                if contact['archived']:
                    raise CRMError('Restore this contact before adding or changing work.')
            stamp = now()
            data.update(id=key or uuid.uuid4().hex, revision=(old['revision'] + 1 if old else 1), created=old['created'] if old else stamp, updated=stamp)
            if old:
                db.execute(f'UPDATE {table} SET data=? WHERE id=?', (json.dumps(data), key))
            else:
                self.insert(db, table, data)
            if table != 'activities':
                if table == 'contacts':
                    text = ('Contact updated' if old else 'Contact created')
                    if old and data['archived'] != old['archived']:
                        text = 'Contact archived' if data['archived'] else 'Contact restored'
                elif table == 'deals':
                    text = f"Deal: {data['title']} — {old['stage'] + ' → ' if old else ''}{data['stage']}"
                    if data['stage'] == 'Lost' and data['loss_reason']:
                        text += ': ' + data['loss_reason']
                else:
                    text = f"{data['kind'].title()}: {data['title']} — {data['status']}"
                self.audit(db, data['id'] if table == 'contacts' else data['contact_id'], text, data.get('due'))
            return data


def register_crm(app, base, token, licensed):
    store = CRMStore(Path(base) / 'crm.sqlite3')
    bp = Blueprint('crm', __name__, url_prefix='/api/crm')

    @bp.before_request
    def guard():
        if request.host.split(':')[0].lower() not in ('localhost', '127.0.0.1') or not licensed():
            raise CRMError('Access denied.', 403)
        if request.method != 'GET' and not hmac.compare_digest(request.headers.get('X-CSRF-Token', ''), token()):
            raise CRMError('Refresh Lumen before saving.', 403)
        if request.content_length and request.content_length > 50000:
            raise CRMError('Record is too large.', 413)

    @bp.after_request
    def private(response):
        response.headers['Cache-Control'] = 'no-store'
        return response

    @bp.errorhandler(CRMError)
    def error(exc):
        return jsonify(error=exc.message), exc.status

    @bp.get('/state')
    def state():
        return jsonify(**store.state(), stages=STAGES, outcomes=OUTCOMES)

    @bp.delete('/contacts/<key>')
    def delete_contact(key):
        store.delete_contact(key, request.get_json(silent=True))
        return jsonify(ok=True)

    @bp.route('/<table>', methods=['POST'])
    @bp.route('/<table>/<key>', methods=['PATCH'])
    def write(table, key=None):
        if table not in DEFAULTS:
            raise CRMError('Unknown record type.', 404)
        data = request.get_json(silent=True)
        return jsonify(store.write(table, data, key)), 200 if key else 201

    app.register_blueprint(bp)
    return store
