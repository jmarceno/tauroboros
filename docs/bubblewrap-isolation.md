# Bubblewrap Sandbox Isolation

The Rust backend uses [bubblewrap](https://github.com/containers/bubblewrap) to sandbox AI agent sessions by default. This document explains the behavior and configuration.

## Default Behavior

- **On by default**: All non-planning agent sessions run inside a bubblewrap sandbox.
- **Planning exemption**: Planning sessions (`Planning`, `Plan`, `PlanRevision`) are never sandboxed.
- **Global kill switch**: Disable entirely via Options (`bubblewrapEnabled: false`).

## Always-On Grants

Every sandboxed session gets these filesystem mounts:

| Path | Access | Purpose |
| --- | --- | --- |
| Repository root | RW | Full repository tree access |
| `~/.pi` | RO | Pi agent resources (skills, extensions) |
| `/tmp` | RW | Temporary files |
| `/usr`, `/bin`, `/lib`, `/lib64`, `/sbin` | RO | System binaries and libraries |
| `PATH` directories | RO | Development toolchains |
| System library roots | RO | Runtime dependencies |
| `/etc/resolv.conf`, `/etc/hosts`, etc. | RO | DNS and host resolution |
| `/dev` | Special | Bubblewrap-managed device filesystem |
| `/proc` | - | Process filesystem |

## Additional Grants

Per-task extra path grants can be configured in the task modal under "Additional Agent Access". Each grant specifies:

- **path** - absolute filesystem path or a path starting with `~/`
- **access** - `ro` (read-only) or `rw` (read-write)

## Failure Behavior

If `bwrap` is not installed or a path grant is invalid, the task fails explicitly with a clear error. There is no silent fallback to unsandboxed execution.

## Session Records

Every session record stores:
- `isolation_mode` - `"none"` or `"bubblewrap"`
- `path_grants_json` - the exact resolved grants used
