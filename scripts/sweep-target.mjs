// Trims stale Rust build artifacts from ./target after a build so the cargo
// cache doesn't balloon — debug builds alone reach several GB. Uses cargo-sweep,
// which deletes artifacts older than a cutoff while keeping the current build
// warm, unlike `cargo clean` which forces a full cold rebuild next time.
//
// Wired as a `post*` npm hook on the build scripts (see package.json), so it
// runs automatically after each build. Cleanup must NEVER fail a build: if
// cargo / cargo-sweep isn't available, or there's nothing to sweep, we print a
// hint and exit 0.
//
// Tune the cutoff with SWEEP_DAYS (default 10).
import { spawnSync } from 'node:child_process';

const DAYS = Number(process.env.SWEEP_DAYS || 10);

console.log(`[sweep-target] trimming Rust artifacts older than ${DAYS} day(s) via cargo-sweep…`);

// `cargo sweep` shells out to the cargo-sweep binary. Any failure (cargo
// missing, subcommand not installed, nothing to remove) is treated as a no-op
// so packaging is never blocked.
const res = spawnSync('cargo', ['sweep', '--time', String(DAYS)], { stdio: 'inherit' });

if (res.error || res.status !== 0) {
  console.log(
    '[sweep-target] skipped — cargo-sweep unavailable (or nothing to sweep).\n' +
    '  Install it once to enable automatic cleanup:  cargo install cargo-sweep',
  );
}

// Always succeed: a cleanup step should never break the build it follows.
process.exit(0);
