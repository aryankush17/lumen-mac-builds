"""Native, private-test macOS build; creates a new build directory each time."""
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NODE_VERSION = 'v24.14.0'

def run(args, cwd=None, env=None):
    print('Running:', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd or ROOT, env=env, check=True)

def validate_archive_member(member, destination):
    # macOS /var is an alias of /private/var: compare canonical paths on BOTH sides.
    destination = Path(destination).resolve()
    target = (destination / member.name).resolve()
    if not target.is_relative_to(destination) or member.isdev():
        raise SystemExit('Unsafe Node archive entry: ' + member.name)
    if member.issym() or member.islnk():
        base = target.parent if member.issym() else destination
        link = (base / member.linkname).resolve()
        if not link.is_relative_to(destination):
            raise SystemExit('Unsafe Node archive link: ' + member.name)

def attach_browsers(bundle, browsers):
    """Preserve Chromium's nested frameworks, symlinks and vendor signatures."""
    destination = bundle / 'Contents/Resources/ms-playwright'
    if not browsers.is_dir() or not any(browsers.glob('chromium-*')):
        raise RuntimeError('Downloaded Chromium bundle is missing; refusing to package an incomplete app.')
    run(['ditto', browsers, destination])
    # Re-seal only the containing app. --deep signing would rewrite Chromium again.
    run(['codesign', '--force', '--sign', '-', '--timestamp=none', bundle])
    run(['codesign', '--verify', '--deep', '--strict', bundle])

def main():
    if sys.platform != 'darwin':
        raise SystemExit('Build on macOS; Windows cannot produce this installer.')
    if sys.version_info < (3, 11):
        raise SystemExit('Install Python 3.11 or newer from python.org.')
    machine = platform.machine()
    if machine not in ('arm64', 'x86_64'):
        raise SystemExit('Unsupported Mac architecture: ' + machine)
    if machine == 'x86_64':
        translated = subprocess.run(['sysctl', '-in', 'sysctl.proc_translated'], capture_output=True, text=True)
        if translated.stdout.strip() == '1':
            raise SystemExit('Run native Apple Silicon Python rather than Python under Rosetta.')
    run(['xcode-select', '-p'])
    work = Path(tempfile.mkdtemp(prefix='lumen-mac-')).resolve()
    print('Build files and logs remain here:', work)
    stage = work / 'source'
    shutil.copytree(ROOT, stage, ignore=shutil.ignore_patterns('Output', '__pycache__', '.DS_Store', '.git', 'node_modules', 'dist', '*.log'))
    arch = 'arm64' if machine == 'arm64' else 'x64'
    archive = f'node-{NODE_VERSION}-darwin-{arch}.tar.gz'
    base = f'https://nodejs.org/dist/{NODE_VERSION}/'
    downloaded = work / archive
    urllib.request.urlretrieve(base + archive, downloaded)
    checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=60).read().decode()
    expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == archive)
    if hashlib.sha256(downloaded.read_bytes()).hexdigest() != expected:
        raise SystemExit('Official Node archive checksum mismatch.')
    # Official archive: reject traversal, unsafe link targets and device entries.
    with tarfile.open(downloaded) as tar:
        for member in tar.getmembers():
            validate_archive_member(member, work)
        tar.extractall(work)
    node_root = work / f'node-{NODE_VERSION}-darwin-{arch}'
    node = node_root / 'bin/node'
    npm = [node, node_root / 'lib/node_modules/npm/bin/npm-cli.js']
    env = dict(os.environ)
    env['PATH'] = str(node_root / 'bin') + os.pathsep + env.get('PATH', '')
    env['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD'] = '1'
    browsers = stage / 'ms-playwright'
    env['PLAYWRIGHT_BROWSERS_PATH'] = str(browsers)
    for folder in ('pages_ui', 'website_builder/client', 'website_builder/server'):
        run(npm + ['ci', '--no-audit', '--no-fund'], stage / folder, env)
        run(npm + ['run', 'build'], stage / folder, env)
    server = stage / 'website_builder/server'
    run(npm + ['prune', '--omit=dev'], server, env)
    run([node, server / 'node_modules/playwright-chromium/cli.js', 'install', 'chromium'], server, env)
    runtime = stage / 'website_builder/node'
    runtime.mkdir()
    shutil.copy2(node, runtime / 'node')
    shutil.copy2(node_root / 'LICENSE', runtime / 'LICENSE')
    venv = work / 'python-env'
    run([sys.executable, '-m', 'venv', venv])
    python = venv / 'bin/python'
    run([python, '-m', 'pip', 'install', '-r', stage / 'mac-requirements.txt'])
    version = (stage / 'VERSION').read_text().strip()
    spec = '''from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules
root = Path(SPECPATH)
datas = []
for folder in ['assets','pages_ui/dist','website_builder/client/dist','website_builder/server/dist','website_builder/server/node_modules','website_builder/server/templates','legal']:
    datas.append((str(root / folder), folder))
for name in ['config.default.json','VERSION','logo.png']:
    datas.append((str(root/name), '.'))
datas.append((str(root/'website_builder/node/LICENSE'),'website_builder/node'))
a = Analysis([str(root/'app.py')], pathex=[str(root)], datas=datas,
    binaries=[(str(root/'website_builder/node/node'),'website_builder/node')],
    runtime_hooks=[str(root/'mac_runtime_hook.py')],
    hiddenimports=['website_builder_bridge','website_generation','pages_store','crm_store']+collect_submodules('qrcode'), excludes=['playwright'])
pyz = PYZ(a.pure)
exe = EXE(pyz,a.scripts,[],exclude_binaries=True,name='Lumen',console=False,target_arch=None,codesign_identity=None)
coll = COLLECT(exe,a.binaries,a.datas,name='Lumen')
app = BUNDLE(coll,name='Lumen.app',bundle_identifier='local.lumen.desktop',version=VERSION_VALUE,
    info_plist={'NSHighResolutionCapable':True,'CFBundleDisplayName':'Lumen'})
'''.replace('VERSION_VALUE', repr(version))
    specfile = stage / 'Lumen-Mac.spec'
    specfile.write_text(spec)
    run([python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', work/'dist', '--workpath', work/'build', specfile], stage, env)
    bundle = work / 'dist/Lumen.app'
    attach_browsers(bundle, browsers)
    dmg_stage = work / 'dmg'
    dmg_stage.mkdir()
    run(['ditto', bundle, dmg_stage/'Lumen.app'])
    (dmg_stage/'Applications').symlink_to('/Applications')
    output = ROOT / 'Output'
    output.mkdir(exist_ok=True)
    destination = output / f'Lumen-{version}-macOS-{arch}-{work.name}.dmg'
    run(['hdiutil','create','-volname','Lumen','-srcfolder',dmg_stage,'-format','UDZO',destination])
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix('.dmg.sha256').write_text(digest+'  '+destination.name+'\n')
    print('\nCreated:', destination)
    print('Private-test build: not Apple notarized. Test every module before distributing.')

if __name__ == '__main__':
    main()
