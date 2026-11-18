"""Locate the intact browser bundle before app.py sets its default browser path."""
import os
import sys
from pathlib import Path

if sys.platform == 'darwin' and getattr(sys, 'frozen', False):
    contents = Path(sys.executable).resolve().parent.parent
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(contents / 'Resources' / 'ms-playwright')
