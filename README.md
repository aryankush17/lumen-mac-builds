# Lumen Mac builds

Private build source for the original Lumen, including Overview and grouped navigation.

In **Actions → Build Mac installer → Run workflow**, choose Apple Silicon or Intel.
The workflow runs only on manual dispatch. Check your GitHub Actions allowance and
spending limits first. Each run has a 45-minute timeout; artifacts expire in 3 days.

Successful runs attach the DMG and checksum under **Artifacts**. Failed runs attach
a build log. This builds an ad-hoc-signed private test app, not an Apple-notarized
public release. A successful compile does not replace functional testing on a Mac.

No personal runtime data or saved credentials are included. Activation and the
existing hosted services remain required. See READ-ME-FIRST.txt for local builds
and the Mac testing checklist.
