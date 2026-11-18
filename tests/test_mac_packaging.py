import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mac_build

class MacPackagingTests(unittest.TestCase):
    def test_frozen_runtime_uses_browser_inside_app_resources(self):
        with tempfile.TemporaryDirectory() as folder:
            contents = Path(folder) / 'Lumen.app' / 'Contents'
            executable = contents / 'MacOS' / 'Lumen'
            with patch.object(sys, 'platform', 'darwin'), patch.object(sys, 'frozen', True, create=True), patch.object(sys, 'executable', str(executable)), patch.dict(os.environ, {'PLAYWRIGHT_BROWSERS_PATH':'stale-build-path'}):
                runpy.run_path(str(mac_build.ROOT / 'mac_runtime_hook.py'))
                self.assertEqual(Path(os.environ['PLAYWRIGHT_BROWSERS_PATH']), contents.resolve() / 'Resources/ms-playwright')

    def test_unfrozen_runtime_does_not_change_browser_settings(self):
        with patch.object(sys, 'frozen', False, create=True), patch.dict(os.environ, {'PLAYWRIGHT_BROWSERS_PATH':'custom-location'}):
            runpy.run_path(str(mac_build.ROOT / 'mac_runtime_hook.py'))
            self.assertEqual(os.environ['PLAYWRIGHT_BROWSERS_PATH'], 'custom-location')

    def test_missing_browser_is_not_shipped(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(mac_build, 'run') as command:
            with self.assertRaises(RuntimeError):
                mac_build.attach_browsers(Path(folder)/'Lumen.app',Path(folder)/'missing')
            command.assert_not_called()

    def test_signing_failure_stops_packaging(self):
        with tempfile.TemporaryDirectory() as folder:
            browsers=Path(folder)/'browsers'
            (browsers/'chromium-1228').mkdir(parents=True)
            error=subprocess.CalledProcessError(1,['codesign'])
            with patch.object(mac_build,'run',side_effect=[None,error]):
                with self.assertRaises(subprocess.CalledProcessError):
                    mac_build.attach_browsers(Path(folder)/'Lumen.app',browsers)

if __name__=='__main__':
    unittest.main()
